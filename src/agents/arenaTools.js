// The only capability exposed to an external agent. This module is deliberately pure:
// callers receive a new environment and a compact audit line; the fly/connectome is untouched.

export const ATTRACTIVE_ODORS = Object.freeze(['banana', 'vinegar']);
export const MAX_AGENT_ITEMS = 3;
export const MAX_ACTION_DISTANCE = 1.0;
export const MAX_SUGAR_AMOUNT = 2;
export const MAX_ODOR_STRENGTH = 1;
export const MAX_ODOR_SIGMA = 1.2;
export const MAX_ODOR_TTL_MS = 30_000;
export const MAX_BITTER_RADIUS = 0.5;
export const AGENT_ITEM_TTL_MS = 30_000;
export const BCI_ACTION_DISTANCE_MIN = 0.3;
export const BCI_ACTION_DISTANCE_MAX = 0.6;
export const BCI_ODOR_DISTANCE = 0.45;
export const BCI_SIDES = Object.freeze(['left', 'right', 'ahead']);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value, allowed) => Object.keys(value).every(key => allowed.has(key));

export const nothingAction = () => ({ tool: 'nothing' });

function validPoint(value) {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

/** Validate the tool contract; spatial coordinates are clamped only when applied to the arena. */
export function validateArenaAction(action) {
  if (!isRecord(action) || typeof action.tool !== 'string') return nothingAction();
  if (action.tool === 'nothing') return Object.keys(action).length === 1 ? nothingAction() : nothingAction();

  if (action.tool === 'place_sugar') {
    if (!ownKeys(action, new Set(['tool', 'near', 'distance', 'amount', 'odor', 'odor_strength']))) return nothingAction();
    const near = action.near;
    const validNear = near === 'fly' || near === 'terminal' || validPoint(near);
    if (!validNear) return nothingAction();
    const distance = action.distance;
    const amount = action.amount;
    if (!Number.isFinite(distance) || !Number.isFinite(amount) || distance < 0 || distance > MAX_ACTION_DISTANCE || amount <= 0 || amount > MAX_SUGAR_AMOUNT) return nothingAction();
    if (action.odor !== undefined && action.odor !== 'banana') return nothingAction();
    if (action.odor_strength !== undefined && (!Number.isFinite(action.odor_strength) || action.odor_strength < 0 || action.odor_strength > 0.6)) return nothingAction();
    return {
      tool: 'place_sugar',
      near: typeof near === 'object' ? { x: near.x, y: near.y } : near,
      distance,
      amount,
      ...(action.odor === undefined ? {} : { odor: 'banana', odor_strength: action.odor_strength ?? 0.6 }),
    };
  }

  if (action.tool === 'place_odor') {
    if (!ownKeys(action, new Set(['tool', 'odor', 'x', 'y', 'strength', 'sigma', 'ttl']))) return nothingAction();
    const values = ['x', 'y', 'strength', 'sigma', 'ttl'].map(key => action[key]);
    if (!ATTRACTIVE_ODORS.includes(action.odor) || values.some(value => !Number.isFinite(value)) || values[2] < 0 || values[2] > MAX_ODOR_STRENGTH || values[3] <= 0 || values[3] > MAX_ODOR_SIGMA || values[4] <= 0 || values[4] > MAX_ODOR_TTL_MS) return nothingAction();
    return { tool: 'place_odor', odor: action.odor, x: values[0], y: values[1], strength: values[2], sigma: values[3], ttl: values[4] };
  }

  if (action.tool === 'remove_bitter') {
    if (!ownKeys(action, new Set(['tool', 'x', 'y', 'r']))) return nothingAction();
    const values = ['x', 'y', 'r'].map(key => action[key]);
    if (values.some(value => !Number.isFinite(value)) || values[2] < 0 || values[2] > MAX_BITTER_RADIUS) return nothingAction();
    return { tool: 'remove_bitter', x: values[0], y: values[1], r: values[2] };
  }
  return nothingAction();
}

/** The deliberately smaller, pose-free tool contract used by the BCI caretaker. */
export function validateBciAction(action) {
  if (!isRecord(action) || typeof action.tool !== 'string') return nothingAction();
  if (action.tool === 'nothing') return nothingAction();
  if (action.tool === 'place_sugar') {
    if (!ownKeys(action, new Set(['tool', 'near', 'distance', 'amount'])) || action.near !== 'fly' ||
      !Number.isFinite(action.distance) || action.distance < BCI_ACTION_DISTANCE_MIN || action.distance > BCI_ACTION_DISTANCE_MAX ||
      !Number.isFinite(action.amount) || action.amount <= 0 || action.amount > MAX_SUGAR_AMOUNT) return nothingAction();
    return { tool: 'place_sugar', near: 'fly', distance: action.distance, amount: action.amount };
  }
  if (action.tool === 'place_odor') {
    if (!ownKeys(action, new Set(['tool', 'near', 'side', 'odor', 'strength', 'sigma', 'ttl'])) || action.near !== 'fly' ||
      !BCI_SIDES.includes(action.side) || !ATTRACTIVE_ODORS.includes(action.odor) ||
      !Number.isFinite(action.strength) || action.strength < 0 || action.strength > MAX_ODOR_STRENGTH ||
      !Number.isFinite(action.sigma) || action.sigma <= 0 || action.sigma > MAX_ODOR_SIGMA ||
      !Number.isFinite(action.ttl) || action.ttl <= 0 || action.ttl > MAX_ODOR_TTL_MS) return nothingAction();
    return { tool: 'place_odor', near: 'fly', side: action.side, odor: action.odor, strength: action.strength, sigma: action.sigma, ttl: action.ttl };
  }
  if (action.tool === 'remove_bitter') {
    if (!ownKeys(action, new Set(['tool', 'near', 'radius'])) || action.near !== 'fly' ||
      !Number.isFinite(action.radius) || action.radius < 0 || action.radius > MAX_BITTER_RADIUS) return nothingAction();
    return { tool: 'remove_bitter', near: 'fly', radius: action.radius };
  }
  return nothingAction();
}

function bciPoint(pose, side, distance) {
  const yaw = finite(pose?.yaw);
  const angle = yaw + (side === 'left' ? Math.PI / 2 : side === 'right' ? -Math.PI / 2 : 0);
  return { x: finite(pose?.pos?.[0]) + Math.cos(angle) * distance, y: finite(pose?.pos?.[1]) + Math.sin(angle) * distance };
}

/** Resolve BCI's pose-free device commands into the existing arena tool contract. */
export function applyBciAction(inputEnv, rawAction, { pose, nowMs = 0 } = {}) {
  const action = validateBciAction(rawAction);
  const deviceAction = action.tool === 'place_sugar'
    ? action
    : action.tool === 'place_odor'
      ? { tool: 'place_odor', odor: action.odor, ...bciPoint(pose, action.side, BCI_ODOR_DISTANCE), strength: action.strength, sigma: action.sigma, ttl: action.ttl }
      : action.tool === 'remove_bitter'
        ? { tool: 'remove_bitter', ...bciPoint(pose, 'ahead', BCI_ODOR_DISTANCE), r: action.radius }
        : nothingAction();
  return applyArenaAction(inputEnv, deviceAction, { pose, nowMs });
}

function clampToArena(x, y, radius) {
  const length = Math.hypot(x, y);
  if (length <= radius || length === 0) return { x, y };
  return { x: x * radius / length, y: y * radius / length };
}

function poseOf(context = {}) {
  const pose = context.pose || {};
  const pos = Array.isArray(pose.pos) ? pose.pos : [pose.x, pose.y, 0.13];
  return { x: finite(pos[0]), y: finite(pos[1]), z: finite(pos[2], 0.13), yaw: finite(pose.yaw) };
}

function targetFor(action, context, radius) {
  const pose = poseOf(context);
  if (typeof action.near === 'object') return clampToArena(action.near.x, action.near.y, radius);
  if (action.near === 'terminal') {
    const terminal = (context.terminals || []).find(item => String(item.id) === String(context.terminalId));
    if (terminal) {
      const angle = Math.atan2(pose.y - finite(terminal.y), pose.x - finite(terminal.x));
      return clampToArena(finite(terminal.x) + Math.cos(angle) * action.distance, finite(terminal.y) + Math.sin(angle) * action.distance, radius);
    }
  }
  return clampToArena(pose.x + Math.cos(pose.yaw) * action.distance, pose.y + Math.sin(pose.yaw) * action.distance, radius);
}

function nextItemId(env) {
  const all = [...(env.food || []), ...(env.odors || []), ...(env.bitterPatches || [])];
  return `agent-${all.reduce((max, item) => Math.max(max, Number(String(item.agentItemId || '').replace('agent-', '')) || 0), 0) + 1}`;
}

function pruneAgentItems(env, nowMs) {
  const keep = item => !item.agentPlaced || (item.expiresAt == null || item.expiresAt > nowMs);
  env.food = (env.food || []).filter(keep);
  env.odors = (env.odors || []).filter(keep);
  env.bitterPatches = (env.bitterPatches || []).filter(keep);
  const active = [];
  for (const list of [env.food, env.odors, env.bitterPatches]) for (const item of list) if (item.agentPlaced) active.push(item);
  active.sort((a, b) => (a.placedAt ?? 0) - (b.placedAt ?? 0));
  while (active.length > MAX_AGENT_ITEMS) {
    const oldest = active.shift();
    for (const list of [env.food, env.odors, env.bitterPatches]) {
      const index = list.indexOf(oldest);
      if (index >= 0) list.splice(index, 1);
    }
  }
}

function positionText(x, y) { return `(${x.toFixed(2)},${y.toFixed(2)})`; }

/** Apply one validated action, returning a new environment plus a compact audit log line. */
export function applyArenaAction(inputEnv, rawAction, context = {}) {
  const action = validateArenaAction(rawAction);
  const env = structuredClone(inputEnv || {});
  env.food ||= []; env.odors ||= []; env.bitterPatches ||= [];
  const beforePruneCount = [...env.food, ...env.odors, ...env.bitterPatches].filter(item => item.agentPlaced).length;
  const nowMs = finite(context.nowMs, 0);
  pruneAgentItems(env, nowMs);
  const radius = Math.max(0, finite(env.arena?.radius, 2.5) - 0.02);
  const id = nextItemId(env);
  const expiresAt = nowMs + AGENT_ITEM_TTL_MS;

  if (action.tool === 'place_sugar') {
    const target = targetFor(action, context, radius);
    const food = { x: target.x, y: target.y, r: 0.12, sugar: 1, bitter: 0, water: 0.2, amount: action.amount,
      maxAmount: action.amount, agentPlaced: true, agentItemId: id, placedAt: nowMs, expiresAt };
    env.food.push(food);
    if (action.odor) env.odors.push({ x: target.x, y: target.y, odor: action.odor, strength: action.odor_strength, sigma: 0.8,
      agentPlaced: true, agentItemId: id, placedAt: nowMs, expiresAt });
    pruneAgentItems(env, nowMs);
    return { env, action, changed: true, line: `sugar ${positionText(target.x, target.y)} / 砂糖を配置` };
  }

  if (action.tool === 'place_odor') {
    const target = clampToArena(action.x, action.y, radius);
    env.odors.push({ x: target.x, y: target.y, odor: action.odor, strength: action.strength, sigma: action.sigma,
      agentPlaced: true, agentItemId: id, placedAt: nowMs, expiresAt: nowMs + action.ttl });
    pruneAgentItems(env, nowMs);
    return { env, action, changed: true, line: `odor ${action.odor} ${positionText(target.x, target.y)} / 匂いを配置` };
  }

  if (action.tool === 'remove_bitter') {
    const target = clampToArena(action.x, action.y, radius);
    const before = env.bitterPatches.length;
    env.bitterPatches = env.bitterPatches.filter(item => Math.hypot(finite(item.x) - target.x, finite(item.y) - target.y) > action.r);
    return { env, action, changed: before !== env.bitterPatches.length, line: `bitter removed ${positionText(target.x, target.y)} / 苦味を除去` };
  }
  const afterPruneCount = [...env.food, ...env.odors, ...env.bitterPatches].filter(item => item.agentPlaced).length;
  return { env, action: nothingAction(), changed: beforePruneCount !== afterPruneCount, line: 'nothing / 何もしない' };
}

/** Compact, non-secret map supplied to an agent. */
export function arenaItems(env = {}) {
  const clean = (item, type) => ({ type, x: finite(item.x), y: finite(item.y), ...(type === 'food' ? { r: finite(item.r), amount: finite(item.amount) } : {}),
    ...(type === 'odor' ? { odor: item.odor, strength: finite(item.strength), sigma: finite(item.sigma) } : {}),
    ...(type === 'bitter' ? { r: finite(item.r) } : {}), ...(item.agentPlaced ? { agentPlaced: true } : {}) });
  return [
    ...(env.food || []).map(item => clean(item, 'food')),
    ...(env.odors || []).map(item => clean(item, 'odor')),
    ...(env.bitterPatches || []).map(item => clean(item, 'bitter')),
  ];
}
