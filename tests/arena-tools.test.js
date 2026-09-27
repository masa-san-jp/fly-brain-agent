import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyArenaAction,
  arenaItems,
  MAX_AGENT_ITEMS,
  validateArenaAction,
} from '../src/agents/arenaTools.js';

const env = () => ({ arena: { radius: 2.5 }, food: [], odors: [], bitterPatches: [{ x: 0, y: 0, r: 0.2, bitter: 1 }] });

test('arena tools validate, clamp and keep sugar free of vinegar odor', () => {
  const invalid = validateArenaAction({ tool: 'place_odor', odor: 'co2', x: 0, y: 0, strength: 1, sigma: 1, ttl: 1 });
  assert.deepEqual(invalid, { tool: 'nothing' });
  const applied = applyArenaAction(env(), { tool: 'place_sugar', near: { x: 99, y: -99 }, distance: 1, amount: 2 }, { nowMs: 0 });
  assert.equal(applied.env.food.length, 1);
  assert.ok(Math.hypot(applied.env.food[0].x, applied.env.food[0].y) <= 2.5);
  assert.equal(applied.env.odors.length, 0);
  assert.match(applied.line, /sugar/);
});

test('agent items expire and are capped oldest-first', () => {
  let current = env();
  for (let i = 0; i < MAX_AGENT_ITEMS + 1; i += 1) {
    current = applyArenaAction(current, { tool: 'place_odor', odor: 'banana', x: i, y: 0, strength: 1, sigma: 1, ttl: 30_000 }, { nowMs: i }).env;
  }
  assert.equal(current.odors.filter(item => item.agentPlaced).length, MAX_AGENT_ITEMS);
  assert.equal(current.odors.find(item => item.x === 0), undefined);
  current = applyArenaAction(current, { tool: 'nothing' }, { nowMs: 31_000 }).env;
  assert.equal(current.odors.filter(item => item.agentPlaced).length, 0);
});

test('arena item map exposes food, odor and bitter without internal fields', () => {
  const mapped = arenaItems({ food: [{ x: 1, y: 2, r: 0.1, amount: 1, secret: 'drop' }], odors: [{ x: 0, y: 0, odor: 'banana', strength: 0.5, sigma: 0.8 }], bitterPatches: [] });
  assert.deepEqual(mapped[0], { type: 'food', x: 1, y: 2, r: 0.1, amount: 1 });
  assert.equal(Object.hasOwn(mapped[0], 'secret'), false);
});
