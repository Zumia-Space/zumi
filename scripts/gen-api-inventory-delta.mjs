// T-31 — measure the preload-surface delta between two commits, so the P0 API inventory can be reconciled
// with what the app actually shipped. Plain Node, no Electron, no window, no network.
//
// The P0 inventory (docs/migration/api-inventory.json) was frozen at `d3d8fc7`; Zumi 0.2.3 shipped at
// `e578206`. There is no separate inventory generator: the freeze was authored by hand in a docs-only
// commit (f1c0ccb). This script is that missing generator — it re-runs the SAME capture the
// `scripts/check-api-contract.mjs` harness uses, but against a commit's source (`git show <ref>:<path>`)
// instead of the working tree, and prints every added / removed / changed exposed name with its kind,
// channel and arity.
//
//   node scripts/gen-api-inventory-delta.mjs                 # d3d8fc7 -> e578206 (the shipped delta)
//   node scripts/gen-api-inventory-delta.mjs --from <ref> --to <ref>
//
// The output is a report for a human to fold into api-inventory.json `delta` + API-INVENTORY.md §8; the
// script never edits the inventory itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The preload the renderer sees: window.zumi (unprefixed). The wardrobe's window.zumiHost preload left in 0.3.0-alpha.11.
const PRELOADS = [
  ['src/main/preload.js', ''],
];

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const FROM = opt('--from', 'd3d8fc7');
const TO = opt('--to', 'e578206');

/** Write a ref's preloads to a scratch dir; return the dir so require() can load them. */
function materialize(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zumi-delta-${ref.slice(0, 7)}-`));
  for (const [rel] of PRELOADS) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const text = execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

/** Load both preloads under a stubbed electron and return Map(name -> {kind, channel, arity}). */
function capture(dir) {
  const worlds = new Map();
  let calls = [];
  const original = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (w, api) => worlds.set(w, api) },
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
    for (const [rel] of PRELOADS) { const abs = path.join(dir, rel); delete require.cache[require.resolve(abs)]; require(abs); }
  } finally {
    Module._load = original;
  }

  const leaves = [];
  const walk = (obj, trail, world) => {
    for (const [k, v] of Object.entries(obj)) {
      const here = `${trail}${k}`;
      if (typeof v === 'function') leaves.push({ world, name: (world === 'zumiHost' ? 'zumiHost.' : '') + here, fn: v });
      else if (v && typeof v === 'object') walk(v, `${here}.`, world);
    }
  };
  for (const [world, api] of worlds) walk(api, '', world);

  const out = new Map();
  for (const leaf of leaves) {
    calls = [];
    try { leaf.fn(...new Array(leaf.fn.length).fill(undefined)); } catch { /* channel capture is best effort */ }
    const first = calls[0] || null;
    const kind = !first ? null : (first.method === 'invoke' ? 'invoke' : first.method === 'send' ? 'send' : 'event');
    out.set(leaf.name, { kind, channel: first ? first.channel : null, arity: leaf.fn.length });
  }
  return out;
}

const fromMap = capture(materialize(FROM));
const toMap = capture(materialize(TO));

const added = [], removed = [], changed = [];
for (const [name, now] of toMap) {
  const before = fromMap.get(name);
  if (!before) { added.push({ name, ...now }); continue; }
  const fields = [];
  if (before.channel !== now.channel) fields.push(`channel ${before.channel} -> ${now.channel}`);
  if (before.kind !== now.kind) fields.push(`kind ${before.kind} -> ${now.kind}`);
  if (before.arity !== now.arity) fields.push(`arity ${before.arity} -> ${now.arity}`);
  if (fields.length) changed.push({ name, fields });
}
for (const name of fromMap.keys()) if (!toMap.has(name)) removed.push(name);

console.log(`preload surface ${FROM} -> ${TO}: ${fromMap.size} -> ${toMap.size} names`);
console.log(`\nADDED (${added.length})`);
for (const a of added) console.log(`  ${a.name}  kind=${a.kind} channel=${a.channel} arity=${a.arity}`);
console.log(`\nREMOVED (${removed.length})`);
for (const r of removed) console.log(`  ${r}`);
console.log(`\nCHANGED (${changed.length})`);
for (const c of changed) console.log(`  ${c.name}  ${c.fields.join('; ')}`);
