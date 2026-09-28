import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEventPayload } from '../bridge-server/src/validation.mjs';
import { applyBciAction, BCI_ODOR_DISTANCE, validateBciAction } from '../src/agents/arenaTools.js';
import { buildBciDecisionTimeline, stateAtTimeline } from '../src/agents/bci.js';
import vocab from '../src/agents/brainStateVocab.json' with { type: 'json' };

const stateTable = Object.entries(vocab.facts).map(([fact, values]) => ({ fact, value: values[0] }));
const pose = { pos: [0.2, 0.2, 0.13], yaw: 0 };

test('bci request validation accepts only the complete vocabulary state table and three prior actions', () => {
  const clean = validateEventPayload({ event: 'bci', agent_id: 2, t_ms: 5000, state_table: stateTable, changed: ['空腹'], last_actions: [{ tool: 'place_sugar', near: 'fly', distance: 0.45, amount: 1 }] });
  assert.deepEqual(clean.state_table, stateTable);
  assert.deepEqual(clean.last_actions[0], { tool: 'place_sugar', near: 'fly', distance: 0.45, amount: 1 });
  assert.throws(() => validateEventPayload({ event: 'bci', agent_id: 2, t_ms: 5000, state_table: stateTable.slice(1), changed: [], last_actions: [] }), /complete vocabulary/);
  assert.throws(() => validateEventPayload({ event: 'bci', agent_id: 2, t_ms: 5000, state_table: stateTable, changed: [], last_actions: [{ tool: 'place_sugar', near: 'map', distance: 0.45, amount: 1 }] }), /invalid action/);
});

test('bci device resolves pose-free side actions into coordinates near the fly', () => {
  const env = { arena: { radius: 2.5 }, food: [], odors: [], bitterPatches: [] };
  const action = validateBciAction({ tool: 'place_odor', near: 'fly', side: 'left', odor: 'banana', strength: 1, sigma: 0.8, ttl: 1000 });
  const applied = applyBciAction(env, action, { pose, nowMs: 10 });
  assert.ok(Math.abs(applied.env.odors[0].x - 0.2) < 1e-9);
  assert.ok(Math.abs(applied.env.odors[0].y - (0.2 + BCI_ODOR_DISTANCE)) < 1e-9);
  assert.equal(applied.env.odors[0].agentPlaced, true);
  const sugar = applyBciAction(env, { tool: 'place_sugar', near: 'fly', distance: 0.3, amount: 2 }, { pose, nowMs: 20 });
  assert.ok(Math.abs(sugar.env.food[0].x - 0.5) < 1e-9);
});

test('yoked timeline selects the other seed state at the same simulated time', () => {
  const a = [{ t_ms: 1, state_table: stateTable, signature: 'a' }, { t_ms: 20_001, state_table: stateTable.map((x, i) => i ? x : { ...x, value: vocab.facts[x.fact][1] }), signature: 'b' }];
  const schedule = buildBciDecisionTimeline(a);
  assert.deepEqual(schedule.map(row => row.t_ms), [1, 20_001]);
  assert.equal(stateAtTimeline(a, 20_000).signature, 'a');
  assert.equal(stateAtTimeline(a, 20_001).signature, 'b');
});

test('tracking compares sugar placements when truly strongly hungry vs not, and Fisher is exact', async () => {
  const { trackingOf, fisherExact } = await import('../scripts/experiment_bci.mjs');
  const ep = (hunger, tool) => ({ real_state_table: [{ fact: '空腹', value: hunger }], action: { tool } });
  const t = trackingOf([ep('強い', 'place_sugar'), ep('強い', 'place_sugar'), ep('強い', 'nothing'), ep('少し', 'nothing'), ep('少し', 'place_sugar')]);
  assert.equal(t.n_strong, 3); assert.equal(t.sugar_strong_count, 2); assert.equal(t.sugar_other_count, 1);
  assert.ok(Math.abs(t.tracking - (2 / 3 - 1 / 2)) < 1e-12);
  assert.ok(Math.abs(fisherExact(8, 2, 1, 9) - 0.00548) < 1e-4);
  assert.ok(Math.abs(fisherExact(1, 1, 1, 1) - 1) < 1e-9);
});

test('Wilcoxon signed-rank is two-sided exact without double counting', async () => {
  const { wilcoxonSignedRank } = await import('../scripts/experiment_bci.mjs');
  assert.ok(Math.abs(wilcoxonSignedRank([0.4, 0.5, 0.6, 0.7, 0.8]).p - 2 / 32) < 1e-12);   // all positive, n=5
  assert.equal(wilcoxonSignedRank([1, -1]).p, 1);
});
