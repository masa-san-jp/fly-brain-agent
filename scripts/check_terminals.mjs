// Headless terminal attraction check. This follows scripts/run_fly.mjs's Node setup,
// but records terminal occupancy, qualifying visits, and first arrival.
// Usage: node scripts/check_terminals.mjs [--flies=2] [--seconds=5] [--sample-ms=10]
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import loadMujoco from '@mujoco/mujoco';
import { loadAll, loadNeuromod } from './lib_node.mjs';
import { FlyAgent } from '../src/sim/fly.js';
import { PRESETS } from '../src/sim/world.js';
import { allocBrainMemory, attachBrain } from '../src/brainsetup.js';

const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
const N = Math.max(1, Number(args.flies || 2));
const seconds = Math.max(1, Number(args.seconds || 5));
const sampleMs = Math.max(1, Number(args['sample-ms'] || 10));
const outPath = args.out || 'scratch/terminals-results.json';
const DWELL_MS = 300;

const D = loadAll();
const data = { ...D, superclass: D.sc };
const sizeBytes = fs.readFileSync('public/data/neuron_size.bin');
const signBytes = fs.readFileSync('public/data/ntsign.bin');
const size = new Float32Array(sizeBytes.buffer.slice(sizeBytes.byteOffset, sizeBytes.byteOffset + sizeBytes.byteLength));
const sign = new Float32Array(signBytes.buffer.slice(signBytes.byteOffset, signBytes.byteOffset + signBytes.byteLength));
const gait = JSON.parse(fs.readFileSync('public/body/gait.json'));
const flyXML = fs.readFileSync('public/body/fly_physics.xml', 'utf8');
const calib = fs.existsSync('public/data/brain_params.json') ? JSON.parse(fs.readFileSync('public/data/brain_params.json')) : { wSyn: 0.4 };
const wasmBytes = fs.readFileSync('public/lif.wasm');
const mj = await loadMujoco();

function conditionEnv(withOdor) {
  const env = PRESETS.agents.env();
  if (!withOdor) env.odors = [];
  return env;
}

function makeTrackers(env) {
  return new Map(env.agents.map(agent => [agent.id, {
    agentId: agent.id, radius: agent.r, withinMs: 0, visits: 0, firstArrival: null,
    inside: false, enteredAt: null,
  }]));
}

function sampleTrackers(trackers, env, x, y, fromMs, toMs) {
  for (const agent of env.agents) {
    const tracker = trackers.get(agent.id);
    const inside = Math.hypot(x - agent.x, y - agent.y) < agent.r;
    if (inside) tracker.withinMs += toMs - fromMs;
    if (inside && !tracker.inside) {
      tracker.inside = true;
      tracker.enteredAt = toMs;
      tracker.firstArrival ??= toMs / 1000;
    } else if (!inside && tracker.inside) {
      if (toMs - tracker.enteredAt >= DWELL_MS) tracker.visits++;
      tracker.inside = false;
      tracker.enteredAt = null;
    }
  }
}

async function runOne({ withOdor, energy, replicate }) {
  const env = conditionEnv(withOdor);
  const brainOpts = { ...calib, gpu: false };
  const memory = allocBrainMemory(data, size, sign, brainOpts, 1, null);
  const brain = await attachBrain(wasmBytes, memory, 0, data, 7 + replicate);
  const fly = new FlyAgent({ mj, flyXML, env, data, size, sign, bodymap: D.bodymap, gait,
    id: replicate, seed: replicate, pos: PRESETS.agents.start.slice(0, 2), yaw: PRESETS.agents.start[2],
    mode: 'descending', brainOpts, vision: false, brain, neuromod: loadNeuromod() });
  fly.energy = energy;
  const trackers = makeTrackers(env);
  const steps = Math.round(seconds * 1000);
  let lastSample = 0;
  try {
    for (let step = 1; step <= steps; step++) {
      fly.step();
      if (step === steps || step - lastSample >= sampleMs) {
        const b = fly.bid.thorax;
        const x = fly.mjd.xpos[b * 3], y = fly.mjd.xpos[b * 3 + 1];
        sampleTrackers(trackers, env, x, y, lastSample, step);
        lastSample = step;
      }
    }
    for (const tracker of trackers.values()) {
      if (tracker.inside && steps - tracker.enteredAt >= DWELL_MS) tracker.visits++;
      tracker.fractionWithin = tracker.withinMs / steps;
      delete tracker.inside;
      delete tracker.enteredAt;
    }
    return { withOdor, hunger: energy < 0.5 ? 'low' : 'high', energy, replicate, seconds, terminals: [...trackers.values()] };
  } finally {
    fly.dispose();
  }
}

const conditions = [
  { name: 'odor-low', withOdor: true, energy: 0.2 },
  { name: 'odor-high', withOdor: true, energy: 0.9 },
  { name: 'control-low', withOdor: false, energy: 0.2 },
  { name: 'control-high', withOdor: false, energy: 0.9 },
];
const runs = [];
for (const condition of conditions) {
  for (let replicate = 0; replicate < N; replicate++) {
    const run = await runOne({ ...condition, replicate });
    run.condition = condition.name;
    runs.push(run);
  }
}

const summary = [];
for (const condition of conditions) for (const agent of PRESETS.agents.env().agents) {
  const rows = runs.filter(run => run.condition === condition.name).map(run => run.terminals.find(t => t.agentId === agent.id));
  const arrivals = rows.filter(row => row.firstArrival !== null).map(row => row.firstArrival);
  summary.push({ condition: condition.name, agentId: agent.id,
    fractionWithin: rows.reduce((sum, row) => sum + row.fractionWithin, 0) / rows.length,
    visits: rows.reduce((sum, row) => sum + row.visits, 0) / rows.length,
    firstArrival: arrivals.length ? arrivals.reduce((sum, value) => sum + value, 0) / arrivals.length : null,
    arrivedFraction: arrivals.length / rows.length,
  });
}

const report = { parameters: { flies: N, simulatedSeconds: seconds, sampleMs, dwellMs: DWELL_MS,
  terminalConfig: PRESETS.agents.env().agents }, runs, summary };
await fsPromises.mkdir(new URL('.', `file://${process.cwd()}/${outPath}`).pathname, { recursive: true }).catch(() => {});
await fsPromises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nTerminal validation: N=${N} independent flies/condition, T=${seconds}s, sample=${sampleMs}ms, dwell>=${DWELL_MS}ms`);
console.log('condition      terminal  fraction-within-r  visits/flight  first-arrival-s  arrived');
for (const row of summary) console.log(`${row.condition.padEnd(14)} ${row.agentId.padEnd(8)} ${(row.fractionWithin * 100).toFixed(1).padStart(17)} ${(row.visits).toFixed(2).padStart(14)} ${(row.firstArrival ?? 'never').toString().padStart(16)} ${(row.arrivedFraction * 100).toFixed(0).padStart(7)}%`);
console.log(`JSON ${outPath}`);
