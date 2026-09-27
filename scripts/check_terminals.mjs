// Headless terminal-attraction check using the same FlyAgent brain options as arena.js.
// Vision is ON by default; use --vision=0 only for an explicit ablation.
// Usage: node scripts/check_terminals.mjs [--flies=2] [--seconds=5] [--sample-ms=10]
//   [--config-json='{"agents":[...]}'] [--vision=0] [--out=path]
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';
import { loadAll, loadNeuromod } from './lib_node.mjs';
import { FlyAgent } from '../src/sim/fly.js';
import { PRESETS } from '../src/sim/world.js';
import { expandAgents } from '../src/agents/terminals.js';
import { allocBrainMemory, attachBrain, attachEyes } from '../src/brainsetup.js';
import { parseFlyVis } from '../src/flyvis.js';

export const DWELL_MS = 300;

function cliArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map(value => {
    const [key, ...rest] = value.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }));
}

function readAssetFloat(file) {
  const bytes = fs.readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function makeAgentEnv(configJson) {
  const presetEnv = PRESETS.agents.env();
  if (!configJson) return presetEnv;
  const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
  const env = structuredClone(presetEnv);
  env.food = [];
  env.odors = [];
  env.agents = structuredClone(config.agents ?? env.agents);
  return expandAgents(env);
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

function finishTrackers(trackers, seconds, steps) {
  for (const tracker of trackers.values()) {
    if (tracker.inside && steps - tracker.enteredAt >= DWELL_MS) tracker.visits++;
    tracker.fractionWithin = tracker.withinMs / steps;
    tracker.visitsPerFlyMinute = tracker.visits / (seconds / 60);
    delete tracker.inside;
    delete tracker.enteredAt;
  }
  return [...trackers.values()];
}

export async function runOne({ env, seconds, sampleMs, replicate, vision = true, data, size, sign, gait, flyXML, calib, wasmBytes, mj }) {
  const brainOpts = { ...calib, gpu: false }; // arena brain parameters; headless backend only
  let visionModel = null;
  let flyvis = null;
  if (vision) {
    const bin = fs.readFileSync('public/vision/flyvis.bin');
    visionModel = { model: parseFlyVis(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
      JSON.parse(fs.readFileSync('public/vision/flyvis.json')),
      JSON.parse(fs.readFileSync('public/vision/flyvis_inputs.json'))),
    map: JSON.parse(fs.readFileSync('public/vision/flyvis_map.json')) };
  }
  const memory = allocBrainMemory(data, size, sign, brainOpts, 1, visionModel);
  const brain = await attachBrain(wasmBytes, memory, 0, data, 7 + replicate);
  if (visionModel) flyvis = { eyes: attachEyes(brain.instance, memory, 0), map: visionModel.map, gain: 150 };
  const fly = new FlyAgent({ mj, flyXML, env, data, size, sign, bodymap: data.bodymap, gait,
    id: replicate, seed: replicate, pos: PRESETS.agents.start.slice(0, 2), yaw: PRESETS.agents.start[2],
    mode: 'descending', brainOpts, vision, brain, flyvis, neuromod: loadNeuromod() });
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
    const terminals = finishTrackers(trackers, seconds, steps);
    return { replicate, seconds, terminals, bothVisited: terminals.every(t => t.visits > 0) };
  } finally {
    fly.dispose();
  }
}

export async function runExperiment({ env, flies, seconds, sampleMs, vision = true, replicateStart = 0 }) {
  const D = loadAll();
  const data = { ...D, superclass: D.sc, bodymap: D.bodymap };
  const size = readAssetFloat('public/data/neuron_size.bin');
  const sign = readAssetFloat('public/data/ntsign.bin');
  const gait = JSON.parse(fs.readFileSync('public/body/gait.json'));
  const flyXML = fs.readFileSync('public/body/fly_physics.xml', 'utf8');
  const calib = fs.existsSync('public/data/brain_params.json') ? JSON.parse(fs.readFileSync('public/data/brain_params.json')) : { wSyn: 0.4 };
  const wasmBytes = fs.readFileSync('public/lif.wasm');
  const mj = await loadMujoco();
  const runs = [];
  for (let replicate = replicateStart; replicate < replicateStart + flies; replicate++) {
    runs.push(await runOne({ env, seconds, sampleMs, replicate, vision, data, size, sign, gait, flyXML, calib, wasmBytes, mj }));
  }
  const summary = env.agents.map(agent => {
    const rows = runs.map(run => run.terminals.find(t => t.agentId === agent.id));
    const arrivals = rows.filter(row => row.firstArrival !== null).map(row => row.firstArrival);
    return { agentId: agent.id,
      fractionWithin: rows.reduce((sum, row) => sum + row.fractionWithin, 0) / rows.length,
      visits: rows.reduce((sum, row) => sum + row.visits, 0) / rows.length,
      visitsPerFlyMinute: rows.reduce((sum, row) => sum + row.visitsPerFlyMinute, 0) / rows.length,
      firstArrival: arrivals.length ? arrivals.reduce((sum, value) => sum + value, 0) / arrivals.length : null,
      arrivedFraction: arrivals.length / rows.length,
      dwellQualifiedFraction: rows.filter(row => row.visits > 0).length / rows.length,
    };
  });
  return { parameters: { flies, simulatedSeconds: seconds, sampleMs, dwellMs: DWELL_MS, vision, terminalConfig: env.agents }, runs, summary,
    bothVisitedFraction: runs.filter(run => run.bothVisited).length / runs.length };
}

async function main() {
  const args = cliArgs();
  const flies = Math.max(1, Number(args.flies || 2));
  const seconds = Math.max(1, Number(args.seconds || 5));
  const sampleMs = Math.max(1, Number(args['sample-ms'] || 10));
  const replicateStart = Math.max(0, Number(args['replicate-start'] || 0));
  const vision = !['0', 'false', 'off', 'no'].includes(String(args.vision || '1').toLowerCase());
  const env = makeAgentEnv(args['config-json']);
  const report = await runExperiment({ env, flies, seconds, sampleMs, vision, replicateStart });
  const outPath = args.out || 'scratch/terminals-results.json';
  await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
  await fsPromises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nTerminal validation: N=${flies} independent flies, T=${seconds}s, sample=${sampleMs}ms, dwell>=${DWELL_MS}ms, vision=${vision ? 'ON' : 'OFF'}`);
  console.log('terminal  fraction-within  visits/fly-min  first-arrival-s  dwell-qualified  both-visited');
  for (const row of report.summary) console.log(`${row.agentId.padEnd(8)} ${(row.fractionWithin * 100).toFixed(1).padStart(16)} ${(row.visitsPerFlyMinute).toFixed(2).padStart(15)} ${(row.firstArrival ?? 'never').toString().padStart(16)} ${(row.dwellQualifiedFraction * 100).toFixed(0).padStart(16)}% ${(report.bothVisitedFraction * 100).toFixed(0).padStart(12)}%`);
  console.log(`JSON ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
