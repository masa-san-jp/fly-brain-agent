import * as THREE from 'three';

// Names in Quaternius' Unreal/Godot glTF export.  The map follows the same
// normalized-bone strategy as three-vrm's Mixamo example, with the UAL
// mannequin names substituted for Mixamo names.
const UAL_TO_VRM = Object.freeze({
  pelvis: 'hips',
  spine_01: 'spine',
  spine_02: 'chest',
  spine_03: 'upperChest',
  neck_01: 'neck',
  Head: 'head',
  clavicle_l: 'leftShoulder', upperarm_l: 'leftUpperArm', lowerarm_l: 'leftLowerArm', hand_l: 'leftHand',
  thigh_l: 'leftUpperLeg', calf_l: 'leftLowerLeg', foot_l: 'leftFoot', ball_l: 'leftToes',
  clavicle_r: 'rightShoulder', upperarm_r: 'rightUpperArm', lowerarm_r: 'rightLowerArm', hand_r: 'rightHand',
  thigh_r: 'rightUpperLeg', calf_r: 'rightLowerLeg', foot_r: 'rightFoot', ball_r: 'rightToes',
});

const FALLBACK_BONES = Object.freeze({
  upperChest: ['chest', 'spine'],
  chest: ['spine'],
  neck: ['head'],
  leftShoulder: ['leftUpperArm'],
  rightShoulder: ['rightUpperArm'],
  leftToes: ['leftFoot'],
  rightToes: ['rightFoot'],
});

function normalizedBone(humanoid, name) {
  if (!humanoid?.getNormalizedBoneNode) return null;
  const candidates = [name, ...(FALLBACK_BONES[name] || [])];
  for (const candidate of candidates) {
    const node = humanoid.getNormalizedBoneNode(candidate);
    if (node) return node;
  }
  return null;
}

function sourceHipsHeight(sourceScene) {
  const hips = sourceScene.getObjectByName('pelvis');
  if (hips) {
    const p = new THREE.Vector3();
    hips.getWorldPosition(p);
    if (Math.abs(p.y) > 1e-5) return Math.abs(p.y);
  }
  const box = new THREE.Box3().setFromObject(sourceScene);
  return Math.max(1e-5, (box.max.y - box.min.y) * 0.5);
}

function targetHipsHeight(vrm) {
  const y = vrm?.humanoid?.normalizedRestPose?.hips?.position?.[1];
  return Number.isFinite(y) && Math.abs(y) > 1e-5 ? Math.abs(y) : 1;
}

function isQuaternionTrack(track) {
  return track instanceof THREE.QuaternionKeyframeTrack || track.ValueTypeName === 'quaternion';
}

function isVectorTrack(track) {
  return track instanceof THREE.VectorKeyframeTrack || track.ValueTypeName === 'vector';
}

/**
 * Convert UAL glTF clips to tracks targeting the VRM normalized humanoid rig.
 * Root motion is intentionally ignored: arena.js owns the root position/yaw.
 */
export function retargetUALClips(gltf, vrm) {
  const sourceScene = gltf.scene || gltf.scenes?.[0];
  if (!sourceScene || !vrm?.humanoid) return [];
  sourceScene.updateMatrixWorld(true);
  const hipsScale = targetHipsHeight(vrm) / sourceHipsHeight(sourceScene);
  const metaVersion = vrm.meta?.metaVersion;
  const clips = [];

  for (const sourceClip of gltf.animations || []) {
    const tracks = [];
    for (const sourceTrack of sourceClip.tracks) {
      const [sourceName, propertyName] = sourceTrack.name.split('.');
      const canonical = UAL_TO_VRM[sourceName];
      if (!canonical || (propertyName !== 'quaternion' && propertyName !== 'position')) continue;
      const targetNode = normalizedBone(vrm.humanoid, canonical);
      const sourceNode = sourceScene.getObjectByName(sourceName);
      if (!targetNode || !sourceNode) continue;

      if (isQuaternionTrack(sourceTrack)) {
        const restRotationInverse = new THREE.Quaternion();
        const parentRestWorldRotation = new THREE.Quaternion();
        sourceNode.getWorldQuaternion(restRotationInverse).invert();
        sourceNode.parent?.getWorldQuaternion(parentRestWorldRotation);
        const converted = new Float32Array(sourceTrack.values.length);
        const q = new THREE.Quaternion();
        for (let i = 0; i < sourceTrack.values.length; i += 4) {
          q.fromArray(sourceTrack.values, i)
            .premultiply(parentRestWorldRotation)
            .multiply(restRotationInverse);
          q.toArray(converted, i);
          if (metaVersion === '0') {
            converted[i] *= -1; converted[i + 2] *= -1;
          }
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${targetNode.name}.quaternion`, sourceTrack.times, converted));
      } else if (isVectorTrack(sourceTrack) && canonical === 'hips') {
        // UAL keys the pelvis in its parent's local frame (other units/axes than
        // the VRM rig), so take each key through the parent's rest world matrix
        // and rescale world-space height to the VRM's hips height.
        const converted = new Float32Array(sourceTrack.values.length);
        const parentWorld = sourceNode.parent ? sourceNode.parent.matrixWorld : new THREE.Matrix4();
        const v = new THREE.Vector3();
        for (let i = 0; i < sourceTrack.values.length; i += 3) {
          v.fromArray(sourceTrack.values, i).applyMatrix4(parentWorld).multiplyScalar(hipsScale);
          v.toArray(converted, i);
          if (metaVersion === '0') { converted[i] *= -1; converted[i + 2] *= -1; }
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${targetNode.name}.position`, sourceTrack.times, converted));
      }
    }
    if (tracks.length) clips.push(new THREE.AnimationClip(sourceClip.name, sourceClip.duration, tracks));
  }
  return clips;
}

export { UAL_TO_VRM };
