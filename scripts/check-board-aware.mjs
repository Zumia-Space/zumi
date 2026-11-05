// T-31 board-aware check (owner brief 07-10): board-digest.mjs (pure state -> text) and board-reader.mjs (cache +
// failure modes on top of a fake liveBoard). No Electron, NO network — every "board" here is a local fixture or a
// mocked fetch, same convention as check-board-live.mjs/check-chat-brain.mjs in this dir.
//   node scripts/check-board-aware.mjs   (or: npm run check:board-aware)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBoardDigest, unavailableDigestText, MAX_DIGEST_CHARS } from '../src/main/board-digest.mjs';
import { createBoardReader, REFRESH_MS } from '../src/main/board-reader.mjs';
import { loadRedactNames, seedRedactNamesIfMissing } from '../src/main/board-redact.mjs';

// Invented client names (no real board data). Same shapes as a real list: multi-word names, a shorter name contained in a
// longer one (Lumen / Lumen Atelier House), short person names.
const NAMES = ['Orvik', 'Lumen Atelier House', 'Lumen', 'Bao', 'Velvet Veil Bridal', 'Nhi', 'Vy', 'Kestra'];

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const NOW = Date.parse('2026-10-07T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

// ---------- fixtures: shaped like vendor/laneboard/src/views.mjs boardView() ----------
function task(id, { title = id, status = 'doing', next = '', currentStepLabel = null, lastActivityMinAgo = 10 } = {}) {
  return { id, title, status, next, current_step: currentStepLabel ? { id: `${id}/s1`, label: currentStepLabel, state: 'active' } : null, last_activity_at: minsAgo(lastActivityMinAgo) };
}
function waiting(taskId, text, sinceMinAgo = 30) { return { kind: 'ask', task_id: taskId, text, since: minsAgo(sinceMinAgo) }; }

// ---------- buildBoardDigest: basic shape ----------
{
  const state = {
    tasks: [
      task('L-01', { title: 'Avatar game', status: 'doing', next: 'wire camera path', lastActivityMinAgo: 5 }),
      task('T-31', { title: 'Zumi desktop', status: 'waiting', currentStepLabel: 'owner PIN', lastActivityMinAgo: 2 }),
      task('J-05', { title: 'Board tooling', status: 'closed', lastActivityMinAgo: 9999 }),
    ],
    attention: { waiting: [waiting('T-31', 'cần anh set PIN để mở live board', 2)] },
  };
  const d = buildBoardDigest(state, NOW);
  ok(d.ok === true, 'buildBoardDigest: returns ok:true for a normal state');
  ok(d.taskCount === 3 && d.waitingCount === 1, 'buildBoardDigest: counts match the fixture', JSON.stringify(d));
  ok(d.text.includes('[T-31]') && d.text.includes('cần anh set PIN'), 'buildBoardDigest: the waiting-on-owner text is in the digest');
  ok(d.text.includes('[WAITING ON OWNER]') && /\[T-31\][^\n]*\[WAITING ON OWNER\]/.test(d.text), 'buildBoardDigest: the waiting task is flagged in the active-tasks line too');
  ok(d.text.includes('[L-01]') && d.text.includes('wire camera path'), 'buildBoardDigest: an active task\'s `next` text is present');
  ok(!d.text.includes('[J-05]'), 'buildBoardDigest: a closed task is excluded from the active-tasks list (still counted in taskCount)');
  ok(/WAITING ON OWNER \(1\)/.test(d.text) && /ACTIVE TASKS \(2\)/.test(d.text), 'buildBoardDigest: section counts exclude inactive tasks correctly', d.text);
}

// ---------- truncation: list-level (N more, truncated) without blowing the char cap ----------
{
  const tasks = Array.from({ length: 45 }, (_, i) => task(`X-${i}`, { title: `task ${i}`, next: 'go' }));
  const d = buildBoardDigest({ tasks, attention: { waiting: [] } }, NOW);
  ok(d.text.includes('(+5 more, truncated)'), 'buildBoardDigest: 45 active tasks (cap 40) truncates the list with a count', d.text.slice(-200));
  ok(d.text.length < MAX_DIGEST_CHARS, 'buildBoardDigest: list truncation alone stays well under the char cap');
}
{
  const waitList = Array.from({ length: 25 }, (_, i) => waiting(`X-${i}`, 'short ask'));
  const d = buildBoardDigest({ tasks: [], attention: { waiting: waitList } }, NOW);
  ok(d.text.includes('(+5 more, truncated)'), 'buildBoardDigest: 25 waiting items (cap 20) truncates that list too', d.text.slice(0, 400));
}

// ---------- truncation: hard char cap on a huge board ----------
{
  const longTitle = 'a very long task title that repeats itself to pad out the line length considerably yes really';
  const tasks = Array.from({ length: 80 }, (_, i) => task(`HUGE-${i}`, { title: longTitle, next: longTitle }));
  const d = buildBoardDigest({ tasks, attention: { waiting: [] } }, NOW);
  ok(d.text.length <= MAX_DIGEST_CHARS, `buildBoardDigest: a huge board is clamped to MAX_DIGEST_CHARS (${d.text.length} <= ${MAX_DIGEST_CHARS})`);
  ok(d.text.endsWith('(…truncated)'), 'buildBoardDigest: the char-capped digest ends with an explicit truncation marker');
}

// ---------- unavailableDigestText: honest, never inventing ----------
{
  const t = unavailableDigestText('locked');
  ok(t.includes('locked') && /cannot see the task board/i.test(t), 'unavailableDigestText: names the reason and says it cannot see the board', t);
  ok(/never invent/i.test(t), 'unavailableDigestText: explicitly forbids inventing task info');
}

// ---------- createBoardReader: a fake liveBoard, no network, no secret ever touched ----------
const FAKE_SECRET = 'lb_SECRET_ck97x_should_never_leak';
const logLines = [];
const log = (m) => logLines.push(m);

function fakeLiveBoard({ configured = true, locked = false, mode = 'live', port = 4321 } = {}) {
  let secretsAccessed = false;
  const board = {
    status: () => ({ mode, configured, locked }),
    bridgePort: async () => (mode === 'live' ? port : null),
    bridgeHeaders: async () => ({}),
  };
  Object.defineProperty(board, 'secrets', { get() { secretsAccessed = true; return { getSecrets: () => ({ token: FAKE_SECRET }) }; } });
  return { board, wasSecretsAccessed: () => secretsAccessed };
}

const state = {
  tasks: [task('L-01', { title: 'Avatar game', next: 'ship round 7', lastActivityMinAgo: 3 })],
  attention: { waiting: [waiting('L-01', 'anh duyệt round 7', 1)] },
};

// unconfigured / locked / not-live: all refuse BEFORE any fetch, and never touch liveBoard.secrets
for (const [label, cfg, reason] of [
  ['unconfigured', { configured: false }, 'unconfigured'],
  ['locked', { locked: true }, 'locked'],
  ['mode=local (secrets fine, toggle off)', { mode: 'local' }, 'not_live'],
]) {
  let fetchCalls = 0;
  const { board, wasSecretsAccessed } = fakeLiveBoard(cfg);
  const reader = createBoardReader({ liveBoard: board, fetchImpl: () => { fetchCalls++; return Promise.reject(new Error('must not be called')); }, now: () => NOW, log });
  // eslint-disable-next-line no-await-in-loop
  const text = await reader.getDigestText();
  ok(text === unavailableDigestText(reason), `boardReader: ${label} -> unavailable(${reason})`, text);
  ok(fetchCalls === 0, `boardReader: ${label} never calls fetch`);
  ok(!wasSecretsAccessed(), `boardReader: ${label} never touches liveBoard.secrets`);
}

// bridgePort race: mode says live but the port comes back null
{
  const { board } = fakeLiveBoard({ mode: 'live', port: null });
  const reader = createBoardReader({ liveBoard: board, fetchImpl: () => Promise.reject(new Error('must not be called')), now: () => NOW, log });
  const text = await reader.getDigestText();
  ok(text === unavailableDigestText('not_live'), 'boardReader: bridgePort() resolving null is also not_live', text);
}

// http error / offline / timeout
{
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({ liveBoard: board, fetchImpl: async () => ({ ok: false, status: 503 }), now: () => NOW, log });
  ok(await reader.getDigestText() === unavailableDigestText('http_503'), 'boardReader: a non-200 bridge response is a clean http_503 reason');
}
{
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({ liveBoard: board, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, now: () => NOW, log });
  ok(await reader.getDigestText() === unavailableDigestText('offline'), 'boardReader: a network error is reason=offline');
}
{
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({ liveBoard: board, fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, now: () => NOW, log });
  ok(await reader.getDigestText() === unavailableDigestText('timeout'), 'boardReader: an aborted fetch is reason=timeout');
}

// success path + caching + force + in-flight de-dupe
{
  let clock = NOW;
  let fetchCalls = 0;
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({
    liveBoard: board,
    fetchImpl: async () => { fetchCalls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, json: async () => state }; },
    now: () => clock,
    log,
  });

  const text1 = await reader.getDigestText();
  ok(text1 === buildBoardDigest(state, clock).text, 'boardReader: a real fetch builds the same digest buildBoardDigest would, standalone');
  ok(fetchCalls === 1, 'boardReader: first call fetches once');

  await reader.getDigestText();
  ok(fetchCalls === 1, 'boardReader: a second call within the cache window does not refetch');

  await reader.getDigestText({ force: true });
  ok(fetchCalls === 2, 'boardReader: force:true refetches even inside the cache window');

  clock += REFRESH_MS + 1000;
  await reader.getDigestText();
  ok(fetchCalls === 3, 'boardReader: a call after the cache window refetches');

  const concurrentReader = createBoardReader({
    liveBoard: board,
    fetchImpl: async () => { fetchCalls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => state }; },
    now: () => clock,
    log,
  });
  const before = fetchCalls;
  await Promise.all([concurrentReader.getDigestText(), concurrentReader.getDigestText(), concurrentReader.getDigestText()]);
  ok(fetchCalls === before + 1, 'boardReader: concurrent callers against a cold cache share one in-flight fetch, not three');
}

// ---------- mirror fallback (owner build only, coordinator follow-up 07-10): bridge first, then the mirror ----------
const MIRROR = 'http://127.0.0.1:3100';
{
  // bridge short-circuited (locked, no network attempted at all) -> falls through to the mirror
  const { board } = fakeLiveBoard({ locked: true });
  let mirrorCalls = 0;
  const reader = createBoardReader({ liveBoard: board, mirrorOrigin: MIRROR, fetchImpl: async () => { mirrorCalls++; return { ok: true, json: async () => state }; }, now: () => NOW, log });
  const text = await reader.getDigestText();
  ok(mirrorCalls === 1, 'mirror fallback: a locked (short-circuited) bridge still reaches the mirror exactly once');
  ok(text === buildBoardDigest(state, NOW).text, 'mirror fallback: the digest built from the mirror matches buildBoardDigest standalone', text);
}
{
  // bridge unlocked but its OWN fetch fails (a real network hiccup, not a short-circuit) -> still falls through
  const { board } = fakeLiveBoard({ locked: false, mode: 'live', port: 4321 });
  let bridgeCalls = 0, mirrorCalls = 0;
  const reader = createBoardReader({
    liveBoard: board,
    mirrorOrigin: MIRROR,
    fetchImpl: async (url) => {
      if (String(url).includes(':4321')) { bridgeCalls++; throw new Error('ECONNRESET'); }
      mirrorCalls++;
      return { ok: true, json: async () => state };
    },
    now: () => NOW,
    log,
  });
  const text = await reader.getDigestText();
  ok(bridgeCalls === 1 && mirrorCalls === 1, 'mirror fallback: an unlocked bridge that itself fails to answer still falls through to the mirror', `bridgeCalls=${bridgeCalls} mirrorCalls=${mirrorCalls}`);
  ok(text === buildBoardDigest(state, NOW).text, 'mirror fallback: real mirror data comes back, not an unavailable message');
}
// never a non-loopback (or malformed) mirror, whatever zumiBoardMirror is set to
for (const bad of ['https://board.example.org', 'http://evil.example:3100', 'not a url at all']) {
  const { board } = fakeLiveBoard({ locked: true });
  let calls = 0;
  const reader = createBoardReader({ liveBoard: board, mirrorOrigin: bad, fetchImpl: async () => { calls++; return Promise.reject(new Error('must never be called')); }, now: () => NOW, log });
  const text = await reader.getDigestText();
  ok(calls === 0, `mirror fallback: a non-loopback/invalid mirror (${bad}) is never fetched`);
  ok(text === unavailableDigestText('locked'), `mirror fallback: a refused mirror (${bad}) falls back to the bridge's own honest reason`, text);
}
// the public build has no mirror at all: omitting mirrorOrigin behaves exactly like before this feature existed
{
  const { board } = fakeLiveBoard({ locked: true });
  let calls = 0;
  const reader = createBoardReader({ liveBoard: board, fetchImpl: async () => { calls++; return Promise.reject(new Error('must never be called')); }, now: () => NOW, log });
  const text = await reader.getDigestText();
  ok(calls === 0, 'mirror fallback: no mirrorOrigin configured (public build) never attempts a fetch beyond the bridge check');
  ok(text === unavailableDigestText('locked'), 'mirror fallback: no mirrorOrigin configured keeps the bridge-only behaviour unchanged', text);
}

// ---------- privacy redaction (CoS decision 07-10): default OFF-send masks every seeded name, zero leaks ----------
{
  // Content shaped like a real board (invented names and tasks): a multi-word client name and a person in DEMO-1,
  // a bridal shop and two people in DEMO-2, a one-word client in DEMO-3.
  const realish = {
    tasks: [
      task('DEMO-1', { title: 'Báo cáo quảng cáo quý cho Lumen Atelier House', next: 'Q4: gửi 2 file báo cáo thô (Lumen + Bao) đầu tháng 1/2027.' }),
      task('DEMO-2', { title: 'Quản lý quảng cáo Velvet Veil Bridal (học cách thắng của Nhi + Vy)', next: 'chốt bộ luật thắng/thua' }),
      task('DEMO-3', { title: 'CRM riêng cho Orvik (giống CRM hiện tại)', next: 'lập kế hoạch' }),
    ],
    attention: { waiting: [waiting('DEMO-1', 'duyệt báo cáo Kestra quý này', 5)] },
  };
  const redacted = buildBoardDigest(realish, NOW, { redact: { names: NAMES, mask: '[client]' } });
  for (const name of NAMES) ok(!redacted.text.includes(name), `redaction: "${name}" never appears in the default (redacted) digest`, redacted.text);
  ok(redacted.text.includes('[client]'), 'redaction: the mask token is present in the redacted digest');

  const unredacted = buildBoardDigest(realish, NOW); // no `redact` opt at all == the toggle is ON
  ok(['Lumen Atelier House', 'Orvik', 'Nhi', 'Vy', 'Bao'].every((n) => unredacted.text.includes(n)), 'redaction: with no redact option (toggle ON), every name is left exactly as on the board');
}
{
  const d = buildBoardDigest({ tasks: [task('X', { title: 'cho Orvik' })], attention: { waiting: [] } }, NOW, { redact: { names: NAMES, mask: '[khách hàng]' } });
  ok(d.text.includes('[khách hàng]') && !d.text.includes('Orvik'), 'redaction: the VI mask word masks correctly too');
}

// ---------- board-redact.mjs: seeded once, editable, never silently overwritten, tolerant of a bad file ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-redact-test-'));
  const file = path.join(dir, 'redact-names.json');
  ok(!fs.existsSync(file), 'board-redact: no file yet before the first seed');
  ok(seedRedactNamesIfMissing(file, NAMES) === true, 'board-redact: the first call seeds the file');
  ok(JSON.stringify(loadRedactNames(file).sort()) === JSON.stringify([...NAMES].sort()), 'board-redact: the seeded list round-trips exactly');

  fs.writeFileSync(file, JSON.stringify(['Only This One'])); // the owner's own edit
  ok(seedRedactNamesIfMissing(file, NAMES) === false, 'board-redact: seeding again on an existing file is a no-op');
  ok(JSON.stringify(loadRedactNames(file)) === JSON.stringify(['Only This One']), "board-redact: the owner's edit survives — the list is editable, never silently overwritten");

  ok(JSON.stringify(loadRedactNames(path.join(dir, 'nope.json'))) === '[]', 'board-redact: a missing file loads as []');
  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not json');
  ok(JSON.stringify(loadRedactNames(path.join(dir, 'corrupt.json'))) === '[]', 'board-redact: a corrupt file loads as [], never throws');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- createBoardReader x getRedact(): flows into the cached digest; sendClientNames:true turns it off ----------
{
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({
    liveBoard: board,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tasks: [task('DEMO-3', { title: 'cho Orvik' })], attention: { waiting: [] } }) }),
    now: () => NOW, log,
    getRedact: () => ({ sendClientNames: false, names: ['Orvik'], mask: '[client]' }),
  });
  const text = await reader.getDigestText();
  ok(text.includes('[client]') && !text.includes('Orvik'), 'boardReader: getRedact() flows through refresh() into the cached digest');
}
{
  const { board } = fakeLiveBoard({});
  const reader = createBoardReader({
    liveBoard: board,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tasks: [task('DEMO-3', { title: 'cho Orvik' })], attention: { waiting: [] } }) }),
    now: () => NOW, log,
    getRedact: () => ({ sendClientNames: true, names: ['Orvik'] }),
  });
  const text = await reader.getDigestText();
  ok(text.includes('Orvik'), 'boardReader: sendClientNames:true turns redaction off entirely, even with a non-empty name list');
}

// ---------- leak sweep: the fake secret must never appear in any digest text or log line produced above ----------
{
  const blob = logLines.join('\n');
  ok(!blob.includes(FAKE_SECRET), 'leak sweep: no log line from board-reader ever contains the fake secret', blob);
}

// ---------- caller-auth: the state fetch carries the bridge's header (else the digest is http_401) ----------
{
  const SENTINEL = 'sentinel-bridge-token-not-a-secret';
  const { board } = fakeLiveBoard({ locked: false, mode: 'live', port: 4321 });
  board.bridgeHeaders = async () => ({ 'x-zumi-bridge-token': SENTINEL });
  let seen = null;
  const reader = createBoardReader({
    liveBoard: board,
    fetchImpl: async (url, init) => { seen = { url: String(url), headers: init && init.headers }; return { ok: true, json: async () => state }; },
    now: () => NOW,
    log,
  });
  const text = await reader.getDigestText();
  ok(seen && seen.url === 'http://127.0.0.1:4321/api/v1/state' && seen.headers && seen.headers['x-zumi-bridge-token'] === SENTINEL, 'caller-auth: board-reader sends the bridge header on the live state fetch', JSON.stringify(seen));
  ok(text === buildBoardDigest(state, NOW).text, 'caller-auth: the digest still comes back with that header present');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
