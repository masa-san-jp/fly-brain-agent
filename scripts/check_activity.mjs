// Headless activity assay for the arena's three relevant modes.
// Usage: node scripts/check_activity.mjs --seconds=20 --flies=3
import fs from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { loadAll, loadNeuromod } from './lib_node.mjs';
import { FlyAgent } from '../src/sim/fly.js';
import { PRESETS } from '../src/sim/world.js';
import { allocBrainMemory, attachBrain, attachEyes } from '../src/brainsetup.js';
import { parseFlyVis } from '../src/flyvis.js';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const seconds = Math.max(1, Number(args.seconds || 20));
const nFlies = Math.max(1, Number(args.flies || 3));
const useVision = args.vision !== '0';

const D = loadAll();
const data = { ...D, superclass: D.sc };
const size = new Float32Array(fs.readFileSync('public/data/neuron_size.bin').buffer.slice(0));
const sign = new Float32Array(fs.readFileSync('public/data/ntsign.bin').buffer.slice(0));
const gait = JSON.parse(fs.readFileSync('public/body/gait.json'));
const flyXML = fs.readFileSync('public/body/fly_physics.xml', 'utf8');
const calib = JSON.parse(fs.readFileSync('public/data/brain_params.json'));
const neuromod = loadNeuromod();
const mj = await loadMujoco();
let visionModel = null;
if (useVision) {
  const bin = fs.readFileSync('public/vision/flyvis.bin');
  visionModel = { model: parseFlyVis(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    JSON.parse(fs.readFileSync('public/vision/flyvis.json')),
    JSON.parse(fs.readFileSync('public/vision/flyvis_inputs.json'))),
  map: JSON.parse(fs.readFileSync('public/vision/flyvis_map.json')) };
}

function isWalkingLabel(label) {
  return /^(walking|turning left|turning right)/.test(label || '');
}

async function measure(name, { humanoidMode = false, preset = 'foraging', brainOverrides = {} } = {}) {
  const env = PRESETS[preset].env();
  const start = PRESETS[preset].start || [0, 0, 0];
  const behaviorMs = new Map();
  const flyResults = [];
  for (let id = 0; id < nFlies; id++) {
    const brainOpts = { ...calib, ...(humanoidMode ? { humanoidMode: true } : {}), ...brainOverrides };
    const mem = allocBrainMemory(data, size, sign, brainOpts, 1, visionModel);
    const brain = await attachBrain(fs.readFileSync('public/lif.wasm'), mem, 0, data, 101 + id);
    const eyes = visionModel ? attachEyes(brain.instance, mem, 0) : null;
    const angle = id * 2.4;
    const pos = id === 0 ? [start[0], start[1]] : [1.2 * Math.cos(angle), 1.2 * Math.sin(angle)];
    const fly = new FlyAgent({ mj, flyXML, env, data, size, sign, bodymap: D.bodymap, gait,
      id, pos, yaw: id === 0 ? start[2] || 0 : angle + Math.PI, brainOpts,
      neuromod, vision: useVision, brain, flyvis: eyes ? { eyes, map: visionModel.map, gain: 150 } : null });
    let previous = fly.state().pos;
    let path = 0;
    let groundDistance = 0;
    let walkingMs = 0;
    const terminalInside = new Set();
    const terminalVisits = new Map();
    for (let ms = 0; ms < seconds * 1000; ms++) {
      fly.step();
      const state = fly.state();
      const label = fly.behavior(state);
      behaviorMs.set(label, (behaviorMs.get(label) || 0) + 1);
      if (isWalkingLabel(label)) walkingMs++;
      const dx = state.pos[0] - previous[0], dy = state.pos[1] - previous[1];
      const stepDistance = Math.hypot(dx, dy);
      path += stepDistance;
      groundDistance += stepDistance;
      previous = state.pos;
      for (const terminal of env.agents || []) {
        const inside = Math.hypot(state.pos[0] - terminal.x, state.pos[1] - terminal.y) < terminal.r;
        const key = String(terminal.id);
        if (inside && !terminalInside.has(key)) terminalVisits.set(key, (terminalVisits.get(key) || 0) + 1);
        if (inside) terminalInside.add(key); else terminalInside.delete(key);
      }
    }
    flyResults.push({
      id,
      alive: fly.alive,
      energy: fly.energy,
      eaten: fly.eaten,
      walkingFraction: walkingMs / (seconds * 1000),
      meanGroundSpeed: groundDistance / seconds,
      pathLength: path,
      terminalVisits: [...terminalVisits.values()].reduce((sum, count) => sum + count, 0),
    });
    fly.dispose();
  }
  const totalMs = nFlies * seconds * 1000;
  const all = flyResults;
  const summary = {
    name,
    seconds,
    flies: nFlies,
    behaviorFraction: Object.fromEntries([...behaviorMs.entries()].sort((a, b) => b[1] - a[1]).map(([label, ms]) => [label, ms / totalMs])),
    walkingFraction: all.reduce((sum, row) => sum + row.walkingFraction, 0) / nFlies,
    meanGroundSpeed: all.reduce((sum, row) => sum + row.meanGroundSpeed, 0) / nFlies,
    pathLength: all.reduce((sum, row) => sum + row.pathLength, 0) / nFlies,
    terminalVisits: all.reduce((sum, row) => sum + row.terminalVisits, 0),
    alive: all.every(row => row.alive),
    fedSometimes: all.some(row => row.eaten > 0),
    fliesResult: all,
  };
  return summary;
}

const allModes = [
  ['default', { preset: 'foraging' }],
  ['humanoid-before', { humanoidMode: true, preset: 'foraging', brainOverrides: {
    humanoidInitialEnergy: 0.6,
    scaffoldParams: {
      intrinsic: { fwdDrive: 12 },
      boutScheduler: { walkBout: [2.2, 0.9], stopBout: [1.4, 0.9], groomBout: [2.5, 0.4], pGroom: 0.2,
        saccadeRate: 0.7, standSaccadeRate: 0.3, pTakeoff: 0.1 },
      feedingStop: { feedBout: [6, 0.5], satiety: 0.9, searchMs: 12000, searchTurns: 3 },
    },
  } }],
  ['humanoid', { humanoidMode: true, preset: 'foraging' }],
  ['humanoid-agents', { humanoidMode: true, preset: 'agents' }],
];
const only = args.only ? String(args.only) : null;
const selected = only ? allModes.filter(([name]) => name === only) : allModes;
if (!selected.length) throw new Error(`unknown --only=${only}; choose ${allModes.map(([name]) => name).join(', ')}`);
const results = [];
for (const [name, config] of selected) results.push(await measure(name, config));
console.log(JSON.stringify({ seconds, flies: nFlies, results }, null, 2));
