import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAnim } from '../src/humanoid/selectAnim.js';

const pose = (overrides = {}) => ({
  alive: true,
  pos: [1, 2, 3],
  behavior: 'standing',
  cmd: { v: 0, turn: 0, grooming: false },
  ...overrides,
});

test('priority 1: dead wins over every other signal', () => {
  const selected = selectAnim(pose({ alive: false, behavior: 'feeding', flying: true, cmd: { v: 1, grooming: true } }));
  assert.equal(selected.state, 'death');
  assert.equal(selected.action, 'death');
});

test('priority 2: escape jump wins over feeding and grooming', () => {
  const selected = selectAnim(pose({ behavior: 'escape jump', cmd: { v: 1, grooming: true } }));
  assert.equal(selected.state, 'jump');
});

test('priority 3: airborne poses use fall and do not select a flight action', () => {
  const selected = selectAnim(pose({ behavior: 'flying…', flying: true }));
  assert.equal(selected.state, 'fall');
  assert.notEqual(selected.action, 'flight');
});

test('priority 4: only the exact feeding label feeds; proboscis extension is idle', () => {
  assert.equal(selectAnim(pose({ behavior: 'feeding', feeding: 0 })).state, 'feeding');
  assert.equal(selectAnim(pose({ behavior: 'proboscis extended', feeding: 1 })).state, 'idle');
});

test('priority 5: grooming command selects the rub-face action', () => {
  const selected = selectAnim(pose({ cmd: { v: 0.8, turn: 0, grooming: true } }));
  assert.equal(selected.state, 'grooming');
  assert.equal(selected.action, 'rubFace');
});

test('priority 6: negative velocity selects back-walk', () => {
  const selected = selectAnim(pose({ groundSpeed: -0.08, cmd: { v: 0, turn: 0, grooming: false } }));
  assert.equal(selected.state, 'backWalk');
  assert.equal(selected.action, 'backWalk');
});

test('priority 7: measured ground speed blends walk, jog and sprint', () => {
  // on-screen units/s: walk ≈ 0.26, jog ≈ 0.56, sprint ≈ 1.1 (0.3-unit avatar = 1.6 m)
  const walk = selectAnim(pose({ groundSpeed: 0.2, cmd: { v: 1, turn: 0, grooming: false } }));
  const jog = selectAnim(pose({ groundSpeed: 0.56, cmd: { v: 0.05, turn: 0, grooming: false } }));
  const sprint = selectAnim(pose({ groundSpeed: 1.1, cmd: { v: 0, turn: 0, grooming: false } }));
  assert.equal(walk.state, 'locomotion');
  assert.ok(walk.blend.walk > walk.blend.jog);
  assert.ok(jog.blend.jog >= jog.blend.walk && jog.blend.jog >= jog.blend.sprint);
  assert.ok(sprint.blend.sprint > sprint.blend.jog);
  assert.ok(walk.playbackRate > 0);
  assert.equal(selectAnim(pose({ groundSpeed: 0, cmd: { v: 1, turn: 0, grooming: false } })).state, 'idle');
});

test('physics jitter of a standing fly stays idle, forwards or backwards', () => {
  for (const groundSpeed of [0.01, -0.01, 0.015, -0.015]) {
    assert.equal(selectAnim(pose({ behavior: 'standing', groundSpeed, cmd: { v: 0, turn: 0, grooming: false } })).state, 'idle');
  }
});

test('a slow on-screen walk plays slowly instead of running on the spot', () => {
  const slow = selectAnim(pose({ groundSpeed: 0.05, cmd: { v: 1, turn: 0, grooming: false } }));
  assert.equal(slow.action, 'walk');
  assert.ok(slow.playbackRate < 0.5);
});

test('priority 8: standing and proboscis extended both idle', () => {
  assert.equal(selectAnim(pose({ behavior: 'standing' })).state, 'idle');
  assert.equal(selectAnim(pose({ behavior: 'proboscis extended' })).state, 'idle');
});

test('turn changes only the upper-body twist and position is three-dimensional', () => {
  const selected = selectAnim(pose({ pos: [-1, 0.25, 0.125], groundSpeed: 0.15, cmd: { v: 0, turn: 0.6, grooming: false } }));
  assert.deepEqual(selected.position, [-1, 0.25, 0.125]);
  assert.ok(selected.upperTwist > 0);
  const sameSpeedNoTurn = selectAnim(pose({ groundSpeed: 0.15, cmd: { v: 0, turn: 0, grooming: false } }));
  assert.deepEqual(selected.blend, sameSpeedNoTurn.blend);
});

test('selection is pure and reports the previous state without mutating it', () => {
  const previous = { state: 'idle', position: [9, 9, 9] };
  const selected = selectAnim(pose({ groundSpeed: 0.15, cmd: { v: 0, turn: -0.2, grooming: false } }), previous);
  assert.equal(selected.previousState, 'idle');
  assert.deepEqual(previous, { state: 'idle', position: [9, 9, 9] });
});
