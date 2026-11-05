// T-31 P1a allow-list check. Plain Node, no network.
//
// The `rpc` command gates on a Rust allow-list generated from the frozen inventory. This check fails
// if the committed list drifts from a fresh generation, or if lib.rs stops enforcing it.
//
//   node scripts/check-tauri-allowlist.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventChannelNames, generateAllowList, guestOnlyMethodNames, rendererMethodNames, rpcMethodNames } from '../tauri/gen-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const INVENTORY = path.join(ROOT, 'docs', 'migration', 'api-inventory.json');
const ALLOW = path.join(ROOT, 'tauri', 'src-tauri', 'src', 'rpc_allow_list.rs');
const LIB = path.join(ROOT, 'tauri', 'src-tauri', 'src', 'lib.rs');

const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));

ok(fs.existsSync(ALLOW), 'committed allow-list exists (tauri/src-tauri/src/rpc_allow_list.rs)');
const committed = fs.readFileSync(ALLOW, 'utf8');
ok(committed === generateAllowList(inventory), 'committed allow-list matches a fresh generation (run: node tauri/gen-allowlist.mjs)');

const methods = rendererMethodNames(inventory);
const guestOnly = guestOnlyMethodNames(inventory);
ok(methods.length > 0, 'the allow-list is non-empty');
ok(new Set(methods).size === methods.length, 'the allow-list has no duplicate names');
ok(methods.every((m) => /^[A-Za-z][\w.]*$/.test(m)), 'every allow-list name is a plain dotted identifier');

// Parity 11-2: an inventory `guestOnly` name is a guest webview's own bridge, never the main renderer's rpc surface.
// The generated GUEST_ONLY_METHODS is the named set; ALLOWED_METHODS excludes it. Its only member (zumiHost.apply, the
// wardrobe bridge) was removed in 0.3.0-alpha.11, so the set is now empty.
const committedGuestBlock = (committed.match(/GUEST_ONLY_METHODS[^=]*=\s*&\[([\s\S]*?)\];/) || ['', ''])[1];
const committedGuest = [...committedGuestBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
ok(guestOnly.every((m) => rpcMethodNames(inventory).includes(m)), 'every guest-only name is still an inventory invoke/send name');
ok(guestOnly.every((m) => !methods.includes(m)), 'no guest-only name is in the main renderer allow-list');
ok(committedGuest.join('\n') === guestOnly.join('\n'), 'the committed GUEST_ONLY_METHODS matches the inventory guestOnly set');
ok(guestOnly.length === 0 && committedGuest.length === 0, 'no guest-only name is left (the wardrobe bridge was the only one)', JSON.stringify(committedGuest));
ok(!methods.some((m) => m.startsWith('wardrobe.')) && !committed.includes('"wardrobe'), 'no wardrobe.* method or wardrobe:* channel in the generated or committed allow-lists');
ok(!methods.includes('zumiHost.apply'), 'zumiHost.apply is absent from the generated main allow-list');
const committedAllowedBlock = (committed.match(/ALLOWED_METHODS[^=]*=\s*&\[([\s\S]*?)\];/) || ['', ''])[1];
// S2 (GATE-BRIDGE-AUTH): board.testBridgeAuth hands out the bridge's caller secret to a script over the sidecar pipe in a
// test flavour only. It must never be renderer- or guest-reachable: not in the inventory, not in either generated block.
ok(!methods.includes('board.testBridgeAuth') && !rpcMethodNames(inventory).includes('board.testBridgeAuth') && !committed.includes('testBridgeAuth'), 'board.testBridgeAuth is not in the inventory nor in the committed allow-list (renderer cannot reach it)');
ok(!committedAllowedBlock.includes('"zumiHost.apply"'), 'zumiHost.apply is absent from the committed ALLOWED_METHODS block');
ok(/pub const GUEST_ONLY_METHODS/.test(committed), 'the committed file declares GUEST_ONLY_METHODS');
// The renderer's rpc must never be able to reach the sidecar's internal `__host.*` methods (guestDecide
// and friends): they are not in the inventory, so they must not be in the generated allow-list either.
ok(methods.every((m) => !m.startsWith('__host.')), 'no __host.* internal method is in the allow-list');

// P1c3: the external-link methods are host-only, exactly like guestDecide. Neither may be in the
// inventory, in the generated list, or callable through the rpc gate.
const HOST_ONLY = ['__host.guestDecide', '__host.decideExternalUrl', '__host.logRefusal', '__host.idle', '__host.windowVisible', '__host.osEvent',
  // Parity 4b: the asset route's resolver. The main webview names only a relative app path, and Rust re-checks whatever
  // it answers; the renderer must never be able to call it (it is not an inventory name).
  '__host.resolveAsset'];
const inventoryText = fs.readFileSync(INVENTORY, 'utf8');
for (const name of HOST_ONLY) {
  ok(!methods.includes(name), `${name} is not in the generated allow-list`);
  ok(!inventoryText.includes(name), `${name} is not in the api inventory`);
  ok(!committed.includes(name), `${name} is not in the committed rpc_allow_list.rs`);
}
ok(!/__host/.test(fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'webview-element.js'), 'utf8')), 'the renderer shims never name a __host method');

const lib = fs.readFileSync(LIB, 'utf8');
ok(/rpc_allow_list::ALLOWED_METHODS\.contains/.test(lib), 'the rpc command gates on ALLOWED_METHODS');
ok(/mod rpc_allow_list;/.test(lib), 'lib.rs declares the rpc_allow_list module');

// Push events: the generated channel list is exactly the inventory's event channels, and events.rs is the only
// consumer that forwards a sidecar notification (lib.rs must route through it).
const channels = eventChannelNames(inventory);
ok(channels.length > 0 && new Set(channels).size === channels.length, 'the event channel allow-list is non-empty and has no duplicates');
ok(channels.every((c) => /^[a-z][A-Za-z]*:[A-Za-z]+$/.test(c)), 'every event channel is a plain "family:name" identifier');
ok(committed.includes('ALLOWED_EVENT_CHANNELS') && channels.every((c) => committed.includes(JSON.stringify(c))), 'the committed list names every inventory event channel');
ok(!channels.some((c) => methods.includes(c)), 'no event channel doubles as an rpc method name');
ok(/mod events;/.test(lib), 'lib.rs declares the events module');
ok(/use crate::rpc_allow_list::ALLOWED_EVENT_CHANNELS;/.test(fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'events.rs'), 'utf8')), 'events.rs checks channels against ALLOWED_EVENT_CHANNELS');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
