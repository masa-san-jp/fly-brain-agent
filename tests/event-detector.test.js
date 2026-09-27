import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventDetector } from '../src/agents/EventDetector.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/event-replay.json', import.meta.url), 'utf8'));

test('replays every browser event with the §4.4 payload shape', () => {
  const detector = new EventDetector({
    terminals: [{ id: 'ollama', backend: 'ollama', x: 1, y: 1, r: 0.22, cooldownMs: 8_000 }],
    eventCooldownMs: 10_000,
    globalCap: 20,
  });
  const events = fixture.flatMap(pose => detector.feed(pose));
  assert.deepEqual(events.map(event => event.event), [
    'startled', 'hungry', 'found_food', 'grooming', 'idle_long', 'died', 'touched_agent',
  ]);
  const touch = events.at(-1);
  assert.equal(touch.terminal_id, 'ollama');
  assert.deepEqual(touch.state.pos, [1, 1, 0.13]);
  assert.equal(touch.state.flying, false);
  assert.equal(touch.recent_behaviors.length <= 5, true);
  assert.equal(new Set(touch.recent_behaviors).size, touch.recent_behaviors.length);
});

test('uses continuous touch time and terminal-specific cooldowns', () => {
  const detector = new EventDetector({
    terminals: [{ id: 'short', x: 0, y: 0, r: 0.2, cooldownMs: 1_000 }],
    globalCap: 20,
  });
  const pose = (t, x = 0) => ({ id: 0, t, pos: [x, 0, 0.13], yaw: 0, energy: 1, alive: true, flying: false, behavior: 'standing', cmd: { v: 0 } });
  assert.equal(detector.feed(pose(0)).length, 0);
  assert.equal(detector.feed(pose(299)).length, 0);
  assert.equal(detector.feed(pose(300)).length, 1);
  assert.equal(detector.feed(pose(900)).length, 0);
  assert.equal(detector.feed(pose(1_299)).length, 0);
  assert.equal(detector.feed(pose(1_300)).length, 1);
  detector.feed(pose(1_400, 1));
  assert.equal(detector.feed(pose(1_700)).length, 0, 'leaving the terminal resets continuous contact');
});

test('enforces the six-events-per-minute global cap', () => {
  const detector = new EventDetector({
    terminals: Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, x: i, y: 0, r: 1 })),
    globalCap: 2,
  });
  const pose = { id: 0, t: 1_000, pos: [0, 0, 0.13], yaw: 0, energy: 1, alive: true, flying: false, behavior: 'standing', cmd: { v: 0 } };
  assert.equal(detector.syntheticTouch(pose, 't0')?.event, 'touched_agent');
  assert.equal(detector.syntheticTouch(pose, 't1')?.event, 'touched_agent');
  assert.equal(detector.syntheticTouch(pose, 't2'), null);
  assert.equal(detector.syntheticTouch({ ...pose, t: 61_001 }, 't2')?.event, 'touched_agent');
});

test('synthetic touches add no synthetic field and preserve debug id responsibility for Client', () => {
  const detector = new EventDetector({ terminals: [{ id: 'ollama', x: 0, y: 0, r: 0.2 }], globalCap: 10 });
  const event = detector.syntheticTouch({ id: 7, t: 50, pos: [0, 0, 0.13], yaw: 0, energy: 0.5, alive: true, flying: false, behavior: 'standing', cmd: { v: 0 } }, 'ollama');
  assert.equal(event.terminal_id, 'ollama');
  assert.equal(Object.hasOwn(event, 'synthetic'), false);
  assert.equal(Object.hasOwn(event, 'id'), false);
});
