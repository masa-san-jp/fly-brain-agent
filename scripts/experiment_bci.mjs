// Read-only brain-computer-interface experiment.
// The fly/connectome imports are unchanged. The only interventions are device
// actions applied to the cloned environment between fly.step() calls.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
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
import { interpretBrainState, NeuralNarrator } from '../src/agents/NeuralNarrator.js';
import { applyBciAction, nothingAction, validateBciAction } from '../src/agents/arenaTools.js';
import { buildBciDecisionTimeline, buildBciPayload, changedFacts, hungerAtLeastLittle, stateAtTimeline } from '../src/agents/bci.js';
import { buildPrompt } from '../bridge-server/src/prompt.mjs';
import { parseToolReply } from '../bridge-server/src/server.mjs';
import { createOllamaTask } from '../bridge-server/src/backends.mjs';
// gemma4:e4b said 「餌を置きました」 while returning nothing; gemma4:26b chose consistently in a 4-case check (~2 s warm).
const DEFAULT_OLLAMA_MODEL = 'gemma4:26b';
import { validateEventPayload } from '../bridge-server/src/validation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONDITIONS = Object.freeze(['real', 'shuffled', 'none', 'rule-real']);

function cli(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map(value => { const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=') || 'true']; }));
}
function floatFile(file) { const bytes = fs.readFileSync(file); return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
function poseOf(fly) {
  const state = fly.state(), pos = state.pos || [0, 0, 0.13];
  return { agent_id: fly.id ?? 0, t_ms: fly.t, behavior: fly.behavior(state), energy: fly.energy, pos: pos.map(Number), yaw: Math.atan2(fly.mjd.xmat[fly.bid.thorax * 9 + 3], fly.mjd.xmat[fly.bid.thorax * 9]), flying: Boolean(fly.flight?.active), alive: Boolean(fly.alive), cmd: fly.cmd, nm: fly.neuromod?.readout?.() };
}
function ensureFoodCounters(fly, count) {
  const old = Array.from(fly.foodEaten || []);
  fly.foodEaten = Array.from({ length: count }, (_, index) => old[index] || 0);
}
function tableCopy(table) { return (table || []).map(item => ({ fact: item.fact, value: item.value })); }
function brainStateOf(meter, narrator, pose, fly) {
  narrator.ingest(meter.read(fly.brain.spikeCount, fly.t), fly.t);
  narrator.brainState = interpretBrainState(narrator.snapshot().signals, pose, narrator.brainState);
  return narrator.brainState;
}
function actionCounts(rows) {
  const counts = {};
  for (const row of rows) for (const episode of row.episodes || []) counts[episode.action?.tool || 'nothing'] = (counts[episode.action?.tool || 'nothing'] || 0) + 1;
  return counts;
}
async function awaitTask(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([task.promise, new Promise((_, reject) => { timer = setTimeout(() => { task.terminate?.(); reject(new Error('ollama timeout')); }, timeoutMs); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}
export async function chooseBciAction(condition, payload, options = {}) {
  if (condition === 'none') return { action: nothingAction(), text: 'none / 操作なし' };
  // Reference policy on the same endpoint as the primary metric: sugar only when strongly hungry
  // (「少し」 is decoded almost all the time, so a ≥少し rule would place sugar at every call).
  if (condition === 'rule-real') return payload.state_table?.find(item => item.fact === '空腹')?.value === '強い'
    ? { action: validateBciAction({ tool: 'place_sugar', near: 'fly', distance: 0.45, amount: 2 }), text: '強い空腹なので正面に砂糖を置く / strongly hungry → sugar ahead' }
    : { action: nothingAction(), text: '必要な操作なし / no action' };
  const task = createOllamaTask({ prompt: buildPrompt(payload), model: options.model || DEFAULT_OLLAMA_MODEL, fetchImpl: options.fetchImpl || fetch });
  try { return parseToolReply(await awaitTask(task, options.timeoutMs || 30_000), { event: 'bci' }); }
  catch (error) { return { action: nothingAction(), text: 'llm error / LLMエラー', error: String(error.message) }; }
}

function outcomeFor(episode, trajectory, finalT) {
  const baselineEaten = episode.food_eaten;
  const endT = episode.t_ms + 20_000;
  const endSample = trajectory.findLast?.(sample => sample.t_ms >= endT) || trajectory.filter(sample => sample.t_ms <= endT).at(-1) || trajectory.at(-1);
  const feedSample = trajectory.find(sample => sample.t_ms > episode.t_ms && sample.t_ms <= endT && sample.eaten > baselineEaten + 1e-9);
  return {
    energy_change_20s: Number((endSample?.energy ?? episode.energy) - episode.energy),
    fed_within_20s: Boolean(feedSample),
    time_to_feed_s: feedSample ? (feedSample.t_ms - episode.t_ms) / 1000 : null,
    outcome_complete: finalT >= endT,
  };
}

export async function runOne({ condition, seed, seconds, sampleMs = 20, vision = true, llmTimeoutMs = 30_000, model, decisionTimeline = null, yokedTimeline = null }) {
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
    visionModel = { model: parseFlyVis(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis.json'))), JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis_inputs.json')))), map: JSON.parse(fs.readFileSync(path.join(ROOT, 'public/vision/flyvis_map.json'))) };
  }
  const brainOpts = { ...calib, gpu: false }, memory = allocBrainMemory(data, size, sign, brainOpts, 1, visionModel);
  const brain = await attachBrain(wasmBytes, memory, 0, data, 7 + Number(seed));
  if (visionModel) flyvis = { eyes: attachEyes(brain.instance, memory, 0), map: visionModel.map, gain: 150 };
  let env = structuredClone(PRESETS.bci.env());
  const mj = await loadMujoco();
  const fly = new FlyAgent({ mj, flyXML, env, data, size, sign, bodymap: D.bodymap, gait, id: 0, seed: Number(seed), pos: PRESETS.bci.start.slice(0, 2), yaw: PRESETS.bci.start[2], mode: 'descending', brainOpts, vision, brain, flyvis, neuromod: loadNeuromod() });
  const narrator = new NeuralNarrator({ agentId: 0, intervalMs: 1, quietMs: 1 });
  const meter = new GroupMeter(buildGroups(D.bodymap, D.meta.types, D.side), D.N);
  const samples = [], trajectory = [{ t_ms: 0, energy: fly.energy, eaten: 0, alive: true, behavior: 'standing' }], episodes = [];
  const actionHistory = [];
  let brainState = null, lastSample = -Infinity, lastPresented = null, scheduleIndex = 0;
  const steps = Math.max(1, Math.round(Number(seconds) * 1000));
  try {
    for (let step = 1; step <= steps; step += 1) {
      fly.step();
      for (const food of env.food) if (food.agentId) food.amount = food.maxAmount ?? food.initialAmount ?? food.amount;
      const pose = poseOf(fly);
      if (fly.t - lastSample < sampleMs && step !== steps) continue;
      lastSample = fly.t;
      brainState = brainStateOf(meter, narrator, pose, fly);
      samples.push({ t_ms: fly.t, state_table: tableCopy(brainState.state_table), signature: brainState.signature, changed: [...brainState.changed] });
      trajectory.push({ t_ms: fly.t, energy: fly.energy, eaten: fly.eaten, alive: fly.alive, behavior: pose.behavior });
      if (condition === 'none') continue;
      while (decisionTimeline && scheduleIndex < decisionTimeline.length && fly.t >= decisionTimeline[scheduleIndex].t_ms) {
        const scheduled = decisionTimeline[scheduleIndex++];
        const realTable = tableCopy(brainState.state_table);
        const yoked = condition === 'shuffled' ? stateAtTimeline(yokedTimeline, scheduled.t_ms) : null;
        const presentedTable = tableCopy(yoked?.state_table || realTable);
        const changed = changedFacts(lastPresented, presentedTable);
        const payload = validateEventPayload(buildBciPayload({ agentId: Number(seed), tMs: fly.t, stateTable: presentedTable, changed, lastActions: actionHistory }));
        const reply = await chooseBciAction(condition, payload, { model, timeoutMs: llmTimeoutMs });
        const action = validateBciAction(reply.action);
        const episode = { t_ms: fly.t, scheduled_t_ms: scheduled.t_ms, real_state_table: realTable, presented_state_table: presentedTable,
          real_hungry: hungerAtLeastLittle(realTable), changed, last_actions: actionHistory.slice(-3), action, action_text: reply.text,
          llm_error: reply.error || null, energy: fly.energy, food_eaten: fly.eaten };
        episodes.push(episode);
        const applied = applyBciAction(env, action, { pose, nowMs: fly.t });
        env = applied.env; fly.env = env; ensureFoodCounters(fly, env.food.length);
        actionHistory.push(action); actionHistory.splice(0, Math.max(0, actionHistory.length - 3));
        lastPresented = presentedTable;
      }
    }
    if (condition === 'none') {
      const baseSchedule = decisionTimeline || buildBciDecisionTimeline(samples);
      for (const scheduled of baseSchedule) {
        const sample = stateAtTimeline(samples, scheduled.t_ms) || scheduled;
        episodes.push({ t_ms: scheduled.t_ms, scheduled_t_ms: scheduled.t_ms, real_state_table: tableCopy(sample.state_table), presented_state_table: tableCopy(sample.state_table), real_hungry: hungerAtLeastLittle(sample.state_table), changed: scheduled.changed, last_actions: [], action: nothingAction(), action_text: 'none / 操作なし', llm_error: null, energy: trajectory.findLast?.(x => x.t_ms <= scheduled.t_ms)?.energy ?? fly.energy, food_eaten: trajectory.findLast?.(x => x.t_ms <= scheduled.t_ms)?.eaten ?? 0 });
      }
    }
    const finalT = fly.t;
    for (const episode of episodes) Object.assign(episode, { outcome: outcomeFor(episode, trajectory, finalT) });
    const completed = episodes.filter(episode => episode.outcome.outcome_complete);
    const hungry = episodes.filter(episode => episode.real_hungry);
    return { condition, seed: Number(seed), simulated_seconds: Number(seconds), decision_count: episodes.length, decoder_timeline: condition === 'none' ? samples : undefined,
      decision_timeline: episodes.map(({ t_ms, scheduled_t_ms, real_state_table, presented_state_table, real_hungry, changed, action, outcome }) => ({ t_ms, scheduled_t_ms, real_state_table, presented_state_table, real_hungry, changed, action, outcome })),
      episodes, food_eaten: Number(fly.eaten), min_energy: Math.min(fly.energy, ...trajectory.map(row => row.energy)), final_energy: fly.energy,
      alive_at_end: Boolean(fly.alive), action_counts: Object.fromEntries(Object.entries(episodes.reduce((out, episode) => { const tool = episode.action?.tool || 'nothing'; out[tool] = (out[tool] || 0) + 1; return out; }, {}))), action_total: condition === 'none' ? 0 : episodes.length,
      completed_episodes: completed.length, hungry_episodes: hungry.length, llm_errors: episodes.filter(episode => episode.llm_error).map(episode => ({ t_ms: episode.t_ms, message: episode.llm_error })),
      time_to_first_feed_s: trajectory.find(row => row.eaten > 0) ? trajectory.find(row => row.eaten > 0).t_ms / 1000 : null };
  } finally { fly.dispose(); }
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function sd(values) { if (values.length < 2) return 0; const m = mean(values); return Math.sqrt(mean(values.map(value => (value - m) ** 2))); }
function ranks(values) {
  const indexed = values.map((value, index) => ({ value: Math.abs(value), index })).sort((a, b) => a.value - b.value); const out = Array(values.length); let i = 0;
  while (i < indexed.length) { let j = i + 1; while (j < indexed.length && indexed[j].value === indexed[i].value) j++; const rank = (i + 1 + j) / 2; for (; i < j; i++) out[indexed[i].index] = rank; }
  return out;
}
export function wilcoxonSignedRank(values) {
  const nonzero = values.filter(value => value !== 0); if (!nonzero.length) return { n: 0, statistic: 0, p: 1 };
  const rs = ranks(nonzero), positive = rs.reduce((sum, rank, i) => sum + (nonzero[i] > 0 ? rank : 0), 0), total = rs.reduce((a, b) => a + b, 0), statistic = Math.min(positive, total - positive);
  if (nonzero.length > 20) return { n: nonzero.length, statistic, p: null };
  let extreme = 0, cases = 1 << nonzero.length;
  for (let mask = 0; mask < cases; mask++) { let plus = 0; for (let i = 0; i < rs.length; i++) if (mask & (1 << i)) plus += rs[i]; if (Math.min(plus, total - plus) <= statistic + 1e-9) extreme++; }
  // min(W+, W−) ≤ observed already counts both tails, so this is the two-sided p (no doubling).
  return { n: nonzero.length, statistic, p: Math.min(1, extreme / cases) };
}
// Primary endpoint: does the agent's behaviour track the fly's TRUE decoded state?
// tracking = P(sugar | true 空腹=強い) − P(sugar | true 空腹≠強い). A read of the fly's own brain
// should track it; a read of another fly's brain (shuffled) should not. Independent of what
// the fly does next, so chaotic divergence does not dilute it.
const strongHunger = table => table?.find(item => item.fact === '空腹')?.value === '強い';
const placedSugar = episode => episode.action?.tool === 'place_sugar';
export function trackingOf(episodes) {
  const strong = episodes.filter(e => strongHunger(e.real_state_table)), other = episodes.filter(e => !strongHunger(e.real_state_table));
  const rate = list => list.length ? mean(list.map(e => placedSugar(e) ? 1 : 0)) : null;
  const a = rate(strong), b = rate(other);
  return { n_strong: strong.length, n_other: other.length, sugar_if_strong: a, sugar_if_other: b,
    sugar_strong_count: strong.filter(placedSugar).length, sugar_other_count: other.filter(placedSugar).length,
    tracking: a === null || b === null ? null : a - b };
}
function comb(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
/** Two-sided Fisher exact test on [[a, b], [c, d]]. */
export function fisherExact(a, b, c, d) {
  const r1 = a + b, c1 = a + c, n = a + b + c + d, p = x => comb(r1, x) * comb(n - r1, c1 - x) / comb(n, c1), p0 = p(a);
  let total = 0; for (let x = Math.max(0, c1 - (n - r1)); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-9)) total += px; }
  return Math.min(1, total);
}
function pairedMetric(rows, name) {
  const real = new Map(rows.filter(row => row.condition === 'real').map(row => [row.seed, row])); const shuffled = new Map(rows.filter(row => row.condition === 'shuffled').map(row => [row.seed, row]));
  const pairs = [...real.keys()].filter(seed => shuffled.has(seed)).map(seed => [real.get(seed), shuffled.get(seed)]);
  const metric = (row) => name === 'tracking' ? trackingOf(row.episodes).tracking : name === 'food_eaten' ? row.food_eaten : row.episodes.filter(e => e.real_hungry && e.outcome.outcome_complete).length ? mean(row.episodes.filter(e => e.real_hungry && e.outcome.outcome_complete).map(e => e.outcome.fed_within_20s ? 1 : 0)) : null;
  const values = pairs.map(([a, b]) => [metric(a), metric(b)]).filter(([a, b]) => a !== null && b !== null);
  const deltas = values.map(([a, b]) => a - b);
  return { n: values.length, real_mean: mean(values.map(v => v[0])), shuffled_mean: mean(values.map(v => v[1])), mean_delta: mean(deltas), wilcoxon: wilcoxonSignedRank(deltas) };
}
export function summarise(rows) {
  const by = Object.fromEntries(CONDITIONS.map(condition => [condition, rows.filter(row => row.condition === condition)]));
  const table = CONDITIONS.map(condition => { const group = by[condition]; const hungry = group.flatMap(row => row.episodes.filter(e => e.real_hungry && e.outcome.outcome_complete)); return { condition, n: group.length, decision_mean: mean(group.map(row => row.decision_count)), food_eaten: { mean: mean(group.map(row => row.food_eaten)), sd: sd(group.map(row => row.food_eaten)) }, min_energy: { mean: mean(group.map(row => row.min_energy)), sd: sd(group.map(row => row.min_energy)) }, hungry_fed_within_20s: { n: hungry.length, fraction: hungry.length ? mean(hungry.map(e => e.outcome.fed_within_20s ? 1 : 0)) : null }, alive: mean(group.map(row => row.alive_at_end ? 1 : 0)), action_counts: actionCounts(group) }; });
  const alignment = Object.fromEntries(CONDITIONS.map(condition => { const episodes = by[condition].flatMap(row => row.episodes); const hungry = episodes.filter(e => e.real_hungry); const notHungry = episodes.filter(e => !e.real_hungry); return [condition, { hungry: actionCounts([{ episodes: hungry }]), not_hungry: actionCounts([{ episodes: notHungry }]) }]; }));
  const tracking = Object.fromEntries(CONDITIONS.map(condition => [condition, trackingOf(by[condition].flatMap(row => row.episodes))]));
  const tr = tracking.real, ts = tracking.shuffled;
  const trackingTest = tr && ts ? { real_strong: fisherExact(tr.sugar_strong_count, tr.n_strong - tr.sugar_strong_count, tr.sugar_other_count, tr.n_other - tr.sugar_other_count),
    shuffled_strong: fisherExact(ts.sugar_strong_count, ts.n_strong - ts.sugar_strong_count, ts.sugar_other_count, ts.n_other - ts.sugar_other_count) } : null;
  return { n: rows.length, table, tracking, tracking_fisher_p: trackingTest, tracking_paired: pairedMetric(rows, 'tracking'), primary: { episode_level: Object.fromEntries(['real', 'shuffled'].map(condition => { const episodes = by[condition].flatMap(row => row.episodes.filter(e => e.real_hungry && e.outcome.outcome_complete)); return [condition, { n: episodes.length, fraction_fed_within_20s: episodes.length ? mean(episodes.map(e => e.outcome.fed_within_20s ? 1 : 0)) : null }]; })), per_fly: { real_vs_shuffled: pairedMetric(rows, 'hungry_fed') } }, secondary: { food_eaten_real_vs_shuffled: pairedMetric(rows, 'food_eaten') }, alignment };
}
function tableText(summary) {
  const lines = ['condition | runs | decisions/run | food eaten mean±sd | hungry→fed≤20s | alive | actions', '---|---:|---:|---:|---:|---:|---'];
  for (const row of summary.table) lines.push(`${row.condition} | ${row.n} | ${row.decision_mean.toFixed(1)} | ${row.food_eaten.mean.toFixed(4)} ± ${row.food_eaten.sd.toFixed(4)} | ${row.hungry_fed_within_20s.n ? `${(row.hungry_fed_within_20s.fraction * 100).toFixed(1)}% (n=${row.hungry_fed_within_20s.n})` : '–'} | ${row.alive.toFixed(2)} | ${JSON.stringify(row.action_counts)}`);
  lines.push('\n## Primary: does the agent track the fly\'s TRUE brain state?\ncondition | sugar when truly 強い | sugar otherwise | tracking (difference) | Fisher p', '---|---:|---:|---:|---:');
  for (const [condition, t] of Object.entries(summary.tracking)) if (condition !== 'none') lines.push(`${condition} | ${t.sugar_strong_count}/${t.n_strong} (${((t.sugar_if_strong ?? 0) * 100).toFixed(0)}%) | ${t.sugar_other_count}/${t.n_other} (${((t.sugar_if_other ?? 0) * 100).toFixed(0)}%) | ${t.tracking === null ? '–' : t.tracking.toFixed(2)} | ${condition === 'real' ? summary.tracking_fisher_p?.real_strong.toFixed(4) : condition === 'shuffled' ? summary.tracking_fisher_p?.shuffled_strong.toFixed(4) : ''}`);
  lines.push(`per-fly tracking real vs shuffled (paired): Δ=${summary.tracking_paired.mean_delta.toFixed(3)}, n=${summary.tracking_paired.n}, Wilcoxon p=${summary.tracking_paired.wilcoxon.p ?? 'NA'}`);
  lines.push(`\nsecondary pooled hungry→fed≤20s: real ${(summary.primary.episode_level.real.fraction_fed_within_20s ?? 0).toFixed(3)} vs shuffled ${(summary.primary.episode_level.shuffled.fraction_fed_within_20s ?? 0).toFixed(3)}`);
  lines.push(`secondary food eaten paired: Δ=${summary.secondary.food_eaten_real_vs_shuffled.mean_delta.toFixed(4)}, Wilcoxon p=${summary.secondary.food_eaten_real_vs_shuffled.wilcoxon.p ?? 'NA'}`);
  return lines.join('\n');
}

export function runJobs(jobs, workers) {
  return new Promise((resolve, reject) => {
    const results = new Array(jobs.length); let next = 0, done = 0, failed = false;
    const launch = () => {
      if (failed || next >= jobs.length) return;
      const index = next++, child = fork(fileURLToPath(import.meta.url), { cwd: ROOT, env: { ...process.env, BCI_WORKER: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      child.once('error', error => { if (!failed) { failed = true; reject(error); } });
      child.on('message', message => { if (message.error) { failed = true; reject(new Error(message.error)); child.kill(); return; } results[index] = message.result; done += 1; child.disconnect?.(); child.kill(); if (done === jobs.length) resolve(results); else launch(); });
      child.send(jobs[index]);
    };
    for (let i = 0; i < Math.min(workers, jobs.length); i++) launch();
  });
}

async function main() {
  const args = cli(), pilot = args.pilot === 'true', flies = Number(args.flies || (pilot ? 2 : 8)), seconds = Number(args.seconds || 60);
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const workers = Math.max(1, Math.min(Number(args.workers || Math.min(available, 16)), 16));
  const conditions = String(args.conditions || CONDITIONS.join(',')).split(',').filter(condition => CONDITIONS.includes(condition));
  const sampleMs = Math.max(1, Number(args['sample-ms'] || 20)), vision = !['0', 'false', 'off'].includes(String(args.vision || '1').toLowerCase());
  const seeds = Array.from({ length: flies }, (_, index) => index + 1), baseJobs = seeds.map(seed => ({ condition: 'none', seed, seconds, sampleMs, vision, llmTimeoutMs: Number(args['llm-timeout-ms'] || 30_000), model: args.model || DEFAULT_OLLAMA_MODEL }));
  const started = Date.now(); console.log(`BCI none phase: N=${flies}, T=${seconds}s, workers=${Math.min(workers, baseJobs.length)}, vision=${vision ? 'ON' : 'OFF'}`);
  const noneRows = await runJobs(baseJobs, workers), bySeed = new Map(noneRows.map(row => [row.seed, row]));
  const jobs = [];
  for (const condition of conditions) {
    if (condition === 'none') continue;
    for (const seed of seeds) {
      const base = bySeed.get(seed); const otherSeed = seeds[(seeds.indexOf(seed) + 1) % seeds.length];
      jobs.push({ condition, seed, seconds, sampleMs, vision, llmTimeoutMs: Number(args['llm-timeout-ms'] || 30_000), model: args.model || DEFAULT_OLLAMA_MODEL, decisionTimeline: base.decision_timeline, yokedTimeline: condition === 'shuffled' ? bySeed.get(otherSeed).decoder_timeline : null });
    }
  }
  console.log(`BCI action phase: ${jobs.length} runs, workers=${Math.min(workers, jobs.length)}`);
  const actionRows = jobs.length ? await runJobs(jobs, workers) : [];
  const rows = [...noneRows, ...actionRows], summary = summarise(rows), out = args.out || path.join(ROOT, `scratch/experiment-bci-${pilot ? 'pilot' : 'main'}.jsonl`);
  await fsPromises.mkdir(path.dirname(out), { recursive: true }); await fsPromises.writeFile(out, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const summaryPath = args.summary || out.replace(/\.jsonl$/i, '.summary.md');
  await fsPromises.writeFile(summaryPath, `# BCI実験（${pilot ? 'パイロット' : '本実験'}）\n\n${tableText(summary)}\n\nworkers: ${workers} / availableParallelism: ${available}\nwall time: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  console.log(tableText(summary)); console.log(`JSONL ${out}\nSUMMARY ${summaryPath}\nWALL ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.env.BCI_WORKER === '1') process.on('message', async job => { try { process.send?.({ result: await runOne(job) }); } catch (error) { process.send?.({ error: error?.stack || String(error) }); } });
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
