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

function locomotionWeights(v) {
  // v is the brain's forward command, not a world-space displacement.  The
  // triangular weights make the three UAL clips meet at walk/jog/sprint speeds.
  const x = clamp((v - 0.05) / 0.95, 0, 1);
  return Object.freeze({
    walk: clamp(1 - x * 2, 0, 1),
    jog: x <= 0.5 ? x * 2 : (1 - x) * 2,
    sprint: clamp((x - 0.5) * 2, 0, 1),
  });
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
 * This deliberately uses exact behaviour labels for feeding and escape jump.
 * In particular, "proboscis extended" is an idle presentation state and is
 * not treated as feeding.
 */
export function selectAnim(pose = {}, prevState = null) {
  const behavior = String(pose.behavior ?? '');
  const cmd = pose.cmd || {};
  const v = numberOr(cmd.v);

  // Priority 1: death always wins, even if the final pose still carries a
  // locomotor command or a stale behaviour label.
  if (pose.alive === false) return result(pose, prevState, 'death', 'death', { clip: 'death' });

  // Priority 2: escape jump remains a valid humanoid action.
  if (behavior === 'escape jump') return result(pose, prevState, 'jump', 'jump', { clip: 'jump' });

  // Voluntary takeoff is gated off for humanoid mode.  A genuine airborne
  // pose can still be represented by the distinct fall fallback; there is no
  // separate flight animation in this phase.
  if (pose.flying === true || behavior.startsWith('flying')) {
    return result(pose, prevState, 'fall', 'fall', { clip: 'fall' });
  }

  // Priority 4: feeding is exact.  Proboscis extension while standing is not
  // feeding because the simulation emits that label while idle.
  if (behavior === 'feeding') return result(pose, prevState, 'feeding', 'crouch', { clip: 'crouch' });

  // Priority 5: grooming is driven by the command flag, not by a label.
  if (Boolean(cmd.grooming)) return result(pose, prevState, 'grooming', 'rubFace', { clip: 'rubFace' });

  // Priorities 6–7: signed forward command controls backward walking and a
  // continuous walk/jog/sprint blend.  Turn is intentionally absent here.
  if (v < -0.05) return result(pose, prevState, 'backWalk', 'backWalk', { clip: 'backWalk', speed: v });
  if (v > 0.05) {
    const blend = locomotionWeights(v);
    return result(pose, prevState, 'locomotion', dominantLocomotion(blend), { clip: 'locomotion', blend, speed: v });
  }

  // Priority 8: both standing and proboscis extended are idle.
  return result(pose, prevState, 'idle', 'idle', { clip: 'idle' });
}

export { locomotionWeights };
