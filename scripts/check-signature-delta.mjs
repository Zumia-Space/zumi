// ReflexEngine.signatureDelta must treat q and -q as the SAME rotation (sign-invariant), keep max-abs-component
// scale for real motion (selftest thresholds 0.003/0.01/0.03 keep their meaning), and so a pure sign flip is not "motion".
// Red on 954d84a: signatureDelta compared raw components, so q vs -q gave 2 and a no-motion selftest passed.
globalThis.self = globalThis; globalThis.window = globalThis;
const { ReflexEngine } = await import('../src/renderer/reflex/engine.js');
const { MIN_POSE_DELTA } = await import('../src/renderer/selftest/gestures.js');
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };

// Real signature() output via a stub rig: every bone node shares one quaternion we control.
const q = { x: 0, y: 0, z: 0, w: 1 };
const node = { quaternion: q };
const eng = Object.create(ReflexEngine.prototype);
eng.rig = { nodes: new Proxy({}, { get: () => node }), vrm: { humanoid: { getNormalizedBoneNode: () => node } } };
eng.lastFinal = null; eng.eyeG = { x: 0, y: 0 };
const set = (x, y, z, w) => Object.assign(q, { x, y, z, w });
const snap = (x, y, z, w) => { set(x, y, z, w); return eng.signature(); };

const idle = snap(0.1, 0.2, 0.3, Math.sqrt(1 - 0.14));
const flipped = snap(-0.1, -0.2, -0.3, -Math.sqrt(1 - 0.14));
ok(ReflexEngine.signatureDelta(idle, flipped) === 0, 'q vs -q delta is 0', `got ${ReflexEngine.signatureDelta(idle, flipped)}`);
ok(ReflexEngine.signatureDelta(flipped, idle) === 0, '-q vs q delta is 0 (symmetric)');
ok(!(ReflexEngine.signatureDelta(flipped, idle) >= MIN_POSE_DELTA), 'selftest-style no-motion (sign flip only) does NOT pass the pose gate');

// Real small rotation (~1.15 deg about x on top of idle) must register, at roughly its component magnitude.
const th = 0.02; // rad
const moved = snap(Math.sin(th / 2), 0, 0, Math.cos(th / 2));
const base = snap(0, 0, 0, 1);
const dReal = ReflexEngine.signatureDelta(moved, base);
ok(dReal > 0 && Math.abs(dReal - Math.sin(th / 2)) < 1e-9, 'real small rotation > 0, scale = max |component| diff', `got ${dReal}`);
// Same small rotation but one side sign-flipped: unchanged.
const movedFlipped = snap(-Math.sin(th / 2), 0, 0, -Math.cos(th / 2));
ok(Math.abs(ReflexEngine.signatureDelta(movedFlipped, base) - dReal) < 1e-9, 'small rotation measured the same with a sign-flipped sample');
// Non-quaternion tail (expressions/eye gaze) keeps plain max-abs.
eng.eyeG = { x: 1, y: 0 }; const gaze = snap(0, 0, 0, 1); eng.eyeG = { x: 0, y: 0 };
ok(Math.abs(ReflexEngine.signatureDelta(gaze, base) - 0.2) < 1e-9, 'scalar tail (eye gaze) still plain abs diff');
// Bare arrays without quatLen keep old behaviour (no caller does this; guards against a silent throw).
ok(ReflexEngine.signatureDelta([0, 1], [0, 0.5]) === 0.5, 'plain array fallback');
console.log(`check:signature-delta ${fail ? 'FAILED' : 'ok'} · ${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
