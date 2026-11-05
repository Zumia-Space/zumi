// Zumi renderer bootstrap: three.js stage + VRM loading + UI shell + reflex engine wiring.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Catalog, ReflexEngine, ClipLayer, attachInput } from './reflex/index.js';
import { runSelftest } from './selftest/index.js';
import { createTalk, talkUi } from './talk/index.js';
import { createAgeConfirm } from './talk/age-confirm.js';
import { createWorkLoop } from './talk/work-loop.js';
import { initSay } from './talk/say.js';
import { runDemo } from './demo.js';
import { initSettings } from './settings.js';
import { initMarket } from './market.js';
import { initPhoneCard } from './phone-card.js';
import { initSettingsTabs } from './settings-tabs.js';
import { initRhythmCard } from './rhythm-card.js';
import { initBoardSignin } from './board-signin.js';
import { initRoomSettings } from './room-settings.js';
import { sceneLabel } from './room/messages.js';
import { initUsage } from './usage.js';
import { initRoleModels } from './role-models.js';
import { initBrainKey } from './brain-key-card.js';
import { initHud } from './hud/hud.js';
import { createWorkSignal } from './hud/work-signal.js';
import { initUpdateUi } from './update-ui.js';
import { initProfileImport } from './profile-import.js';
import { isPublicBuild, applyPublicShell } from './public-build.js';
import { initNodeSetup, nodeSetupOpen } from './node-setup.js';
import { initKeyGuide } from './key-guide.js';
import { initFreeKeyGuide } from './free-key-guide.js';
import { initSidecarStatus } from './sidecar-status.js';
import { prepareVrm } from './model-facing.js';
import { loadRoom } from './room/room-loader.js';
import { placeZumi, standTransform, frameStageCamera, isViewBlocked, projectLookTargets } from './room/room-stage.js';
import { loadRoomV2 } from './room/room-loader-v2.js';
import { CameraDirector, setFloatCloseSoleY } from './room/camera-director.js';
import { SceneVideo } from './room/scene-video.js';
import { Chair3D } from './room/chair3d.js';
import { measureSeatDropM, measureHipOffsetXZ, placeSeated, enterSeated, clearSeatedPose } from './room/seat.js';
import { FLOAT, readStageMode, saveStageMode, parseFloatOverrides, placeFloat, enter as enterFloat, exit as exitFloat, update as updateFloat } from './room/float-mode.js';
import { HoloScreen, workPanelOn } from './room/holo-screen.js';
import { readHoloPrefs, saveHoloPrefs, resolveHolo } from './room/float-holo-prefs.js';
import { FloatShadow, SHADOW_RUNTIME } from './room/float-shadow.js';
import { CameraRegister } from './room/camera-register.js';
import { SeatFit, VIEW_FIT } from './room/seat-fit.js';
import { createLookTuning } from './room/look-tuning.js';
import { JEV_LABELS } from './talk/jevlabels.js';
import { JevSelector } from './talk/jevSelector.js';
import { t, apply, setLocale, getLocale, onLocaleChange, setPublicBuild, osUiLang } from './i18n.js';
import { readTheme, applyTheme, onThemeChange, withBoardTheme } from './theme.js';
import { DEFAULT_MODEL_FILE, isDefaultModelActive, modelLabel, restoreDefaultModel } from './default-model.js';

const $ = (id) => document.getElementById(id);
const zumi = window.zumi;

async function main() {
  // Whole-app theme (R1): the next-UI build writes data-theme="blue" into index.html; apply the saved pick before anything else so another theme never flashes blue.
  // A build without next/ has no data-theme and no theme setting, so it looks as in 0.2.11 (esbuild drops this line).
  if (__ZUMI_NEXT_UI__) applyTheme(readTheme());
  // Tauri only (no-op in Electron): the sidecar can die and restart under the app, and the owner must see that
  // (PARITY-PLAN 13). Registered before the first rpc so a death during boot still paints.
  initSidecarStatus({ t });
  initNodeSetup();
  const info = await zumi.info();
  setPublicBuild(isPublicBuild(info));
  if (isPublicBuild(info)) applyPublicShell(document);
  $('app-version').textContent = `v${info.version}`;
  $('about-version').textContent = info.version; // Settings > App > About: always visible, unlike the dev-only sidebar tag
  // Views this BUILD turns off (Thu 16:00 talk-QC build, option C: work off) -- main.js's app:info.disabledViews.
  const disabledViews = new Set(Array.isArray(info.disabledViews) ? info.disabledViews : []);
  // UI language: persisted per user in the app's settings store (settings.json uiLang). Until one is saved (first run) the host answers
  // the OS locale's language that the webview reports (i18n.js osUiLang: vi / zh, else English); a saved choice always wins.
  let savedLang = 'en';
  try { if (zumi.ui) savedLang = await zumi.ui.getLang(osUiLang(navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])); } catch { /* keep English */ }
  setLocale(savedLang);
  const paintLangButtons = () => { for (const b of document.querySelectorAll('#lang-switch button')) b.setAttribute('aria-checked', String(b.dataset.lang === getLocale())); };
  apply(document);
  paintLangButtons();
  const [modelList, clipList, catalog, roomList] = await Promise.all([zumi.listModels(), zumi.listClips(), Catalog.load('gestures/'), zumi.rooms.list()]);
  const clips = new ClipLayer();
  clips.setAvailable(clipList);

  // ---------- three.js stage ----------
  const stageEl = $('stage');
  const canvas = $('stage-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.95);
  key.position.set(0.6, 1.4, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcc8ff, 1.1);
  rim.position.set(-1.2, 1.2, -1.5);
  scene.add(rim);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const defaultLights = [key, rim, ambient]; // T-31 camera modes round 3: a v2 view's own `lights` hides these while it is active
  // Hologram screen light (T-31 float-holo pilot): created ONCE here and always in the scene, intensity 0 while
  // the mode is off. Adding a PointLight later changes NUM_POINT_LIGHTS and recompiles every MToon program (a
  // visible hitch), so it must exist from the start. holo-screen.js owns its colour/intensity/falloff per frame
  // (it overrides this distance with the short SCREEN_LIGHT_DISTANCE, so only her screen-facing side is lit).
  const screenLight = new THREE.PointLight(0xffffff, 0, 0.85, 2);
  scene.add(screenLight);

  const plateCanvas = $('stage-plate');
  const plateCtx = plateCanvas.getContext('2d');
  const registerOverlay = $('cam-register-overlay');
  const lookTuningPanel = $('look-tuning-panel');
  const roomViewPicker = $('room-view-picker');
  const roomViewSelect = $('room-view-select');
  const resize = () => {
    const r = stageEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    // The plate canvas draws in CSS pixels (drawImage, no DPR scaling needed for a cross-faded background image).
    plateCanvas.width = r.width; plateCanvas.height = r.height;
    registerOverlay.width = r.width; registerOverlay.height = r.height;
  };
  new ResizeObserver(resize).observe(stageEl);
  resize();

  const engine = new ReflexEngine({ catalog, clips });
  // CameraDirector (T-31 camera modes): idle for v1 rooms / no room (director.room stays null, update()/drawPlate()
  // are then no-ops) -- only a v2 room ever calls director.setRoom(...). Lives outside the player/rig; see the
  // module header for the latency-gate reasoning.
  let seatDropM = 0; // the CURRENT model's ankle-anchored seat drop (measured once per model/room bind, seat.js:measureSeatDropM) -- same number for every view, round 2
  let hipOffsetXZ = null; // the CURRENT model's hip-joint-to-root local offset (measureHipOffsetXZ) -- also model-only, not per-view
  const director = new CameraDirector({
    engine, camera, plateCtx, defaultLights, disabledViews,
    setLookTargets: (targets) => engine.setLookTargets(targets),
    // Round 6: a per-view seat.pose (e.g. work's 'sit-work' vs talk/room's default 'sit-idle') needs its OWN
    // sustained clip, which enterSeated() can only switch to asynchronously (clip load/warm) -- but placeSeat
    // itself must stay synchronous (CameraDirector's own latency contract: a view switch can never await
    // I/O). Placement runs synchronously here as before; the pose switch is fired WITHOUT awaiting it --
    // enterSeated is idempotent per pose name (a no-op when that pose is already playing, the common case:
    // most switches are between two views that share 'sit-idle'), so this costs nothing when the pose hasn't
    // actually changed, and briefly shows the PREVIOUS pose's legs/arms for the few frames a real pose switch
    // takes to warm -- the same one-time cost enterSeated's own header already documents for the very first
    // seat, now paid again only on the (rarer) cut between two views whose poses actually differ.
    // T-31 chair fix: seatFit.adjustSeat() re-seats her ON the painted cushion (height + seat depth per view) -- see seat-fit.js
    placeSeat: (seat) => { if (current) { if (stageMode === 'float') { placeFloat(engine, seat, floatRuntime); return; } placeSeated(engine, seatFit.adjustSeat(seat, director.room && Object.keys(director.room.views).find((n) => director.room.views[n].seat === seat), seatDropM), seatDropM, hipOffsetXZ); enterSeated(engine, seat.pose).catch((e) => console.error('seat.js: pose switch failed', e)); } },
  });
  // T-31 chair fix: per-frame post-pass -- legs to the painted chair, fingertips to the painted keys (seat-fit.js)
  const seatFit = new SeatFit({ engine });
  const camRegister = new CameraRegister({ director, overlayCanvas: registerOverlay, zumiRoomsV2: zumi.rooms.v2, t });
  // Look-tuning panel (T-31 camera modes, owner priority shift 03-10): live camera-framing + grading overrides,
  // dev-only. Sets director.getFramingOverride itself (see look-tuning.js) -- a plain property assignment, not a
  // constructor option, so the panel can be created after the director without restructuring its constructor.
  const lookTuning = createLookTuning({ director, rim, plateCanvas, stageCanvas: canvas, panelEl: lookTuningPanel, zumi });
  lookTuning.load();
  // Floating mode (T-31 float-holo pilot): renderer-only toggle, OFF unless localStorage says 'float'
  // (float-mode.js owns the key + read/save). Default 'seated' keeps the shipped 0.2.3 path unchanged.
  let stageMode = readStageMode();
  // T-31 0.2.6: the reflex clamp follows the panel, not the stored mode. The engine starts unclamped (no panel can be
  // up before applyStageMode() brings it up for a room that has a talk view), so a saved float launch whose current
  // room has no talk view never over-clamps. applyStageMode() is the single owner of both states.
  // While float is on, the talk view uses the FLOAT_WIDE crop instead of CHEST_UP. Wraps whatever lookTuning
  // installed (a plain property assignment), preserving its grading fields; chestUp is cleared so the crop
  // preset chain picks FLOAT_WIDE, not CHEST_UP.
  const baseGetFramingOverride = director.getFramingOverride;
  // `floatFraming` picks WHICH float crop is live: 'wide' (default, whole body) or 'close' (head-to-knees, so the
  // rim and the panel read). The harness's `--framing close` sets it via __zumiScene.float.setFraming (dev only).
  let floatFraming = 'wide';
  // r6 parameter sweep: the box sets these four values at RUNTIME (URL query at launch, or the dev hook between
  // captures). `floatRuntime` is a copy, so the shipped FLOAT constants are never mutated by a tuning run.
  const floatRuntime = { ...FLOAT };
  const applyFloatOverrides = (o = {}) => {
    if (Number.isFinite(o.soleY)) { floatRuntime.soleY = o.soleY; setFloatCloseSoleY(o.soleY); }
    if (Number.isFinite(o.centerBackM)) SHADOW_RUNTIME.centerBackM = o.centerBackM;
    holo.setRim({ rimMul: o.rimMul, fresnelPower: o.fresnelPower });
    if (current && currentRoomV2 && stageMode === 'float' && currentRoomV2.views.talk) placeFloat(engine, currentRoomV2.views.talk.seat, floatRuntime);
  };
  const urlOverrides = parseFloatOverrides(typeof location !== 'undefined' ? location.search : '');
  director.getFramingOverride = (name) => {
    const base = baseGetFramingOverride(name);
    if (name === 'talk' && stageMode === 'float') return { ...(base || {}), chestUp: false, float: floatFraming !== 'close', floatClose: floatFraming === 'close' };
    return base;
  };
  let currentRoomV2Id = null; // the v2 room's own id (for camRegister.setRoom / the save IPC) -- null when not on a v2 room

  // ---------- video rooms (T-31 room picker): "Current room (default)" or a looping room video behind the talk view ----------
  // The pick persists in settings.json (main: scene-rooms.mjs). It only applies on top of the painted v2 room (the videos
  // are registered to its talk plate); any other room, or 'current', shows the plate exactly as before.
  const sceneVideo = new SceneVideo();
  const scenePicker = $('scene-picker');
  const sceneSelect = $('scene-select');
  let sceneList = { selected: 'current', geometry: null, rooms: [] };
  let sceneApplyToken = 0;
  // Launch order (0.2.2 RC box runs): the Jev variety warm used to be one ~27 s main-thread task right after the model
  // loaded, and the video room + chair waited behind it. Now it starts once the launch has settled -- the room/video
  // applied and her seat + chair placed (or 15 s at the latest) -- and runs one rig check per idle slice.
  let settleScene, settleSeat;
  const launchSettled = Promise.race([Promise.all([new Promise((r) => { settleScene = r; }), new Promise((r) => { settleSeat = r; })]), new Promise((r) => setTimeout(r, 15000))]);
  const idleSlice = () => new Promise((r) => requestIdleCallback(() => r(), { timeout: 500 }));
  // Never a chairless video room: with a 3D chair picked, the video waits until applyChair has attached it (or given up:
  // load failed, so the painted cut-out is back). 20 s cap so a model that never loads cannot hold the room forever.
  let chairWaiters = [];
  const chairSettled = () => new Promise((r) => { chairWaiters.push(r); setTimeout(r, 20000); });
  const settleChair = () => { const w = chairWaiters; chairWaiters = []; for (const r of w) r(); };
  // (currentRoomV2 is declared further down; these only run after a room switch or a user pick, never before it exists)
  function paintScenePicker() {
    sceneSelect.innerHTML = '';
    const cur = document.createElement('option');
    cur.value = 'current'; cur.textContent = t('scene.current');
    sceneSelect.appendChild(cur);
    for (const r of sceneList.rooms) { const o = document.createElement('option'); o.value = r.id; o.textContent = sceneLabel(r); sceneSelect.appendChild(o); }
    sceneSelect.value = sceneList.selected;
    scenePicker.hidden = !currentRoomV2 || !sceneList.rooms.length;
  }
  if (window.__zumiPlateProbe) director.plateProbe = window.__zumiPlateProbe; // debug probe only (see CameraDirector.plateProbe); undefined in any real run
  // The video room is gone (load failed, timed out, or froze mid-play): the painted plate is back and the View picker unlocks.
  async function sceneToPlate() {
    director.setScene(null);
    roomViewSelect.disabled = false;
    roomViewSelect.title = '';
    await applyChair(); // the painted cut-out comes back when no 3D chair is on
  }
  sceneVideo.onStall = sceneToPlate;
  async function applyScene() {
    const token = ++sceneApplyToken;
    const room = currentRoomV2 ? sceneList.rooms.find((r) => r.id === sceneList.selected) || null : null;
    // Picking 'Current room' goes straight to the painted plate. Picking a video room does NOT clear the scene first: the
    // plate shows at launch until the first frame is decoded, and on a switch the OLD room's frames stay until the new
    // video's first frame is ready (SceneVideo.load swaps late) -- never the painted B plate in between.
    if (!room) director.setScene(null);
    const ok = await sceneVideo.load(room, sceneList.geometry);
    if (token !== sceneApplyToken) return;
    if (ok && chairList.chairs.some((c) => c.id === chairList.selected) && !chair3d.active) { await chairSettled(); if (token !== sceneApplyToken) return; }
    if (!ok) await sceneToPlate();
    else {
      director.setScene(sceneVideo); roomViewSelect.value = ''; // a video room is talk-only: the View picker reads Auto and is locked
      roomViewSelect.disabled = true;
      roomViewSelect.title = t('scene.talkOnly');
      await applyChair(); // the 3D chair applies in video rooms too; the painted cut-out is drawn only when no 3D chair is on
    }
    settleScene();
  }
  sceneSelect.addEventListener('change', async () => {
    sceneList = await zumi.scenes.select(sceneSelect.value);
    paintScenePicker();
    document.dispatchEvent(new Event('zumi:scene-changed')); // Settings > Room names the video room too (room-settings.js)
    await applyScene();
  });
  onLocaleChange(paintScenePicker);
  // Pause while the window cannot be seen (battery): main's minimize/hide/restore/show, plus the page's own visibility.
  let windowVisible = true;
  const syncSceneVisibility = () => sceneVideo.setVisible(windowVisible && !document.hidden);
  zumi.onWindowVisible((v) => { windowVisible = Boolean(v); syncSceneVisibility(); });
  document.addEventListener('visibilitychange', syncSceneVisibility);
  try { sceneList = await zumi.scenes.list(); } catch (e) { console.error('video rooms: list failed', e); }
  if (sceneList.error) console.warn('video rooms:', sceneList.error);

  // ---------- 3D chair (T-31 chair3d): settings.json chair3d = 'painted' | a chairs.json id (default: chair3d.mjs DEFAULT_CHAIR) ----------
  // Applies on the v2 room's talk view, in the painted room and under a video room alike (qc-021 ROOM-CROP: the video
  // rooms' painted cut-out showed the old night plate's pixels). While a 3D chair is on, SceneVideo skips that cut-out.
  const chair3d = new Chair3D({ renderer });
  let chairList = { selected: 'painted', chairs: [], hideOccluders: [] };
  let chairApplyToken = 0;
  async function applyChair() {
    const token = ++chairApplyToken;
    const entry = chairList.chairs.find((c) => c.id === chairList.selected) || null;
    sceneVideo.drawChair = !entry; // the pick decides, not the load: while a picked 3D chair (or her model) loads, no painted cut-out over the video
    const want = entry && currentRoomV2 && seatFit.model ? entry : null;
    if (!want) { chair3d.detach(); seatFit.setChairFit('talk', null); if (!entry) settleChair(); }
    else {
      if (!chair3d.entry || chair3d.entry.id !== want.id) { const ok = await chair3d.load(want, chairList.noChairPlateUrl); if (token !== chairApplyToken) return; if (!ok) { seatFit.setChairFit('talk', null); sceneVideo.drawChair = true; settleChair(); return; } }
      const talkSeat = currentRoomV2.views.talk.seat;
      chair3d.attach(currentRoomV2, chairList.hideOccluders);
      chair3d.fit(seatFit.model, (talkSeat && talkSeat.scale) || 1, VIEW_FIT.talk.hipFwd, seatFit, 'talk'); // scales the chair to her and sets seatFit's chair fit
      settleChair();
    }
    if (director.room && current) director.applyViewSideEffects(director.switching ? director.toName : director.view); // re-seat her on the new seat height
  }
  // Floating mode (T-31 float-holo pilot): hide the chair group (kept ATTACHED so the no-chair plate and
  // sceneVideo.drawChair=false stay) plus every talk occluder MESH (the group's own visibility is the director's,
  // toggled per view), switch the legs to the float clip, then re-seat her through the normal path (placeSeat now
  // branches to placeFloat). Exit restores both and re-runs applyChair(). No-op until a v2 room is loaded.
  let hiddenOccluders = null; // { room, meshes } | null -- the talk occluder meshes hidden while floating
  async function applyStageMode() {
    if (!currentRoomV2 || !currentRoomV2.views.talk) { // no talk view -> no panel, so no clamp (and no stale panel)
      holo.setOn(false);
      floatShadow.setOn(false);
      engine.setHoloPanel(false);
      return;
    }
    const floatOn = stageMode === 'float';
    // T-31 C1 step 11 (seated parity): the panel is up in float ALWAYS, and seated only while the working signal is
    // on -- one expression (`workPanelOn`) shared with applyWorkPanel below, so a mode switch and a signal flip can
    // never disagree. The seated placement is the smaller, front-and-side panel solved for the chest-up crop.
    const panelOn = workPanelOn(stageMode, engine.working, isPublicBuild(info));
    holo.setPlacement(floatOn ? 'float' : 'seated');
    // T-31 0.2.6: the holo panel's visibility and the reflex clamp are ONE state. Every place this function turns the
    // panel on/off (holo.setOn below, both branches) keeps the engine in lockstep, so a panel can never play a reach
    // that sweeps a hand through it, and a stage with no panel keeps the untouched catalog.
    engine.setHoloPanel(panelOn);
    if (floatOn) {
      if (chair3d.group) chair3d.group.visible = false;
      // Capture only once per room: a model re-bind while float is already on calls this again, and the meshes are
      // already hidden (the `o.visible` filter would capture nothing, so the later restore would leave them hidden).
      if (!hiddenOccluders || hiddenOccluders.room !== currentRoomV2) {
        const meshes = [];
        currentRoomV2.views.talk.occludersGroup.traverse((o) => { if (o.isMesh && o.visible) { o.visible = false; meshes.push(o); } });
        hiddenOccluders = { room: currentRoomV2, meshes };
      }
      await enterFloat(engine);
      holo.setOn(panelOn);
      floatShadow.setOn(true);
    } else {
      holo.setOn(panelOn); // seated: up only if she is already working when this mode is applied
      floatShadow.setOn(false);
      exitFloat(engine);
      if (chair3d.group) chair3d.group.visible = true;
      if (hiddenOccluders) { for (const o of hiddenOccluders.meshes) o.visible = true; hiddenOccluders = null; }
    }
    if (director.room) director.applyViewSideEffects(director.switching ? director.toName : director.view);
    if (!floatOn) await applyChair();
  }
  // T-31 C1 step 11: the seated half of the panel state, driven by the working signal (applied in the workSignal sink
  // below). It touches the PANEL ONLY -- no chair/occluder/pose/stage-mode work -- so the moment the signal drops the
  // non-working seated look is exactly the 0.2.6 seated view again (the group is hidden by holo.setOn(false), whose
  // own light/rim restore already runs). Float keeps the panel up regardless of the signal (unchanged since the pilot).
  function applyWorkPanel() {
    if (!currentRoomV2 || !currentRoomV2.views.talk) return; // no talk view: applyStageMode owns the off state
    const floatOn = stageMode === 'float';
    const on = workPanelOn(stageMode, engine.working, isPublicBuild(info));
    holo.setPlacement(floatOn ? 'float' : 'seated');
    engine.setHoloPanel(on);
    if (on !== holo.on) holo.setOn(on); // idempotent per frame; only a real change pays for the page/rim re-arm
  }
  async function setStageMode(mode) {
    stageMode = mode === 'float' ? 'float' : 'seated';
    saveStageMode(stageMode);
    await applyStageMode();
  }
  try { chairList = await zumi.chairs.list(); } catch (e) { console.error('chair3d: list failed', e); }
  if (chairList.error) console.warn('chair3d:', chairList.error);
  // never two chairs, also at launch: applyScene may show the video before any applyChair has run (0.2.2 RC run trc2)
  sceneVideo.drawChair = !chairList.chairs.some((c) => c.id === chairList.selected);
  // Settings > Room > Chair: 'painted' + every listed chair; labels from i18n `chair.<id>`, else chairs.json's own label.
  const chairPicker = $('chair-picker');
  function paintChairPicker() {
    chairPicker.innerHTML = '';
    for (const id of ['painted', ...chairList.chairs.map((c) => c.id)]) {
      const o = document.createElement('option');
      const label = t(`chair.${id}`);
      o.value = id; o.textContent = label !== `chair.${id}` ? label : ((chairList.chairs.find((c) => c.id === id) || {}).label || id);
      chairPicker.appendChild(o);
    }
    chairPicker.value = chairList.selected;
    chairPicker.disabled = !chairList.chairs.length;
  }
  chairPicker.addEventListener('change', async () => {
    chairList = await zumi.chairs.select(chairPicker.value);
    paintChairPicker();
    await applyChair();
  });
  onLocaleChange(paintChairPicker);
  paintChairPicker();
  // Settings > Room > Pose (pilot): the floating-mode toggle. float-mode.js owns the localStorage key; the
  // options are static (data-i18n), only the selected value is repainted.
  const stageModeSelect = $('stage-mode');
  stageModeSelect.addEventListener('change', () => setStageMode(stageModeSelect.value));
  stageModeSelect.value = stageMode;
  if (!info.packaged) window.__zumiScene = { THREE, sceneVideo, director, chair3d, seatFit, scene, camera, renderer,     getModel: () => current, applyChair: async (id) => { chairList = await zumi.chairs.select(id); paintChairPicker(); await applyChair(); return chairList; },
    // float pilot (scripts/electron-float-holo.cjs): toggle the mode from the harness, and read it back; setFraming
    // switches the talk crop to the close preset for the harness's --framing close stills/clip.
    float: { set: (on) => setStageMode(on ? 'float' : 'seated'), get: () => stageMode, params: floatRuntime, setFraming: (f) => { floatFraming = f === 'close' ? 'close' : 'wide'; }, setParams: (o) => { applyFloatOverrides(o); return true; } },
    // holo pilot (scripts/electron-float-holo.cjs): drive the screen + its light for the stills
    work: { feed: (rows) => workSignal.setFeed(rows) }, // harness only: the working-signal half of a fixture feed (seated panel up)
    holo: { setFeed: (rows) => holo.setFeed(rows), setPageAccent: (hex) => holo.setPageAccent(hex), pin: (on) => holo.pinPage(on), setLight: (on) => holo.setLight(on), setIntensity: (cd) => holo.setIntensity(cd), setMode: (m) => holo.setMode(m), setRim: (o) => holo.setRim(o), state: () => holo.state() },
    // fair comparison shots (scripts/electron-chair3d.cjs): neutral idle (no blinks, glances, saccades or idle gestures),
    // then freeze() holds the current pose until thaw()
    holdNeutral: () => { engine.resetForTest(); engine.autoIdle = false; const L = engine.life; L.blinkStart = -1; L.blinkNext = Infinity; L.glanceNext = Infinity; L.glanceUntil = 0; L.saccNext = Infinity; L.sx = 0; L.sy = 0; },
    freeze: () => { poseFrozen = true; }, thaw: () => { poseFrozen = false; } }; // dev/test runs only (scripts/electron-room-picker.cjs, electron-chair3d.cjs)

  // ---------- models ----------
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  // prepareVrm() (model-facing.js) does the same clean-up for every VRM instance (the stage model and the talk
  // path's hidden rig probe) and records the model's own base orientation (VRM 0.x 180-degree flip) so stage
  // placement composes with it instead of overwriting it.
  // Talk: Zumi answers, speaks and gestures (off in builds without a talk server; self-tests use recorded answers).
  // T-31 free LLM S1: the Gemini 18+ confirm in the talk panel exists only under the Tauri host (the same signal the
  // settings card uses); Electron passes null, so its DOM and behaviour are unchanged.
  const tauriHost = typeof window !== 'undefined' && Boolean(window.__TAURI__);
  // The switch offers the next USABLE default preset (Groq, then OpenRouter :free, then Cloudflare), never a
  // hard-coded Groq; when none has a key the provider picker opens instead (talk/age-confirm.js).
  const openProviderPicker = () => {
    const settingsTab = document.querySelector('.tab[data-tab="settings"]');
    if (settingsTab) settingsTab.click();
    const aiTab = document.getElementById('stab-ai');
    if (aiTab) aiTab.click();
    const picker = document.getElementById('brain-provider');
    if (picker && typeof picker.focus === 'function') picker.focus();
  };
  let brainCard = null; // assigned below; the talk switch refreshes it after a live provider change
  const ageConfirm = tauriHost && zumi.ai ? createAgeConfirm({ zumi, openPicker: openProviderPicker, onSwitched: () => { if (brainCard) brainCard.refresh(); } }) : null;
  const ui = talkUi($, { openSource: (url) => zumi.talk.openSource(url), ageConfirm });
  const talk = await createTalk({ zumi, engine, catalog, loader, camera, prepareVrm, ui, canned: Boolean(info.demo && info.demoFixture) });
  // Auto-update offer: never while Zumi speaks or a reply is still on its way (the turn is not done yet).
  const replyBusy = () => Boolean(talk.speech && talk.speech.speaking()) || Boolean(talk.director && talk.director.turn && !talk.director.turn.done);
  // Working signal (T-31 C1 step 7): derived in the renderer from the HUD feed it already receives -- never a new
  // IPC (src/main is frozen). The board half arrives with every 'hud:feed' via initHud's onWorkFeed; the chat half is
  // mirrored from the turn clock in the render loop, which is also the clock that ends a 10-min-silent board step and
  // the 10 s hold after a reply (review S2). A HUD style of Off means no feed, so working stays false -- accepted for
  // this slice (CONTEXT.md). The sink is the two renderer surfaces that follow work: engine.working (the work loop and
  // the seated work panel below) and applyWorkPanel. It deliberately does NOT call CameraDirector.setWorking: spec §5
  // keeps talk/video rooms on the talk view, so a working beat must never cut the camera to the Work view (review B1).
  const workSignal = createWorkSignal({
    apply: (on) => { engine.setWorking(on); applyWorkPanel(); },
  });
  initUpdateUi({ zumi, $, isBusy: replyBusy });
  if (!info.selftest && !info.demo) initProfileImport({ zumi, $ }); // Tauri only: the first-run "Import from Zumi <detected version>?" prompt
  // T-31 talk-mode: Zumi's own lines (subtitle + voice + gesture) and the one-click stage mute. The scheduler in main
  // decides what may be said; self-tests and demos run on recorded answers, so they never get unprompted speech.
  if (!info.selftest && !info.demo) {
    const say = initSay({ zumi, $, speech: talk.speech, library: talk.library, engine, isBusy: replyBusy, t });
    // P5 reactions: a poke and the start of a pat. Main whitelists the names and applies the level / gap rules.
    engine.on('reaction', (r) => { if (r && r.trigger === 'poke') say.event('poke'); });
    engine.on('state', (st) => { if (st && st.name === 'pat' && st.on) say.event('pat'); });
    if (!info.packaged) window.__zumiSay = say;
  }
  // Hologram screen (T-31 float-holo pilot): the 3D panel beside her in float mode. Its colour lights Zumi via
  // screenLight; a content change flickers + recolours and she glances (the same board quick-glance the HUD uses).
  const holo = new HoloScreen({
    parent: scene, engine, camera, light: screenLight, P: FLOAT,
    glance: (look) => { catalog.forceNext('board', 'quick-glance'); engine.trigger('board', { look }); },
    isSpeaking: () => Boolean(talk.speech && talk.speech.speaking()),
    stageWidth: () => $('stage-canvas').clientWidth, // the card is laid out at its on-screen width, in the HUD's type
  });
  // Work loop (T-31 C1 steps 8-10, CONCEPTS §4): while engine.working is on (the signal above), this per-frame
  // scheduler gives her a beat to play instead of a frozen mouse-follow. C1's beats read the holo panel (primaryGaze
  // scans inside its NDC rect), tap/swipe it, and every 20-40 s look at anh with a small smile. It yields to a talk
  // turn, typing, speech, a pointer hovering on her and a live reflex; the only command it ever triggers is the
  // shipped board reaction the HUD would have played anyway (step 10's task events), so it cannot add latency to a
  // reflex. The camera is NOT part of this signal: the talk view stays (review B1 / spec §5).
  // `hoverOnHer` is wired right after attachInput below (the pointer position lives there).
  let hoverOnHer = () => false;
  // Play one shipped board variant aimed at the panel and report its length, so the task timeline matches the real
  // command instead of a copy of its timings (engine.trigger returns the instance; the player owns the duration).
  const workReact = (variant, look) => {
    catalog.forceNext('board', variant);
    const info = engine.trigger('board', { look });
    const inst = info && engine.player ? engine.player.find(info.id) : null;
    return inst ? engine.player.duration(inst) : 0;
  };
  const workLoop = createWorkLoop({
    engine, holo,
    busy: () => Boolean(talk.director && talk.director.turn && !talk.director.turn.done),
    hover: () => hoverOnHer(),
    react: workReact,
  });
  // Soft floor shadow (T-31 float-holo cheap win 1): the decal under her feet that sells the hover height -- see
  // float-shadow.js. Shown/hidden with the float mode (applyStageMode), updated each frame after the hover moves.
  const floatShadow = new FloatShadow({ parent: scene, engine });
  // Settings > Agent & Soul > Hologram QC (T-31 float-holo): "Kiểu hologram" = the r6 TOP3 parameter sets, "Màu
  // viền" = the two colours the sweep measured. Renderer-only + LIVE: the style re-applies the r6 overrides, the
  // colour repaints the panel/light/rim. Saved in the renderer-only localStorage store (float-holo-prefs.js), so
  // Electron main stays frozen. Boot applies the saved pick here, BEFORE the URL overrides below, so a harness/
  // `?fh...` run still wins for its measurements.
  const holoStyleSelect = $('holo-style');
  const holoColourSelect = $('holo-colour');
  const applyHoloPrefs = (prefs) => {
    const r = resolveHolo(prefs);
    applyFloatOverrides(r.params);
    holo.setAccent(r.accent);
    return r;
  };
  let holoPrefs = readHoloPrefs();
  holoStyleSelect.value = holoPrefs.style;
  holoColourSelect.value = holoPrefs.colour;
  holoStyleSelect.addEventListener('change', () => {
    holoPrefs = saveHoloPrefs({ ...holoPrefs, style: holoStyleSelect.value });
    holoStyleSelect.value = holoPrefs.style; // a rejected value snaps back to what is stored
    applyHoloPrefs(holoPrefs);
  });
  holoColourSelect.addEventListener('change', () => {
    holoPrefs = saveHoloPrefs({ ...holoPrefs, colour: holoColourSelect.value });
    holoColourSelect.value = holoPrefs.colour;
    applyHoloPrefs(holoPrefs);
  });
  // Jev reaction variety (T-31): its own pool, independent of the talk/speech-gesture pipeline above --
  // warmed (derived + gated) per model/rigVersion right after talk.onModel(m) below, never on the reflex hot path.
  const jevSelector = new JevSelector({ log: (m) => zumi.talk.log({ kind: 'jev-variety', note: m }) });
  const picker = $('model-picker');
  // The model is one setting: main resolves it from assets/models/models.json, a user-picked .vrm, or a test --model.
  let models = [];
  let currentId = null;
  let current = null;
  let loadToken = 0;
  const showEmpty = () => { $('empty-model').hidden = Boolean(current); };
  // "Về model mặc định" (T-31, owner 20-10): hidden only when the current model IS the locked default -- the 'user'
  // slot whose file resolves to the default path (separator/case-insensitive). A built-in model or another user path
  // shows it. `selected` is passed at boot from the full list, because currentId only lands once the model finishes
  // loading; every model change repaints through fillPicker.
  const paintDefaultModel = (selected = currentId) => {
    $('model-default').hidden = isDefaultModelActive({ models, selected });
  };
  function fillPicker(list) {
    models = list.models;
    picker.innerHTML = '';
    if (!models.length || !currentId) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = models.length ? t('app.chooseModel') : t('app.noModel');
      picker.appendChild(opt);
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${modelLabel(m, t)}${m.isDefault ? t('app.defaultSuffix') : ''}`;
      if (m.file) opt.title = m.file; // the file name, for whoever needs it, only on hover
      picker.appendChild(opt);
    }
    picker.disabled = !models.length;
    picker.value = currentId || '';
    const sel = models.find((x) => x.id === currentId);
    picker.title = sel && sel.file ? sel.file : '';
    paintDefaultModel(list.selected); // full list: its own `selected` (boot / model:changed); { models }: the live currentId
  }
  fillPicker(modelList);
  const defaultModel = modelList.selected;
  const defaultRoom = roomList.selected;

  const setLoading = (on, frac) => {
    $('loading').hidden = !on;
    if (on) $('loading-text').textContent = frac != null ? t('zumi.loadingPct', { pct: Math.round(frac * 100) }) : t('zumi.loading');
  };

  // ---------- room (T-31 R3, PLAN-room.md §3): none | default | an imported id ----------
  // The room's own THREE scene sits in `scene` alongside the VRM; `currentRoom` holds its anchors (world positions,
  // captured at load time) plus a `blocked` flag set by the occluder check below. Placing Zumi at zumi_stand and
  // framing the camera from camera_default both need the CURRENT room, so every model (re)load re-applies them too.
  let currentRoom = null; // v1: { scene, anchors, lightCount, dispose, blocked } | null
  let currentRoomV2 = null; // v2 (T-31 camera modes): loadRoomV2() result | null -- mutually exclusive with currentRoom
  // r6: URL-query overrides (?fhSoleY=&fhCenterBackM=&fhRimMul=&fhFresnelPower=) applied once every closure it
  // touches (current/currentRoomV2) is initialised. No query -> `{}` -> nothing changes, so a normal launch is
  // byte-identical to r5; a launch WITH a query is a box tuning run.
  applyHoloPrefs(holoPrefs); // the saved Hologram pick first (it touches `current`), then any URL overrides below win
  if (Object.keys(urlOverrides).length) { applyFloatOverrides(urlOverrides); console.log('float-holo overrides', JSON.stringify(urlOverrides)); }
  let roomLoadToken = 0;
  function roomNote(text, bad) { const el = $('room-note'); if (el) { el.textContent = text || ''; el.classList.toggle('bad', Boolean(bad)); } }

  // Places Zumi at zumi_stand (or the origin when there is no room/anchor) + re-binds the engine (Rig measures
  // world positions once, at bind time, so moving vrm.scene afterward needs a fresh bind — same cost switchModel
  // already pays on every model change) + frames the camera from camera_default, falling back to the plain
  // in-front camera when the room has no camera_default OR an occluder check finds something between the camera
  // and Zumi's head/torso (PLAN §3 "Never a crash"). v1 ONLY -- a v2 room uses placeAndFrameV2 instead (below).
  function placeAndFrame() {
    if (!current || currentRoomV2) return;
    const standAnchor = currentRoom && currentRoom.anchors.zumi_stand;
    placeZumi(current.scene, standAnchor);
    engine.bind(current, camera);
    if (current.springBoneManager) current.springBoneManager.reset();
    const standPos = standTransform(standAnchor).position;
    const camAnchor = currentRoom && currentRoom.anchors.camera_default;
    frameStageCamera(camera, engine.rig, current, standPos, camAnchor ? camAnchor.position : null);
    if (currentRoom) {
      const blocked = isViewBlocked(camera, engine.rig, currentRoom.scene);
      if (blocked && camAnchor) { frameStageCamera(camera, engine.rig, current, standPos, null); roomNote(t('room.occluderBlocked'), true); }
      currentRoom.blocked = blocked;
    }
    // R4a idle glances: project AFTER the camera is in its final position (including any occluder re-frame
    // above) -- no room / no look_targets anchor both yield [], which engine.setLookTargets treats as "glance
    // around as before".
    engine.setLookTargets(currentRoom ? projectLookTargets(camera, currentRoom.anchors.look_targets) : []);
  }

  // v2 (T-31 camera modes): zumi_seat (if any) is the stand anchor (position/facing); computeRootDrop then seats
  // her (seat.js). The camera/plate/occluders/per-view gaze targets are ENTIRELY CameraDirector's job from here --
  // v1's frameStageCamera/isViewBlocked/projectLookTargets never run for a v2 room (its camera comes from
  // room.json's own per-view params, matched to the painted plate, not derived from Zumi's measured bounds).
  async function placeAndFrameV2() {
    if (!current || !currentRoomV2) return;
    const model = current, room = currentRoomV2; // captured: a newer switch may land while the drop measurement below awaits
    clearSeatedPose(engine); // undo a previous room/model's seated base before this one decides whether to seat her
    placeZumi(model.scene, null); // neutral placement before bind (v1's own "no anchor" default) -- CameraDirector's placeSeat callback repositions her for real once a view is live, below
    engine.bind(model, camera);
    if (model.springBoneManager) model.springBoneManager.reset();
    seatDropM = 0;
    hipOffsetXZ = measureHipOffsetXZ(engine); // synchronous -- the hip-joint bones' own origin does not depend on the (async) clip, see seat.js header
    seatFit.measureModel(model); // T-31 chair fix: needs the same origin/rest state measureHipOffsetXZ just left
    const drop = await measureSeatDropM(engine); // round 2: the drop no longer depends on WHICH view -- only on this model's own standing/seated leg geometry -- so it is measured once and cached, not per view-switch
    if (current !== model || currentRoomV2 !== room) return; // stale: a newer switch already took over
    if (drop != null) {
      seatDropM = drop;
      // T-31 chair fix: build EVERY view's seat pose now, so a later view switch never waits on a clip load (a missing
      // pose for even one frame reset the legs to standing: straight legs through the seat on the first work switch)
      await Promise.all([...new Set(Object.values(room.views).map((v) => v && v.seat && v.seat.pose).filter(Boolean))].map((pose) => engine.clips.warm(pose)));
      if (current !== model || currentRoomV2 !== room) return;
      await enterSeated(engine);
    }
    director.setRoom(room); // jumps to 'talk': places Zumi at its own seat (via placeSeat below), sets camera pos/target/fov/aspect/viewOffset, the plate, look_targets, occluders, lights
    await applyChair(); // T-31 chair3d: needs this model's measured pelvis depth (seatFit.measureModel above)
    if (current !== model || currentRoomV2 !== room) return;
    lookTuning.load(); // re-reads defaults now that director.room is set, so a room's own views.<v>.grade (if any) becomes the baseline under any saved user override -- a no-op merge when this room has no grade authored
    if (stageMode === 'float') applyStageMode(); // float pilot: re-apply the stored mode on every bind (fire-and-forget, like enterSeated above)
  }

  async function placeAndFrameAny() { if (currentRoomV2) await placeAndFrameV2(); else placeAndFrame(); if (current) settleSeat(); }

  async function switchRoom(id) {
    const token = ++roomLoadToken;
    if (currentRoom) { scene.remove(currentRoom.scene); currentRoom.dispose(); currentRoom = null; }
    if (currentRoomV2) { scene.remove(currentRoomV2.scene); currentRoomV2.dispose(); currentRoomV2 = null; director.setRoom(null); clearSeatedPose(engine); }
    currentRoomV2Id = null;
    camRegister.setRoom(null);
    if (id && id !== 'none') {
      const list = (await zumi.rooms.list()).rooms;
      const entry = list.find((r) => r.id === id);
      if (entry && entry.schemaVersion === 2) {
        try {
          const res = await fetch(entry.url);
          const json = await res.json();
          const room = await loadRoomV2(json, (rel) => new URL(rel, entry.url).href);
          if (token !== roomLoadToken) { if (room) room.dispose(); return; }
          if (room) { scene.add(room.scene); currentRoomV2 = room; currentRoomV2Id = entry.id; camRegister.setRoom(entry.id); seatFit.setRoomJson(json); }
          else roomNote(t('room.loadFailed', { error: 'room.json v2' }), true);
        } catch (e) {
          console.error('room v2 load failed', entry.url, e);
          if (token === roomLoadToken) roomNote(t('room.loadFailed', { error: String((e && e.message) || e).slice(0, 120) }), true);
        }
      } else if (entry) {
        try {
          const room = await loadRoom(entry.url);
          if (token !== roomLoadToken) { room.dispose(); return; }
          scene.add(room.scene);
          currentRoom = room;
        } catch (e) {
          console.error('room load failed', entry.url, e);
          if (token === roomLoadToken) roomNote(t('room.loadFailed', { error: String((e && e.message) || e).slice(0, 120) }), true);
        }
      }
    }
    if (token === roomLoadToken) placeAndFrameAny();
    roomViewPicker.hidden = !currentRoomV2; // the manual view picker only makes sense while a v2 room is loaded
    roomViewSelect.value = ''; // a fresh room load always starts on Auto -- a stale manual pin from the PREVIOUS room would be confusing
    director.setManualView(null);
    if (token === roomLoadToken) { paintScenePicker(); applyScene(); } // video rooms apply only on top of the painted v2 room
  }

  async function switchModel(id, { forceEntrance } = {}) {
    const m = models.find((x) => x.id === id);
    if (!m) return null;
    const token = ++loadToken;
    $('empty-model').hidden = true;
    setLoading(true, 0);
    let gltf;
    try {
      gltf = await loader.loadAsync(m.url, (e) => { if (e.total) setLoading(true, e.loaded / e.total); });
    } catch (e) {
      console.error('model load failed', m.file, e);
      if (token === loadToken) {
        $('loading-text').textContent = t('app.modelLoadFailed', { file: m.file });
        paintDefaultModel(); // a failed load leaves currentId unchanged: let the restore item reflect that
        if (!current) setTimeout(() => { if (token === loadToken) { setLoading(false); showEmpty(); } }, 2500);
      }
      return null;
    }
    const vrm = gltf.userData.vrm;
    if (token !== loadToken || !vrm) { VRMUtils.deepDispose(gltf.scene); return null; }
    prepareVrm(gltf, vrm);
    // Compile shaders before the model goes on stage: otherwise the first frame blocks ~1.5 s and
    // the entrance reaction would start while the window is frozen.
    try { await renderer.compileAsync(vrm.scene, camera, scene); } catch (e) { console.warn('compileAsync', e); }
    if (token !== loadToken) { VRMUtils.deepDispose(gltf.scene); return null; }
    if (current) { scene.remove(current.scene); engine.unbind(); VRMUtils.deepDispose(current.scene); }
    current = vrm;
    currentId = id;
    scene.add(vrm.scene);
    placeAndFrameAny(); // places her at the room's zumi_stand (or the origin), binds the engine, frames the camera
    jevSelector.reset(); // the previous model's pool and probe verdicts must not serve this one
    talk.onModel(m).then(() => jevSelector.warmAsync(talk.rigVersion, talk.probe && ((cmd, opts) => talk.probe.check(cmd, opts)), idleSlice, launchSettled))
      .catch((e) => console.error('jev variety warm failed', e));
    // hashes the model for the gesture cache key, builds the hidden rig probe, and (re)warms the Jev variety pool against
    // it in idle slices once the launch has settled -- derived-variant gating never runs on the reflex hot path, except a
    // reaction on a label the warm has not reached yet, which gates that one label first (jevSelector.pickBody)
    fillPicker({ models });
    setLoading(false);
    showEmpty();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // first frame is on screen
    if (token !== loadToken) return null;
    if (forceEntrance) catalog.forceNext('entrance', forceEntrance);
    return engine.trigger('entrance');
  }
  picker.addEventListener('change', async () => {
    const id = picker.value;
    picker.blur();
    if (!id) return;
    fillPicker(await zumi.selectModel(id));
    switchModel(id);
  });
  const openVrm = async () => {
    const list = await zumi.openModelFile();
    if (!list) return;
    fillPicker(list);
    switchModel(list.selected);
  };
  $('open-vrm').addEventListener('click', openVrm);
  $('open-vrm-empty').addEventListener('click', openVrm);
  // "Về model mặc định" (T-31, owner 20-10): ONE click back to the locked default avatar through its own no-argument
  // IPC (main owns the file, checks its locked sha256, then writes { userModelPath, model: 'user' } only): no dialog
  // opens and no other setting is touched. A missing/changed file only paints the note below and changes nothing.
  let defaultNoteKey = null;
  const paintDefaultNote = () => {
    $('model-default-note').textContent = defaultNoteKey ? t(defaultNoteKey, { file: DEFAULT_MODEL_FILE }) : '';
  };
  $('model-default').addEventListener('click', async () => {
    $('model-default').disabled = true;
    defaultNoteKey = null;
    paintDefaultNote();
    try {
      await restoreDefaultModel({
        list: { models, selected: currentId },
        restoreDefault: () => zumi.restoreDefaultModel(),
        onError: (key) => { defaultNoteKey = key; paintDefaultNote(); },
        onList: (list) => { fillPicker(list); if (list.selected) switchModel(list.selected); },
      });
    } catch {
      defaultNoteKey = 'app.defaultModelMissing'; // could not read/verify the file: say so, change nothing
      paintDefaultNote();
    } finally {
      $('model-default').disabled = false;
      paintDefaultModel();
    }
  });



  // ---------- render loop (paused while the board tab is shown) ----------
  let poseFrozen = false; // set only by the dev/test hook below (never in a packaged build)
  let stageVisible = true;
  let last = performance.now();
  const loop = (now) => {
    requestAnimationFrame(loop);
    const dt = (now - last) / 1000;
    last = now;
    workSignal.setChatBusy(replyBusy()); // C1 step 7: a chat turn in flight counts as working; also the 10-min expiry
    // clock -- above the stage-visibility return, so a paused stage (Settings/Board tab) still ends a silent step.
    if (!stageVisible || !current) return;
    if (poseFrozen) { holo.update(now / 1000); floatShadow.update(); director.update(); renderer.render(scene, camera); return; } // dev/test only: comparison shots hold one pose (the holo + shadow still update, so its light A/B renders)
    engine.setSpeechMouth(talk.mouth());
    if (stageMode === 'float') updateFloat(engine, now / 1000); // float pilot: hover the root + refresh rig.hipsPos BEFORE engine.update pins the hips to it
    floatShadow.update(); // float pilot: the floor decal follows the hover's ankle gap (no-op while the mode is off)
    holo.update(now / 1000); // holo pilot: panel position/orientation + light flicker (no-op while the mode is off)
    workLoop.update(now); // C1 step 8: while working, the beat owns the gaze (after holo.update, so the panel rect is current)
    engine.update(dt);
    director.update(); // T-31 camera modes: view FSM + camera ease + plate cross-fade (incl. the per-frame
    // cover-crop: camera.viewOffset is kept registered with whatever drawPlate() just drew, at the canvas's
    // OWN current size -- see camera-director.js's applyFrameCrop). Never awaits I/O, never touches
    // trigger()/play() -- see camera-director.js's header for the latency-gate reasoning. A no-op when no v2
    // room is loaded (director.room is null). The WebGL viewport is always the full canvas now -- a v2 room's
    // plate+camera cover it edge-to-edge by construction, so there is no letterboxed sub-rect left to scissor to.
    if (currentRoomV2) seatFit.update(dt, current, director.switching ? director.toName : director.view); // T-31 chair fix: after the pose + camera, before render; never awaits, never triggers
    renderer.render(scene, camera);
    engine.afterRender();
    if (camRegister.active) camRegister.draw();
  };
  requestAnimationFrame(loop);

  // ---------- reflex chip / heard bubble ----------
  let chipTimer;
  let devChrome = false;
  document.addEventListener('zumi:dev-chrome', (e) => { devChrome = Boolean(e.detail); });
  engine.on('reaction', (r) => {
    if (isPublicBuild(info) && !devChrome) return;
    const chip = $('reflex-chip');
    chip.textContent = r.labelVi;
    chip.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('show'), 2600);
  });
  let heardTimer;
  // Jev fast-reflex (T-31): fires on every Enter, in parallel with the /turn call below — not gated on talk being
  // enabled, since it works offline (local/neutral fallback) and has nothing to do with the cloud talk feature.
  // The /turn answer, once it lands, plays its own (slower, better-informed) gesture on top — this just reacts first.
  // onReflex: same small pub/sub shape as director.onEvent, so a reflex-only demo run can await each line's
  // result directly instead of guessing from the DOM.
  const reflexListeners = new Set();
  const onReflex = (cb) => { reflexListeners.add(cb); return () => reflexListeners.delete(cb); };
  const runReflexJev = async (text) => {
    let r;
    try { r = await zumi.reflexJev.classify(text); } catch (e) { console.error('reflex-jev', e); return; }
    if (!r || typeof r.ms !== 'number') return;
    const pickT0 = performance.now();
    const picked = jevSelector.pick(r.reaction);
    const pickMs = performance.now() - pickT0;
    const playCommand = picked.side === -1 ? { ...picked.command, mirror: 'random' } : picked.command;
    const reaction = JEV_LABELS.includes(r.reaction) ? r.reaction : 'neutral';
    engine.playCommand(playCommand, 'speech', { side: picked.side, labelVi: `${t('jev.' + reaction)} · ${t('app.fastReflex')}` });
    ui.reflexTiming(r.ms, r.source);
    zumi.talk.log({ kind: 'reflex-jev', reaction: r.reaction, source: r.source, decider: r.decider || null, confidence: r.confidence, ms: r.ms, bodyId: picked.bodyId, faceId: picked.faceId, pickMs: +pickMs.toFixed(2) });
    for (const cb of reflexListeners) { try { cb(r); } catch (e) { console.error(e); } }
  };
  const onSend = (text) => {
    if (current) runReflexJev(text);
    if (talk.enabled && current && !talk.muted) { talk.send(text); return; }
    const el = $('heard');
    if (isPublicBuild(info) && current && !talk.enabled) {
      el.textContent = t('app.noKeyReply');
      el.hidden = false;
      clearTimeout(heardTimer);
      heardTimer = setTimeout(() => { el.hidden = true; }, 8000);
      return;
    }
    el.textContent = t('app.heard', { text: text.length > 60 ? text.slice(0, 57) + '…' : text });
    el.hidden = false;
    clearTimeout(heardTimer);
    heardTimer = setTimeout(() => { el.hidden = true; }, 2600);
  };

  // T-31-TAURI R1: Kokoro loads on demand, so the first keystroke after idle asks the host to pre-warm it (the load then
  // overlaps with the user's typing). One call per idle period (30 s without a keystroke); the host is idempotent too.
  { let lastKey = 0; $('msg').addEventListener('input', () => { const t = Date.now(); const idle = t - lastKey > 30000; lastKey = t; if (idle && zumi.talk && zumi.talk.voiceWarm) zumi.talk.voiceWarm().catch(() => {}); }); }
  const input = attachInput(engine, { stage: stageEl, textbox: $('msg'), onSend });
  hoverOnHer = () => input.pointerOver(); // C1 step 10: the work loop's hover rule reads the real pointer + hit regions

  // ---------- window focus / board events / gesture commands ----------
  let locked = false; // self-test ignores real OS focus + mouse so screenshots are deterministic
  const onWindowFocus = (focused) => {
    if (focused) {
      const woke = engine.noteInput();
      engine.exitState('blur');
      return woke ? null : engine.trigger('focus');
    }
    return engine.enterState('blur');
  };
  zumi.onWindowFocus((f) => { if (!locked) onWindowFocus(f); });

  // A generic board event (a new message this camera cannot pin to a HUD card): the one-shot 'double-take' gazing the
  // sidebar NDC. 4 of the 5 board variants now gaze only the per-play 'dynamic' target, which player.js skips when no
  // look is passed -- so the old bare trigger('board') lost the glance AND could pick nod-smile (done) / concerned
  // (blocked) at random (review 16-10). The HUD's own reaction passes its card's NDC instead (hud/hud.js).
  const onBoardEvent = () => {
    if (!document.querySelector('.tab[data-tab="board"]').classList.contains('active')) $('board-badge').hidden = false;
    // A board reaction is activity for the idle ladder: exiting 'sleepy' alone left lastInputAt ~180 s stale, so
    // the very next idleTimers() frame re-entered 'sleepy' over the board double-take (8/8 events, DIAG 20-10
    // §3.5). noteActivity() resets the ladder without the wake startle -- the board gesture is the reaction.
    engine.noteActivity();
    if (engine.isState('sleepy')) engine.exitState('sleepy');
    catalog.forceNext('board', 'double-take');
    return engine.trigger('board', { look: { x: -1.6, y: 0.35 } });
  };
  zumi.onReflexEvent((ev) => { if (ev && ev.type === 'board-message') onBoardEvent(); });
  $('sim-board').addEventListener('click', () => onBoardEvent());
  $('cam-register').addEventListener('click', () => camRegister.toggle());
  $('look-tuning-toggle').addEventListener('click', () => lookTuning.toggle());
  // Manual view switch (owner priority shift 03-10): a Settings-adjacent dropdown ("Auto"/Talk/Work/Room) + Ctrl+1/2/3.
  // Auto (empty value) hands control back to CameraDirector's own state->view rules (unchanged, still live in code).
  // Thu 16:00 talk-QC build (option C): work off for this build -- hide it from the dropdown so there is nothing
  // to pick, same list otherwise (the <option> stays in the DOM, just hidden; nothing else needs to change).
  for (const name of disabledViews) { const opt = roomViewSelect.querySelector(`option[value="${name}"]`); if (opt) opt.hidden = true; }
  roomViewSelect.addEventListener('change', () => director.setManualView(roomViewSelect.value || null));
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !currentRoomV2) return;
    const view = { Digit1: 'talk', Digit2: 'work', Digit3: 'room' }[e.code];
    if (!view || disabledViews.has(view)) return;
    e.preventDefault();
    roomViewSelect.value = view;
    director.setManualView(view);
  });

  zumi.onGesture((command) => engine.playCommand(command, 'gesture'));

  // ---------- tabs + board: local (Laneboard core) or live (the loopback bridge, T-31 L1) ----------
  let webview = null;
  let webviewMode = null; // 'local' | 'live' | null — which mode `webview` was built for; a mode switch tears it down
  let boardOpening = null; // in-flight openBoard() (local) promise
  let liveOpening = null; // in-flight openLiveBoard() promise
  let boardStatus = { mode: 'local', configured: false, locked: false };
  const isBoardTabActive = () => document.querySelector('.tab[data-tab="board"]').classList.contains('active');
  // Owner build (coordinator scope-add 07-10): the local/sample board's own pill never applies, so it is hidden
  // outright rather than repainted with a now-meaningless label.
  if (info.ownerAdmin) $('board-mode-label').hidden = true;
  // onDone also tells Settings (same keystore) to repaint its Account card now, not at the next window focus.
  const boardSignin = initBoardSignin(zumi, $, { onDone: () => { document.dispatchEvent(new CustomEvent('zumi:board-changed')); refreshBoardTab(); } });
  const resetHint = () => {
    const hint = $('board-hint');
    hint.hidden = false;
    hint.classList.remove('notice');
    hint.innerHTML = `<div class="spinner"></div><span>${t('board.opening')}</span>`;
    delete hint.dataset.dir;
  };
  function destroyWebview() {
    if (webview) webview.remove();
    webview = null;
    webviewMode = null;
    boardOpening = null;
    liveOpening = null;
  }
  // items: strings, or { text, rule } (rule = the machine id, kept in data-rule; the owner reads only the words)
  // where: a folder, kept in data-dir for diagnosis — never shown (no paths in owner-visible text)
  const boardHint = (text, items = [], where = null) => {
    $('board-hint').hidden = false;
    $('board-hint').classList.toggle('notice', items.length > 0);
    $('board-hint').innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = text;
    $('board-hint').appendChild(msg);
    if (where) $('board-hint').dataset.dir = where; else delete $('board-hint').dataset.dir;
    if (items.length) {
      const ul = document.createElement('ul');
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = typeof it === 'string' ? it : it.text;
        if (it && it.rule) li.dataset.rule = it.rule;
        ul.appendChild(li);
      }
      $('board-hint').appendChild(ul);
    }
  };
  // Laneboard's importer checks every v0.2 row against the board rules first and refuses the whole snapshot on any
  // violation; nothing is written and the old files stay as they are, so the refusal is shown here, item by item.
  const VIOLATION_KEY = { waiting_before_done: 'board.violation.waiting_before_done', invalid_step_state: 'board.violation.invalid_step_state' };
  // The board toolbar line: owner words only; the data folder is kept in data-dir for diagnosis, not shown.
  // The last (key, vars, dir) is remembered so a language change can repaint the line in place.
  let whereState = null;
  const setWhere = (key, vars, dir) => {
    whereState = { key, vars, dir };
    const el = $('board-where');
    el.textContent = t(key, vars);
    el.dataset.dir = dir || '';
  };
  // Embedded-board URL: ?embed=1 makes the board's lang-boot.js add the `embed` class before first paint, which
  // hides the board's own logo/tagline/language switch/sign-in-out/owner line (app.js reads that class) so the only
  // chrome on screen is the app shell's. ?lang=<locale> is read by that same lang-boot.js ahead of its own
  // localStorage pick and written back to localStorage, so the URL is authoritative — no separate localStorage poke
  // is needed (dropped; it only mattered before the board read `lang` from its own query string).
  // ?local= tells the board what to do with a "local" link (a file on anh's PC attached to an ask): the owner build
  // opens it through main (`open` -> /__zumi-open, allowlisted in src/main/board-open.mjs); any other build has no
  // such files, so the board leaves those links out (`hide`). Presentation only: main enforces the allowlist.
  function withEmbedLang(urlStr) {
    const u = new URL(urlStr);
    u.searchParams.set('embed', '1');
    u.searchParams.set('lang', getLocale());
    u.searchParams.set('local', info.ownerAdmin ? 'open' : 'hide');
    // R1: the Board follows the shell theme through the URL fragment only (the vendored page reads #theme= once at boot; no vendored edit).
    // No data-theme on <html> (next-UI off) = no fragment = the board keeps its own pick, as before.
    const applied = document.documentElement.dataset.theme;
    if (applied) withBoardTheme(u, applied);
    return u;
  }
  // Shared by the reload button and a language change: local re-applies the owner token (dataset.home) plus a fresh
  // `r` cache-buster; live just re-applies the bridge origin. Both always carry embed=1 and the CURRENT locale, not
  // whichever ones the webview first loaded with.
  function reloadBoardUrl() {
    if (webviewMode === 'live') return withEmbedLang(webview.dataset.home);
    const home = withEmbedLang(webview.dataset.home);
    home.searchParams.set('r', Date.now().toString(36)); // a new query forces a real load; a hash-only change would not re-run the page
    return home;
  }
  const openBoard = () => boardOpening || (boardOpening = (async () => {
    const b = await zumi.openBoard();
    if (b && b.refused) {
      boardOpening = null;
      const names = b.legacyNames || {};
      const said = (v) => {
        const rec = names[v.task], s = rec && rec.steps[v.step];
        const task = rec && rec.title ? t('board.legacy.task', { title: rec.title }) : t('board.legacy.someTask');
        const step = s ? t(s.label ? 'board.legacy.stepLabel' : 'board.legacy.step', { n: s.n, label: s.label }) : t('board.legacy.someStep');
        return { text: `${task}, ${step}: ${t(VIOLATION_KEY[v.error] || 'board.violation.generic')}`, rule: v.error };
      };
      boardHint(t('board.migrateRefused'), b.refused.violations.map(said), b.root);
      setWhere('board.migrateRefusedWhere', null, b.root);
      return null;
    }
    if (!b || b.error) {
      boardOpening = null;
      boardHint(t('board.openFailed', { error: (b && b.error) || t('board.unknownError') }));
      return null;
    }
    const moved = b.outcome === 'migrated' ? t('board.migrated') : '';
    setWhere('board.localWhere', { extra: moved }, b.dataDir);
    $('board-where').dataset.board = `${b.origin} laneboard ${b.laneboard || ''}`; // for diagnosis, not shown
    webview = document.createElement('webview');
    webview.setAttribute('partition', info.boardPartition);
    webview.setAttribute('allowpopups', ''); // boardPopups: see the live board's <webview> below
    webview.setAttribute('src', withEmbedLang(b.url).href);
    webview.dataset.home = b.url; // the bare address (owner token etc.); embed/lang/r are re-applied on every (re)load
    webviewMode = 'local';
    const wv = webview; // captured per element: a mode switch can tear this one down while an event is in flight
    wv.addEventListener('did-finish-load', () => { $('board-hint').hidden = true; wv.dataset.loaded = '1'; });
    // Guest-view attach readiness (J-05 coordinator QC 03-10, GUEST_VIEW_MANAGER_CALL investigation): dom-ready is
    // the signal the board selftest now waits for before its first executeJavaScript() call on this webview --
    // did-finish-load alone was found to occasionally fire before the guest view's internal attach handshake (the
    // thing executeJavaScript/capturePage route through) has settled under heavy load; see board.js.
    wv.addEventListener('dom-ready', () => { wv.dataset.domReady = '1'; });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // aborted by a newer navigation
      boardHint(t('board.openFailed', { error: e.errorDescription || e.errorCode }));
    });
    $('board-host').appendChild(webview);
    return webview;
  })());
  // Live mode (T-31 L1): the webview loads the loopback bridge's origin (never the live origin directly, and
  // no token in the URL — see the L1 UI contract), on its own in-memory partition.
  const openLiveBoard = () => liveOpening || (liveOpening = (async () => {
    const r = await zumi.board.liveOpen();
    if (!r || r.error) {
      liveOpening = null;
      // Tauri preview: the live board is waived to P2, and the shim says so with its own code. Name the
      // Electron app as where the board lives today instead of blaming the network (the gate is the same
      // window.__TAURI__ signal brain-key-card.js uses, so Electron keeps its existing hint byte-for-byte).
      if (tauriHost && r && r.error === 'live_board_later') {
        boardHint(t('board.liveInElectron'));
        return null;
      }
      boardHint(t('board.liveConnectFailed', { error: (r && r.error) || t('board.unknownError') }));
      return null;
    }
    setWhere('board.liveWhere', null, r.origin);
    delete $('board-where').dataset.board;
    const homeUrl = `${r.origin}/`; // trailing slash: main.js's webview guard checks url.startsWith(liveBridgeOrigin + '/')
    webview = document.createElement('webview');
    webview.setAttribute('partition', r.partition);
    // boardPopups: without `allowpopups` Chromium drops a guest's window.open / <a target="_blank"> before main sees
    // it, so no link on the board opened at all (the owner build's /__zumi-open chips included; review 10-10).
    // With it, every new window goes to main.js's setWindowOpenHandler for this guest, which always DENIES the window
    // and only opens: /__zumi-open (owner build, allowlisted, board-open.mjs) or an outside http(s) link in the browser.
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('src', withEmbedLang(r.openUrl || homeUrl).href); // openUrl: first load only (bridge caller-auth nonce)
    webview.dataset.home = homeUrl; // the bare origin; embed/lang are re-applied on every (re)load
    webviewMode = 'live';
    const wv = webview; // captured per element: a mode switch can tear this one down while an event is in flight
    wv.addEventListener('did-finish-load', () => { $('board-hint').hidden = true; wv.dataset.loaded = '1'; });
    // Guest-view attach readiness (J-05 coordinator QC 03-10, GUEST_VIEW_MANAGER_CALL investigation): dom-ready is
    // the signal the board selftest now waits for before its first executeJavaScript() call on this webview --
    // did-finish-load alone was found to occasionally fire before the guest view's internal attach handshake (the
    // thing executeJavaScript/capturePage route through) has settled under heavy load; see board.js.
    wv.addEventListener('dom-ready', () => { wv.dataset.domReady = '1'; });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      boardHint(t('board.liveConnectFailed', { error: e.errorDescription || e.errorCode }));
    });
    $('board-host').appendChild(webview);
    return webview;
  })());
  // Owner words only (PLAN-live-board.md §4): the bridge itself 401s every call while locked, so this overlay —
  // not the webview's own error state — is what the owner sees. Driven by board:status(), not by trying to load.
  // `rejected` (T-31 0.2.11 auth-401): the live board refused the stored sign-in (board:status authRejected). Same
  // overlay, its own words; the button still lands on Settings > Account, where "Change sign-in" lives.
  let boardOverlayRejected = false;
  function showLockedBoard(rejected = false) {
    boardOverlayRejected = rejected;
    destroyWebview();
    $('board-hint').hidden = true;
    const keys = rejected ? ['board.rejected.title', 'board.rejected.body', 'board.rejected.action'] : ['board.locked.title', 'board.locked.body', 'board.locked.settings'];
    const els = [$('board-locked').querySelector('h2'), $('board-locked').querySelector('p'), $('board-locked-settings')];
    els.forEach((el, i) => { el.setAttribute('data-i18n', keys[i]); el.textContent = t(keys[i]); });
    $('board-locked').hidden = false;
  }
  const signInRejected = (status) => status.mode === 'live' && !status.locked && status.authRejected === true;
  // "Unlock in Settings" must land on the PIN unlock row, which lives in the Account inner tab (T-31 settings P1):
  // select that tab first, so the remembered last tab (settings-tabs.js) can never hide the row the owner was sent to.
  $('board-locked-settings').addEventListener('click', () => {
    if (boardOverlayRejected) { document.dispatchEvent(new CustomEvent('zumi:board-signin')); return; } // settings.js opens Account + the form
    const account = document.getElementById('stab-account');
    if (account) account.click();
    document.querySelector('.tab[data-tab="settings"]').click();
  });
  // Dispatcher: local vs live vs locked, and "switching mode reloads the tab" (a mode change tears the old webview
  // down so the next render starts clean, rather than trying to re-point a live webview's partition in place).
  // Owner build (app:info.ownerAdmin, coordinator scope-add 07-10): the local/sample board never mounts here at
  // all -- `openBoard()` (below) is simply never called from this branch. Before sign-in, or whenever configured
  // credentials are locked, the sign-in card (board-signin.js) takes the place of both the sample board AND the
  // generic #board-locked overlay; once live+unlocked it behaves exactly like the non-owner branch below.
  function renderOwnerBoardTab(status) {
    if (signInRejected(status)) { $('board-signin').hidden = true; showLockedBoard(true); return; }
    $('board-locked').hidden = true;
    if (status.mode !== 'live' || status.locked) {
      if (webview) destroyWebview();
      $('board-hint').hidden = true;
      boardSignin.render(status);
      $('board-signin').hidden = false;
      return;
    }
    $('board-signin').hidden = true;
    if (webview) return; // already showing the live board; don't reload on every status poll
    resetHint();
    openLiveBoard();
  }
  function renderBoardTab(status) {
    const modeChanged = boardStatus.mode !== status.mode;
    boardStatus = status;
    if (!info.ownerAdmin) $('board-mode-label').textContent = status.mode === 'live' ? t('board.mode.live') : t('board.mode.local');
    if (info.ownerAdmin) return renderOwnerBoardTab(status);
    if (status.mode === 'live' && status.locked) { showLockedBoard(); return; }
    if (signInRejected(status)) { showLockedBoard(true); return; }
    $('board-locked').hidden = true;
    if (modeChanged && webview) destroyWebview();
    if (webview) return; // already showing the right mode; don't reload on every status poll
    resetHint();
    if (status.mode === 'live') openLiveBoard(); else openBoard();
  }
  const refreshBoardTab = async () => { if (isBoardTabActive()) renderBoardTab(await zumi.board.status()); };
  // Reload: local re-opens the board's own address (with the owner token), so it also re-authenticates a stale
  // session; live just re-loads the bridge origin (it carries no token to begin with). Both go through
  // reloadBoardUrl() so embed=1 and the current language are re-applied, not just the values the tab first loaded.
  $('board-reload').addEventListener('click', () => {
    if (!webview) {
      // Same dispatch as renderBoardTab: an owner build must never reach openBoard() (the sample/local board) from
      // here either -- re-render off the last-known status rather than re-deciding local-vs-live ourselves.
      if (info.ownerAdmin) return renderOwnerBoardTab(boardStatus);
      return boardStatus.mode === 'live' ? openLiveBoard() : openBoard();
    }
    return webview.loadURL(reloadBoardUrl().href);
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const el of document.querySelectorAll('.tab')) el.classList.toggle('active', el === tab);
      const name = tab.dataset.tab;
      for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `tab-${name}`);
      stageVisible = name === 'zumi';
      if (name === 'board') { $('board-badge').hidden = true; refreshBoardTab(); }
      else if (name === 'zumi') { last = performance.now(); resize(); }
      else if (name === 'settings') { const s = document.querySelector('#tab-settings .settings'); if (s) s.scrollTop = 0; }
    });
  }
  // Next-version UI (ADR 2026-10-27-next-version-path-flag): __ZUMI_NEXT_UI__ is a build constant (scripts/build-renderer.mjs, default off);
  // off, esbuild drops this line and the build carries no src/renderer/next/**. Runs after the tab handlers above, so it can add its own sidebar item.
  const freeKeyGuide = initFreeKeyGuide({ zumi, $ }); // the Guide panel: three key routes; opened from the first-run card and Settings > AI
  if ($('free-key-open')) $('free-key-open').addEventListener('click', () => freeKeyGuide.open());
  if (isPublicBuild(info)) initKeyGuide({ zumi, $, openGuide: freeKeyGuide.open }); // listens before the next UI can announce the end of onboarding
  if (__ZUMI_NEXT_UI__) import('./next/boot.js').then((m) => m.initNextUi({ $, engine, info })).catch((e) => console.error('next-ui: init failed', e));
  // Settings > the six inner tabs (T-31 settings P1): one tab bar over one scroll box, arrow keys + last tab remembered.
  initSettingsTabs();
  // The Marketplace reads the stage's two pickers and switches through them, so "Use" and the picker can never disagree.
  const pickerRows = (select, hidden) => (hidden ? [] : [...select.options].filter((o) => o.value).map((o) => ({ id: o.value, label: o.textContent, selected: o.value === select.value })));
  const market = initMarket({
    zumi,
    openTab: () => document.querySelector('.tab[data-tab="market"]').click(),
    pickers: {
      rooms: () => pickerRows($('scene-select'), $('scene-picker').hidden),
      models: () => pickerRows($('model-picker'), false),
      use: (kind, id) => { const s = $(kind === 'room' ? 'scene-select' : 'model-picker'); s.value = id; s.dispatchEvent(new Event('change')); },
    },
  });
  if (market) {
    $('voice-market-row').hidden = false;
    $('voice-market-open').addEventListener('click', () => market.open('voice.kokoro-82m', 'voice'));
  }
  // Settings (mode switch / save-lock / unlock / lock) reports every status change here; re-render only while the
  // Board tab is the one on screen. Window focus + a 30s poll catch an idle/OS lock flipping `locked` while the tab
  // stays open (contract doc §"Locked overlay while a live tab is already open").
  initSettings(zumi, $, {
    onBoardChange: (s) => { if (isBoardTabActive()) renderBoardTab(s); },
    devBuild: info.packaged === false && !info.settingsShots && !info.settingsProbe, // shots + probe show the installed-build view
    ownerAdmin: info.ownerAdmin,
    // Settings > Voice: the volume slider drives this playback gain live; "Play sample" speaks through the real path.
    voice: { setVolume: (v) => talk.speech.setVolume(v), playSample: (text) => talk.playSample(text), playTest: (lang, text) => talk.playTest(lang, text) },
  });
  // T-31 alpha.12: Settings > Agent & Soul > Rhythm + the read-only watcher switch (rhythm-card.js; absent without the host API).
  initRhythmCard(zumi, $);
  brainCard = initBrainKey(zumi, $);
  // Settings > AI brain saved/cleared the key: chat switches on/off now, no restart (role-models.js refreshes too).
  document.addEventListener('zumi:brain-key-changed', () => { talk.refreshStatus(); });
  initRoomSettings(zumi, $, { onRoomChange: (r) => { roomNote(''); switchRoom(r.selected); }, sceneName: () => { const r = sceneList.rooms.find((x) => x.id === sceneList.selected); return r ? sceneLabel(r) : null; } });
  initPhoneCard(zumi, $); // T-31-MOBILE M3: Settings > App > Phone (Tauri owner build only; hidden elsewhere)
  const roleModels = initRoleModels(zumi, $);
  if (roleModels) roleModels.refresh();
  // Owner build only: the lane models (Plan/Code/Review/Scout per task) live on the Board tab, never in this card.
  if (info.ownerAdmin) {
    $('roles-board-link').hidden = false;
    $('roles-board-open').addEventListener('click', () => document.querySelector('.tab[data-tab="board"]').click());
  }
  initUsage(zumi, $, roleModels ? { modelName: roleModels.modelName } : {});
  // HUD card "Open on the board" (T-31 0.2.3 B2): same page, no new IPC (Opus review 15-10). The board's own route
  // (#/task/<id>, vendor/laneboard public/app.js route()) opens that task; the panels never carry a step deep-link
  // (the board keeps the step in its own view state, not the URL), so at most the task is focused. The webview may not
  // be mounted yet (the board tab was never opened, or is still signing in): retry briefly, then give up.
  const openBoardTask = (taskId) => {
    if (!taskId) return;
    document.querySelector('.tab[data-tab="board"]').click();
    let tries = 0;
    const go = () => {
      // Wait for dom-ready, not just the home address: dataset.home is set before the <webview> loads (and before the
      // guest view is attached), so on a cold Board tab loadURL ran too early and hit a GUEST_VIEW error. dom-ready
      // only fires after dataset.home is set, so it still supplies the URL below.
      if (!webview || webview.dataset.domReady !== '1') { if (tries++ < 20) setTimeout(go, 150); return; }
      const u = reloadBoardUrl();
      u.hash = '#/task/' + encodeURIComponent(taskId);
      webview.loadURL(u.href).catch((e) => console.error('hud: open on board failed', e));
    };
    go();
  };
  // Talk-camera HUD (T-31 hud-react): off until the owner picks a style in Settings > HUD (hud/hud.js). Never blocks boot.
  initHud({
    zumi, $, engine, catalog, talk, hasModel: () => Boolean(current), devRun: !info.packaged,
    getView: () => (director.room ? (director.switching ? director.toName : director.view) : null),
    openBoardTask,
    onWorkFeed: (updates) => workSignal.setFeed(updates),
    onHoloFeed: (updates) => holo.setFeed(updates), // R3: the same task rows, to the holo panel (it shows the live task)
    onWorkEvent: ({ state }) => workLoop.taskEvent({ state }), // C1 step 10: a step event while working is work behaviour
  }).then((hud) => { if (!info.packaged) window.__zumiHud = hud; }).catch((e) => console.error('hud: init failed', e));
  zumi.onWindowFocus((f) => { if (f) refreshBoardTab(); });
  setInterval(refreshBoardTab, 30_000);

  // model:changed: the host changed the active model on its own. Re-derive the id to show from the fresh list's own
  // `selected` (which already applies the app's one precedence rule -- a --model/ZUMI_TEST_MODEL test file always wins);
  // the list can name any id, or no model at all.
  zumi.onModelChanged(async () => {
    const list = await zumi.listModels();
    fillPicker(list);
    if (list.selected) {
      switchModel(list.selected);
    } else {
      // Bump loadToken even though there is nothing to load: switchModel() checks `token !== loadToken` at every
      // await boundary, and that is the ONLY thing that can cancel an Apply's switchModel() still in flight if an
      // Undo lands a moment later (e.g. an owner double-clicking) — without this, that older load finishes after
      // us and clobbers the empty state it was just told to show.
      ++loadToken;
      if (current) { scene.remove(current.scene); engine.unbind(); VRMUtils.deepDispose(current.scene); current = null; currentId = null; }
      showEmpty();
      renderer.clear(); // the render loop skips frames while !current, so the canvas would otherwise still show the last drawn frame
    }
  });

  // ---------- language switch (EN / VI / 中文) ----------
  // The pick is persisted by main (settings.json uiLang) and applied without a restart: repaint the shell, the
  // dynamic lines, and — when the board page is open — the board's own language (laneboard.uiLang).
  async function changeLang(lang) {
    if (lang === getLocale()) return;
    try { if (zumi.ui) await zumi.ui.setLang(lang); } catch { /* still switch this session */ }
    setLocale(lang); // fires the onLocaleChange handler below (and settings.js's)
  }
  for (const b of document.querySelectorAll('#lang-switch button')) b.addEventListener('click', () => changeLang(b.dataset.lang));
  // R1: a theme change reloads an open Board so its #theme= fragment is read again (the page consumes it only at boot). A new query (`r`) forces a
  // real load: a hash-only change is a same-document navigation and would not re-run the page.
  onThemeChange(() => {
    if (!webview) return;
    const u = reloadBoardUrl();
    if (!u.searchParams.has('r')) u.searchParams.set('r', Date.now().toString(36));
    webview.loadURL(u.href);
  });
  let boardLocale = getLocale(); // setAddress fires this listener too: changing her words must not reload a board someone is typing in
  onLocaleChange(() => {
    apply(document);
    paintLangButtons();
    fillPicker({ models });
    paintDefaultNote(); // a visible refusal keeps its wording in the new language
    ui.setEnabled(talk.enabled);
    if (isBoardTabActive()) renderBoardTab(boardStatus);
    if (whereState) setWhere(whereState.key, whereState.vars, whereState.dir);
    if (webview && getLocale() !== boardLocale) webview.loadURL(reloadBoardUrl().href); // board already open: reload it so ?lang= matches the new locale
    boardLocale = getLocale();
  });

  // ---------- boot ----------
  // Self-tests start from the empty stage (what a fresh install shows) and load the test model themselves; same
  // for the room -- the room selftest drives switchRoom() itself (fixtures, the missing-anchor fallback, ...).
  if (!info.selftest && defaultModel) switchModel(defaultModel);
  else showEmpty();
  if (!info.selftest && defaultRoom && defaultRoom !== 'none') switchRoom(defaultRoom);
  if (info.demo) runDemo({ zumi, talk, engine, input, textbox: $('msg'), hasModel: () => Boolean(current), openBoardTab: () => document.querySelector('.tab[data-tab="board"]').click(), openZumiTab: () => document.querySelector('.tab[data-tab="zumi"]').click(), boardWebview: () => webview, reflexOnly: info.demoReflexOnly, onReflex });
  if (info.selftest) {
    locked = true;
    talk.muted = true;
    input.setLocked(true);
    runSelftest({
      info, engine, input, catalog, clips, defaultModel,
      get models() { return models; },
      bundledCount: modelList.bundledCount,
      hasModel: () => Boolean(current),
      emptyStateVisible: () => !$('empty-model').hidden && $('empty-model').getBoundingClientRect().width > 0,
      openBoardTab: () => document.querySelector('.tab[data-tab="board"]').click(),
      openZumiTab: () => document.querySelector('.tab[data-tab="zumi"]').click(),
      boardWebview: () => webview,
      switchModel,
      switchRoom,
      roomBlocked: () => Boolean(currentRoom && currentRoom.blocked),
      roomAnchorsFound: () => currentRoom && currentRoom.anchors,
      roomV2Id: () => currentRoomV2Id,
      onWindowFocus,
      setModelVisible: (v) => { if (current) current.scene.visible = v; },
      stageRect: () => { const r = stageEl.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, left: r.left, top: r.top }; },
      textbox: $('msg'),
      talk,
    });
  }
  if (info.roomShots) {
    const { runRoomShots } = await import('./shots/room.js');
    runRoomShots({
      zumi, $, engine,
      openZumiTab: () => document.querySelector('.tab[data-tab="zumi"]').click(),
      openSettingsTab: () => document.querySelector('.tab[data-tab="settings"]').click(),
    });
  }
  if (info.settingsShots && roleModels) {
    const { runSettingsRolesShots } = await import('./shots/settings-roles.js');
    runSettingsRolesShots({
      zumi, $, roleModels, minWindow: info.minWindow, talk,
      openSettingsTab: () => document.querySelector('.tab[data-tab="settings"]').click(),
      openZumiTab: () => document.querySelector('.tab[data-tab="zumi"]').click(),
    });
  }
  if (info.settingsProbe) {
    const { runSettingsProbe } = await import('./shots/settings-probe.js');
    runSettingsProbe({ zumi, $, openSettingsTab: () => document.querySelector('.tab[data-tab="settings"]').click() });
  }
  if (info.boardStress) {
    const { runBoardStress } = await import('./shots/board-stress.js');
    runBoardStress({
      zumi, $,
      openBoardTab: () => document.querySelector('.tab[data-tab="board"]').click(),
      openZumiTab: () => document.querySelector('.tab[data-tab="zumi"]').click(),
      boardWebview: () => webview,
    });
  }
}

main().catch((e) => {
  console.error(e);
  if (nodeSetupOpen()) return;
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;left:90px;top:60px;color:var(--danger);white-space:pre-wrap">${String(e && e.stack || e).replace(/</g, '&lt;')}</pre>`);
  if (window.zumi) window.zumi.info().then((i) => { if (i.selftest) window.zumi.selftest.finish({ ok: false, error: String(e && e.stack || e) }); });
});
