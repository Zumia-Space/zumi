// R-02 gate (headless, no GUI): setRoom(null) must clear the stale #stage-plate canvas and restore the plain-stage
// camera (fov/aspect/view offset). Race: select a room, resize (plate canvas re-sized, plate painted), setRoom(null).
//   node scripts/check-camera-noroom.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

globalThis.self = globalThis;
globalThis.window = globalThis;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CameraDirector } = await import(pathToFileURL(path.join(ROOT, 'src/renderer/room/camera-director.js')).href);

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };

const DEFAULT_FOV = 28;
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 50);
const canvas = { width: 0, height: 0 };
const calls = [];
const plateCtx = { canvas, globalAlpha: 1, clearRect: (...a) => calls.push(['clear', ...a]), drawImage: () => calls.push(['draw']) };
const director = new CameraDirector({ engine: { lastInputAt: 0, speechMouth: false }, camera, plateCtx, defaultLights: [] });

// "select a room": a v2 room whose views carry a plate; its camera moves fov/aspect off the defaults.
director.room = { views: { talk: { plateTexture: { image: {} } } } };
director.cropFor = () => ({ plate: { x: 0, y: 0, w: 1, h: 1 } });
director.applyFrameCrop = () => {};
camera.fov = 41; camera.aspect = 1.9; camera.updateProjectionMatrix();

// resize(): the stage changes size (app.js sets plateCanvas.width/height + camera.aspect), a plate is drawn.
canvas.width = 800; canvas.height = 450;
camera.aspect = canvas.width / canvas.height;
camera.aspect = 2.3; // a camera move after the resize: setRoom(null) must put aspect back to the canvas aspect
director.drawPlate();
calls.length = 0;

director.setRoom(null);
ok(calls.some((c) => c[0] === 'clear' && c[1] === 0 && c[2] === 0 && c[3] === 800 && c[4] === 450), 'setRoom(null) clears the whole plate canvas', JSON.stringify(calls));
ok(camera.fov === DEFAULT_FOV, 'setRoom(null) restores the default fov', String(camera.fov));
ok(Math.abs(camera.aspect - 800 / 450) < 1e-9, 'setRoom(null) resets aspect to the canvas aspect', String(camera.aspect));
ok(camera.view === null || camera.view === undefined || camera.view.enabled === false, 'setRoom(null) clears the view offset');
director.update(); // no room: update() and drawPlate() are both no-ops (drawPlate has a room guard), must not repaint
director.drawPlate();
ok(!calls.some((c) => c[0] === 'draw'), 'update() with no room does not repaint the plate');

// zero-size canvas (stage hidden) must not throw and must still restore the camera
camera.fov = 41; canvas.width = 0; canvas.height = 0; director.room = {};
director.setRoom(null);
ok(camera.fov === DEFAULT_FOV, 'hidden stage (0x0 canvas): fov still restored, no throw');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
