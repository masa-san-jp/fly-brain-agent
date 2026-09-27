const DEFAULTS = Object.freeze({
  eventCooldownMs: 10_000,
  globalCap: 6,
  globalWindowMs: 60_000,
  touchHoldMs: 300,
  groomingMs: 1_500,
  idleMs: 10_000,
});

const IDLE_BEHAVIORS = new Set(['standing', 'proboscis extended']);

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function timestampOf(pose, fallback) {
  return finite(pose?.t, fallback);
}

function flyIdOf(pose) {
  return pose?.agent_id ?? pose?.id ?? 0;
}

function positionOf(pose) {
  const pos = pose?.pos || [0, 0, 0];
  return [finite(pos[0]), finite(pos[1]), finite(pos[2])];
}

function stateOf(pose) {
  return {
    behavior: String(pose?.behavior ?? ''),
    energy: finite(pose?.energy),
    pos: positionOf(pose),
    yaw: finite(pose?.yaw),
    flying: Boolean(pose?.flying),
  };
}

function behaviorOf(pose) {
  return String(pose?.behavior ?? '');
}

function isGrooming(pose) {
  return Number(pose?.cmd?.grooming) > 0 || Boolean(pose?.cmd?.grooming);
}

function isIdle(pose) {
  return Math.abs(finite(pose?.cmd?.v)) < 0.05 && IDLE_BEHAVIORS.has(behaviorOf(pose));
}

function distanceXY(pos, terminal) {
  return Math.hypot(pos[0] - finite(terminal?.x), pos[1] - finite(terminal?.y));
}

/**
 * Replayable pose-to-event detector. It uses the pose timestamp as its clock;
 * no wall clock or browser state is consulted, so recorded sequences replay
 * deterministically.
 */
export class EventDetector {
  constructor({ terminals = [], ...options } = {}) {
    this.terminals = terminals.map(terminal => ({ ...terminal }));
    this.options = { ...DEFAULTS, ...options };
    this.agents = new Map();
    this.globalEvents = [];
  }

  reset() {
    this.agents.clear();
    this.globalEvents = [];
  }

  stateFor(agentId) {
    let state = this.agents.get(agentId);
    if (!state) {
      state = {
        previousPose: null,
        recentBehaviors: [],
        cooldowns: new Map(),
        touchStarts: new Map(),
        groomingSince: null,
        groomingFired: false,
        idleSince: null,
        idleFired: false,
      };
      this.agents.set(agentId, state);
    }
    return state;
  }

  rememberBehavior(state, behavior) {
    if (!behavior) return;
    state.recentBehaviors = state.recentBehaviors.filter(label => label !== behavior);
    state.recentBehaviors.push(behavior);
    state.recentBehaviors = state.recentBehaviors.slice(-5);
  }

  canEmit(state, event, timestamp, terminalId = null, cooldownMs = this.options.eventCooldownMs) {
    const key = terminalId == null ? event : `${event}:${String(terminalId)}`;
    const last = state.cooldowns.get(key);
    if (last != null && timestamp - last < cooldownMs) return false;
    this.globalEvents = this.globalEvents.filter(t => timestamp - t < this.options.globalWindowMs);
    if (this.globalEvents.length >= this.options.globalCap) return false;
    state.cooldowns.set(key, timestamp);
    this.globalEvents.push(timestamp);
    return true;
  }

  payload(event, pose, recentBehaviors, terminalId = undefined, timestamp = 0) {
    const output = {
      event,
      t_ms: timestamp,
      agent_id: flyIdOf(pose),
      state: stateOf(pose),
      recent_behaviors: [...recentBehaviors],
    };
    if (terminalId !== undefined) output.terminal_id = terminalId;
    return output;
  }

  emit(state, event, pose, timestamp, terminalId = undefined, cooldownMs = this.options.eventCooldownMs) {
    if (!this.canEmit(state, event, timestamp, terminalId, cooldownMs)) return null;
    return this.payload(event, pose, state.recentBehaviors, terminalId, timestamp);
  }

  /** Feed one pose snapshot and return zero or more event payloads. */
  feed(pose = {}) {
    const agentId = flyIdOf(pose);
    const state = this.stateFor(agentId);
    const previous = state.previousPose;
    const timestamp = timestampOf(pose, previous ? timestampOf(previous, 0) : 0);
    const behavior = behaviorOf(pose);
    const events = [];
    const push = (event, terminalId) => {
      const terminal = terminalId === undefined ? null : this.terminals.find(item => String(item.id) === String(terminalId));
      const cooldown = terminal?.cooldownMs ?? this.options.eventCooldownMs;
      const emitted = this.emit(state, event, pose, timestamp, terminalId, cooldown);
      if (emitted) events.push(emitted);
    };

    this.rememberBehavior(state, behavior);

    if (previous && behavior === 'escape jump' && behaviorOf(previous) !== behavior) push('startled');
    if (previous && finite(previous.energy, 1) >= 0.3 && finite(pose.energy) < 0.3) push('hungry');
    if (previous && behavior === 'feeding' && behaviorOf(previous) !== behavior) push('found_food');
    if (previous && previous.alive !== false && pose.alive === false) push('died');

    if (isGrooming(pose)) {
      if (state.groomingSince == null) state.groomingSince = timestamp;
      if (!state.groomingFired && timestamp - state.groomingSince >= this.options.groomingMs) {
        push('grooming');
        state.groomingFired = true;
      }
    } else {
      state.groomingSince = null;
      state.groomingFired = false;
    }

    if (isIdle(pose)) {
      if (state.idleSince == null) state.idleSince = timestamp;
      if (!state.idleFired && timestamp - state.idleSince >= this.options.idleMs) {
        push('idle_long');
        state.idleFired = true;
      }
    } else {
      state.idleSince = null;
      state.idleFired = false;
    }

    const pos = positionOf(pose);
    for (const terminal of this.terminals) {
      const id = terminal.id;
      const key = String(id);
      const touching = distanceXY(pos, terminal) < finite(terminal.r);
      if (!touching) {
        state.touchStarts.delete(key);
        continue;
      }
      if (!state.touchStarts.has(key)) state.touchStarts.set(key, timestamp);
      const since = state.touchStarts.get(key);
      if (timestamp - since >= this.options.touchHoldMs) push('touched_agent', id);
    }

    state.previousPose = {
      ...pose,
      pos: [...pos],
      cmd: { ...(pose.cmd || {}) },
    };
    return events;
  }

  /** Emit a debug touch through the same cooldown and global-cap path. */
  syntheticTouch(pose = {}, terminalId, timestamp = undefined) {
    const agentId = flyIdOf(pose);
    const state = this.stateFor(agentId);
    const now = timestamp === undefined ? timestampOf(pose, 0) : finite(timestamp);
    if (!state.previousPose) state.previousPose = { ...pose, pos: positionOf(pose), cmd: { ...(pose.cmd || {}) } };
    const terminal = this.terminals.find(item => String(item.id) === String(terminalId));
    return this.emit(state, 'touched_agent', pose, now, terminalId, terminal?.cooldownMs ?? this.options.eventCooldownMs);
  }
}

export { DEFAULTS as EVENT_DETECTOR_DEFAULTS, IDLE_BEHAVIORS };
