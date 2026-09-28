// Pure scheduling and payload helpers for the read-only brain-computer interface.
// The fly is never modified here: the module only selects a decoded state and
// translates a caretaker command into the existing environment-device contract.
import { BCI_ACTION_DISTANCE_MIN, BCI_ACTION_DISTANCE_MAX, BCI_SIDES, validateBciAction } from './arenaTools.js';

export const BCI_MIN_GAP_MS = 5_000;
export const BCI_MAX_GAP_MS = 20_000;

const tableSignature = table => (table || []).map(item => `${item.fact}=${item.value}`).join('|');

export function changedFacts(previous, current) {
  if (!previous) return (current || []).map(item => item.fact);
  const old = new Map(previous.map(item => [item.fact, item.value]));
  return (current || []).filter(item => old.get(item.fact) !== item.value).map(item => item.fact);
}

/**
 * Make a fixed decision schedule from the no-agent decoder trace. A state change
 * is eligible after five simulated seconds; an unchanged state is still sent at
 * least every twenty simulated seconds.
 */
export function buildBciDecisionTimeline(samples, { minGapMs = BCI_MIN_GAP_MS, maxGapMs = BCI_MAX_GAP_MS } = {}) {
  const decisions = [];
  let lastAt = -Infinity;
  let lastSignature = null;
  for (const sample of samples || []) {
    if (!sample || !Number.isFinite(sample.t_ms) || !Array.isArray(sample.state_table)) continue;
    const signature = sample.signature || tableSignature(sample.state_table);
    const changed = lastSignature === null || signature !== lastSignature;
    const due = decisions.length === 0 || sample.t_ms - lastAt >= maxGapMs || (changed && sample.t_ms - lastAt >= minGapMs);
    if (!due) continue;
    decisions.push({ t_ms: sample.t_ms, state_table: sample.state_table, signature, changed: decisions.length ? changedFacts(decisions.at(-1).state_table, sample.state_table) : sample.state_table.map(item => item.fact) });
    lastAt = sample.t_ms;
    lastSignature = signature;
  }
  return decisions;
}

/** Return the recorded decoder state at the same simulated time (last sample <= t). */
export function stateAtTimeline(timeline, tMs) {
  if (!timeline?.length) return null;
  let best = timeline[0];
  for (const sample of timeline) {
    if (sample.t_ms > tMs) break;
    best = sample;
  }
  return best;
}

export function hungerAtLeastLittle(stateTable) {
  const value = stateTable?.find(item => item.fact === '空腹')?.value;
  return value === '少し' || value === '強い';
}

export function buildBciPayload({ agentId = 0, tMs, stateTable, changed = [], lastActions = [] }) {
  return {
    event: 'bci', agent_id: agentId, t_ms: Number(tMs),
    state_table: stateTable,
    changed: [...changed],
    last_actions: lastActions.slice(-3).map(action => validateBciAction(action)),
  };
}

export function bciActionSchemaDescription() {
  return {
    place_sugar: { near: 'fly', distance: `${BCI_ACTION_DISTANCE_MIN}..${BCI_ACTION_DISTANCE_MAX}`, amount: '0..2' },
    place_odor: { near: 'fly', side: BCI_SIDES, odor: ['banana', 'vinegar'], strength: '0..1', sigma: '0..1.2', ttl: '1..30000' },
    remove_bitter: { near: 'fly', radius: '0..0.5' },
    nothing: {},
  };
}
