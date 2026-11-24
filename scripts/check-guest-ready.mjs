// The real-app harness's guest boot wait (scripts/lib/guest-ready.mjs) against fake CDP connections. No app, no browser.
//   node scripts/check-guest-ready.mjs
// 1. A booted page resolves with its boot facts.
// 2. A context destroyed under the evaluate is retried on a fresh connection (the document swap), and the retry is counted.
// 3. A page whose boot REJECTED is a failure the caller cannot miss: guestReady rejects with the page's error (GATE-OPUS-LAG S1; before,
//    it resolved `{ ok: false }` and four of five callers went on to fail later with an unrelated null error).
// 4. (below) the page side: a rejected boot waits out a document swap before it is reported (T31reload).
import assert from 'node:assert/strict';
import vm from 'node:vm';

import * as lib from './lib/guest-ready.mjs';

const noSleep = async () => {};
const quiet = () => {};
// One fake connection per answer: a value is what the page's GUEST_BOOT returned, an Error is what the CDP call threw.
function fakeGuests(answers) {
  const made = [];
  const connectGuest = async () => {
    const answer = answers[Math.min(made.length, answers.length - 1)];
    const g = { closed: false, close() { g.closed = true; }, evaluate: async (expr) => { assert.equal(expr, lib.GUEST_BOOT); if (answer instanceof Error) throw answer; return answer; } };
    made.push(g);
    return g;
  };
  return { connectGuest, made };
}

let failed = 0;
async function row(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

await row('a booted page resolves with its boot facts', async () => {
  const f = fakeGuests([{ page: true, ok: true, gpu: 'gtx', marks: { firstFrameMs: 900 } }]);
  const { guest, boot } = await lib.guestReady({ connectGuest: f.connectGuest, timeoutMs: 5000, sleep: noSleep, log: quiet });
  assert.equal(guest, f.made[0]);
  assert.deepEqual(boot, { page: true, ok: true, gpu: 'gtx', marks: { firstFrameMs: 900 }, retries: 0 });
});

await row('a context destroyed under the evaluate is retried on a fresh connection', async () => {
  const f = fakeGuests([new Error('Execution context was destroyed.'), { page: false, href: 'about:blank' }, { page: true, ok: true, gpu: 'gtx', marks: {} }]);
  const { guest, boot } = await lib.guestReady({ connectGuest: f.connectGuest, timeoutMs: 5000, sleep: noSleep, log: quiet });
  assert.equal(guest, f.made[2]);
  assert.equal(boot.retries, 2);
  assert.ok(f.made[0].closed && f.made[1].closed, 'the dead connections are closed');
});

await row('a guest whose boot rejected makes guestReady reject with the page error (no silent { ok: false })', async () => {
  const f = fakeGuests([{ page: true, ok: false, err: 'TypeError: Failed to fetch' }]);
  let resolved = null, error = null;
  try { resolved = await lib.guestReady({ connectGuest: f.connectGuest, timeoutMs: 5000, sleep: noSleep, log: quiet }); } catch (e) { error = e; }
  assert.equal(resolved, null, `guestReady resolved ${JSON.stringify(resolved && resolved.boot)}`);
  assert.ok(error instanceof lib.GuestBootError, `rejected with ${error}`);
  assert.match(error.message, /guest boot failed: TypeError: Failed to fetch/);
  assert.deepEqual(error.boot, { page: true, ok: false, err: 'TypeError: Failed to fetch', retries: 0 });
  assert.equal(error.guest, f.made[0], 'the failed guest stays reachable for a screenshot or a log');
});

// 4. The page side (GUEST_BOOT, run in a vm with a fake page). A reload in place aborts the fetches of the document it replaces, and that
//    document, still alive, rejects its boot ("THREE.GLTFLoader: Failed to load buffer", T31reload red1 on the real app) while the new
//    document boots fine. So a rejected boot is held for the swap grace: a document being replaced dies inside it (CDP: context destroyed,
//    retried on the new document); only a document still there after it reports the failure.
async function runBootScript(ready) {
  const ctx = vm.createContext({ location: { href: lib.GUEST_PAGE }, window: { __room: { ready } }, setTimeout, String });
  const t0 = Date.now();
  const value = await vm.runInContext(lib.GUEST_BOOT, ctx);
  return { value, ms: Date.now() - t0 };
}
await row('page: a booted room reports at once', async () => {
  const { value, ms } = await runBootScript(Promise.resolve({ gpu: 'gtx', marks: { firstFrameMs: 1 } }));
  assert.equal(value.ok, true);
  assert.ok(ms < 500, `${ms} ms`);
});
await row('page: a rejected boot is reported only after the swap grace (a document being replaced dies first)', async () => {
  const ready = Promise.reject(new Error('THREE.GLTFLoader: Failed to load buffer "desk_lamp_arm_01.bin".'));
  ready.catch(() => {});
  const { value, ms } = await runBootScript(ready);
  assert.equal(value.ok, false);
  assert.match(value.err, /Failed to load buffer/);
  assert.ok(ms >= lib.SWAP_GRACE_MS - 50 && lib.SWAP_GRACE_MS >= 1500, `reported after ${ms} ms (grace ${lib.SWAP_GRACE_MS})`);
});

await row('an unrelated CDP error is not retried: it rejects at once', async () => {
  const f = fakeGuests([new Error('Runtime.evaluate: Internal error')]);
  await assert.rejects(lib.guestReady({ connectGuest: f.connectGuest, timeoutMs: 5000, sleep: noSleep, log: quiet }), /Internal error/);
  assert.equal(f.made.length, 1);
});

console.log(failed ? `FAILED: ${failed}` : 'ALL OK');
process.exit(failed ? 1 : 0);
