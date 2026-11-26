// zumi-avatar-core (T-31-ROOM-live-b P1): the part of Zumi's avatar that is not specific to the main webview -- the VRM
// load (three-vrm path), the mouth and held-emotion drive, and the idle life + gaze. One instance per mount: the main
// webview builds one now, the room pack's guest webview builds another later (P1 part 2); instances share nothing.
//
//   const core = createAvatarCore({ random });
//   const { vrm } = await core.load(urlOrArrayBuffer, { onProgress });   // prepared VRM, or null when the file holds none
//   core.bind(vrm, camera);
//   core.setMouth({ aa, ih, ou, ee, oh } | null);  core.setEmotion('happy', 0.8 | undefined) / setEmotion(null);
//   core.update(dt, nowMs);   // standalone frame: life + gaze + mouth + emotion, bones and expressions applied, vrm.update
//
// The main webview's ReflexEngine is a client of the same core: it shares `core.gaze` (life + gaze state and layers) and
// the pose writers, and adds gestures, IK arms and clips on top. This module imports only three, three-vrm, the reflex
// schema/accumulator and model-facing: nothing of the app (no IPC, i18n or talk), so it can be bundled into a guest.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { prepareVrm } from '../model-facing.js';
import { ChannelAcc } from '../reflex/player.js';
import { LifeGaze } from './life-gaze.js';
import { MOUTH, torsoNodes, applyTorso, mixExpressions, applyExpressions } from './pose.js';

export { LifeGaze, MOUTH, applyTorso, mixExpressions, applyExpressions };

const HELD_EMOTION_WEIGHT = 0.8; // same fixed weight the talk director holds an emotion at, so a model cannot over-drive the face

export function createAvatarCore({ random = Math.random } = {}) {
  const gaze = new LifeGaze({ random });
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const acc = new ChannelAcc();
  let vrm = null, camera = null, nodes = null, mouth = null, emotion = null, state = 'idle', hold = 0;

  return {
    gaze,
    loader, // the GLTFLoader with the VRM plugin: the talk path's hidden rig probe parses the same bytes with it
    get vrm() { return vrm; },
    get camera() { return camera; },

    /** url (string) or file bytes (ArrayBuffer) -> { vrm, gltf }, cleaned up like every VRM load path; null if not a VRM. */
    async load(source, { onProgress } = {}) {
      const gltf = typeof source === 'string' ? await loader.loadAsync(source, onProgress) : await loader.parseAsync(source, '');
      const loaded = gltf.userData.vrm;
      if (!loaded) { VRMUtils.deepDispose(gltf.scene); return null; }
      prepareVrm(gltf, loaded);
      return { vrm: loaded, gltf };
    },
    dispose(model) { VRMUtils.deepDispose(model.scene); },

    /** Points the model's eyes at the gaze target and remembers the camera the gaze is measured against. */
    bind(model, cam) {
      vrm = model; camera = cam; nodes = torsoNodes(model);
      if (model.lookAt) { model.lookAt.target = gaze.gazeObj; model.lookAt.autoUpdate = true; }
    },
    unbind() { vrm = null; camera = null; nodes = null; },

    setMouth(weights) { mouth = weights || null; },
    /** 'idle' | 'listening' | 'thinking' | 'speaking' (the stage `state` enum): thinking calms the sway and holds the idle glances. */
    setState(name) { state = ['idle', 'listening', 'thinking', 'speaking'].includes(name) ? name : 'idle'; },
    snapshot() { return { state, mouth, emotion }; },
    /** 0..1, faded by the caller: the idle sway and the breath go still (the room holds her torso under a planned motion). */
    setHold(k) { hold = Math.min(1, Math.max(0, Number(k) || 0)); },
    /** A VRM expression preset name (the tag -> preset map lives with the chat brain), or null to release. */
    setEmotion(name, weight = HELD_EMOTION_WEIGHT) { emotion = name ? { name, weight } : null; },

    /** One standalone frame (no gestures, arms or clips): life, gaze, mouth, held emotion -> bones + expressions. */
    update(dt, now = performance.now()) {
      if (!vrm) return;
      dt = Math.min(dt, 0.1);
      acc.reset();
      gaze.lifeLayer(acc, now, { camera, busy: state === 'thinking' ? 0.5 : 0, sleepy: false, typing: false, speaking: Boolean(mouth) || state === 'speaking', working: false, hold });
      if (mouth) for (const m of MOUTH) acc.expr[m] = mouth[m] || 0; // while she speaks the voice owns the mouth
      if (emotion) acc.expression(emotion.name, emotion.weight);
      gaze.gazeLayer(acc, now, dt, camera, nodes.head || vrm.scene);
      applyTorso(nodes, acc.bones);
      applyExpressions(vrm, mixExpressions(acc.expr));
      vrm.update(dt);
    },
  };
}
