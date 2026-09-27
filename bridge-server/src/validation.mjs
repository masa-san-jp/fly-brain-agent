const EVENTS = new Set([
  'touched_agent',
  'startled',
  'hungry',
  'found_food',
  'grooming',
  'idle_long',
  'died',
  'narrate',
]);

const GROUP_KEYS = Object.freeze([
  'smell', 'taste', 'vision', 'loom', 'escape', 'walk', 'back', 'steer',
  'groom', 'court', 'octopamine', 'feed',
]);
const GROUP_KEY_SET = new Set(GROUP_KEYS);

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

function boundedNumber(value, field, low, high) {
  if (!isFiniteNumber(value)) throw new PayloadValidationError(`${field} must be a finite number`);
  return Math.max(low, Math.min(high, value));
}

function validateNarration(payload, clean) {
  if (!Array.isArray(payload.signals) || payload.signals.length > 12) {
    throw new PayloadValidationError('signals must contain at most 12 items');
  }
  const seen = new Set();
  clean.signals = payload.signals.map((item) => {
    if (!isRecord(item) || !GROUP_KEY_SET.has(item.group)) throw new PayloadValidationError('signals contains an unknown group');
    if (seen.has(item.group)) throw new PayloadValidationError('signals contains a duplicate group');
    seen.add(item.group);
    return {
      group: item.group,
      hz_left: boundedNumber(item.hz_left, 'signals.hz_left', 0, 1_000),
      hz_right: boundedNumber(item.hz_right, 'signals.hz_right', 0, 1_000),
      baseline: boundedNumber(item.baseline, 'signals.baseline', 0, 1_000),
      salience: boundedNumber(item.salience, 'signals.salience', -50, 50),
      asymmetry: boundedNumber(item.asymmetry, 'signals.asymmetry', -1, 1),
    };
  });
  if (!Array.isArray(payload.top) || payload.top.length > 3 || payload.top.some(key => !GROUP_KEY_SET.has(key))) {
    throw new PayloadValidationError('top must contain at most three known groups');
  }
  if (new Set(payload.top).size !== payload.top.length) throw new PayloadValidationError('top contains duplicate groups');
  clean.top = [...payload.top];
  if (payload.previous_line !== undefined) {
    if (typeof payload.previous_line !== 'string' || Array.from(payload.previous_line).length > 40) {
      throw new PayloadValidationError('previous_line must be a string of at most 40 characters');
    }
    clean.previous_line = payload.previous_line;
  } else {
    clean.previous_line = '';
  }
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

  if (payload.event !== 'narrate' && Object.prototype.hasOwnProperty.call(payload, 'terminal_id')) {
    clean.terminal_id = validateIdentifier(payload.terminal_id, 'terminal_id');
  }

  if (payload.event === 'narrate') validateNarration(payload, clean);

  return clean;
}

export { EVENTS, GROUP_KEYS, MAX_BEHAVIOR_LENGTH, MAX_IDENTIFIER_LENGTH };
