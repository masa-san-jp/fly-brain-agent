// Browser-side, stateful signal summariser. The arithmetic helpers and the pure brain-state
// interpreter are exported so narration can be tested without a Worker, DOM, WebSocket, or clock.
import VOCAB from './brainStateVocab.json' with { type: 'json' };

export const GROUP_KEYS = Object.freeze([
  'smell', 'taste', 'vision', 'loom', 'escape', 'walk', 'back', 'steer',
  'groom', 'court', 'octopamine', 'feed',
]);

export const SENSORY_GROUPS = new Set(['smell', 'taste', 'vision', 'loom']);
export const BRAIN_STATE_FACTS = Object.freeze(Object.keys(VOCAB.facts));
export const BRAIN_STATE_THRESHOLDS = Object.freeze({
  // Signal salience is (short-window mean - baseline) / (baseline + 2). The on/off
  // thresholds below deliberately leave a 0.10 hysteresis band to stop flicker.
  salienceOn: 0.25,
  salienceOff: 0.15,
  asymmetryOn: 0.18,
  asymmetryOff: 0.10,
  tasteOn: 0.20,
  tasteOff: 0.10,
  hungerLittleOn: 0.25,
  hungerLittleOff: 0.12,
  hungerStrongOn: 0.65,
  hungerStrongOff: 0.55,
  arousalOn: 0.60,
  arousalOff: 0.45,
});

const DEFAULTS = Object.freeze({
  intervalMs: 4_000,
  quietMs: 30_000,
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

function signalMap(signals) {
  return new Map((Array.isArray(signals) ? signals : []).map(signal => [signal.group, {
    salience: finite(signal.salience),
    asymmetry: finite(signal.asymmetry),
  }]));
}

function previousValues(previous) {
  if (!previous) return {};
  if (previous.values) return previous.values;
  return Object.fromEntries((previous.state_table || previous.table || []).map(({ fact, value }) => [fact, value]));
}

function hystereticBand(score, previous, { littleOn, littleOff, strongOn, strongOff }) {
  if (previous === '強い') {
    if (score >= strongOff) return '強い';
    if (score >= littleOff) return '少し';
    return 'なし';
  }
  if (previous === '少し') {
    if (score >= strongOn) return '強い';
    if (score >= littleOff) return '少し';
    return 'なし';
  }
  if (score >= strongOn) return '強い';
  if (score >= littleOn) return '少し';
  return 'なし';
}

function hystereticOn(score, previous, on, off, onValue, offValue) {
  return previous === onValue ? (score >= off ? onValue : offValue) : (score >= on ? onValue : offValue);
}

function movementOf(pose) {
  const behavior = String(pose?.behavior ?? '').toLowerCase();
  const drive = String(pose?.drive ?? '').toLowerCase();
  const cmd = pose?.cmd || {};
  if (behavior.includes('feed') || behavior.includes('proboscis')) return '食べている';
  if (behavior.includes('groom') || Boolean(cmd.grooming) || drive === 'groom') return '毛づくろい';
  if (behavior.includes('back') || finite(cmd.v) < -0.05 || drive === 'back') return '後ずさり';
  if (behavior.includes('turn') || Math.abs(finite(cmd.turn)) > 0.3 || drive === 'turn') return '向きを変えている';
  if (behavior.includes('walk') || finite(cmd.v) > 0.05 || drive === 'walk' || drive === 'search') return '歩いている';
  return '止まっている';
}

function valueFor(fact, value) {
  return VOCAB.facts[fact].includes(value) ? value : VOCAB.facts[fact][0];
}

function changedFacts(current, previous) {
  if (!previous) return [...BRAIN_STATE_FACTS];
  return BRAIN_STATE_FACTS.filter(fact => previous.values[fact] !== current.values[fact]);
}

/**
 * Deterministically translates group readouts and the worker pose into the small, Japanese
 * state table sent to the bridge. `previous` is optional and only supplies the previous table
 * for hysteresis; the function has no mutable state or clock dependency.
 *
 * Thresholds: group salience turns on at 0.25 and off at 0.15; left/right smell needs
 * |asymmetry| 0.18 and stays directional down to 0.10. Hunger uses max energy deficit,
 * AKH, arousal and normalised octopamine: little >= 0.25, strong >= 0.65, with off levels
 * 0.12 and 0.55. Taste uses 0.20/0.10; arousal uses 0.60/0.45.
 */
export function interpretBrainState(signals = [], pose = {}, previous = null) {
  const byGroup = signalMap(signals);
  const old = previousValues(previous);
  const strength = key => Math.max(0, finite(byGroup.get(key)?.salience));
  const nm = pose?.nm || {};
  const energy = clamp(finite(pose?.energy, 0.6), 0, 1);
  const hungerScore = Math.max(
    clamp((0.75 - energy) / 0.45, 0, 1),
    clamp(finite(nm.akh), 0, 1),
    clamp(finite(nm.arousal), 0, 1),
    clamp((finite(nm.oa) - 2) / 10, 0, 1),
  );
  const hunger = hystereticBand(hungerScore, old['空腹'], {
    littleOn: BRAIN_STATE_THRESHOLDS.hungerLittleOn,
    littleOff: BRAIN_STATE_THRESHOLDS.hungerLittleOff,
    strongOn: BRAIN_STATE_THRESHOLDS.hungerStrongOn,
    strongOff: BRAIN_STATE_THRESHOLDS.hungerStrongOff,
  });

  const smellSignal = byGroup.get('smell') || {};
  const smellActive = strength('smell') >= BRAIN_STATE_THRESHOLDS.salienceOn ||
    (old['匂い'] && old['匂い'] !== '変化なし' && strength('smell') >= BRAIN_STATE_THRESHOLDS.salienceOff);
  const smellAsymmetry = finite(smellSignal.asymmetry);
  let smell = '変化なし';
  if (smellActive) {
    const previousSmell = old['匂い'];
    if (previousSmell === '左から強まっている' && smellAsymmetry >= BRAIN_STATE_THRESHOLDS.asymmetryOff) smell = '左から強まっている';
    else if (previousSmell === '右から強まっている' && smellAsymmetry <= -BRAIN_STATE_THRESHOLDS.asymmetryOff) smell = '右から強まっている';
    else if (smellAsymmetry >= BRAIN_STATE_THRESHOLDS.asymmetryOn) smell = '左から強まっている';
    else if (smellAsymmetry <= -BRAIN_STATE_THRESHOLDS.asymmetryOn) smell = '右から強まっている';
    else smell = '正面';
  }

  const taste = hystereticOn(
    strength('taste'), old['味'], BRAIN_STATE_THRESHOLDS.tasteOn, BRAIN_STATE_THRESHOLDS.tasteOff,
    '味がする', 'なし',
  );
  const vision = hystereticOn(
    strength('vision'), old['視界'], BRAIN_STATE_THRESHOLDS.salienceOn, BRAIN_STATE_THRESHOLDS.salienceOff,
    '大きく変わった', '変化なし',
  );
  const escapeCommand = clamp(finite(pose?.cmd?.escape) / 40, 0, 1);
  const approach = Math.max(strength('loom'), strength('escape'), escapeCommand);
  const approaching = hystereticOn(
    approach, old['接近物'], BRAIN_STATE_THRESHOLDS.salienceOn, BRAIN_STATE_THRESHOLDS.salienceOff,
    '迫ってくる', 'なし',
  );
  const arousalScore = Math.max(
    clamp(finite(nm.arousal), 0, 1),
    clamp((finite(nm.oa) - 2) / 10, 0, 1),
  );
  const arousal = hystereticOn(
    arousalScore, old['気分/覚醒'], BRAIN_STATE_THRESHOLDS.arousalOn, BRAIN_STATE_THRESHOLDS.arousalOff,
    '高ぶっている', '落ち着いている',
  );

  const values = {
    '空腹': hunger,
    '匂い': smell,
    '味': valueFor('味', taste),
    '視界': vision,
    '接近物': approaching,
    '気分/覚醒': arousal,
    '体の動き': movementOf(pose),
  };
  const state_table = BRAIN_STATE_FACTS.map(fact => ({ fact, value: valueFor(fact, values[fact]) }));
  const changed = previous ? BRAIN_STATE_FACTS.filter(fact => old[fact] !== values[fact]) : [...BRAIN_STATE_FACTS];
  const signature = state_table.map(({ fact, value }) => `${fact}=${value}`).join('|');
  return { state_table, changed, signature, values };
}

/** Converts the selected fly's activity trace into state-change narration requests. */
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
    this.brainState = null;
    this.lastRequestedState = null;
    this.lastRequestedSignature = null;
    this.lastDeliveredState = null;
    this.lastDeliveredSignature = null;
    this.pendingState = null;
  }

  reset() {
    this.groups.forEach(group => { group.baseline = null; group.samples = []; });
    this.lastSampleAt = null;
    this.lastRequestedAt = -Infinity;
    this.lastSnapshot = null;
    this.previousLine = '';
    this.inFlight = false;
    this.brainState = null;
    this.lastRequestedState = null;
    this.lastRequestedSignature = null;
    this.lastDeliveredState = null;
    this.lastDeliveredSignature = null;
    this.pendingState = null;
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

  /** Add one activity sample and return a narrate event when a state gate allows it. */
  maybeNarrate(pose = {}, rawGroups, now = this.clock()) {
    const current = this.ingest(rawGroups, now);
    this.brainState = interpretBrainState(current.signals, pose, this.brainState);
    if (!this.enabled || this.inFlight || pose.alive === false) return null;

    const stateChanged = this.lastRequestedSignature === null || this.brainState.signature !== this.lastRequestedSignature;
    const quietDue = !stateChanged && now - this.lastRequestedAt >= this.options.quietMs;
    if (!stateChanged && !quietDue) return null;
    if (now - this.lastRequestedAt < this.options.intervalMs) return null;

    const changed = stateChanged ? changedFacts(this.brainState, this.lastRequestedState) : [];
    this.inFlight = true;
    this.lastRequestedAt = now;
    this.lastRequestedState = this.brainState;
    this.lastRequestedSignature = this.brainState.signature;
    this.pendingState = this.brainState;
    this.lastSnapshot = { signals: cloneSignals(current.signals), top: [...current.top] };
    return {
      event: 'narrate',
      t_ms: finite(pose.t_ms, now),
      agent_id: pose.agent_id ?? this.agentId,
      state: {
        behavior: String(pose.behavior ?? ''),
        energy: finite(pose.energy),
        pos: [0, 1, 2].map(index => finite(pose.pos?.[index])),
        yaw: finite(pose.yaw),
        flying: Boolean(pose.flying),
      },
      recent_behaviors: Array.isArray(pose.recent_behaviors) ? pose.recent_behaviors.slice(0, 5) : [],
      state_table: this.brainState.state_table,
      changed,
      signals: current.signals,
      top: current.top,
      previous_line: this.previousLine,
    };
  }

  complete(text = '') {
    this.inFlight = false;
    if (this.pendingState) {
      this.lastDeliveredState = this.pendingState;
      this.lastDeliveredSignature = this.pendingState.signature;
    }
    this.pendingState = null;
    if (typeof text === 'string') this.previousLine = Array.from(text).slice(0, 40).join('');
  }

  fail() {
    this.inFlight = false;
    this.lastRequestedSignature = this.lastDeliveredSignature;
    this.lastRequestedState = this.lastDeliveredState;
    this.lastRequestedAt = -Infinity;
    this.pendingState = null;
  }
}

export { DEFAULTS as NEURAL_NARRATOR_DEFAULTS };
