// Bit-stability trace for the headless one-fly simulation.
// Usage: node scripts/golden_trace.mjs [seconds] [--write|--verify]
// The trace is deliberately sampled at 10 ms, matching the headless runner's
// observation cadence. It hashes the complete observable brain/physics state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { loadAll, loadNeuromod } from './lib_node.mjs';
import { FlyAgent } from '../src/sim/fly.js';
import { DEFAULT_ENV, PRESETS } from '../src/sim/world.js';
import { allocBrainMemory, attachBrain, attachEyes } from '../src/brainsetup.js';
import { parseFlyVis } from '../src/flyvis.js';

const seconds = Number(process.argv[2] || 1);
const action = process.argv.includes('--verify') ? 'verify' : 'write';
const SEEDS = [7, 19];
const CASES = [
  { name: 'default-vision-on', vision: true, env: () => structuredClone(DEFAULT_ENV) },
  { name: 'default-vision-off', vision: false, env: () => structuredClone(DEFAULT_ENV) },
  { name: 'agents-vision-on', vision: true, env: () => PRESETS.agents.env() },
];
const GOLD_DIR = 'scratch/golden';

function readFloat(file) {
  const bytes = fs.readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function updateBytes(hash, label, view) {
  hash.update(label);
  hash.update(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
}

function commandJson(cmd) {
  const out = {};
  for (const key of Object.keys(cmd || {}).sort()) {
    const value = cmd[key];
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || typeof value === 'string') out[key] = value;
    else if (value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

function snapshot(fly, st) {
  const b = fly.brain, d = fly.mjd;
  const hash = crypto.createHash('sha256');
  hash.update(`t=${fly.t};energy=${fly.energy};health=${fly.health};behavior=${fly.behavior(st)};cmd=${commandJson(fly.cmd)};`);
  updateBytes(hash, 'qpos', d.qpos);
  updateBytes(hash, 'spikeCount', b.spikeCount);
  updateBytes(hash, 'ringCount', b.ringCount);
  updateBytes(hash, 'ring', b.ring);
  return {
    hash: hash.digest('hex'),
    t: fly.t,
    energy: fly.energy,
    health: fly.health,
    behavior: fly.behavior(st),
    cmd: JSON.parse(commandJson(fly.cmd)),
    qpos: Array.from(d.qpos),
  };
}

async function runCase({ name, vision, env: envFactory }, seed, shared) {
  const env = envFactory();
  const brainOpts = { ...shared.calib, gpu: false };
  const visionModel = vision ? shared.visionModel : null;
  const memory = allocBrainMemory(shared.data, shared.size, shared.sign, brainOpts, 1, visionModel);
  const brain = await attachBrain(shared.wasmBytes, memory, 0, shared.data, seed);
  const flyvis = visionModel ? { eyes: attachEyes(brain.instance, memory, 0), map: visionModel.map, gain: 150 } : null;
  const fly = new FlyAgent({ mj: shared.mj, flyXML: shared.flyXML, env, data: shared.data, size: shared.size,
    sign: shared.sign, bodymap: shared.data.bodymap, gait: shared.gait, id: seed, seed,
    pos: PRESETS.agents.start?.slice(0, 2) || [0, 0], yaw: PRESETS.agents.start?.[2] || 0,
    mode: 'descending', brainOpts, vision, brain, flyvis, neuromod: loadNeuromod() });
  const checkpoints = [];
  try {
    for (let step = 1; step <= Math.round(seconds * 1000); step++) {
      fly.step();
      if (step % 10 === 0) checkpoints.push({ ms: step, ...snapshot(fly, fly.state()) });
    }
    const final = snapshot(fly, fly.state());
    return { name, seed, seconds, checkpoints, final };
  } finally {
    fly.dispose();
  }
}

function flattenTrace(trace) {
  return trace.map(x => `${x.name}/${x.seed}`);
}

async function main() {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid seconds: ${seconds}`);
  const D = loadAll();
  const data = { ...D, superclass: D.sc, bodymap: D.bodymap };
  const shared = {
    data,
    size: readFloat('public/data/neuron_size.bin'),
    sign: readFloat('public/data/ntsign.bin'),
    gait: JSON.parse(fs.readFileSync('public/body/gait.json')),
    flyXML: fs.readFileSync('public/body/fly_physics.xml', 'utf8'),
    calib: fs.existsSync('public/data/brain_params.json') ? JSON.parse(fs.readFileSync('public/data/brain_params.json')) : { wSyn: 0.4 },
    wasmBytes: fs.readFileSync('public/lif.wasm'),
    mj: await loadMujoco(),
    visionModel: null,
  };
  const fb = fs.readFileSync('public/vision/flyvis.bin');
  shared.visionModel = {
    model: parseFlyVis(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength),
      JSON.parse(fs.readFileSync('public/vision/flyvis.json')),
      JSON.parse(fs.readFileSync('public/vision/flyvis_inputs.json'))),
    map: JSON.parse(fs.readFileSync('public/vision/flyvis_map.json')),
  };
  const traces = [];
  for (const spec of CASES) for (const seed of SEEDS) traces.push(await runCase(spec, seed, shared));
  fs.mkdirSync(GOLD_DIR, { recursive: true });
  const failures = [];
  for (const trace of traces) {
    const file = path.join(GOLD_DIR, `${trace.name}-seed${trace.seed}.json`);
    if (action === 'verify') {
      const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
      const actual = JSON.stringify(trace);
      const want = JSON.stringify(expected);
      if (actual !== want) {
        const a = trace.checkpoints, e = expected.checkpoints;
        const n = Math.min(a.length, e.length);
        let first = -1; for (let i = 0; i < n; i++) if (a[i].hash !== e[i].hash) { first = i; break; }
        failures.push(`${file}: first checkpoint ${first < 0 ? 'length/final' : a[first].ms + ' ms'}`);
      }
    } else {
      fs.writeFileSync(file, `${JSON.stringify(trace, null, 2)}\n`);
    }
  }
  if (failures.length) throw new Error(`golden mismatch:\n${failures.join('\n')}`);
  console.log(`${action} OK: ${traces.length} traces, ${traces[0].checkpoints.length} checkpoints each`);
  for (const trace of traces) console.log(`${trace.name} seed=${trace.seed} final=${trace.final.hash}`);
}

await main();
