// Headless guard for the selftest harness fixes of 12 RESULT.md (poke latency settle, agree gate, clip pick, sign-out diag).
//   node scripts/check-tauri-selftest-harness.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = globalThis.document || { documentElement: { classList: { contains: () => false } }, getElementById: () => null };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}`); } };
const src = (f) => fs.readFileSync(path.join(ROOT, 'src/renderer/selftest', f), 'utf8');

const { pickClipFallbackName, SETTLE_FRAMES_AFTER_CAPTURE, MAX_LATENCY_MS } = await import('../src/renderer/selftest/gestures.js');
const { agreeComposedOk } = await import('../src/renderer/selftest/talk.js');

// poke latency: the settle sits between the 'base' capture and the latency timer (callT0), and the 150 ms limit is untouched
const g = src('gestures.js');
const iBase = g.indexOf("api.capture('base', { rect, keepAs: 'base' });");
const iSettle = g.indexOf('await frames(SETTLE_FRAMES_AFTER_CAPTURE)', iBase);
const iT0 = g.indexOf('const callT0 = performance.now()', iBase);
ok(iBase > 0 && iSettle > iBase && iT0 > iSettle, 'runCase: rAF settle after the base capture, before the latency timer starts');
ok(SETTLE_FRAMES_AFTER_CAPTURE >= 2, 'settle is at least 2 frames');
ok(MAX_LATENCY_MS === 150, 'latency threshold still 150 ms');

// clip fallback never picks the seated base pose
ok(pickClipFallbackName(['sit-idle', 'sit-work'], 'sit-work') === null, 'clip pick: only seated clips (base sit-work) -> null');
ok(pickClipFallbackName(['sit-idle', 'sit-work'], 'sit-idle') === null, 'clip pick: only seated clips (base sit-idle) -> null');
ok(pickClipFallbackName(['sit-idle', 'Talk'], 'sit-idle') === 'Talk', 'clip pick: seated excluded, Talk picked');
ok(/skipped: 'no non-seated clip bundled'/.test(g) && !/clipFallback = \{ ok: true, skipped/.test(g), 'clipFallback: empty pool is reported skipped, not ok:true');
ok(/e\.skipped \? true : e\.ok|extrasSkipped/.test(src('index.js')), 'index: extrasOk handles skipped explicitly');
ok(pickClipFallbackName(['sit-work'], 'sit-work') === null, 'clip pick: only the base -> explicit skip');
ok(pickClipFallbackName(['sit-idle', 'Talk', 'x'], 'sit-idle') === 'Talk', 'clip pick: Talk preferred');

// agree: with the P1 gate on, composed is cached but never played as a second beat
const cacheOnly = { ok: true, played: false, cacheOnly: { remainingMs: 5100, speaking: true }, cachedAs: 'k' };
ok(agreeComposedOk(cacheOnly, true), 'agree gate on: cache-only passes');
ok(!agreeComposedOk({ ...cacheOnly, played: true, secondBeat: { remainingMs: 5000 } }, true), 'agree gate on: a played second beat fails');
ok(!agreeComposedOk({ ok: false, reason: 'schema' }, true), 'agree gate on: rejected composed fails');
ok(agreeComposedOk({ ok: true, played: true, secondBeat: { remainingMs: 5000 } }, false), 'agree gate off: second beat required');
ok(!agreeComposedOk(cacheOnly, false), 'agree gate off: cache-only fails');

// board: the embedded board hides sign-out by design (laneboard railFoot); assert the button is absent instead
const b = src('board.js');
ok(!/b\.signedOut/.test(b), 'board: no signedOut assertion in embed mode');
ok(/b\.signOutHiddenInEmbed/.test(b) && /b\.ok = Boolean\(b\.signOutHiddenInEmbed && /.test(b), 'board: ok requires signOutHiddenInEmbed');
ok(!/\[data-action=signout\]'\)\.click\(\)/.test(b), 'board: dead sign-out click removed');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
