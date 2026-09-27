// Browser-side, stateful signal summariser. The arithmetic helpers are exported so the
// narrator can be tested without a Worker, DOM, WebSocket, or clock globals.
export const GROUP_KEYS = Object.freeze([
  'smell', 'taste', 'vision', 'loom', 'escape', 'walk', 'back', 'steer',
  'groom', 'court', 'octopamine', 'feed',
]);

export const SENSORY_GROUPS = new Set(['smell', 'taste', 'vision', 'loom']);

const DEFAULTS = Object.freeze({
  intervalMs: 7_000,
  repeatMs: 20_000,
  baselineTauMs: 20_000,
  shortWindowMs: 2_000,
  meaningfulSalienceDelta: 0.1,
  meaningfulHzDelta: 1,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round2 = value => Math.round(value * 100) / 100;

export function normaliseGroups(groups) {
  return GROUP_KEYS.map((_, groupIndex) => [0, 1].map(side => clamp(
    finite(groups?.[groupIndex * 2 + side]), 0, 1_000,
  ))).flat();
}

export function asymmetry(left, right) {
  return (left - right) / (left + right + 1);
}

export function salience(shortMean, baseline) {
  return (shortMean - baseline) / (baseline + 2);
}

function average(samples, side) {
  if (!samples.length) return 0;
  return samples.reduce((sum, sample) => sum + sample[side], 0) / samples.length;
}

function cloneSignals(signals) {
  return signals.map(signal => ({ ...signal }));
}

export function meaningfulSignalChange(current, previous, {
  salienceDelta = DEFAULTS.meaningfulSalienceDelta,
  hzDelta = DEFAULTS.meaningfulHzDelta,
} = {}) {
  if (!previous) return true;
  if (current.top.join('|') !== previous.top.join('|')) return true;
  const old = new Map(previous.signals.map(signal => [signal.group, signal]));
  return current.signals.some(signal => {
    const before = old.get(signal.group);
    return !before || Math.abs(signal.salience - before.salience) >= salienceDelta ||
      Math.abs(signal.hz_left - before.hz_left) >= hzDelta ||
      Math.abs(signal.hz_right - before.hz_right) >= hzDelta;
  });
}

/**
 * Converts the selected fly's activity trace into occasional narration requests.
 * `clock` is injected so interval and repeat behaviour can be tested with a fake clock.
 */
export class NeuralNarrator {
  constructor({ agentId = 0, clock = () => Date.now(), ...options } = {}) {
    this.agentId = agentId;
    this.clock = clock;
    this.options = { ...DEFAULTS, ...options };
    this.groups = GROUP_KEYS.map(() => ({ baseline: null, samples: [] }));
    this.lastSampleAt = null;
    this.lastRequestedAt = -Infinity;
    this.lastSnapshot = null;
    this.previousLine = '';
    this.inFlight = false;
    this.enabled = true;
  }

  reset() {
    this.groups.forEach(group => { group.baseline = null; group.samples = []; });
    this.lastSampleAt = null;
    this.lastRequestedAt = -Infinity;
    this.lastSnapshot = null;
    this.previousLine = '';
    this.inFlight = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.inFlight = false;
  }

  ingest(rawGroups, at = this.clock()) {
    const groups = normaliseGroups(rawGroups);
    const dt = this.lastSampleAt == null ? 0 : Math.max(0, at - this.lastSampleAt);
    const alpha = dt > 0 ? 1 - Math.exp(-dt / this.options.baselineTauMs) : 0;
    this.lastSampleAt = at;

    this.groups.forEach((group, index) => {
      const left = groups[index * 2];
      const right = groups[index * 2 + 1];
      const mean = (left + right) / 2;
      if (group.baseline == null) group.baseline = mean;
      else group.baseline += alpha * (mean - group.baseline);
      group.samples.push({ at, left, right });
      while (group.samples.length > 1 && at - group.samples[0].at > this.options.shortWindowMs) group.samples.shift();
    });
    return this.snapshot();
  }

  snapshot() {
    const signals = this.groups.map((group, index) => {
      const left = average(group.samples, 'left');
      const right = average(group.samples, 'right');
      const baseline = group.baseline ?? 0;
      const key = GROUP_KEYS[index];
      return {
        group: key,
        hz_left: round2(left),
        hz_right: round2(right),
        baseline: round2(baseline),
        salience: round2(salience((left + right) / 2, baseline)),
        asymmetry: round2(SENSORY_GROUPS.has(key) ? asymmetry(left, right) : 0),
      };
    }).sort((left, right) => Math.abs(right.salience) - Math.abs(left.salience) ||
      GROUP_KEYS.indexOf(left.group) - GROUP_KEYS.indexOf(right.group));
    return { signals, top: signals.slice(0, 3).map(signal => signal.group) };
  }

  /** Add one activity sample and return a narrate event when its gates allow it. */
  maybeNarrate(state = {}, rawGroups, now = this.clock()) {
    const current = this.ingest(rawGroups, now);
    if (!this.enabled || this.inFlight || state.alive === false) return null;
    if (now - this.lastRequestedAt < this.options.intervalMs) return null;
    if (now - this.lastRequestedAt < this.options.repeatMs && !meaningfulSignalChange(current, this.lastSnapshot, this.options)) return null;

    this.inFlight = true;
    this.lastRequestedAt = now;
    this.lastSnapshot = { signals: cloneSignals(current.signals), top: [...current.top] };
    return {
      event: 'narrate',
      t_ms: finite(state.t_ms, now),
      agent_id: state.agent_id ?? this.agentId,
      state: {
        behavior: String(state.behavior ?? ''),
        energy: finite(state.energy),
        pos: [0, 1, 2].map(index => finite(state.pos?.[index])),
        yaw: finite(state.yaw),
        flying: Boolean(state.flying),
      },
      recent_behaviors: Array.isArray(state.recent_behaviors) ? state.recent_behaviors.slice(0, 5) : [],
      signals: current.signals,
      top: current.top,
      previous_line: this.previousLine,
    };
  }

  complete(text = '') {
    this.inFlight = false;
    if (typeof text === 'string') this.previousLine = Array.from(text).slice(0, 40).join('');
  }

  fail() {
    this.inFlight = false;
  }
}

export { DEFAULTS as NEURAL_NARRATOR_DEFAULTS };
