const EVENTS = new Set([
  'touched_agent',
  'startled',
  'hungry',
  'found_food',
  'grooming',
  'idle_long',
  'died',
]);

const MAX_IDENTIFIER_LENGTH = 64;
const MAX_BEHAVIOR_LENGTH = 40;

export class PayloadValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadValidationError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateIdentifier(value, fieldName) {
  if (isFiniteNumber(value)) return value;
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    /^[a-z0-9_-]+$/.test(value)
  ) {
    return value;
  }
  throw new PayloadValidationError(`${fieldName} must be a number or short identifier`);
}

function validateState(value) {
  if (!isRecord(value)) throw new PayloadValidationError('state must be an object');
  if (typeof value.behavior !== 'string' || value.behavior.length > MAX_BEHAVIOR_LENGTH) {
    throw new PayloadValidationError('state.behavior must be a string of at most 40 characters');
  }
  if (!isFiniteNumber(value.energy)) throw new PayloadValidationError('state.energy must be a number');
  if (!Array.isArray(value.pos) || value.pos.length !== 3 || !value.pos.every(isFiniteNumber)) {
    throw new PayloadValidationError('state.pos must be an array of three numbers');
  }
  if (!isFiniteNumber(value.yaw)) throw new PayloadValidationError('state.yaw must be a number');
  if (typeof value.flying !== 'boolean') throw new PayloadValidationError('state.flying must be boolean');

  return {
    behavior: value.behavior,
    energy: value.energy,
    pos: [...value.pos],
    yaw: value.yaw,
    flying: value.flying,
  };
}

function validateRecentBehaviors(value) {
  if (!Array.isArray(value) || value.length > 5) {
    throw new PayloadValidationError('recent_behaviors must contain at most five strings');
  }
  if (value.some((item) => typeof item !== 'string' || item.length > MAX_BEHAVIOR_LENGTH)) {
    throw new PayloadValidationError('recent_behaviors contains an invalid behavior');
  }
  return [...value];
}

export function validateEventPayload(payload) {
  if (!isRecord(payload)) throw new PayloadValidationError('payload must be an object');
  if (!EVENTS.has(payload.event)) throw new PayloadValidationError('unknown event');
  if (!Object.prototype.hasOwnProperty.call(payload, 'agent_id')) {
    throw new PayloadValidationError('agent_id is required');
  }
  if (!isFiniteNumber(payload.t_ms)) throw new PayloadValidationError('t_ms must be a number');
  if (!Object.prototype.hasOwnProperty.call(payload, 'state')) {
    throw new PayloadValidationError('state is required');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'recent_behaviors')) {
    throw new PayloadValidationError('recent_behaviors is required');
  }

  const clean = {
    event: payload.event,
    agent_id: validateIdentifier(payload.agent_id, 'agent_id'),
    t_ms: payload.t_ms,
    state: validateState(payload.state),
    recent_behaviors: validateRecentBehaviors(payload.recent_behaviors),
  };

  if (Object.prototype.hasOwnProperty.call(payload, 'terminal_id')) {
    clean.terminal_id = validateIdentifier(payload.terminal_id, 'terminal_id');
  }

  return clean;
}

export { EVENTS, MAX_BEHAVIOR_LENGTH, MAX_IDENTIFIER_LENGTH };
