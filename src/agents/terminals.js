// Expand the declarative agent-terminal schema into the existing food/odor world.
// The input is never mutated: callers can safely reuse a preset definition.
export function expandAgents(input) {
  const env = structuredClone(input);
  env.food ||= [];
  env.odors ||= [];

  for (const agent of env.agents || []) {
    if (agent.id === undefined || agent.id === null) throw new Error('agent terminal requires an id');
    if (!env.food.some(food => food.agentId === agent.id)) {
      const amount = agent.amount ?? 5;
      env.food.push({ x: agent.x, y: agent.y, r: agent.r, sugar: agent.sugar ?? 0.3,
        bitter: 0, water: agent.water ?? 0.2, amount, maxAmount: amount, agentId: agent.id });
    }
    if (agent.odor && !env.odors.some(odor => odor.agentId === agent.id)) {
      env.odors.push({ x: agent.x, y: agent.y, odor: agent.odor,
        strength: agent.strength ?? 0.8, sigma: agent.sigma ?? 0.8, agentId: agent.id });
    }
  }
  return env;
}
