#!/usr/bin/env node
// check:board-tab (0.3.5-alpha.9.10, OSS-02 step 2, owner 17-11): the Board tab is off on a new install, the Marketplace card
// "Laneboard" switches it on and off, a profile that already has a board keeps it, and switching never touches the board data.
// Node only: the real sidecar wrapper on scratch data folders, the renderer's pure Marketplace rows, the wiring in the sources.
// The page itself (click the card, the tab appears) is check:market-ui section 10; the built app is the 9.10 smoke.
//   node scripts/check-board-tab.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tabModule = path.join(ROOT, 'tauri', 'sidecar', 'board-tab.mjs');
if (!fs.existsSync(tabModule)) {
  ok(false, 'tauri/sidecar/board-tab.mjs exists (the Board tab switch)');
  console.log(`check:board-tab: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
const { BOARD_TAB_ID, boardTabOn, hasBoardData, withBoardTab } = await import(pathToFileURL(tabModule).href);
const { readSettings, saveSettings } = await import(pathToFileURL(path.join(ROOT, 'tauri', 'sidecar', 'adapters.mjs')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-board-tab-'));
let n = 0;
const fresh = () => { const d = path.join(tmp, `p${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
// A market host stand-in: one voice item, and a record of what reached it.
const inner = () => {
  const calls = [];
  return { calls, handlers: {
    'market.list': () => ({ platform: 'win-x64', store: null, items: [{ id: 'voice.kokoro-82m', kind: 'voice', state: 'available' }] }),
    'market.install': (id) => { calls.push(['install', id]); return { ok: true }; },
    'market.remove': (id) => { calls.push(['remove', id]); return { ok: true }; },
  } };
};
// One app start on a data folder: the wrapper as main.mjs builds it.
const start = (dataDir, { live = false } = {}) => {
  const m = inner();
  const h = withBoardTab(m.handlers, { dataDir, settings: () => readSettings(dataDir), saveSettings: (p) => saveSettings(dataDir, p), liveConfigured: () => live });
  return { h, calls: m.calls, card: () => h['market.list']().items.find((i) => i.id === BOARD_TAB_ID) };
};
// The board's data folder as files + sha256, to prove a switch never touches it.
const seedBoard = (dataDir) => {
  const dir = path.join(dataDir, 'board-data', 'laneboard');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.ndjson'), '{"seq":1,"type":"bootstrap"}\n{"seq":2,"type":"task.create","id":"T-1"}\n');
  fs.writeFileSync(path.join(dir, 'owner.token'), 'not-a-real-token-fixture');
  fs.writeFileSync(path.join(dir, 'media', 'a.png'), Buffer.from([137, 80, 78, 71]));
  return dir;
};
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)} ${fs.statSync(p).size} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } };
  walk(dir);
  return out.join('\n');
};

// ---------- 1. a fresh profile: no Board tab ----------
{
  const d = fresh();
  const app = start(d);
  ok(app.card() && app.card().state === 'off', 'fresh profile: the Laneboard card is listed and reads off', app.card());
  ok(boardTabOn({ dataDir: d, settings: () => readSettings(d) }) === false, 'fresh profile: the Board tab is off');
  ok(!('boardTab' in readSettings(d)), 'fresh profile: nothing is written until the card is used');
  ok(!fs.existsSync(path.join(d, 'board-data')), 'fresh profile: listing creates no board folder');
  const c = app.card();
  ok(c.kind === 'tool' && c.name === 'Laneboard' && c.author === 'Zumia' && c.licence === 'Apache-2.0' && Array.isArray(c.needs) && c.needs.includes('local-board'), 'the card: kind tool, named Laneboard, by Zumia, Apache-2.0, says it runs a local board', c);
  const list = app.h['market.list']();
  ok(list.items[0].id === 'voice.kokoro-82m' && list.platform === 'win-x64', 'the store items and fields are passed through unchanged');
}
// ---------- 2. turn the card on: the tab is on and survives a restart ----------
{
  const d = fresh();
  const app = start(d);
  const r = app.h['market.install'](BOARD_TAB_ID);
  ok(r && r.ok === true && !r.restartNeeded, 'Turn on answers ok, no restart', r);
  ok(readSettings(d).boardTab === true, 'Turn on saves boardTab: true in settings.json');
  ok(app.card().state === 'on', 'after Turn on the card reads on');
  ok(start(d).card().state === 'on', 'restart (a new host on the same folder): still on');
  ok(app.calls.length === 0, 'the Laneboard id never reaches the pack installer', app.calls);
}
// ---------- 3. turn the card off: the tab goes, the data folder is untouched ----------
{
  const d = fresh();
  const dir = seedBoard(d);
  const before = snapshot(dir);
  const app = start(d);
  app.h['market.install'](BOARD_TAB_ID);
  const r = app.h['market.remove'](BOARD_TAB_ID);
  ok(r && r.ok === true, 'Turn off answers ok', r);
  ok(readSettings(d).boardTab === false, 'Turn off saves boardTab: false');
  ok(app.card().state === 'off' && start(d).card().state === 'off', 'off now and after a restart, even with board data on disk');
  ok(snapshot(dir) === before, 'the laneboard folder is byte for byte the same after on and off', { before, after: snapshot(dir) });
  ok(app.calls.length === 0, 'Turn off never reaches the pack remover', app.calls);
}
// ---------- 4. an existing install with board data, setting unset: the tab stays on ----------
{
  const d = fresh();
  seedBoard(d);
  ok(hasBoardData(d) === true, 'a non-empty laneboard folder is board data');
  ok(start(d).card().state === 'on', 'board data + setting unset: on');
  const empty = fresh();
  fs.mkdirSync(path.join(empty, 'board-data', 'laneboard'), { recursive: true });
  ok(hasBoardData(empty) === false && start(empty).card().state === 'off', 'an empty laneboard folder is not board data: off');
  const legacy = fresh();
  fs.mkdirSync(path.join(legacy, 'board-data'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'board-data', 'tasks.json'), '{}');
  ok(start(legacy).card().state === 'on', 'a v0.2 board waiting for import (tasks.json): on');
  const live = fresh();
  ok(start(live, { live: true }).card().state === 'on', 'a signed-in live board, no local data: on');
  const user = fresh();
  saveSettings(user, { uiLang: 'vi' });
  ok(start(user).card().state === 'off', 'other settings saved, boardTab unset, no board: off');
}
// ---------- 5. other ids still go to the market host ----------
{
  const app = start(fresh());
  app.h['market.install']('voice.kokoro-82m');
  app.h['market.remove']('voice.kokoro-82m');
  ok(JSON.stringify(app.calls) === JSON.stringify([['install', 'voice.kokoro-82m'], ['remove', 'voice.kokoro-82m']]), 'install/remove of a pack still reach the market host', app.calls);
}
// ---------- 6. the sidecar wiring ----------
{
  const main = read('tauri/sidecar/main.mjs');
  ok(/import \{[^}]*withBoardTab[^}]*\} from '\.\/board-tab\.mjs'/.test(main), 'main.mjs imports withBoardTab');
  ok(/withBoardTab\(market\.handlers/.test(main), 'main.mjs wraps the market host handlers');
  for (const name of ['market.list', 'market.install', 'market.remove']) ok(new RegExp(`'${name.replace('.', '\\.')}': \\([^)]*\\) => marketTab\\['${name.replace('.', '\\.')}'\\]`).test(main), `main.mjs answers ${name} through the wrapper`);
  ok(/liveConfigured: \(\) => boardHost\.handlers\['board\.status'\]\(\)\.configured === true/.test(main), 'a signed-in live board counts as board data');
  ok(!/rmSync|unlinkSync|renameSync|rmdirSync/.test(read('tauri/sidecar/board-tab.mjs')), 'board-tab.mjs has no delete, move or rename call');
}
// ---------- 7. the renderer ----------
{
  const { buildRows, rowsFor } = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'market.js')).href);
  const { TABLES } = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'i18n.js')).href);
  const tr = (k) => TABLES.en[k] || k;
  const item = (state) => ({ id: BOARD_TAB_ID, kind: 'tool', name: 'Laneboard', author: 'Zumia', licence: 'Apache-2.0', needs: ['local-board'], state });
  const rowsOn = buildRows({ market: { items: [item('on')] }, rooms: [], models: [], tr, lang: 'en' });
  const rowsOff = buildRows({ market: { items: [item('off')] }, rooms: [], models: [], tr, lang: 'en' });
  ok(rowsOn[0].name === 'Laneboard' && rowsOn[0].desc === TABLES.en['market.item.tool_laneboard.desc'], 'the card row: named Laneboard, with its own line', rowsOn[0]);
  ok(rowsFor(rowsOn, 'installed', '').length === 1 && rowsFor(rowsOff, 'installed', '').length === 0, 'Installed lists the card only while it is on');
  ok(rowsFor(rowsOff, 'tool', '').length === 1, 'the Tools category lists it');
  for (const k of ['market.cat.tool', 'market.sect.tool', 'market.none.tool', 'market.turnOn', 'market.turnOff', 'market.need.local-board', 'market.item.tool_laneboard.desc', 'market.item.tool_laneboard.note']) {
    ok(['en', 'vi', 'zh'].every((l) => typeof TABLES[l][k] === 'string' && TABLES[l][k].length > 0), `${k} has words in en, vi and zh`);
  }
  const market = read('src/renderer/market.js');
  ok(/r\.state === 'off'\) button\('market\.turnOn'/.test(market) && /r\.state === 'on'\) button\('market\.turnOff'/.test(market), 'the card: Turn on when off, Turn off when on');
  ok(/onBoardTab/.test(market), 'market.js reports the switch to the app (onBoardTab)');
  const html = read('src/renderer/index.html');
  ok(/<button class="tab" data-tab="board"[^>]*\bhidden\b/.test(html), 'index.html: the Board tab starts hidden (shown once the host says on)');
  const app = read('src/renderer/app.js');
  ok(/onBoardTab: setBoardTab/.test(app), 'app.js passes setBoardTab to the Marketplace');
  ok(/if \(!market\) boardTabButton\.hidden = false/.test(app), 'app.js: a host with no Marketplace (Electron) keeps the Board tab');
}
// ---------- 8. the chat board digest ----------
// The brief asks for "no board installed" from the chat digest when the tab is off, only if that already exists. It does not
// (src/main/board-digest.mjs and the chat host have no such answer): reported in RESULT.md, not built here.

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:board-tab: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
