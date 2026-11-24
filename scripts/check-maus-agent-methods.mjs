// R2 contract check: the four chat-agent methods (agent.start|stop|status|confirm) and the one event channel (agent:event)
// are in the inventory, flow through gen-allowlist.mjs into the Rust allow-list and the generated shim, and the host answers
// them itself (no sidecar call, no preload). Plain Node, no build.
//   node scripts/check-maus-agent-methods.mjs     (exit 1 on any failure)
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

export const METHODS = ['agent.start', 'agent.stop', 'agent.status', 'agent.confirm'];
export const CHANNEL = 'agent:event';

const inventory = JSON.parse(read('docs/migration/api-inventory.json'));
const byName = new Map(inventory.apis.map((a) => [a.name, a]));

for (const m of METHODS) {
  const a = byName.get(m);
  ok(Boolean(a), `inventory lists ${m}`);
  ok(a && a.kind === 'invoke' && a.tauriOnly === true, `${m} is an invoke the Rust host answers (tauriOnly)`);
  ok(a && /agent_host\.rs/.test(a.handler || ''), `${m} names its handler (agent_host.rs, zumi-agent-loop runs.rs)`);
  ok(a && !a.guestOnly, `${m} is the main renderer's, never a guest's`);
}
const ev = inventory.apis.find((a) => a.kind === 'event' && a.channel === CHANNEL);
ok(Boolean(ev) && ev.name === 'agent.onEvent', `inventory lists the ${CHANNEL} push event as agent.onEvent`);

const allow = read('tauri/src-tauri/src/rpc_allow_list.rs');
ok(allow === generateAllowList(inventory), 'the committed allow-list is a fresh generation');
const methods = rendererMethodNames(inventory);
for (const m of METHODS) ok(methods.includes(m) && allow.includes(JSON.stringify(m)), `${m} is in the generated ALLOWED_METHODS`);
ok(guestOnlyMethodNames(inventory).every((m) => !m.startsWith('agent.')), 'no agent.* name is guest-only');
ok(eventChannelNames(inventory).includes(CHANNEL) && allow.includes(JSON.stringify(CHANNEL)), `${CHANNEL} is in the generated ALLOWED_EVENT_CHANNELS`);

// No other agent.* name may appear: a fifth method is a contract change that needs its own gate.
ok(methods.filter((m) => m.startsWith('agent.')).sort().join(',') === [...METHODS].sort().join(','), 'exactly four agent.* methods are allowed');

const shim = read('tauri/shim/zumi-shim.js');
for (const m of METHODS) ok(shim.includes(`$invoke("${m}"`), `the shim routes ${m}`);
ok(shim.includes(`$subscribe("${CHANNEL}"`) || shim.includes(`"${CHANNEL}"`), `the shim subscribes ${CHANNEL}`);

// The host answers them itself, after the allow-list check and before any sidecar call.
const lib = read('tauri/src-tauri/src/lib.rs');
const allowAt = lib.indexOf('renderer_method_allowed(&method)?;');
const hostAt = lib.indexOf('agent_host::is_method(&method)');
const sidecarAt = lib.indexOf('let client = state.inner().clone();', allowAt);
ok(allowAt > 0 && hostAt > allowAt && hostAt < sidecarAt, 'rpc answers agent.* in the host, after renderer_method_allowed and before the sidecar call');
ok(/mod agent_host;/.test(lib), 'lib.rs declares mod agent_host');
ok(/\.manage\(agent_host::State::default\(\)\)/.test(lib), 'lib.rs manages the agent_host state');
ok(fs.existsSync(path.join(ROOT, 'tauri/src-tauri/src/agent_host.rs')), 'agent_host.rs exists');
ok(!/agent\./.test(read('src/main/preload.js')), 'the Electron preload exposes no agent.*');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
