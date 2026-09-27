import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { selectAnim } from './selectAnim.js';
import { retargetUALClips } from './retargetUAL.js';
import { createProceduralClips } from './proceduralClips.js';

const BODY_Z = 0.132;
const AVATAR_HEIGHT = 0.3;
const FLY_BODY_LENGTH = 0.025;
const MAX_INTERPOLATION_LAG = FLY_BODY_LENGTH * 0.1;
const CROSS_FADE_SECONDS = 0.2;
const DEFAULT_AVATAR = 'avatars/AvatarSample_A.vrm';
const FALLBACK_AVATAR = 'avatars/VRM1_Constraint_Twist_Sample.vrm';
const UAL_CLIP = 'animations/UAL1_Standard.glb';

function urlFor(base, path) {
  return `${String(base || '/').replace(/\/?$/, '/')}${path}`;
}

function lerpAngle(a, b, t) {
  let delta = (b - a + Math.PI) % (Math.PI * 2) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function posePosition(pose, previous, blend) {
  const p = pose?.pos || [0, 0, 0];
  const old = previous?.pos;
  const current = [p[0] || 0, p[1] || 0, p[2] || 0];
  if (!old || blend >= 1) return current;
  const interpolated = [
    old[0] + ((p[0] || 0) - old[0]) * blend,
    old[1] + ((p[1] || 0) - old[1]) * blend,
    old[2] + ((p[2] || 0) - old[2]) * blend,
  ];
  // Under a heavily loaded headless renderer the worker can deliver a sparse
  // snapshot. Do not let the presentation drift farther than 10% of the fly
  // body length; normal 30 Hz snapshots still use the existing interpolation.
  return Math.hypot(
    interpolated[0] - current[0], interpolated[1] - current[1], interpolated[2] - current[2],
  ) > MAX_INTERPOLATION_LAG ? current : interpolated;
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export class HumanoidRenderer {
  constructor({ scene, base = '/', avatarUrl = DEFAULT_AVATAR, animationUrl = UAL_CLIP } = {}) {
    this.scene = scene;
    this.base = base;
    this.avatarPath = avatarUrl;
    this.animationPath = animationUrl;
    this.instances = new Map();
    this.errors = [];
    this.vrmLoaded = false;
    this.animationLoaded = false;
    this.animationSource = 'procedural';
    this.ready = this.load();
  }

  async load() {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    this.loader = loader;
    try {
      this.avatarBuffer = await fetchBuffer(urlFor(this.base, this.avatarPath));
      this.avatarPathUsed = this.avatarPath;
    } catch (error) {
      this.errors.push({ path: this.avatarPath, error: String(error?.message || error) });
      // AvatarSample_A is intentionally a manual drop-in because VRoid Hub's
      // download requires an interactive/terms-acceptance flow.
      this.avatarBuffer = await fetchBuffer(urlFor(this.base, FALLBACK_AVATAR));
      this.avatarPathUsed = FALLBACK_AVATAR;
    }
    // Each fly gets its own parsed VRM (the bytes are fetched once): a
    // SkeletonUtils clone would copy the normalized rig without the VRMHumanoid
    // that propagates it to the raw bones, leaving the avatar in its rest pose.
    const vrm = await this.parseVRM();
    this.vrm = vrm;
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    this.avatarHeight = Math.max(1e-4, box.max.y - box.min.y);
    this.avatarScale = AVATAR_HEIGHT / this.avatarHeight;
    this.avatarOffsetZ = -BODY_Z - box.min.y * this.avatarScale;
    this.vrmLoaded = true;

    const procedural = createProceduralClips(vrm.humanoid);
    this.clips = new Map(procedural);
    try {
      const ual = await loader.loadAsync(urlFor(this.base, this.animationPath));
      this.ualClips = new Map(retargetUALClips(ual, vrm).map(clip => [clip.name, clip]));
      const choose = (key, name) => { if (this.ualClips.has(name)) this.clips.set(key, this.ualClips.get(name)); };
      choose('idle', 'Idle_Loop'); choose('walk', 'Walk_Loop'); choose('jog', 'Jog_Fwd_Loop'); choose('sprint', 'Sprint_Loop');
      choose('crouch', 'Crouch_Idle_Loop'); choose('jump', 'Jump_Loop'); choose('death', 'Death01');
      // Backing up = the walk cycle played in reverse (selectAnim gives a
      // negative rate). A separate clip object so it gets its own action; the
      // procedural fallback swings the arms from the T-pose rest and left them spread.
      if (this.ualClips.has('Walk_Loop')) {
        const reverse = this.ualClips.get('Walk_Loop').clone();
        reverse.name = 'Walk_Loop_reverse';
        this.clips.set('backWalk', reverse);
      }
      this.animationLoaded = this.ualClips.size > 0;
      this.animationSource = this.animationLoaded ? 'ual+procedural' : 'procedural';
    } catch (error) {
      this.errors.push({ path: this.animationPath, error: String(error?.message || error) });
      this.ualClips = new Map();
    }
    for (const instance of this.instances.values()) this.finishInstance(instance);
    return this;
  }

  async parseVRM() {
    const gltf = await this.loader.parseAsync(this.avatarBuffer.slice(0), '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('Loaded avatar is not a VRM');
    // VRM 0.x faces -Z; turn it to face +Z like VRM 1.0 (the retarget already
    // mirrors VRM 0.x tracks to match).
    VRMUtils.rotateVRM0(vrm);
    return vrm;
  }

  addFly(fly) {
    const root = new THREE.Group();
    root.name = `humanoid-root-${fly.id}`;
    root.userData.flyId = fly.id;
    root.userData.fly = fly;
    const heading = new THREE.Group();
    heading.name = `humanoid-heading-${fly.id}`;
    root.add(heading);
    const model = new THREE.Group();
    model.name = `humanoid-model-${fly.id}`;
    model.rotation.x = Math.PI / 2; // VRM is Y-up; arena is Z-up.
    model.position.z = this.avatarOffsetZ || -BODY_Z;
    if (this.avatarScale) model.scale.setScalar(this.avatarScale);
    heading.add(model);

    // Selection geometry is intentionally invisible but remains raycastable.
    const proxy = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.018, AVATAR_HEIGHT - 0.036, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
    );
    proxy.name = `humanoid-hit-capsule-${fly.id}`;
    proxy.position.z = AVATAR_HEIGHT * 0.5;
    proxy.rotation.x = Math.PI / 2;
    proxy.userData.flyId = fly.id;
    proxy.userData.fly = fly;
    root.add(proxy);
    this.scene.add(root);

    const instance = { fly, root, heading, model, proxy, actions: new Map(), actionKey: null, animationState: null, mixer: null, lastTime: null, ready: false };
    this.instances.set(fly.id, instance);
    fly.humanoid = instance;
    if (this.vrmLoaded) this.finishInstance(instance);
    return instance;
  }

  async finishInstance(instance) {
    if (!this.vrmLoaded || instance.ready || instance.loading) return;
    instance.loading = true;
    const vrm = this.vrmClaimed ? await this.parseVRM() : this.vrm;
    this.vrmClaimed = true;
    instance.model.position.z = this.avatarOffsetZ;
    instance.model.scale.setScalar(this.avatarScale);
    instance.model.add(vrm.scene);
    instance.vrm = vrm;
    instance.avatar = vrm.scene;
    instance.mixer = new THREE.AnimationMixer(vrm.scene);

    for (const [key, clip] of this.clips) {
      const action = instance.mixer.clipAction(clip);
      action.enabled = false;
      action.setEffectiveWeight(0);
      if (key === 'death') action.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
      else action.setLoop(THREE.LoopRepeat, Infinity);
      instance.actions.set(key, action);
    }
    instance.ready = true;
    instance.root.userData.vrmLoaded = true;
    instance.root.updateMatrixWorld(true);
  }

  setAnimation(instance, selection, dt) {
    if (!instance.ready) return;
    const desired = selection.action;
    const next = instance.actions.get(desired) || instance.actions.get('idle');
    if (!next) return;
    if (instance.actionKey !== desired) {
      const previous = instance.actions.get(instance.actionKey);
      next.reset().setEffectiveTimeScale(selection.playbackRate ?? 1).setEffectiveWeight(1).play();
      if (previous && previous !== next) next.crossFadeFrom(previous, CROSS_FADE_SECONDS, true);
      instance.actionKey = desired;
      instance.fadeRemaining = CROSS_FADE_SECONDS;
    }
    instance.fadeRemaining = Math.max(0, (instance.fadeRemaining || 0) - dt);
    if (instance.fadeRemaining > 0) return;

    if (selection.state === 'locomotion') {
      for (const key of ['walk', 'jog', 'sprint']) {
        const action = instance.actions.get(key); if (!action) continue;
        const weight = selection.blend?.[key] || 0;
        action.enabled = weight > 0;
        action.setEffectiveWeight(weight).setEffectiveTimeScale(selection.playbackRate ?? 1);
        if (weight > 0 && !action.isRunning()) action.play();
      }
    } else {
      for (const [key, action] of instance.actions) {
        const active = key === desired;
        action.enabled = active;
        action.setEffectiveWeight(active ? 1 : 0).setEffectiveTimeScale(active ? (selection.playbackRate ?? 1) : 1);
      }
    }
  }

  update(fly, pose, previous, blend, now = performance.now()) {
    const instance = this.instances.get(fly.id);
    if (!instance) return;
    const p = posePosition(pose, previous, blend);
    // Feet stay on the floor: the fly's height (jumps, flight) is not shown.
    instance.root.position.set(p[0], p[1], BODY_Z);
    const yaw = previous?.yaw !== undefined && blend < 1 ? lerpAngle(previous.yaw, pose.yaw || 0, blend) : (pose.yaw || 0);
    instance.heading.rotation.z = yaw + Math.PI / 2;
    const wallDt = instance.lastTime == null ? 0 : Math.max(0, (now - instance.lastTime) / 1000);
    const dt = Math.min(0.05, wallDt);
    instance.lastTime = now;
    // On-screen ground speed: displacement of the rendered root per wall-clock
    // second, signed by the heading, smoothed over ~0.4 s of wall time.
    let groundSpeed = instance.groundSpeed || 0;
    if (instance.lastRootXY && wallDt > 0) {
      const dx = p[0] - instance.lastRootXY[0], dy = p[1] - instance.lastRootXY[1];
      const forward = dx * Math.cos(yaw) + dy * Math.sin(yaw);
      const raw = Math.hypot(dx, dy) / wallDt * (forward < -0.5 * Math.hypot(dx, dy) ? -1 : 1);
      groundSpeed += (raw - groundSpeed) * Math.min(1, wallDt / 0.4);
    }
    instance.lastRootXY = [p[0], p[1]];
    instance.groundSpeed = groundSpeed;
    const selection = selectAnim({ ...pose, groundSpeed }, instance.animationState);
    instance.animationState = selection;
    this.setAnimation(instance, selection, dt);
    instance.mixer?.update(dt);
    // normalized rig → raw bones, then constraints and expressions. Spring
    // bones (hair/cloth) are left out: at the arena's ~0.19 avatar scale and
    // Z-up world they flare instead of hanging, so hair stays in its rest shape.
    if (instance.vrm) {
      instance.vrm.humanoid.update();
      instance.vrm.nodeConstraintManager?.update();
      instance.vrm.expressionManager?.update();
    }
    instance.root.updateMatrixWorld(true);
  }

  raycast(raycaster) {
    const proxies = [...this.instances.values()].filter(instance => instance.root.visible).map(instance => instance.proxy);
    return raycaster.intersectObjects(proxies, false)[0] || null;
  }
}

export const HUMANOID_ASSET_PATHS = Object.freeze({ avatar: DEFAULT_AVATAR, fallbackAvatar: FALLBACK_AVATAR, animation: UAL_CLIP });
