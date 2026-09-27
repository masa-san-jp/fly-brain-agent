// Pure behaviour-to-animation selection for the humanoid presentation layer.
// The simulation remains the source of truth; this function only interprets a pose.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function numberOr(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positionOf(pose) {
  const source = pose?.pos;
  return Object.freeze([
    numberOr(source?.[0]),
    numberOr(source?.[1]),
    numberOr(source?.[2]),
  ]);
}

function previousKey(prevState) {
  if (typeof prevState === 'string') return prevState;
  return prevState?.state ?? null;
}

// Speeds are what the viewer sees: arena units per wall-clock second of the
// rendered root (the simulation runs well below real time, so simulated cm/s
// would pick a sprint while the avatar barely moves). The avatar is 0.3 units
// tall, so with a 1.6 m human 1 m ≈ 0.19 units: walk ≈ 1.4 m/s, jog ≈ 3 m/s,
// sprint ≈ 6 m/s. Below MOVE_SPEED (≈ 0.1 m/s) the avatar stands.
const UNITS_PER_METRE = 0.3 / 1.6;
const MOVE_SPEED = 0.1 * UNITS_PER_METRE;
const CLIP_SPEED = Object.freeze({ walk: 1.4 * UNITS_PER_METRE, jog: 3 * UNITS_PER_METRE, sprint: 6 * UNITS_PER_METRE });
const WALK_SPEED = MOVE_SPEED;
const SPRINT_SPEED = CLIP_SPEED.sprint;

function locomotionWeights(speed) {
  // Triangular weights meeting at the three clips' natural speeds.
  const v = Math.abs(speed);
  if (v <= CLIP_SPEED.walk) return Object.freeze({ walk: 1, jog: 0, sprint: 0 });
  if (v <= CLIP_SPEED.jog) { const x = (v - CLIP_SPEED.walk) / (CLIP_SPEED.jog - CLIP_SPEED.walk); return Object.freeze({ walk: 1 - x, jog: x, sprint: 0 }); }
  const x = clamp((v - CLIP_SPEED.jog) / (CLIP_SPEED.sprint - CLIP_SPEED.jog), 0, 1);
  return Object.freeze({ walk: 0, jog: 1 - x, sprint: x });
}

function dominantLocomotion(weights) {
  return Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
}

function result(pose, prevState, state, action, extra = {}) {
  const cmd = pose?.cmd || {};
  const turn = clamp(numberOr(cmd.turn), -0.6, 0.6);
  return Object.freeze({
    state,
    action,
    previousState: previousKey(prevState),
    changed: previousKey(prevState) !== state,
    position: positionOf(pose),
    // Turn never changes the locomotion decision.  HumanoidRenderer applies
    // this small local twist after the selected clip has been evaluated.
    upperTwist: turn * 0.16,
    ...extra,
  });
}

/**
 * Select the presentation animation for one simulation pose.
 *
 * The avatar is a person walking, whatever the fly is doing: jumps, flight,
 * feeding and grooming are not acted out (the fly's inner state is voiced by
 * the narrator instead). Only death has its own clip; otherwise the on-screen
 * ground speed picks idle, back-walk or a walk/jog/sprint blend.
 */
export function selectAnim(pose = {}, prevState = null) {
  const groundSpeed = numberOr(pose.groundSpeed);

  if (pose.alive === false) return result(pose, prevState, 'death', 'death', { clip: 'death' });

  // Priorities 6–7: signed measured ground speed controls backward walking and
  // a continuous walk/jog/sprint blend. A high command with no displacement is
  // deliberately idle, preventing an avatar from running in place.
  // Playback follows the on-screen speed so the feet roughly match the ground
  // (a slow simulation shows a slow walk rather than running on the spot).
  if (groundSpeed < -MOVE_SPEED) return result(pose, prevState, 'backWalk', 'backWalk', { clip: 'backWalk', speed: groundSpeed,
    playbackRate: clamp(Math.abs(groundSpeed) / CLIP_SPEED.walk, 0.25, 1.5) });
  if (groundSpeed > MOVE_SPEED) {
    const blend = locomotionWeights(groundSpeed);
    const dominant = dominantLocomotion(blend);
    return result(pose, prevState, 'locomotion', dominant, { clip: 'locomotion', blend, speed: groundSpeed,
      playbackRate: clamp(groundSpeed / CLIP_SPEED[dominant], 0.25, 1.5) });
  }

  // Not moving on screen: stand.
  return result(pose, prevState, 'idle', 'idle', { clip: 'idle' });
}

export { locomotionWeights, WALK_SPEED, SPRINT_SPEED, MOVE_SPEED, CLIP_SPEED };
