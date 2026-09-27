import test from 'node:test';
import assert from 'node:assert/strict';
import { expandAgents } from '../src/agents/terminals.js';

const source = {
  arena: { radius: 2.5 }, food: [{ x: 0, y: 0, r: 0.1, sugar: 1, amount: 2 }], odors: [],
  agents: [{ id: 'one', backend: 'ollama', x: 1, y: -1, r: 0.2, odor: 'banana', strength: 0.8, sigma: 0.7, sugar: 0.4 }],
};

test('expandAgents adds tagged food and odor without changing the input', () => {
  const expanded = expandAgents(source);
  assert.equal(source.food.length, 1);
  assert.equal(expanded.food.length, 2);
  assert.equal(expanded.odors.length, 1);
  assert.deepEqual(expanded.food.at(-1), {
    x: 1, y: -1, r: 0.2, sugar: 0.4, bitter: 0, water: 0.2,
    amount: 5, maxAmount: 5, agentId: 'one',
  });
  assert.deepEqual(expanded.odors[0], { x: 1, y: -1, odor: 'banana', strength: 0.8, sigma: 0.7, agentId: 'one' });
});

test('expandAgents is idempotent and supports a no-odor control', () => {
  const once = expandAgents({ agents: [{ id: 'quiet', x: 0, y: 0, r: 0.2, odor: null }] });
  const twice = expandAgents(once);
  assert.equal(once.food.length, 1);
  assert.equal(twice.food.length, 1);
  assert.equal(twice.odors.length, 0);
  assert.equal(twice.food[0].agentId, 'quiet');
});

test('existing tagged entries are not duplicated', () => {
  const env = expandAgents({
    agents: [{ id: 'one', x: 1, y: 1, r: 0.2, odor: 'vinegar' }],
    food: [{ x: 1, y: 1, r: 0.2, sugar: 0.3, amount: 7, maxAmount: 7, agentId: 'one' }],
    odors: [{ x: 1, y: 1, odor: 'vinegar', strength: 1, sigma: 1, agentId: 'one' }],
  });
  assert.equal(env.food.filter(f => f.agentId === 'one').length, 1);
  assert.equal(env.odors.filter(o => o.agentId === 'one').length, 1);
});
