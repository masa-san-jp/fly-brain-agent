import test from 'node:test';
import assert from 'node:assert/strict';
import { NeuralNarrator, asymmetry, meaningfulSignalChange, salience } from '../src/agents/NeuralNarrator.js';

const state = (overrides = {}) => ({
  agent_id: 4, t_ms: 123, behavior: 'walking', energy: 0.8, pos: [1, 2, 0.13], yaw: 0.4, flying: false, alive: true,
  ...overrides,
});

test('signal math computes salience and sensory asymmetry', () => {
  assert.equal(salience(12, 10), 2 / 12);
  assert.equal(asymmetry(8, 2), 6 / 11);
  const narrator = new NeuralNarrator({ baselineTauMs: 20_000, shortWindowMs: 2_000 });
  narrator.ingest([10, 10, ...Array(22).fill(0)], 0);
  const snapshot = narrator.ingest([20, 10, ...Array(22).fill(0)], 1_000);
  const smell = snapshot.signals.find(signal => signal.group === 'smell');
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

test('interval gating and unchanged-repeat suppression use the injected clock', () => {
  let now = 0;
  const narrator = new NeuralNarrator({ clock: () => now, intervalMs: 7_000, repeatMs: 20_000 });
  const groups = Array(24).fill(0);
  assert.ok(narrator.maybeNarrate(state(), groups));
  narrator.complete('静かだな');
  now = 6_999;
  assert.equal(narrator.maybeNarrate(state(), groups), null);
  now = 7_000;
  assert.equal(narrator.maybeNarrate(state(), groups), null, 'unchanged signals should not repeat before 20 s');
  now = 20_001;
  assert.ok(narrator.maybeNarrate(state(), groups));
});

test('a meaningful signal change bypasses the repeat suppression', () => {
  const narrator = new NeuralNarrator({ intervalMs: 7_000, repeatMs: 20_000 });
  const quiet = Array(24).fill(0);
  assert.ok(narrator.maybeNarrate(state(), quiet, 0));
  narrator.complete('静かだな');
  const louderSmell = quiet.slice(); louderSmell[0] = 40; louderSmell[1] = 10;
  const next = narrator.maybeNarrate(state(), louderSmell, 7_000);
  assert.equal(next.event, 'narrate');
  assert.equal(next.previous_line, '静かだな');
  assert.equal(meaningfulSignalChange(narrator.snapshot(), narrator.lastSnapshot), false);
});

test('dead flies and in-flight requests do not create narration', () => {
  const narrator = new NeuralNarrator();
  const groups = Array(24).fill(1);
  assert.equal(narrator.maybeNarrate(state({ alive: false }), groups, 0), null);
  assert.ok(narrator.maybeNarrate(state(), groups, 0));
  assert.equal(narrator.maybeNarrate(state(), groups, 7_000), null);
});
