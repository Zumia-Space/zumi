// T-31 parity step 6 (network half): the egress guard. Gate: GATE-step6-hosts.md conditions 1-5.
// Plain Node, no app, no network (every base fetch here is a recorder; the one real fetch is used only to prove a
// refused URL never reaches it).
//
//   node scripts/check-tauri-egress.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_ORIGINS, providerEgressOrigins, guardedFetch, closedFetch, providerFetch, cloudFetch, jevFetch, mirrorFetch, JEV_ORIGIN,
  TTS_ORIGINS, KOKORO_ORIGINS, TTS_ALLOWED_ORIGINS, ttsFetch, selfTestFetch, isSelfTestRun,
} from '../tauri/sidecar/egress.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const prov = require('../src/main/providers.js');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

const FOUR = [
  'https://generativelanguage.googleapis.com',
  'https://api.groq.com',
  'https://integrate.api.nvidia.com',
  'https://api.cerebras.ai',
  'https://openrouter.ai',
  'https://opencode.ai',
];
// FL-1: the Tauri-only presets add Cloudflare Workers AI and Mistral to the same derived set.
const PRESET_HOSTS = ['https://api.cloudflare.com', 'https://api.mistral.ai'];
const EXPECTED = [...FOUR, ...PRESET_HOSTS];

// A base fetch that records and answers 200 without touching a socket.
function recorder(status = 200) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => ({}), text: async () => '' }; };
  f.calls = calls;
  return f;
}
const codeOf = async (p) => { try { await (typeof p === 'function' ? p() : p); return null; } catch (e) { return e.message; } };

// ---- 1. refusal order and exact code words ----
{
  const base = recorder();
  const g = guardedFetch(base, PROVIDER_ORIGINS);
  const cases = [
    [42, 'egress_bad_url'],
    [{ href: 'https://openrouter.ai/' }, 'egress_bad_url'],
    ['not a url', 'egress_bad_url'],
    ['https://openrouter.ai.evil.example/api/v1/chat/completions', 'egress_host'],
    ['https://openrouter.ai:8443/api/v1/chat/completions', 'egress_host'],
    ['https://openrouter.ai./api/v1/chat/completions', 'egress_host'],
    ['https://xn--e1afmkfd.example/', 'egress_host'],
    ['https://93.184.216.34/api/v1/chat/completions', 'egress_host'],
    ['https://api.groq.com@evil.example/openai/v1/chat/completions', 'egress_userinfo'],
    ['https://user:pass@openrouter.ai/api/v1/chat/completions', 'egress_userinfo'],
    ['http://openrouter.ai/api/v1/chat/completions', 'egress_scheme'],
    ['ftp://openrouter.ai/api/v1/chat/completions', 'egress_scheme'],
    ['file:///C:/secret.txt', 'egress_scheme'],
    // a loopback http origin that is not in the set: the fixture's port through the production guard (GATE-5)
    ['http://127.0.0.1:18787/api/v1/chat/completions', 'egress_host'],
  ];
  let allCodes = true;
  let allBare = true;
  let detail = '';
  for (const [url, code] of cases) {
    let err = null;
    try { await g(url, {}); } catch (e) { err = e; }
    if (!err || err.message !== code) { allCodes = false; detail = `${String(url).slice(0, 48)} -> ${err && err.message} (want ${code})`; break; }
    if (err.cause !== undefined || err.url !== undefined || String(err.message).includes('openrouter') || String(err.message).includes('127.0.0.1')) { allBare = false; detail = `attached data on ${code}`; }
  }
  ok(allCodes, 'guardedFetch refuses in order with the exact code words (bad_url, host, userinfo, scheme)', detail);
  ok(allBare, 'a refusal carries the code word only: no URL, no .cause, no host in the message', detail);
  ok(base.calls.length === 0, 'no refused call reaches the base fetch (no socket is opened)', `${base.calls.length} call(s)`);
  ok((await codeOf(closedFetch('https://openrouter.ai/'))) === 'egress_closed', 'closedFetch refuses every request with egress_closed');
}

// ---- 2. the provider set is derived, not typed ----
{
  ok(JSON.stringify([...PROVIDER_ORIGINS].sort()) === JSON.stringify([...EXPECTED].sort()), 'the provider set is derived from PROVIDERS and equals the six literal origins (incl. NVIDIA NIM, Cerebras) + the two Tauri presets', JSON.stringify(PROVIDER_ORIGINS));
  ok(PROVIDER_ORIGINS.length === EXPECTED.length, `exactly ${EXPECTED.length} provider origins`, String(PROVIDER_ORIGINS.length));
  const again = providerEgressOrigins(prov.PROVIDERS);
  ok(JSON.stringify(again) === JSON.stringify(PROVIDER_ORIGINS), 'providerEgressOrigins(PROVIDERS) is stable (baseURL + keyTest.url origins)');
  const sidecar = fs.readdirSync(path.join(ROOT, 'tauri', 'sidecar')).filter((f) => f.endsWith('.mjs'));
  // Step 8b's TTS allow-list is a DECLARED set (asserted above and by the recording fetch), not the provider table.
  // FL-1's free-llm-presets.mjs is the same kind of declared extension: it is the ONE file that may name the two new
  // provider hosts, and scripts/check-tauri-free-llm.mjs pins them to the registry. Everything else must stay derived.
  const DECLARED = new Set(['free-llm-presets.mjs']);
  const declaredTts = (code) => code.replace(/export const (?:TTS|KOKORO)_ORIGINS = Object\.freeze\(\[[\s\S]*?\]\);\s*export const TTS_ALLOWED_ORIGINS = Object\.freeze\(\[[^\]]*\]\);/g, '');
  const HOSTS = ['generativelanguage.googleapis.com', 'api.groq.com', 'opencode.ai', 'api.cloudflare.com', 'api.mistral.ai'];
  const typed = sidecar.filter((f) => {
    if (DECLARED.has(f)) return false;
    const code = declaredTts(fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    return HOSTS.some((h) => code.includes(h));
  });
  ok(typed.length === 0, 'no provider hostname is hand-typed under tauri/sidecar (only the derived set + the declared TTS/preset allow-lists)', typed.join(','));
  const presetSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'free-llm-presets.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(PRESET_HOSTS.every((o) => presetSrc.includes(new URL(o).host)), 'the preset layer declares exactly the two new provider hosts', PRESET_HOSTS.join(','));
}

// ---- 3. redirect is always error ----
{
  const base = recorder();
  const g = guardedFetch(base, PROVIDER_ORIGINS);
  await g('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
  await g('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', redirect: 'follow' });
  ok(base.calls[0].init.redirect === 'error', 'a call with no redirect is forwarded as redirect:error', JSON.stringify(base.calls[0].init));
  ok(base.calls[1].init.redirect === 'error', 'a caller asking for follow is overridden to redirect:error', JSON.stringify(base.calls[1].init));
  ok(base.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'the forwarded URL is unchanged (the guard never rewrites)', base.calls[0].url);
}

// ---- 4. the log line is origin + status only ----
{
  const lines = [];
  const base = recorder(204);
  const g = guardedFetch(base, PROVIDER_ORIGINS, (l) => lines.push(l));
  await g('https://openrouter.ai/api/v1/chat/completions?key=SECRET#frag', { method: 'POST', headers: { authorization: 'Bearer SECRET' }, body: 'SECRET body' });
  ok(lines.length === 1 && lines[0] === 'egress https://openrouter.ai 204', 'the guard logs exactly "egress <origin> <status>" after the call', lines.join(' | '));
  ok(!/SECRET|chat\/completions|authorization|body|\?|#/.test(lines.join('\n')), 'the log line carries no path, query, fragment, header or body');
  const transport = guardedFetch(async () => { throw new Error('connect ECONNREFUSED https://openrouter.ai/api/v1?key=SECRET'); }, PROVIDER_ORIGINS, (l) => lines.push(l));
  const err = await codeOf(() => transport('https://openrouter.ai/api/v1/chat/completions'));
  ok(err === 'connect ECONNREFUSED https://openrouter.ai/api/v1?key=SECRET' && lines[1] === 'egress https://openrouter.ai network', 'a transport failure logs the fixed word "network" and rethrows the original error untouched', lines.join(' | '));
}

// ---- 5. the flavour-gated sets ----
{
  const base = recorder();
  const cloud = cloudFetch(base, 'https://cloud.example.org');
  await cloud('https://cloud.example.org/api/zumi/desktop/turn', { method: 'POST' });
  ok(base.calls.length === 1 && base.calls[0].url.startsWith('https://cloud.example.org/'), 'cloudFetch allows the flavour cloudBase origin only');
  ok((await codeOf(() => cloud('https://cloud.example.org.evil.example/x'))) === 'egress_host', 'cloudFetch refuses a look-alike cloud origin');
  const noCloud = cloudFetch(base, null);
  ok((await codeOf(() => noCloud('https://cloud.example.org/x'))) === 'egress_closed', 'no cloudBase -> closedFetch');

  const jev = jevFetch(base, true);
  await jev('https://openrouter.ai/api/alpha/decisions', { method: 'POST' });
  ok(base.calls.at(-1).url === 'https://openrouter.ai/api/alpha/decisions', 'jevFetch allows openrouter.ai when reflexEgress is on');
  ok((await codeOf(() => jev('https://openrouter.ai.evil.example/x'))) === 'egress_host', 'jevFetch refuses a look-alike Jev origin');
  ok(JEV_ORIGIN === 'https://openrouter.ai', 'the Jev origin is the documented openrouter.ai');
  ok((await codeOf(() => jevFetch(base, false)('https://openrouter.ai/api/alpha/decisions'))) === 'egress_closed', 'reflexEgress off -> closedFetch');

  const mirror = mirrorFetch(base, 'http://127.0.0.1:3100');
  await mirror('http://127.0.0.1:3100/api/v1/state');
  ok(base.calls.at(-1).url === 'http://127.0.0.1:3100/api/v1/state', 'mirrorFetch allows the flavour loopback mirror over http');
  ok((await codeOf(() => mirror('http://127.0.0.1:3101/api/v1/state'))) === 'egress_host', 'mirrorFetch refuses another loopback port');
  ok((await codeOf(() => mirror('http://example.com/api/v1/state'))) === 'egress_scheme', 'mirrorFetch refuses a public http origin as a scheme');
  ok((await codeOf(() => mirrorFetch(base, null)('http://127.0.0.1:3100/api/v1/state'))) === 'egress_closed', 'no mirror -> closedFetch');
}

// ---- 6. the production guard refuses the SSE fixture's loopback origin (GATE-5) ----
{
  // A recording fetch stands in for the real one: the point is that the guard refuses BEFORE it, so the fixture URL
  // (http://127.0.0.1:<port>) can never be reached through the production provider fetch.
  let calls = 0;
  const real = async () => { calls++; return { status: 200 }; };
  const prod = providerFetch(real);
  const code = await codeOf(() => prod('http://127.0.0.1:18787/api/v1/chat/completions', { method: 'POST' }));
  ok(code === 'egress_host' && calls === 0, 'the production guard refuses the fixture loopback origin (egress_host) before any fetch', `${code} calls=${calls}`);
  const code2 = await codeOf(() => prod('https://127.0.0.1:18787/api/v1/chat/completions'));
  ok(code2 === 'egress_host' && calls === 0, 'even https on the fixture loopback port is refused (origin differs)', `${code2} calls=${calls}`);
}

// ---- 6b. step 8b: the TTS egress set (per-provider guards + the custom-URL rule) ----
{
  const FIXED = ['https://api.elevenlabs.io', 'https://generativelanguage.googleapis.com', 'https://texttospeech.googleapis.com', 'https://zumia.space'];
  ok(JSON.stringify([...TTS_ORIGINS].sort()) === JSON.stringify(FIXED), 'TTS_ORIGINS is exactly the four fixed BYO-TTS origins (PLAN-steps6plus 8b egress)', JSON.stringify(TTS_ORIGINS));
  ok(KOKORO_ORIGINS.includes('https://huggingface.co') && KOKORO_ORIGINS.every((o) => /^https:\/\/(?:[a-z0-9-]+\.)*(?:huggingface|hf)\.co$/.test(o)), 'KOKORO_ORIGINS names huggingface.co and its pinned redirect hosts', JSON.stringify(KOKORO_ORIGINS));
  ok(TTS_ALLOWED_ORIGINS.length === TTS_ORIGINS.length + KOKORO_ORIGINS.length, 'the TTS allow-list is the two named sets, with no extra origin');

  const base = recorder();
  const fixed = { google: 'https://texttospeech.googleapis.com', gemini: 'https://generativelanguage.googleapis.com', elevenlabs: 'https://api.elevenlabs.io' };
  for (const [id, origin] of Object.entries(fixed)) {
    const before = base.calls.length;
    await ttsFetch(base, id)(`${origin}/v1/speak`, { method: 'POST' });
    const c = base.calls[base.calls.length - 1];
    ok(base.calls.length === before + 1 && new URL(c.url).origin === origin && c.init.redirect === 'error', `${id}: reaches only ${origin}, with redirect:error`);
  }
  const codes = [];
  for (const [id, url] of [
    ['google', 'https://texttospeech.googleapis.com.evil.example/x'],
    ['gemini', 'https://generativelanguage.googleapis.com:8443/x'],
    ['elevenlabs', 'https://user:pass@api.elevenlabs.io/v1/x'],
    ['elevenlabs', 'http://api.elevenlabs.io/v1/x'],
    ['gemini', 'javascript:alert(1)'],
  ]) codes.push([id, url, await codeOf(() => ttsFetch(base, id)(url))]);
  ok(codes[0][2] === 'egress_host' && codes[1][2] === 'egress_host' && codes[2][2] === 'egress_userinfo' && (codes[3][2] === 'egress_scheme' || codes[3][2] === 'egress_host') && codes[4][2] === 'egress_scheme',
    'a fixed provider refuses a look-alike, a non-default port, userinfo, public http and another scheme', JSON.stringify(codes));

  const custom = ttsFetch(base, 'http-openai');
  const before = base.calls.length;
  await custom('https://tts.example.com/v1/audio/speech', { method: 'POST' });
  await custom('http://localhost:8880/v1/audio/speech', { method: 'POST' });
  await custom('http://127.0.0.1:8880/v1/audio/speech', { method: 'POST' });
  ok(base.calls.length === before + 3 && base.calls.slice(before).every((c) => c.init.redirect === 'error'), 'http-openai: a user https URL and loopback http URLs are allowed (tts-http rules), redirect:error');
  const customCodes = [];
  for (const url of ['http://tts.example.com/v1', 'https://u:p@tts.example.com/v1', 'https://tts.example.com/v1?key=1', 'ftp://tts.example.com/v1']) customCodes.push(await codeOf(() => custom(url)));
  ok(customCodes.slice(0, 3).every((c) => c === 'egress_userinfo' || c === 'egress_host' || c === 'egress_scheme') && customCodes.length === 4, 'http-openai: public http, userinfo, a query and another scheme are refused', JSON.stringify(customCodes));
  const zumia = ttsFetch(base, 'zumia-owner');
  const beforeZ = base.calls.length;
  await zumia('https://zumia.space/api/zumi/tts', { method: 'POST' });
  ok(base.calls.length === beforeZ + 1 && base.calls[base.calls.length - 1].init.redirect === 'error', 'zumia-owner: the fixed zumia.space origin is allowed with redirect:error');
}

// ---- 7. static: the socket API and the env reads ----
{
  const dir = path.join(ROOT, 'tauri', 'sidecar');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const SOCKET = /\bfetch\s*\(|globalThis\.fetch|undici|node:(?:http|https|net|tls)\b|XMLHttpRequest|WebSocket/;
  const offenders = files.filter((f) => f !== 'egress.mjs' && f !== 'main.mjs' && SOCKET.test(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  ok(offenders.length === 0, 'the socket API appears under tauri/sidecar only in egress.mjs and main.mjs', offenders.join(','));
  const envOffenders = files.filter((f) => /process\.env\.(?:ZUMI_TEST_|ZUMI_FIXTURE_LLM_URL)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  ok(envOffenders.length === 0, 'no ZUMI_TEST_* / ZUMI_FIXTURE_LLM_URL read exists under tauri/sidecar', envOffenders.join(','));
  // Step 10a: the live board's test-only upstream override is the ONE exception, and it lives in board-host.mjs where
  // the flavour gates it (public never reads it). scripts/check-tauri-board.mjs proves both halves; any other reference
  // to the name in the sidecar is still a failure.
  const upstreamReaders = files.filter((f) => /ZUMI_BOARD_UPSTREAM/.test(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  ok(upstreamReaders.length === 1 && upstreamReaders[0] === 'board-host.mjs', 'ZUMI_BOARD_UPSTREAM is referenced only by board-host.mjs (test-flavour board upstream, PLAN 10a)', upstreamReaders.join(','));
  const eventFixture = fs.readFileSync(path.join(dir, 'main.mjs'), 'utf8').includes('process.env.ZUMI_EVENT_FIXTURE');
  ok(eventFixture, 'the existing ZUMI_EVENT_FIXTURE probe stays (it is not egress)');
}

// ---- 8. condition 10: the Q4 deviation is recorded in DRIFT and the plan points at it ----
if (fs.existsSync(path.join(ROOT, 'docs', 'migration', 'DRIFT.md'))) { // the public export has no drift log
  const drift = fs.readFileSync(path.join(ROOT, 'docs', 'migration', 'DRIFT.md'), 'utf8');
  const entry = drift.split('\n').find((l) => l.includes('step 6 network half') && l.includes('Q4')) || '';
  ok(entry.includes('__host.aiKeyPageVerdict') && entry.includes('shell_ops::handle_request') && entry.includes('PLAN-steps6plus.md'), 'the DRIFT freeze-exceptions log records the Q4 deviation (intercept + verdict, plan bullet points at it)');
}

// ---- 9. self-test mode never leaves loopback (box re-probe 9bd5e2b: the owner --selftest called https://zumia.space) ----
{
  const base = recorder();
  const lines = [];
  const f = selfTestFetch(base, (l) => lines.push(l));
  let err = null;
  try { await f('https://zumia.space/api/tts', { method: 'POST' }); } catch (e) { err = e; }
  ok(err && err.message === 'egress_selftest_nonloopback' && base.calls.length === 0, 'a self-test egress to zumia.space is refused before the base fetch');
  ok(lines.length === 1 && lines[0] === 'egress https://zumia.space egress_selftest_nonloopback', 'the refusal is logged (origin + code word only)', lines.join('|'));
  for (const bad of ['https://openrouter.ai/x', 'http://example.com/', 'ftp://127.0.0.1/x', 'not a url']) {
    let e2 = null; try { await f(bad); } catch (e) { e2 = e; }
    ok(Boolean(e2) && base.calls.length === 0, 'self-test refuses ' + bad);
  }
  await f('http://127.0.0.1:3100/api/v1/state');
  await f('http://localhost:4212/');
  ok(base.calls.length === 2, 'self-test passes loopback http through to the base fetch');
  const stacked = ttsFetch(selfTestFetch(recorder(), () => {}), 'zumia-owner', () => {});
  let e3 = null; try { await stacked('https://zumia.space/api/v1/tts'); } catch (e) { e3 = e; }
  ok(e3 && e3.message === 'egress_selftest_nonloopback', 'the owner voice route (zumia.space) is refused in self-test even though ttsFetch allows it');
  const normal = recorder();
  const g = ttsFetch(normal, 'zumia-owner', () => {});
  await g('https://zumia.space/api/v1/tts');
  ok(normal.calls.length === 1, 'normal mode: the owner voice route still reaches zumia.space');
  ok(!isSelfTestRun({ selftest: null, demo: null, shots: null, probe: null }) && !isSelfTestRun(null), 'isSelfTestRun is false for a normal launch');
  ok(['selftest', 'demo', 'shots', 'probe'].every((k) => isSelfTestRun({ [k]: k === 'selftest' || k === 'probe' ? '/x' : { dir: '/x' } })), 'isSelfTestRun is true for every self-test mode');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  ok(mainSrc.includes('const baseFetch = isSelfTestRun(ctx.selfTest) ? selfTestFetch(rawFetch, egressLog) : rawFetch;'), 'main.mjs hands the self-test guard to every module as the ONE base fetch');
  ok(mainSrc.includes('cloud: () => (cloudFixtureFor(ctx.selfTest) ? chatHost.cloud : null)'), 'main.mjs gives the voice core the fixture cloud only in a fixture run (normal mode: null, unchanged)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
