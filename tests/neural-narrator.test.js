import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_STATE_FACTS,
  NeuralNarrator,
  asymmetry,
  interpretBrainState,
  salience,
} from '../src/agents/NeuralNarrator.js';

const state = (overrides = {}) => ({
  agent_id: 4, t_ms: 123, behavior: 'standing', energy: 0.8, pos: [1, 2, 0.13], yaw: 0.4, flying: false, alive: true,
  ...overrides,
});
const signal = (group, salienceValue, asymmetryValue = 0) => ({ group, salience: salienceValue, asymmetry: asymmetryValue });
const quietSignals = [];

test('signal math computes salience and sensory asymmetry', () => {
  assert.equal(salience(12, 10), 2 / 12);
  assert.equal(asymmetry(8, 2), 6 / 11);
  const narrator = new NeuralNarrator({ baselineTauMs: 20_000, shortWindowMs: 2_000 });
  narrator.ingest([10, 10, ...Array(22).fill(0)], 0);
  const snapshot = narrator.ingest([20, 10, ...Array(22).fill(0)], 1_000);
  const smell = snapshot.signals.find(item => item.group === 'smell');
  assert.equal(smell.hz_left, 15);
  assert.equal(smell.hz_right, 10);
  assert.equal(smell.asymmetry, 0.19);
  assert.ok(smell.salience > 0);
});

test('top three are ordered by absolute salience', () => {
  const narrator = new NeuralNarrator();
  narrator.ingest(Array(24).fill(0), 0);
  const snapshot = narrator.ingest([
    0, 0, 10, 10, 20, 20, 50, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ], 1_000);
  assert.deepEqual(snapshot.top, ['loom', 'vision', 'taste']);
});

test('interpretBrainState maps energy and arousal levels to whitelisted facts', () => {
  const noHunger = interpretBrainState([], state({ energy: 0.9, nm: { akh: 0, oa: 2, arousal: 0 } }));
  const little = interpretBrainState([], state({ energy: 0.6, nm: { akh: 0, oa: 2, arousal: 0 } }), noHunger);
  const strong = interpretBrainState([], state({ energy: 0.45, nm: { akh: 0, oa: 2, arousal: 0 } }), little);
  const table = facts => Object.fromEntries(facts.state_table.map(item => [item.fact, item.value]));
  assert.equal(table(noHunger)['空腹'], 'なし');
  assert.equal(table(little)['空腹'], '少し');
  assert.equal(table(strong)['空腹'], '強い');
  assert.equal(table(interpretBrainState([], state({ energy: 0.8, nm: { oa: 10, arousal: 0.8 } })))['気分/覚醒'], '高ぶっている');
});

test('interpretBrainState uses salience/asymmetry and hysteresis without inventing taste', () => {
  const first = interpretBrainState([
    signal('smell', 0.30, 0.22), signal('taste', 0.21), signal('vision', 0.30), signal('loom', 0.30),
  ], state({ behavior: 'walking' }));
  const second = interpretBrainState([
    signal('smell', 0.16, 0.14), signal('taste', 0.11), signal('vision', 0.14), signal('loom', 0.14),
  ], state({ behavior: 'walking' }), first);
  const table = facts => Object.fromEntries(facts.state_table.map(item => [item.fact, item.value]));
  assert.deepEqual(table(first), {
    '空腹': 'なし', '匂い': '左から強まっている', '味': '味がする', '視界': '大きく変わった',
    '接近物': '迫ってくる', '気分/覚醒': '落ち着いている', '体の動き': '歩いている',
  });
  assert.equal(table(second)['匂い'], '左から強まっている', 'direction stays through the off band');
  assert.equal(table(second)['味'], '味がする', 'taste stays through its off band');
  assert.equal(table(second)['視界'], '変化なし');
  assert.equal(table(second)['接近物'], 'なし');
});

test('interpretBrainState maps pose behaviour and drive only to observed movement', () => {
  for (const [behavior, expected] of [
    ['walking backward', '後ずさり'], ['turning left', '向きを変えている'], ['feeding', '食べている'],
    ['grooming', '毛づくろい'], ['standing', '止まっている'],
  ]) {
    const result = interpretBrainState([], state({ behavior }));
    assert.equal(result.values['体の動き'], expected);
  }
});

test('trigger logic requests on state change, stays silent when unchanged, then emits one quiet line', () => {
  let now = 0;
  const narrator = new NeuralNarrator({ clock: () => now, intervalMs: 4_000, quietMs: 30_000 });
  const standing = state();
  const first = narrator.maybeNarrate(standing, quietSignals, now);
  assert.deepEqual(first.changed, BRAIN_STATE_FACTS);
  assert.equal(first.state_table.length, 7);
  narrator.complete('静かだな');

  now = 3_999;
  assert.equal(narrator.maybeNarrate(standing, quietSignals, now), null);
  now = 4_000;
  assert.equal(narrator.maybeNarrate(standing, quietSignals, now), null, 'unchanged state is silent');

  now = 8_000;
  const changed = narrator.maybeNarrate(state({ behavior: 'walking', drive: 'walk' }), quietSignals, now);
  assert.deepEqual(changed.changed, ['体の動き']);
  narrator.complete('歩いている');

  now = 37_999;
  assert.equal(narrator.maybeNarrate(state({ behavior: 'walking', drive: 'walk' }), quietSignals, now), null);
  now = 38_000;
  const quiet = narrator.maybeNarrate(state({ behavior: 'walking', drive: 'walk' }), quietSignals, now);
  assert.deepEqual(quiet.changed, []);
});

test('changed facts compare against the last sent table after an in-flight state change', () => {
  const narrator = new NeuralNarrator({ intervalMs: 4_000 });
  const standing = state();
  const first = narrator.maybeNarrate(standing, quietSignals, 0);
  assert.ok(first);
  // The browser receives this pose while the first bridge request is still in flight.
  assert.equal(narrator.maybeNarrate(state({ behavior: 'walking', drive: 'walk' }), quietSignals, 4_000), null);
  narrator.complete('止まっている');
  const next = narrator.maybeNarrate(state({ behavior: 'walking', drive: 'walk' }), quietSignals, 8_000);
  assert.deepEqual(next.changed, ['体の動き']);
});

test('dead flies and in-flight requests do not create narration', () => {
  const narrator = new NeuralNarrator();
  assert.equal(narrator.maybeNarrate(state({ alive: false }), quietSignals, 0), null);
  assert.ok(narrator.maybeNarrate(state(), quietSignals, 0));
  assert.equal(narrator.maybeNarrate(state(), quietSignals, 4_000), null);
});
