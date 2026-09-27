// Headless P1/P2 check for the opt-in humanoid presentation.
// Usage: npm run dev -- --host 127.0.0.1
//        node scripts/check_humanoid.mjs [--url=http://127.0.0.1:5173] [--seconds=6]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
const baseUrl = (args.url || 'http://127.0.0.1:5173').replace(/\/$/, '');
const outDir = args.out || 'scratch';
const seconds = Math.max(2, Number(args.seconds || 6));
const MAX_ROOT_XY_ERROR = 0.25;
// raw yaw vs the interpolated, animated body: allow for one pose of lag and gait sway
const MAX_HEADING_ERROR = 0.35;
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
const warnings = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});

const report = { url: `${baseUrl}/arena.html?avatar=vrm`, errors, warnings, samples: [] };
try {
  await page.goto(report.url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(
    () => window.__arena?.humanoidRenderer?.vrmLoaded && window.__arena?.flies?.[0]?.last,
    null,
    { timeout: 180000 },
  );
  const initial = await page.evaluate(() => ({
    t: __arena.flies[0].last.t,
    source: __arena.humanoidRenderer.avatarPathUsed,
    animationSource: __arena.humanoidRenderer.animationSource,
    vrmLoaded: __arena.humanoidRenderer.vrmLoaded,
    instanceReady: __arena.humanoidRenderer.instances.get(0)?.ready,
  }));
  report.initial = initial;
  assert.equal(initial.vrmLoaded, true, 'VRM must load');
  assert.equal(initial.instanceReady, true, 'VRM instance must be attached');

  await page.click('#play');
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(250);
    report.samples.push(await page.evaluate(() => {
      const fly = __arena.flies[0];
      const instance = __arena.humanoidRenderer.instances.get(0);
      const pose = fly.last;
      const dx = instance.root.position.x - pose.pos[0];
      const dy = instance.root.position.y - pose.pos[1];
      // Facing measured from the avatar's own body (left minus right hip,
      // crossed with world up), so a model turned backwards fails too.
      const { Vector3 } = __arena.THREE;
      const bone = name => instance.vrm.humanoid.getRawBoneNode(name).getWorldPosition(new Vector3());
      const across = bone('leftUpperLeg').sub(bone('rightUpperLeg'));
      const forward = across.cross(new Vector3(0, 0, 1));
      const headingDelta = Math.atan2(forward.y, forward.x) - pose.yaw;
      return {
        t: pose.t,
        behavior: pose.behavior,
        action: instance.animationState?.action || null,
        xyError: Math.hypot(dx, dy),
        headingError: Math.abs(Math.atan2(Math.sin(headingDelta), Math.cos(headingDelta))),
        root: instance.root.position.toArray(),
        fly: pose.pos.slice(),
      };
    }));
  }
  await page.screenshot({ path: `${outDir}/humanoid.png` });

  assert.ok(report.samples.length >= 4, 'pose samples must arrive');
  assert.ok(report.samples.at(-1).t > initial.t, 'simulation time must advance');
  assert.ok(Math.max(...report.samples.map(sample => sample.xyError)) <= MAX_ROOT_XY_ERROR, 'root must track raw last.pos xy within body length');
  assert.ok(Math.max(...report.samples.map(sample => sample.headingError)) <= MAX_HEADING_ERROR, 'avatar body must face the fly yaw');
  const visual = await page.evaluate(() => ({
    flyMeshVisible: __arena.flies[0].group.visible,
    batchVisible: __arena.scene.children.filter(child => child.name === 'arena-body-batch').some(child => child.visible),
    humanoidVisible: __arena.humanoidRenderer.instances.get(0).root.visible,
  }));
  report.visual = visual;
  assert.equal(visual.flyMeshVisible, false, 'legacy fly mesh must be hidden');
  assert.equal(visual.batchVisible, false, 'legacy fly batches must be hidden');
  assert.equal(visual.humanoidVisible, true, 'humanoid root must be visible');
  assert.deepEqual(errors, [], 'arena.html?avatar=vrm must have no console errors');
  console.log(JSON.stringify({
    vrm: report.initial,
    samples: report.samples.length,
    maxXYError: Math.max(...report.samples.map(sample => sample.xyError)),
    maxHeadingError: Math.max(...report.samples.map(sample => sample.headingError)),
    finalT: report.samples.at(-1).t,
    visual: report.visual,
  }));
} finally {
  report.errors = errors;
  report.warnings = warnings;
  await fs.writeFile(`${outDir}/humanoid-results.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
