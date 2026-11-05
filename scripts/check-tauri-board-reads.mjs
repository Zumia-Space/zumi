#!/usr/bin/env node
// Brain's three read-only board calls in the Tauri sidecar (T-31 slice 3a-3, GATE-SEC-3a-3 C4 / C10 / C11, nit N2). Plain Node, no window, no network
// beyond loopback mocks on 127.0.0.1.
//   TB-0  readNextUiFlag and stageNextUiFlag: only a small {"nextUi":true} file beside the host exe turns it on; every doubt is off
//   TB-1  the REAL sidecar: no flag file / {"nextUi":false} / an oversized file / ZUMI_NEXT_UI=1 in the environment -> the three names are
//         "not_implemented" (unknown methods); {"nextUi":true} -> they answer
//   TB-2  bridgeMediaFetch (the pinned media transport): exactly the media route on the current bridge port passes (redirect:'error', the bridge
//         headers added); every other URL is egress_closed with 0 calls; a real 302 is refused as "offline" in Tauri (Electron says http_302, N2)
//   TB-3  inventory +3 rows (arity), the generated allow-list and the generated shim carry them
//   TB-4  a 5 MiB image fits the 16 MB response frame (about 6.7 MB on the wire) while a 12 MiB payload becomes response_too_large (the cap bites)
//   TB-5  createBrainReads: the public flavour has no opener (open_unavailable, nothing opened; a local ref is not_owner_build); the owner flavour
//         opens through the host primitive; decide is board-open.mjs's with this build's ownerAdmin
//   TB-6  wiring proof in main.mjs / board-reads-host.mjs / stage-bundle.mjs / egress.mjs
// Fault proof (C13): after the real run, each FAULTS entry patches one tauri/ file IN PLACE (restored in a finally; the tree must be clean first),
// runs the same asserts in a child process, and requires exit 1 AND a FAIL starting with the expected id. A fault anchor not found is exit 2.
//   node scripts/check-tauri-board-reads.mjs [--no-faults]        (child: --child)
// The real-sidecar part needs the vault helper: ZUMI_VAULT_EXE, or tauri/src-tauri/target/{release,debug}/zumi-vault.exe (no cargo build is run).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const args = process.argv.slice(2);
const CHILD = args.includes('--child');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; if (!CHILD) console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const FAULTS = [
  { id: 'flag-fail-open', expect: 'TB-0', file: 'tauri/sidecar/next-ui-flag.mjs', edits: [['} catch { return false; }', '} catch { return true; }']] },
  { id: 'flag-not-strict', expect: 'TB-0', file: 'tauri/sidecar/next-ui-flag.mjs', edits: [['.nextUi === true;', '.nextUi !== false;']] },
  { id: 'flag-no-size-cap', expect: 'TB-0', file: 'tauri/sidecar/next-ui-flag.mjs', edits: [['if (fsImpl.statSync(file).size > 256) return false;', '']] },
  { id: 'stage-when-off', expect: 'TB-0', file: 'tauri/next-ui-stage.mjs', edits: [['if (!on) { fs.rmSync(dest, { force: true }); return false; }', 'if (!on) { fs.writeFileSync(dest, `${JSON.stringify({ nextUi: true })}\\n`); return false; }']] },
  { id: 'gate-bypassed', expect: 'TB-1', file: 'tauri/sidecar/board-reads-host.mjs', edits: [['if (!readNextUiFlag(hostDir, fsImpl)) return null;', '']] },
  { id: 'rows-not-removed', expect: 'TB-1', file: 'tauri/sidecar/main.mjs', edits: [["if (!boardReads) for (const name of ['board.state', 'board.media', 'board.openRef']) delete handlers[name];", '']] },
  { id: 'bridge-forwards-everything', expect: 'TB-2', file: 'tauri/sidecar/egress.mjs', edits: [['if (!ok) return closedFetch(url, init);', '']] },
  { id: 'bridge-id-regex-loose', expect: 'TB-2', file: 'tauri/sidecar/egress.mjs', edits: [['att-\\\\d{1,12}', 'att-.+']] },
  { id: 'bridge-port-unpinned', expect: 'TB-2', file: 'tauri/sidecar/egress.mjs', edits: [['127\\\\.0\\\\.0\\\\.1:${port}', '127\\\\.0\\\\.0\\\\.1:\\\\d+']] },
  { id: 'bridge-follows-redirects', expect: 'TB-2', file: 'tauri/sidecar/egress.mjs', edits: [["...(await bridgeHeaders()) }, redirect: 'error' });", "...(await bridgeHeaders()) }, redirect: 'follow' });"]] },
  { id: 'public-has-opener', expect: 'TB-5', file: 'tauri/sidecar/board-reads-host.mjs', edits: [["open: ownerAdmin ? openHost : async () => { throw new Error('open_unavailable'); },", 'open: openHost,']] },
  { id: 'decide-always-owner', expect: 'TB-5', file: 'tauri/sidecar/board-reads-host.mjs', edits: [['decideOpenRef(ref, { ownerAdmin })', 'decideOpenRef(ref, { ownerAdmin: true })']] },
  { id: 'env-var-decides', expect: 'TB-6', file: 'tauri/sidecar/next-ui-flag.mjs', edits: [['export function readNextUiFlag(hostDir, fsImpl = fs) {\n  try {', "export function readNextUiFlag(hostDir, fsImpl = fs) {\n  if (process.env.ZUMI_NEXT_UI === '1') return true;\n  try {"]] },
];

const sidecarSrc = (name) => pathToFileURL(path.join(ROOT, 'tauri', 'sidecar', name)).href;
const { readNextUiFlag } = await import(sidecarSrc('next-ui-flag.mjs'));
const { bridgeMediaFetch } = await import(sidecarSrc('egress.mjs'));
const { createBrainReads } = await import(sidecarSrc('board-reads-host.mjs'));
const { serializeResponse, ok: rpcOk, MAX_RESPONSE_FRAME_BYTES } = await import(sidecarSrc('protocol.mjs'));
const { stageNextUiFlag } = await import(pathToFileURL(path.join(ROOT, 'tauri', 'next-ui-stage.mjs')).href);

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'brain-reads-'));
const dirWith = (name, files = {}) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d; };
const listen = (handler) => new Promise((res) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => res(srv)); });

// ---------------------------------------------------------------- TB-0 flag + stage
{
  const flag = (content) => readNextUiFlag(dirWith(`flag-${Math.random().toString(36).slice(2, 8)}`, content === undefined ? {} : { 'next-ui.json': content }));
  ok(flag('{"nextUi":true}\n') === true, 'TB-0a {"nextUi":true} -> on');
  const offs = [['no file', undefined], ['{"nextUi":false}', '{"nextUi":false}'], ['{}', '{}'], ['string "true"', '{"nextUi":"true"}'], ['number 1', '{"nextUi":1}'], ['not JSON', 'nextUi=true'], ['empty', ''], ['array', '[true]'], ['padded past 256 bytes', `{"nextUi":true,"pad":"${'x'.repeat(300)}"}`]];
  for (const [name, content] of offs) ok(flag(content) === false, `TB-0b ${name} -> off (fail-closed)`);
  ok(readNextUiFlag(undefined) === false && readNextUiFlag(null) === false, 'TB-0c no host dir (a self-test run) -> off');
  ok(readNextUiFlag('x', { statSync: () => { throw new Error('boom'); }, readFileSync: () => '' }) === false, 'TB-0d an unreadable file -> off, no throw');
  const renderer = (c) => dirWith(`renderer-${Math.random().toString(36).slice(2, 8)}`, c === undefined ? {} : { 'next-ui.json': c });
  const stageOf = (c, preexisting) => { const stage = dirWith(`stage-${Math.random().toString(36).slice(2, 8)}`, preexisting ? { 'next-ui.json': preexisting } : {}); const staged = stageNextUiFlag(stage, renderer(c)); return { staged, file: fs.existsSync(path.join(stage, 'next-ui.json')) ? fs.readFileSync(path.join(stage, 'next-ui.json'), 'utf8') : null, stage }; };
  const on = stageOf('{"nextUi":true}\n');
  ok(on.staged === true && on.file === '{"nextUi":true}\n' && readNextUiFlag(on.stage) === true, 'TB-0e a next-UI renderer build stages next-ui.json beside the host exe (and the sidecar reads it as on)', on);
  for (const [name, c] of [['a default build {"nextUi":false}', '{"nextUi":false}\n'], ['no next-ui.json in the renderer folder', undefined], ['garbage', 'x']]) {
    const r = stageOf(c);
    ok(r.staged === false && r.file === null, `TB-0f ${name}: nothing is staged`, r);
  }
  const stale = stageOf('{"nextUi":false}\n', '{"nextUi":true}\n');
  ok(stale.staged === false && stale.file === null, 'TB-0g a stale next-ui.json in the stage is removed when this build is not a next-UI build', stale);
}

// ---------------------------------------------------------------- TB-2 pinned media transport
{
  const calls = [];
  const base = async (url, init) => { calls.push({ url, init }); return { status: 200, url }; };
  const PORT = 45123;
  const hdrs = async () => ({ 'x-zumi-bridge-token': 'TOKEN' });
  const f = bridgeMediaFetch(base, async () => PORT, hdrs);
  const good = await f(`http://127.0.0.1:${PORT}/api/v1/media/att-17?w=480`, { headers: { accept: 'image/*' }, signal: 'S' });
  ok(good.status === 200 && calls.length === 1 && calls[0].init.redirect === 'error' && calls[0].init.headers['x-zumi-bridge-token'] === 'TOKEN' && calls[0].init.headers.accept === 'image/*' && calls[0].init.signal === 'S', 'TB-2a the exact media URL on the current port passes with redirect:"error", the bridge headers added, the caller\'s signal kept', calls[0]);
  await f(`http://127.0.0.1:${PORT}/api/v1/media/att-123456789012?w=1600`);
  ok(calls.length === 2, 'TB-2b width 1600 and a 12-digit id pass');
  const refused = [
    `http://127.0.0.1:${PORT}/api/v1/state`, `http://127.0.0.1:${PORT}/api/v1/media/att-1/../state?w=480`, `http://127.0.0.1:${PORT}/api/v1/media/att-1?w=9`,
    `http://127.0.0.1:${PORT + 1}/api/v1/media/att-1?w=480`, `https://127.0.0.1:${PORT}/api/v1/media/att-1?w=480`, `http://localhost:${PORT}/api/v1/media/att-1?w=480`,
    `http://127.0.0.1:${PORT}/api/v1/media/att-${'1'.repeat(13)}?w=480`, `http://127.0.0.1:${PORT}/api/v1/media/att-1?w=480&x=1`, `http://127.0.0.1:${PORT}/api/v1/media/att-1?w=480#f`,
    `http://u:p@127.0.0.1:${PORT}/api/v1/media/att-1?w=480`, `http://127.0.0.1:${PORT}/api/v1/media/ATT-1?w=480`, `http://127.0.0.1:${PORT}/api/v1/media/att-1`,
    ` http://127.0.0.1:${PORT}/api/v1/media/att-1?w=480`, `http://127.0.0.1:${PORT}/api/v1/media/att-1?w=480\n`, `http://127.0.0.1:${PORT}/x/api/v1/media/att-1?w=480`,
    `http://127.0.0.1:${PORT}0/api/v1/media/att-1?w=480`, `http://127.0.0.1:${PORT}//api/v1/media/att-1?w=480`, 'not a url', undefined, 5,
  ];
  const before = calls.length;
  const bad = [];
  for (const u of refused) { let err = null; try { await f(u); } catch (e) { err = e; } if (!(err && err.message === 'egress_closed')) bad.push(String(u).slice(-40)); }
  ok(bad.length === 0 && calls.length === before, `TB-2c ${refused.length} other URLs (state route, path tricks, other port, https, localhost, long id, extra query, fragment, userinfo, whitespace) -> egress_closed and no call`, { bad, extra: calls.length - before });
  for (const port of [null, 0, 70000, '45123', 1.5]) { let err = null; try { await bridgeMediaFetch(base, async () => port, hdrs)(`http://127.0.0.1:45123/api/v1/media/att-1?w=480`); } catch (e) { err = e; } ok(err && err.message === 'egress_closed', `TB-2d bridge port ${JSON.stringify(port)} -> closed`); }
  let err2 = null; try { await bridgeMediaFetch(base, async () => { throw new Error('x'); }, hdrs)(`http://127.0.0.1:1/api/v1/media/att-1?w=480`); } catch (e) { err2 = e; }
  ok(err2 && err2.message === 'egress_closed', 'TB-2e a bridgePort() that throws -> closed');
  let tErr = null; try { bridgeMediaFetch('nope', async () => 1, hdrs); } catch (e) { tErr = e; }
  ok(tErr instanceof TypeError, 'TB-2f no base fetch -> TypeError');
  // a real 302 through the real fetch: refused as "offline" in Tauri (Electron: http_302), and NOT followed
  const hits = [];
  const target = await listen((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); });
  const media = await listen((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/api/v1/state` }); res.end(); });
  const { createBoardReads } = await import(pathToFileURL(path.join(ROOT, 'src', 'main', 'board-reads.mjs')).href);
  const reads = createBoardReads({
    boardReader: { getState: async () => ({ ok: true, state: { attachments: [{ id: 'att-17', mime: 'image/png' }] } }) },
    liveBoard: { status: () => ({ configured: true, locked: false, mode: 'live' }), bridgePort: async () => media.address().port, bridgeHeaders: async () => ({}) },
    fetchImpl: bridgeMediaFetch(fetch, async () => media.address().port, async () => ({})), decide: () => ({ action: 'refuse', reason: 'x' }), open: async () => {},
  });
  const red = await reads.media('att-17');
  media.close(); target.close();
  ok(red.ok === false && red.reason === 'offline' && hits.length === 0, 'TB-2g a 302 from the bridge is refused as "offline" in Tauri (redirect:"error"; Electron says http_302) and is not followed', { red, followed: hits.length });
}

// ---------------------------------------------------------------- TB-3 inventory, allow-list, shim
{
  const inv = JSON.parse(read('docs', 'migration', 'api-inventory.json'));
  const row = (n) => inv.apis.find((a) => a.name === n);
  const want = { 'board.state': ['board:state', 0], 'board.media': ['board:media', 2], 'board.openRef': ['board:open-ref', 1] };
  ok(Object.entries(want).every(([n, [ch, arity]]) => row(n) && row(n).channel === ch && row(n).kind === 'invoke' && row(n).args.length === arity && !row(n).guestOnly && !row(n).tauriOnly), 'TB-3a the inventory has board.state (0 args), board.media (2), board.openRef (1), invoke kind, channels board:state / board:media / board:open-ref');
  const allow = read('tauri', 'src-tauri', 'src', 'rpc_allow_list.rs');
  ok(Object.keys(want).every((n) => allow.includes(`"${n}"`)), 'TB-3b the generated Rust allow-list names all three (a skipped regen would leave them refused)');
  const shim = read('tauri', 'shim', 'zumi-shim.js');
  ok(Object.keys(want).every((n) => shim.includes(`'${n}'`) || shim.includes(`"${n}"`)), 'TB-3c the generated shim carries all three');
}

// ---------------------------------------------------------------- TB-4 frame cap
{
  const img = Buffer.alloc(5 * 1024 * 1024, 7);
  const text = serializeResponse(rpcOk(1, { ok: true, mime: 'image/png', bytes: img }));
  const n = Buffer.byteLength(text);
  ok(n < MAX_RESPONSE_FRAME_BYTES && n > 6_000_000 && JSON.parse(text).result.bytes.$bin.length > 6_000_000, `TB-4a a 5 MiB image is ${(n / 1e6).toFixed(1)} MB on the wire as {$bin}, under the 16 MB response frame`, n);
  const big = serializeResponse(rpcOk(2, { ok: true, mime: 'image/png', bytes: Buffer.alloc(12 * 1024 * 1024, 7) }));
  ok(JSON.parse(big).error && JSON.parse(big).error.message === 'response_too_large', 'TB-4b a 12 MiB payload becomes response_too_large (the cap bites; control for 4a)', big.slice(0, 80));
}

// ---------------------------------------------------------------- TB-5 createBrainReads: flavours
{
  const URL_REF = 'https://example.com/spec?a=1';
  const LOCAL_MISSING = `${ownerPath('openRoots', ['D:/data/notes/'])[0]}t31/definitely-missing-3a3.md`; // under the owner build's first open root
  const state = { tasks: [{ id: 'T-31', title: 'Brain', goal: `Spec [Spec](${URL_REF}) and \`${LOCAL_MISSING}\`` }], attachments: [] };
  const mk = (ownerAdmin) => {
    const opened = [], entries = [];
    const reads = createBrainReads({
      hostDir: dirWith(`brain-${ownerAdmin ? 'owner' : 'public'}-${Math.random().toString(36).slice(2, 6)}`, { 'next-ui.json': '{"nextUi":true}\n' }), ownerAdmin,
      boardReader: { getState: async () => ({ ok: true, state }) }, liveBoard: { status: () => ({ configured: true, mode: 'live' }), bridgePort: async () => 1, bridgeHeaders: async () => ({}) },
      baseFetch: async () => { throw new Error('no network'); }, openHost: async (d) => { opened.push(d); }, logRefusal: (r) => entries.push(r),
    });
    return { reads, opened, entries };
  };
  ok(createBrainReads({ hostDir: dirWith('brain-off'), ownerAdmin: true, boardReader: {}, liveBoard: {}, baseFetch: async () => {}, openHost: async () => {}, logRefusal: () => {} }) === null, 'TB-5a no next-ui.json -> createBrainReads gives null (no table rows)');
  const pub = mk(false);
  const p1 = await pub.reads.openRef({ kind: 'url', target: URL_REF });
  await new Promise((r) => setTimeout(r, 1100));
  const p2 = await pub.reads.openRef({ kind: 'local', target: LOCAL_MISSING });
  ok(p1.opened === false && p1.reason === 'open_unavailable' && pub.opened.length === 0, 'TB-5b public flavour: a cited https link ends as { opened:false, reason:"open_unavailable" }, nothing opened', { p1, opened: pub.opened });
  ok(p2.opened === false && p2.reason === 'not_owner_build' && pub.opened.length === 0, 'TB-5c public flavour: a cited local file -> not_owner_build (decide runs with ownerAdmin false)', p2);
  const own = mk(true);
  const o1 = await own.reads.openRef({ kind: 'url', target: URL_REF });
  await new Promise((r) => setTimeout(r, 1100));
  const o2 = await own.reads.openRef({ kind: 'local', target: LOCAL_MISSING });
  ok(o1.opened === true && own.opened.length === 1 && own.opened[0].action === 'openExternal' && own.opened[0].url === URL_REF, 'TB-5d owner flavour: a cited https link opens through the host primitive, once', { o1, opened: own.opened });
  ok(o2.opened === false && o2.reason === 'not_found' && own.opened.length === 1, 'TB-5e owner flavour: a cited local path goes through decideOpenRef with ownerAdmin true (a missing file -> not_found, nothing opened)', o2);
  ok(!JSON.stringify([...pub.entries, ...own.entries]).match(/D:|definitely|spec\?a/), 'TB-5f the refusal entries carry no path or query', [...pub.entries, ...own.entries]);
}

// ---------------------------------------------------------------- TB-6 wiring proof
{
  const main = read('tauri', 'sidecar', 'main.mjs');
  const host = read('tauri', 'sidecar', 'board-reads-host.mjs');
  ok(/createBrainReads\(\{\s*\n\s*hostDir: ctx\.hostDir, ownerAdmin, boardReader: chatHost\.boardReader, liveBoard: boardHost\.liveBoard, baseFetch,/.test(main) && /openHost: createHostOpen\(ctx\.hostCalls\.call\)/.test(main), 'TB-6a main.mjs builds the reads over the SAME reader chat/HUD own, the board\'s liveBoard, the one base fetch and the host opener');
  ok(/'board\.state': \(\) => boardReads\.state\(\), \/\/ board:state/.test(main) && /'board\.media': \(id, opts\) => boardReads\.media\(id, opts\), \/\/ board:media/.test(main) && /'board\.openRef': \(ref\) => boardReads\.openRef\(ref\), \/\/ board:open-ref/.test(main), 'TB-6b the three rows are in the handler table (the coverage meter parses them)');
  ok(/if \(!boardReads\) for \(const name of \['board\.state', 'board\.media', 'board\.openRef'\]\) delete handlers\[name\];/.test(main), 'TB-6c without the flag the three rows are removed right after the table');
  ok(/fetchImpl: bridgeMediaFetch\(baseFetch, \(\) => liveBoard\.bridgePort\(\), \(\) => liveBoard\.bridgeHeaders\(\)\)/.test(host) && !/fetchImpl\s*[:=]\s*(globalThis\.)?fetch\b/.test(host), 'TB-6d fetchImpl is the pinned transport, never the global fetch');
  const hits = fs.readdirSync(path.join(ROOT, 'tauri', 'sidecar')).filter((f) => /\.m?js$/.test(f) && /process\.env(\.ZUMI_NEXT_UI|\[\s*['"]ZUMI_NEXT_UI['"]\s*\])/.test(read('tauri', 'sidecar', f)));
  ok(hits.length === 0, 'TB-6e no `process.env.ZUMI_NEXT_UI` anywhere in tauri/sidecar', hits);
  ok(/stageNextUiFlag\(stage, path\.join\(repo, 'build', 'renderer'\)\);/.test(read('tauri', 'stage-bundle.mjs')) && /import \{ stageNextUiFlag \} from '\.\/next-ui-stage\.mjs';/.test(read('tauri', 'stage-bundle.mjs')), 'TB-6f stage-bundle.mjs stages next-ui.json from build/renderer (flavour.json untouched)');
  ok(read('src', 'main', 'board-reads.mjs').length > 1000 && !read('tauri', 'sidecar', 'adapters.mjs').includes('board-reads'), 'TB-6g board-reads.mjs is imported unchanged (no adapter copy)');
}

// ---------------------------------------------------------------- TB-1 the REAL sidecar
function findHelper() {
  if (process.env.ZUMI_VAULT_EXE) return path.resolve(process.env.ZUMI_VAULT_EXE);
  const found = ['release', 'debug'].map((p) => path.join(ROOT, 'tauri', 'src-tauri', 'target', p, 'zumi-vault.exe')).filter((p) => fs.existsSync(p));
  return found[0] || null;
}
const HELPER = findHelper();
function startSidecar(host, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceEnabled: false, talkLevel: 'off' }));
  const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', '--now-ms', String(new Date(2025, 0, 15, 12).getTime()), '--vault-exe', path.join(host, 'zumi-vault.exe'), '--host-dir', host, '--flavour', path.join(host, 'flavour.json')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '', nextId = 1, readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.method === 'ready') readyResolve(); else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); } });
  return {
    ready, stderr: () => stderr,
    request(method, params = []) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000); pending.set(id, { resolve, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }); },
    close() { child.stdin.end(); return new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill(); }, 5000); }); },
  };
}
async function sidecarRun(name, files, ownerAdmin, env) {
  const host = dirWith(`host-${name}`, { 'flavour.json': `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin, boardMirror: null }, null, 2)}\n`, ...files });
  fs.copyFileSync(HELPER, path.join(host, 'zumi-vault.exe'));
  const c = startSidecar(host, env);
  try {
    await Promise.race([c.ready, new Promise((_r, rej) => setTimeout(() => rej(new Error(`sidecar not ready: ${c.stderr().slice(0, 300)}`)), 30000))]);
    const st = await c.request('board.state');
    const md = await c.request('board.media', ['att-1/../state', { w: 480 }]);
    const op = await c.request('board.openRef', [{ kind: 'url', target: 'https://example.com/x' }]);
    const control = await c.request('board.status');
    return { st, md, op, control };
  } finally { await c.close(); }
}
if (!HELPER || process.platform !== 'win32') {
  ok(false, 'TB-1 the vault helper is not built (set ZUMI_VAULT_EXE or build zumi-vault.exe); the real-sidecar asserts did not run');
} else {
  const unknown = (r) => r.error && r.error.code === -32601 && /^not_implemented:board\./.test(r.error.message);
  for (const [name, files, env] of [['absent', {}, {}], ['false', { 'next-ui.json': '{"nextUi":false}\n' }, {}], ['oversized', { 'next-ui.json': `{"nextUi":true,"pad":"${'x'.repeat(300)}"}` }, {}], ['env-var-only', {}, { ZUMI_NEXT_UI: '1' }]]) {
    const r = await sidecarRun(name, files, false, env);
    ok(unknown(r.st) && unknown(r.md) && unknown(r.op) && r.control.result && r.control.result.mode, `TB-1a sidecar with next-ui.json ${name}: board.state / media / openRef -> not_implemented (unknown methods); board.status still answers (control)`, { st: r.st.error || r.st.result, md: r.md.error || r.md.result, op: r.op.error || r.op.result });
  }
  const on = await sidecarRun('on', { 'next-ui.json': '{"nextUi":true}\n' }, false, { ZUMI_NEXT_UI: '0' });
  ok(on.st.result && on.st.result.ok === false && on.st.result.reason === 'unconfigured', 'TB-1b sidecar with {"nextUi":true} (ZUMI_NEXT_UI=0 in its environment): board.state answers, with the reader\'s own reason (no board is set up)', on.st);
  ok(on.md.result && on.md.result.ok === false && on.md.result.reason === 'bad_id', 'TB-1c ... board.media("att-1/../state") -> bad_id', on.md);
  ok(on.op.result && on.op.result.opened === false && on.op.result.reason === 'unconfigured', 'TB-1d ... board.openRef with no board data -> unconfigured, nothing opened', on.op);
}

fs.rmSync(work, { recursive: true, force: true });
if (CHILD) { console.log(`child: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
console.log(`\nreal run: ${pass} passed, ${fail} failed`);
let bad = fail;

if (!args.includes('--no-faults')) {
  const files = [...new Set(FAULTS.map((f) => f.file))];
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (dirty) { console.log(`ERROR the fault proof patches these files in place and restores them; commit or revert first:\n${dirty}`); process.exit(2); }
  let proved = 0;
  for (const f of FAULTS) {
    const file = path.join(ROOT, f.file);
    const original = fs.readFileSync(file, 'utf8');
    let patched = original;
    for (const [from, to] of f.edits) {
      const n = patched.split(from).length - 1;
      if (n !== 1) { console.log(`ERROR fault ${f.id}: anchor found ${n} times (need 1): ${from.slice(0, 70)}`); process.exit(2); }
      patched = patched.replace(from, () => to);
    }
    let run;
    try { fs.writeFileSync(file, patched); run = spawnSync(process.execPath, [SELF, '--child'], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env }); } finally { fs.writeFileSync(file, original); }
    const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
    const hit = fails.some((l) => l.startsWith(`FAIL ${f.expect}`));
    const good = run.status === 1 && hit;
    if (good) proved++; else bad++;
    console.log(`${good ? 'PROVED' : 'NOT PROVED'} fault ${f.id}: exit ${run.status}, ${fails.length} assert(s) failed, expected ${f.expect}* ${hit ? 'among them' : 'MISSING'}`);
    for (const l of fails) console.log(`    > ${l.slice(0, 200)}`);
  }
  const after = spawnSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (after) { console.log(`ERROR files not restored: ${after}`); bad++; }
  console.log(`faults proved: ${proved}/${FAULTS.length}`);
}
console.log(bad ? `\ncheck-tauri-board-reads: FAILED (${bad})` : '\ncheck-tauri-board-reads: all passed');
process.exit(bad ? 1 : 0);
