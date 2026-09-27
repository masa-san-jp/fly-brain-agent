// Paired baseline experiment. FlyAgent/connectome code is imported unchanged; only env/tools change.
// Awaiting chooseAction happens between fly.step() calls, so simulation time is frozen during latency.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import loadMujoco from '@mujoco/mujoco';
import { loadAll, loadNeuromod } from './lib_node.mjs';
import { FlyAgent } from '../src/sim/fly.js';
import { PRESETS } from '../src/sim/world.js';
import { allocBrainMemory, attachBrain, attachEyes } from '../src/brainsetup.js';
import { parseFlyVis } from '../src/flyvis.js';
import { buildGroups, GroupMeter } from '../src/sim/groups.js';
import { EventDetector } from '../src/agents/EventDetector.js';
import { interpretBrainState, NeuralNarrator } from '../src/agents/NeuralNarrator.js';
import { applyArenaAction, arenaItems, nothingAction, validateArenaAction } from '../src/agents/arenaTools.js';
import { buildPrompt } from '../bridge-server/src/prompt.mjs';
import { parseToolReply } from '../bridge-server/src/server.mjs';
import { createOllamaTask, DEFAULT_OLLAMA_MODEL, randomToolAction } from '../bridge-server/src/backends.mjs';
import { validateEventPayload } from '../bridge-server/src/validation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONDITIONS = Object.freeze(['llm', 'random', 'none', 'oracle']);

function cli(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map(value => {
    const [key, ...rest] = value.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }));
}
function floatFile(file) {
  const bytes = fs.readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function rngOf(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function yawOf(fly) { return Math.atan2(fly.mjd.xmat[fly.bid.thorax * 9 + 3], fly.mjd.xmat[fly.bid.thorax * 9]); }
function poseOf(fly) {
  const state = fly.state(), pos = state.pos || [0, 0, 0.13];
  return { agent_id: fly.id ?? 0, t: fly.t, t_ms: fly.t, behavior: fly.behavior(state), energy: fly.energy,
    pos: [Number(pos[0]), Number(pos[1]), Number(pos[2] ?? 0.13)], yaw: yawOf(fly), flying: Boolean(fly.flight?.active),
    alive: Boolean(fly.alive), cmd: fly.cmd, nm: fly.neuromod?.readout?.() };
}
function ensureFoodCounters(fly, count) {
  const old = Array.from(fly.foodEaten || []);
  fly.foodEaten = Array.from({ length: count }, (_, index) => old[index] || 0);
}
function requestOf({ env, terminal, pose, brainState, recentBehaviors }) {
  return validateEventPayload({
    event: 'request', t_ms: pose.t_ms, agent_id: pose.agent_id, terminal_id: terminal.id,
    request_kind: terminal.kind, request_text: terminal.request, state: {
      behavior: pose.behavior, energy: pose.energy, pos: pose.pos, yaw: pose.yaw, flying: pose.flying,
    }, recent_behaviors: recentBehaviors.slice(-5), state_table: brainState?.state_table || interpretBrainState([], pose).state_table,
    arena: { pose: { x: pose.pos[0], y: pose.pos[1], yaw: pose.yaw }, items: arenaItems(env) },
  });
}
async function awaitTask(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([task.promise, new Promise((_, reject) => {
      timer = setTimeout(() => { task.terminate?.(); reject(new Error('ollama timeout')); }, timeoutMs);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
export async function chooseAction(condition, request, random, options = {}) {
  if (condition === 'none') return { action: nothingAction(), text: 'none / 操作なし' };
  if (condition === 'oracle') return { action: validateArenaAction({ tool: 'place_sugar', near: 'fly', distance: 0.3, amount: 2 }), text: 'oracle / 上限対照' };
  if (condition === 'random') return { action: randomToolAction(request, random), text: 'random / ランダム制御' };
  const task = createOllamaTask({ prompt: buildPrompt(request), model: options.model || DEFAULT_OLLAMA_MODEL, fetchImpl: options.fetchImpl || fetch });
  try { return parseToolReply(await awaitTask(task, options.timeoutMs || 30_000)); }
  catch (error) { return { action: nothingAction(), text: 'llm error', error: String(error.message) }; }
}
function brainStateOf(meter, narrator, pose, fly) {
  narrator.ingest(meter.read(fly.brain.spikeCount, fly.t), fly.t);
  narrator.brainState = interpretBrainState(narrator.snapshot().signals, pose, narrator.brainState);
  return narrator.brainState;
}

export async function runOne({ condition, seed, seconds, sampleMs = 20, vision = true, llmTimeoutMs = 30_000, model }) {
  const D = loadAll(), data = { ...D, superclass: D.sc, bodymap: D.bodymap };
  const size = floatFile(path.join(ROOT, 'public/data/neuron_size.bin')), sign = floatFile(path.join(ROOT, 'public/data/ntsign.bin'));
  const gait = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/body/gait.json')));
  const flyXML = fs.readFileSync(path.join(ROOT, 'public/body/fly_physics.xml'), 'utf8');
  const calibFile = path.join(ROOT, 'public/data/brain_params.json');
  const calib = fs.existsSync(calibFile) ? JSON.parse(fs.readFileSync(calibFile)) : { wSyn: 0.4 };
  const wasmBytes = fs.readFileSync(path.join(ROOT, 'public/lif.wasm'));
  let visionModel = null, flyvis = null;
  if (vision) {
    const bin = fs.readFileSync(path.join(ROOT, 'public/vision/flyvis.bin'));
    visionModel = { model: parseFlyVis(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
      JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis.json'))), JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis_inputs.json')))),
      map: JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis_map.json'))) };
  }
  const brainOpts = { ...calib, gpu: false }, memory = allocBrainMemory(data, size, sign, brainOpts, 1, visionModel);
  const brain = await attachBrain(wasmBytes, memory, 0, data, 7 + Number(seed));
  if (visionModel) flyvis = { eyes: attachEyes(brain.instance, memory, 0), map: visionModel.map, gain: 150 };
  let env = structuredClone(PRESETS.agents.env());
  const mj = await loadMujoco();
  const fly = new FlyAgent({ mj, flyXML, env, data, size, sign, bodymap: D.bodymap, gait, id: 0, seed: Number(seed),
    pos: PRESETS.agents.start.slice(0, 2), yaw: PRESETS.agents.start[2], mode: 'descending', brainOpts, vision, brain, flyvis, neuromod: loadNeuromod() });
  const detector = new EventDetector({ terminals: env.agents });
  const narrator = new NeuralNarrator({ agentId: 0, intervalMs: 1, quietMs: 1 });
  const meter = new GroupMeter(buildGroups(D.bodymap, D.meta.types, D.side), D.N);
  const random = rngOf(Number(seed) * 1009 + condition.length * 97);
  const terminalVisitsByKind = Object.fromEntries(env.agents.map(agent => [agent.kind, 0]));
  const touches = [];
  const actionCounts = {}, llmErrors = [], energyTrajectory = [{ t: 0, energy: fly.energy }];
  let brainState = null, lastSample = -Infinity, nextEnergy = 1000, firstMeal = null, recentBehaviors = [];
  const steps = Math.max(1, Math.round(Number(seconds) * 1000));
  try {
    for (let step = 1; step <= steps; step += 1) {
      fly.step();
      const pose = poseOf(fly);
      if (firstMeal === null && (fly.eaten > 0 || pose.behavior === 'feeding')) firstMeal = fly.t / 1000;
      while (fly.t >= nextEnergy) { energyTrajectory.push({ t: nextEnergy / 1000, energy: fly.energy }); nextEnergy += 1000; }
      if (fly.t - lastSample < sampleMs && step !== steps) continue;
      lastSample = fly.t;
      recentBehaviors = recentBehaviors.filter(label => label !== pose.behavior);
      if (pose.behavior) recentBehaviors.push(pose.behavior);
      recentBehaviors = recentBehaviors.slice(-5);
      brainState = brainStateOf(meter, narrator, pose, fly);
      const expired = applyArenaAction(env, nothingAction(), { nowMs: fly.t });
      if (expired.changed) { env = expired.env; fly.env = env; ensureFoodCounters(fly, env.food.length); }
      for (const event of detector.feed(pose)) {
        if (event.event !== 'touched_agent') continue;
        const terminal = env.agents.find(item => String(item.id) === String(event.terminal_id));
        if (!terminal) continue;
        terminalVisitsByKind[terminal.kind] = (terminalVisitsByKind[terminal.kind] || 0) + 1;
        touches.push({ t: fly.t / 1000, terminal_id: terminal.id, kind: terminal.kind, pose: { x: pose.pos[0], y: pose.pos[1], yaw: pose.yaw } });
        const reply = await chooseAction(condition, requestOf({ env, terminal, pose, brainState, recentBehaviors }), random, { model, timeoutMs: llmTimeoutMs });
        const tool = reply.action?.tool || 'nothing'; actionCounts[tool] = (actionCounts[tool] || 0) + 1;
        if (reply.error) llmErrors.push({ t: fly.t / 1000, message: reply.error });
        const applied = applyArenaAction(env, reply.action, { pose, terminals: env.agents, terminalId: terminal.id, nowMs: fly.t });
        env = applied.env; fly.env = env; ensureFoodCounters(fly, env.food.length);
      }
    }
    if (energyTrajectory.at(-1)?.t !== Math.floor(fly.t / 1000)) energyTrajectory.push({ t: fly.t / 1000, energy: fly.energy });
    return { condition, seed: Number(seed), simulatedSeconds: Number(seconds), foodEaten: Number(fly.eaten), energyTrajectory,
      minEnergy: Math.min(fly.energy, ...energyTrajectory.map(row => row.energy)), aliveAtEnd: Boolean(fly.alive),
      terminalVisitsByKind, touches, actionCounts, actionTotal: Object.values(actionCounts).reduce((a, b) => a + b, 0),
      timeToFirstMeal: firstMeal, llmErrors, finalEnergy: fly.energy };
  } finally { fly.dispose(); }
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function sd(values) { if (values.length < 2) return 0; const m = mean(values); return Math.sqrt(mean(values.map(value => (value - m) ** 2))); }
function metric(row, name) { if (name === 'aliveAtEnd') return row.aliveAtEnd ? 1 : 0; if (name === 'timeToFirstMeal') return row.timeToFirstMeal ?? row.simulatedSeconds; return Number(row[name] ?? 0); }
export function summarise(rows) {
  const by = Object.fromEntries([...new Set(rows.map(row => row.condition))].map(condition => [condition, rows.filter(row => row.condition === condition)]));
  const metrics = ['foodEaten', 'minEnergy', 'aliveAtEnd', 'timeToFirstMeal', 'actionTotal'];
  const table = Object.entries(by).map(([condition, group]) => ({ condition, ...Object.fromEntries(metrics.map(name => [name, { mean: mean(group.map(row => metric(row, name))), sd: sd(group.map(row => metric(row, name))) }])),
    visitsByKind: Object.fromEntries([...new Set(group.flatMap(row => Object.keys(row.terminalVisitsByKind)))].map(kind => [kind, mean(group.map(row => row.terminalVisitsByKind[kind] || 0))])) }));
  const comparisons = {};
  for (const other of ['random', 'none']) {
    const pairs = (by.llm || []).map(row => [row, (by[other] || []).find(candidate => candidate.seed === row.seed)]).filter(pair => pair[1]);
    comparisons[`llm_vs_${other}`] = Object.fromEntries(metrics.map(name => [name, { n: pairs.length, meanDelta: mean(pairs.map(([a, b]) => metric(a, name) - metric(b, name))) }]));
  }
  return { n: rows.length, table, comparisons };
}
function tableText(summary) {
  const lines = ['condition | food eaten mean±sd | min energy mean±sd | alive mean±sd | first meal s mean±sd | actions mean±sd', '---|---:|---:|---:|---:|---:'];
  for (const row of summary.table) lines.push(`${row.condition} | ${row.foodEaten.mean.toFixed(4)} ± ${row.foodEaten.sd.toFixed(4)} | ${row.minEnergy.mean.toFixed(4)} ± ${row.minEnergy.sd.toFixed(4)} | ${row.aliveAtEnd.mean.toFixed(3)} ± ${row.aliveAtEnd.sd.toFixed(3)} | ${row.timeToFirstMeal.mean.toFixed(2)} ± ${row.timeToFirstMeal.sd.toFixed(2)} | ${row.actionTotal.mean.toFixed(2)} ± ${row.actionTotal.sd.toFixed(2)}`);
  for (const [name, values] of Object.entries(summary.comparisons)) lines.push(`\n${name}: foodEaten Δ=${values.foodEaten.meanDelta.toFixed(4)}, minEnergy Δ=${values.minEnergy.meanDelta.toFixed(4)}, firstMeal Δ=${values.timeToFirstMeal.meanDelta.toFixed(2)} (n=${values.foodEaten.n})`);
  return lines.join('\n');
}
function runJobs(jobs, workers) {
  return new Promise((resolve, reject) => {
    const results = new Array(jobs.length); let next = 0, done = 0, failed = false;
    const launch = () => {
      if (failed || next >= jobs.length) return;
      const index = next++, child = fork(fileURLToPath(import.meta.url), { cwd: ROOT, env: { ...process.env, BASELINE_WORKER: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      child.once('error', error => { if (!failed) { failed = true; reject(error); } });
      child.on('message', message => {
        if (message.error) { failed = true; reject(new Error(message.error)); child.kill(); return; }
        results[index] = message.result; done += 1; child.disconnect?.(); child.kill();
        if (done === jobs.length) resolve(results); else launch();
      });
      child.send(jobs[index]);
    };
    for (let i = 0; i < Math.min(workers, jobs.length); i += 1) launch();
  });
}
async function main() {
  const args = cli(), pilot = args.pilot === 'true', flies = Number(args.flies || (pilot ? 2 : 8)), seconds = Number(args.seconds || 60);
  const workers = Math.max(1, Math.min(Number(args.workers || 4), 8));
  const conditions = String(args.conditions || CONDITIONS.join(',')).split(',').filter(condition => CONDITIONS.includes(condition));
  const sampleMs = Math.max(1, Number(args['sample-ms'] || 20)), vision = !['0', 'false', 'off'].includes(String(args.vision || '1').toLowerCase());
  const jobs = conditions.flatMap(condition => Array.from({ length: flies }, (_, index) => ({ condition, seed: index + 1, seconds, sampleMs, vision, llmTimeoutMs: Number(args['llm-timeout-ms'] || 30000), model: args.model || DEFAULT_OLLAMA_MODEL })));
  const started = Date.now(); console.log(`${pilot ? 'PILOT' : 'BASELINE'}: ${jobs.length} flies, T=${seconds}s, conditions=${conditions.join(',')}, workers=${Math.min(workers, jobs.length)}, vision=${vision ? 'ON' : 'OFF'}`);
  const rows = await runJobs(jobs, workers), summary = summarise(rows), out = args.out || path.join(ROOT, 'scratch/experiment-baseline.jsonl');
  await fsPromises.mkdir(path.dirname(out), { recursive: true }); await fsPromises.writeFile(out, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const summaryPath = args.summary || out.replace(/\.jsonl$/i, '.summary.md');
  await fsPromises.writeFile(summaryPath, `# ベースライン実験\n\n${tableText(summary)}\n\nwall time: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  console.log(tableText(summary)); console.log(`JSONL ${out}\nSUMMARY ${summaryPath}\nWALL ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
if (process.env.BASELINE_WORKER === '1') {
  process.on('message', async job => { try { process.send?.({ result: await runOne(job) }); } catch (error) { process.send?.({ error: error?.stack || String(error) }); } });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
