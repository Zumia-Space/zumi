// T-31 P0 API contract check (freeze the compatibility surface). Plain Node, no Electron, nothing opened, no network.
//
// What it does:
//   1. loads docs/migration/api-inventory.json (the frozen inventory);
//   2. loads the preload with a stubbed `electron` module and captures every name it exposes through
//      contextBridge.exposeInMainWorld (window.zumi.*), walking nested objects into dotted paths ('talk.turn',
//      'rooms.v2.saveView', ...). The wardrobe's window.zumiHost preload was removed in 0.3.0-alpha.11;
//   3. for each exposed leaf, CALLS it against the stub and records the IPC channel it uses plus its kind
//      (invoke/send/event) and declared arity (function.length);
//   4. FAILS if:
//        - the preloads expose a name that is not in the inventory (new API without a doc update);
//        - an exposed name calls a DIFFERENT channel than the inventory (a channel was renamed);
//        - an exposed name's KIND changed (invoke <-> send <-> event);
//        - an exposed name's ARITY changed (declared parameters != inventory args);
//        - a second window object reuses a name (two worlds expose it), or two preloads expose the same world;
//   5. WARNs (does not fail) on inventory names no longer exposed, and validates that each documented internal
//      channel ('channels[]') and renderer localStorage key ('rendererStorage[]') still exists in source.
//
// The preloads `require('electron')` at load time but only reference ipcRenderer inside their function bodies, so a
// stub that captures exposeInMainWorld lets us read the full surface without Electron.
//   node scripts/check-api-contract.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

const INVENTORY_PATH = path.join(ROOT, 'docs', 'migration', 'api-inventory.json');
const PRELOAD_FILES = {
  'src/main/preload.js': '',                    // exposes window.zumi -> unprefixed names
};

// ---------- load the inventory ----------
ok(fs.existsSync(INVENTORY_PATH), 'inventory file exists (docs/migration/api-inventory.json)');
if (!fs.existsSync(INVENTORY_PATH)) { console.log(`\n${pass} passed, ${fail} failed (fatal: no inventory)`); process.exit(1); }
const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
const invByName = new Map((inventory.apis || []).map((a) => [a.name, a]));
ok(invByName.size > 0, 'inventory lists at least one API name');

// ---------- capture the preload-exposed surface with a stubbed electron ----------
function captureExposed(relFile, prefix) {
  const worlds = new Map(); // worldName -> api object
  let calls = [];           // [{ method, channel }] recorded while a leaf runs
  const abs = path.join(ROOT, relFile);
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (worldName, api) => { worlds.set(worldName, api); } },
        ipcRenderer: {
          invoke: (channel) => { calls.push({ method: 'invoke', channel }); return Promise.resolve(); },
          send: (channel) => { calls.push({ method: 'send', channel }); },
          on: (channel) => { calls.push({ method: 'on', channel }); },
          once: (channel) => { calls.push({ method: 'on', channel }); },
          removeListener: () => {},
        },
      };
    }
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(abs)];
    require(abs);
  } finally {
    Module._load = original;
  }

  // Walk every exposed world's object graph into dotted leaf names.
  const leaves = [];
  const walk = (obj, trail, world) => {
    for (const [key, val] of Object.entries(obj)) {
      const here = `${trail}${key}`;
      if (typeof val === 'function') leaves.push({ world, name: prefix + here, fn: val });
      else if (val && typeof val === 'object') walk(val, `${here}.`, world);
    }
  };
  for (const [world, api] of worlds) walk(api, '', world);

  // Call each leaf (undefined args) and record the channel + kind it uses. Keep an ARRAY (not a map) so the same
  // dotted name exposed by two worlds is not collapsed.
  const results = [];
  for (const leaf of leaves) {
    calls = [];
    let error = null;
    try { leaf.fn(...new Array(leaf.fn.length).fill(undefined)); } catch (e) { error = e; }
    const first = calls[0] || null;
    const kind = !first ? null : (first.method === 'invoke' ? 'invoke' : first.method === 'send' ? 'send' : 'event');
    results.push({ world: leaf.world, name: leaf.name, kind, channel: first ? first.channel : null, arity: leaf.fn.length, error });
  }
  return { worlds, results };
}

const all = new Map();          // name -> first-seen { world, kind, channel, arity, file } (for channel/kind/arity)
const nameWorlds = new Map();    // name -> Set(world) across EVERY leaf (for name-reuse detection)
const worldOwners = new Map();   // world -> Set(files that expose it)
for (const [file, prefix] of Object.entries(PRELOAD_FILES)) {
  const { worlds, results } = captureExposed(file, prefix);
  for (const w of worlds.keys()) {
    if (!worldOwners.has(w)) worldOwners.set(w, new Set());
    worldOwners.get(w).add(file);
  }
  for (const info of results) {
    if (!all.has(info.name)) all.set(info.name, { ...info, file });
    if (!nameWorlds.has(info.name)) nameWorlds.set(info.name, new Set());
    nameWorlds.get(info.name).add(info.world);
  }
}
const exposedNames = new Set(all.keys());
ok(exposedNames.size > 0, 'preloads expose at least one API name');
const perFile = {};
for (const [name, info] of all) perFile[info.file] = (perFile[info.file] || 0) + 1;
console.log(`  preload surface: ${Object.entries(perFile).map(([f, n]) => `${f}=${n}`).join(', ')}`);

// ---------- forward direction: every exposed name must be in the inventory (hard fail) ----------
// A fold that is ahead of the working tree (talkModeFold: inventory = talk-mode 0.2.5 surface, tree not merged yet)
// lists the names it removed; those may still be exposed here. Nothing else is excused.
const foldRemoved = new Set((inventory.talkModeFold && inventory.talkModeFold.removed) || []);
const stillExposedRemoved = [...exposedNames].filter((n) => foldRemoved.has(n) && !invByName.has(n)).sort();
if (stillExposedRemoved.length) console.log(`NOTE ${stillExposedRemoved.length} name(s) removed by talkModeFold are still exposed (tree not merged to ${inventory.talkModeFold.to} yet): ${stillExposedRemoved.join(', ')}`);
const missing = [...exposedNames].filter((n) => !invByName.has(n) && !foldRemoved.has(n)).sort();
ok(missing.length === 0, 'every preload-exposed name is present in the inventory',
  missing.length ? `missing ${missing.length}: ${missing.join(', ')}` : '');

// ---------- channel / kind / arity drift (hard fail) ----------
const chanMismatch = [], kindMismatch = [], arityMismatch = [], noChannel = [];
for (const [name, info] of all) {
  const inv = invByName.get(name);
  if (!inv) continue; // already reported as missing
  if (info.channel == null) { noChannel.push(`${name}${info.error ? ` (threw: ${info.error.message})` : ''}`); continue; }
  if (inv.channel !== info.channel) chanMismatch.push(`${name}: preload='${info.channel}' inventory='${inv.channel}'`);
  if (inv.kind !== info.kind) kindMismatch.push(`${name}: preload='${info.kind}' inventory='${inv.kind}'`);
  if (Array.isArray(inv.args) && inv.args.length !== info.arity) arityMismatch.push(`${name}: preload=${info.arity} inventory=${inv.args.length}`);
}
ok(chanMismatch.length === 0, 'every exposed name calls its inventory channel (no rename)', chanMismatch.join('; '));
ok(kindMismatch.length === 0, 'every exposed name keeps its inventory kind (invoke/send/event)', kindMismatch.join('; '));
ok(arityMismatch.length === 0, 'every exposed name keeps its inventory arity (declared params)', arityMismatch.join('; '));
ok(noChannel.length === 0, 'every exposed name reaches an IPC channel when called', noChannel.join('; '));

// ---------- window-object reuse (hard fail) ----------
const dupWorlds = [...worldOwners].filter(([, files]) => files.size > 1).map(([w]) => w);
ok(dupWorlds.length === 0, 'no window object name is exposed by more than one preload', dupWorlds.join(', '));
const dupNames = [...nameWorlds].filter(([, ws]) => ws.size > 1).map(([n, ws]) => `${n} (${[...ws].join(', ')})`);
ok(dupNames.length === 0, 'no exposed name is reused by a second window object', dupNames.join('; '));

// ---------- anchors, so a broken walk/call is caught explicitly ----------
ok(exposedNames.has('talk.turn'), 'sanity: captured a nested name (talk.turn)');
ok(![...exposedNames].some((n) => n.startsWith('zumiHost.') || n.startsWith('wardrobe.') || n === 'onWardrobeProgress'), 'no wardrobe name is exposed (window.zumiHost and zumi.wardrobe removed in 0.3.0-alpha.11)');
ok(!(inventory.apis || []).some((a) => a.name.startsWith('zumiHost.') || a.name.startsWith('wardrobe.') || /^wardrobe:/.test(a.channel || '')), 'the inventory lists no wardrobe name or channel');
ok(all.get('talk.turn') && all.get('talk.turn').channel === 'talk:turn', 'sanity: talk.turn -> talk:turn');
ok(all.get('update.onState') && all.get('update.onState').kind === 'event', 'sanity: update.onState is an event');
ok(all.get('demo.log') && all.get('demo.log').kind === 'send', 'sanity: demo.log is a send');

// ---------- documented internal channels + renderer storage still exist in source ----------
const chanEntries = inventory.channels || [];
const storageEntries = inventory.rendererStorage || [];
const chanMissing = [];
for (const c of chanEntries) {
  for (const site of [c.emitter, c.handler]) {
    if (!site) continue;
    const rel = String(site).split(':')[0];
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.readFileSync(abs, 'utf8').includes(c.channel)) chanMissing.push(`${c.channel} @ ${site}`);
  }
}
ok(chanEntries.length > 0 && chanMissing.length === 0, 'each documented internal channel exists in its source sites',
  chanMissing.length ? `not found: ${chanMissing.join(', ')}` : '');
const storageMissing = [];
for (const s of storageEntries) {
  const abs = path.join(ROOT, s.owner.split(':')[0]);
  if (!fs.existsSync(abs) || !fs.readFileSync(abs, 'utf8').includes(s.key)) storageMissing.push(`${s.key} @ ${s.owner}`);
}
ok(storageEntries.length > 0 && storageMissing.length === 0, 'each documented renderer storage key exists in its owner',
  storageMissing.length ? `not found: ${storageMissing.join(', ')}` : '');

// ---------- reverse direction: inventory names no longer exposed (warning, not a failure) ----------
const stale = [...invByName.keys()].filter((n) => !exposedNames.has(n)).sort();
if (stale.length) console.log(`WARN ${stale.length} inventory name(s) not currently exposed (stale inventory, review): ${stale.join(', ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
