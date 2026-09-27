import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startBridgeServer } from '../bridge-server/src/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function waitForHttp(url, child, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* vite is still starting */ }
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test('agents arena mock loop and continuous narration work in Playwright', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fly-agent-e2e-'));
  const logPath = path.join(tempDir, 'calls.jsonl');
  const bridge = await startBridgeServer({ port: 0, forceMock: true, logPath, workspaceDir: path.join(tempDir, 'workspace') });
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, VITE_CACHE_DIR: 'node_modules/.vite-e2e' },
  });
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    await waitForHttp('http://127.0.0.1:4173/arena.html', vite, 30_000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:4173/arena.html?avatar=vrm&env=agents&bridge=ws://127.0.0.1:${bridge.port}&touch=debug&narrateEvery=3&flies=1&vision=0&gpu=0&run=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__arena?.flies?.[0]?.last, null, { timeout: 120_000 });
    await page.locator('[data-debug-terminal="ollama"]').click();
    await page.waitForFunction(() => !document.querySelector('#agentBubble')?.hidden, null, { timeout: 15_000 });
    const bubble = await page.locator('#agentBubble').textContent();
    assert.match(bubble, /こんにちは|ここにいる|甘くてうれしい！|おなかがすいたよ。/);
    await page.waitForFunction(() => window.__arena.env.food.find(food => food.agentId === 'ollama')?.sugar >= 1, null, { timeout: 5_000 });
    const envSugar = await page.evaluate(() => window.__arena.env.food.find(food => food.agentId === 'ollama').sugar);
    assert.ok(envSugar >= 1);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /"event":"touched_agent"/);
    assert.match(log, /"id":"debug-/);
    assert.match(log, /"terminal_id":"ollama"/);
    assert.match(log, /"payload":/);
    await page.waitForFunction(() => document.querySelector('#narrationNotes')?.textContent?.trim(), null, { timeout: 40_000 });
    // The bubble may still hold the touch reply (transition replies keep priority for 10 s),
    // so the narration is checked where it always lands: the Brain voice list.
    assert.match(await page.locator('#narrationNotes').textContent(), /左から何かいい匂いがする/);
    const narrationLog = await readFile(logPath, 'utf8');
    assert.match(narrationLog, /"id":"narr-/);
    assert.match(narrationLog, /"event":"narrate"/);
    assert.match(narrationLog, /"signals":\[/);
  } finally {
    await browser?.close().catch(() => {});
    await bridge.close();
    vite.kill('SIGTERM');
    await rm(tempDir, { recursive: true, force: true });
  }
});
