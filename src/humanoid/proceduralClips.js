import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const AXES = Object.freeze({ x: new THREE.Vector3(1, 0, 0), y: UP, z: new THREE.Vector3(0, 0, 1) });

function bone(humanoid, name) {
  return humanoid?.getNormalizedBoneNode?.(name) || null;
}

function addRotationTracks(tracks, humanoid, specs, times = [0, 0.5, 1]) {
  for (const [name, axisName, angles] of specs) {
    const node = bone(humanoid, name);
    if (!node) continue;
    const axis = AXES[axisName] || AXES.x;
    const base = node.quaternion.clone();
    const values = new Float32Array(times.length * 4);
    const q = new THREE.Quaternion();
    for (let i = 0; i < times.length; i++) {
      q.copy(base).multiply(new THREE.Quaternion().setFromAxisAngle(axis, angles[i] ?? 0));
      q.toArray(values, i * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
  }
}

function clip(name, humanoid, specs, duration = 1) {
  const tracks = [];
  addRotationTracks(tracks, humanoid, specs);
  return new THREE.AnimationClip(name, duration, tracks);
}

/**
 * Small, deliberately conservative fallback poses. They are also used for
 * actions absent from the free UAL set (back-walk, rub-face and fall), so a
 * missing external animation never makes two state-machine states identical.
 */
export function createProceduralClips(humanoid) {
  const clips = new Map();
  clips.set('idle', clip('procedural_idle', humanoid, [
    ['chest', 'z', [0, 0.035, 0]], ['upperChest', 'z', [0, -0.025, 0]],
  ], 1.6));
  clips.set('walk', clip('procedural_walk', humanoid, [
    ['leftUpperArm', 'x', [0.35, -0.35, 0.35]], ['rightUpperArm', 'x', [-0.35, 0.35, -0.35]],
    ['leftUpperLeg', 'x', [-0.38, 0.38, -0.38]], ['rightUpperLeg', 'x', [0.38, -0.38, 0.38]],
  ], 0.85));
  clips.set('jog', clip('procedural_jog', humanoid, [
    ['leftUpperArm', 'x', [0.55, -0.55, 0.55]], ['rightUpperArm', 'x', [-0.55, 0.55, -0.55]],
    ['leftUpperLeg', 'x', [-0.65, 0.65, -0.65]], ['rightUpperLeg', 'x', [0.65, -0.65, 0.65]],
    ['leftLowerLeg', 'x', [0.4, 0, 0.4]], ['rightLowerLeg', 'x', [0.4, 0, 0.4]],
  ], 0.62));
  clips.set('sprint', clip('procedural_sprint', humanoid, [
    ['leftUpperArm', 'x', [0.8, -0.8, 0.8]], ['rightUpperArm', 'x', [-0.8, 0.8, -0.8]],
    ['leftUpperLeg', 'x', [-0.9, 0.9, -0.9]], ['rightUpperLeg', 'x', [0.9, -0.9, 0.9]],
    ['leftLowerLeg', 'x', [0.65, -0.1, 0.65]], ['rightLowerLeg', 'x', [0.65, -0.1, 0.65]],
  ], 0.45));
  clips.set('backWalk', clip('procedural_back_walk', humanoid, [
    ['leftUpperArm', 'x', [-0.25, 0.25, -0.25]], ['rightUpperArm', 'x', [0.25, -0.25, 0.25]],
    ['leftUpperLeg', 'x', [0.32, -0.32, 0.32]], ['rightUpperLeg', 'x', [-0.32, 0.32, -0.32]],
  ], 0.9));
  clips.set('crouch', clip('procedural_crouch', humanoid, [
    ['hips', 'x', [0.18, 0.22, 0.18]], ['spine', 'x', [0.25, 0.32, 0.25]],
    ['leftUpperLeg', 'x', [-0.55, -0.62, -0.55]], ['rightUpperLeg', 'x', [-0.55, -0.62, -0.55]],
    ['leftLowerLeg', 'x', [0.85, 0.95, 0.85]], ['rightLowerLeg', 'x', [0.85, 0.95, 0.85]],
  ], 1.2));
  clips.set('rubFace', clip('procedural_rub_face', humanoid, [
    ['leftUpperArm', 'z', [-1.0, -1.15, -1.0]], ['leftLowerArm', 'z', [-1.15, -1.35, -1.15]],
    ['rightUpperArm', 'z', [1.0, 1.15, 1.0]], ['rightLowerArm', 'z', [1.15, 1.35, 1.15]],
    ['neck', 'x', [0.1, -0.08, 0.1]],
  ], 0.8));
  clips.set('jump', clip('procedural_jump', humanoid, [
    ['hips', 'x', [-0.15, 0.1, -0.15]], ['spine', 'x', [-0.22, 0.15, -0.22]],
    ['leftUpperArm', 'z', [-0.8, -1.25, -0.8]], ['rightUpperArm', 'z', [0.8, 1.25, 0.8]],
    ['leftUpperLeg', 'x', [0.5, -0.25, 0.5]], ['rightUpperLeg', 'x', [0.5, -0.25, 0.5]],
  ], 0.9));
  clips.set('fall', clip('procedural_fall', humanoid, [
    ['hips', 'z', [0, 0.6, 1.1]], ['spine', 'x', [0, 0.35, 0.75]],
    ['leftUpperArm', 'z', [0, -0.7, -1.1]], ['rightUpperArm', 'z', [0, 0.7, 1.1]],
  ], 0.9));
  clips.set('death', clip('procedural_death', humanoid, [
    ['hips', 'x', [0, 0.45, 0.8]], ['spine', 'x', [0, 0.7, 1.25]],
    ['head', 'x', [0, 0.4, 0.9]], ['leftUpperArm', 'z', [0, -0.45, -0.8]], ['rightUpperArm', 'z', [0, 0.45, 0.8]],
  ], 1.4));
  return clips;
}
