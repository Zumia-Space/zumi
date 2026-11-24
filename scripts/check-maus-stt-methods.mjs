// R4b/R4c contract check: the five voice-in methods (stt.state|set|ptt|audio|install) and the one event channel (stt:event) are in the
// inventory, flow through gen-allowlist.mjs into the Rust allow-list and the generated shim, the host answers them itself for the
// MAIN webview only (never the sidecar, the model or a guest), and the event is host-only. Plain Node, no build.
//   node scripts/check-maus-stt-methods.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventChannelNames, generateAllowList, guestOnlyMethodNames, rendererMethodNames } from '../tauri/gen-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

export const METHODS = ['stt.state', 'stt.set', 'stt.ptt', 'stt.audio', 'stt.install'];
export const CHANNEL = 'stt:event';

const inventory = JSON.parse(read('docs/migration/api-inventory.json'));
const byName = new Map(inventory.apis.map((a) => [a.name, a]));

for (const m of METHODS) {
  const a = byName.get(m);
  ok(Boolean(a), `inventory lists ${m}`);
  ok(a && a.kind === 'invoke' && a.tauriOnly === true, `${m} is an invoke the Rust host answers (tauriOnly)`);
  ok(a && /stt_host\.rs/.test(a.handler || ''), `${m} names its handler (stt_host.rs)`);
  ok(a && !a.guestOnly, `${m} is the main renderer's, never a guest's`);
}
// The install downloads files from the network: it is the owner's click only, never a model, sidecar or hands call (R4c).
const inst = byName.get('stt.install') || {};
ok(/stt_not_owner/.test(inst.errors || '') && /stt_install_busy/.test(inst.errors || '') && /stt_install_unpublished/.test(inst.errors || ''), 'stt.install says it is the owner only and names its refusals (busy, unpublished)');
ok(/install/.test((byName.get('stt.onEvent') || {}).returns || ''), "stt.onEvent lists the 'install' event (progress of the first-use install)");
ok(/owner/i.test((byName.get('stt.set') || {}).errors || '') && /stt_not_owner/.test((byName.get('stt.set') || {}).errors || ''), 'stt.set says it is the owner settings screen only (stt_not_owner for any other caller)');
const ev = inventory.apis.find((a) => a.kind === 'event' && a.channel === CHANNEL);
ok(Boolean(ev) && ev.name === 'stt.onEvent', `inventory lists the ${CHANNEL} push event as stt.onEvent`);
ok(ev && /host/i.test(ev.emitter || ''), 'the event names the host as its only emitter');

const allow = read('tauri/src-tauri/src/rpc_allow_list.rs');
ok(allow === generateAllowList(inventory), 'the committed allow-list is a fresh generation');
const methods = rendererMethodNames(inventory);
for (const m of METHODS) ok(methods.includes(m) && allow.includes(JSON.stringify(m)), `${m} is in the generated ALLOWED_METHODS`);
ok(guestOnlyMethodNames(inventory).every((m) => !m.startsWith('stt.')), 'no stt.* name is guest-only');
ok(eventChannelNames(inventory).includes(CHANNEL) && allow.includes(JSON.stringify(CHANNEL)), `${CHANNEL} is in the generated ALLOWED_EVENT_CHANNELS`);
ok(methods.filter((m) => m.startsWith('stt.')).sort().join(',') === [...METHODS].sort().join(','), 'exactly five stt.* methods are allowed');

const shim = read('tauri/shim/zumi-shim.js');
for (const m of METHODS) ok(shim.includes(`$invoke("${m}"`), `the shim routes ${m}`);
ok(shim.includes(`$subscribe("${CHANNEL}"`), `the shim subscribes ${CHANNEL}`);

// The host answers them itself, after the allow-list check and before any sidecar call, and tells the service the caller is the owner's UI.
const lib = read('tauri/src-tauri/src/lib.rs');
const allowAt = lib.indexOf('renderer_method_allowed(&method)?;');
const hostAt = lib.indexOf('stt_host::is_method(&method)');
const sidecarAt = lib.indexOf('let client = state.inner().clone();', allowAt);
ok(allowAt > 0 && hostAt > allowAt && hostAt < sidecarAt, 'rpc answers stt.* in the host, after renderer_method_allowed and before the sidecar call');
ok(/mod stt_host;/.test(lib) && /\.manage\(stt_host::State::default\(\)\)/.test(lib), 'lib.rs declares and manages stt_host');
ok(/stt_host::ensure_started\(/.test(lib), 'lib.rs starts the service with the data dir');
const callAt = hostAt > 0 ? lib.slice(hostAt, hostAt + 700) : '';
ok(/Caller::OwnerUi|serve_owner|stt_host::serve\(/.test(callAt), 'the rpc branch is the one place that serves stt.* for the owner UI');
const host = fs.existsSync(path.join(ROOT, 'tauri/src-tauri/src/stt_host.rs')) ? read('tauri/src-tauri/src/stt_host.rs') : '';
ok(host.length > 0, 'stt_host.rs exists');
const calls = [...lib.matchAll(/stt_host::serve\(/g)].length + [...read('tauri/src-tauri/src/agent_host.rs').matchAll(/stt_host/g)].length + [...read('tauri/src-tauri/src/agent_wiring.rs').matchAll(/stt_host/g)].length;
ok(calls === 1, 'stt_host::serve has exactly one caller (the rpc command); the agent wiring never reaches it', `calls=${calls}`);
const events = read('tauri/src-tauri/src/events.rs');
ok(/HOST_ONLY_EVENT_CHANNELS: &\[&str\] = &\[[^\]]*"stt:event"/.test(events), 'stt:event is a host-only channel: a sidecar notification naming it is dropped');
ok(/zumi-stt\s*=\s*\{\s*path/.test(read('tauri/src-tauri/Cargo.toml')), 'the host depends on the zumi-stt crate (a crate of this repository)');
ok(/name = "zumi-stt"/.test(read('tauri/src-tauri/Cargo.lock')), 'the host lock names zumi-stt');

// Nothing else can reach the service: no sidecar handler, no preload name, no tool.
const sidecar = read('tauri/sidecar/main.mjs');
ok(!/['"]stt\./.test(sidecar), 'the sidecar has no stt.* handler');
ok(!/stt\./.test(read('src/main/preload.js')), 'the Electron preload exposes no stt.*');
const loopSrc = fs.readdirSync(path.join(ROOT, 'tauri/zumi-agent-loop/src')).filter((f) => f.endsWith('.rs')).map((f) => read(`tauri/zumi-agent-loop/src/${f}`)).join('\n');
ok(!/"stt\./.test(loopSrc), 'no agent-loop tool or rpc names an stt.* method');
const handsSrc = fs.readdirSync(path.join(ROOT, 'tauri/zumi-hands/src')).filter((f) => f.endsWith('.rs')).map((f) => read(`tauri/zumi-hands/src/${f}`)).join('\n');
ok(!/"stt\./.test(handsSrc), 'the hands helper names no stt.* method');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
