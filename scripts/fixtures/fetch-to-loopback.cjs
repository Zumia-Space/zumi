'use strict';
// T-31 baseline M: test-only Node preload (NOT app code, never shipped). The app's provider base URLs are hardcoded
// https hosts (src/main/providers.js) with no override, so this wraps globalThis.fetch and re-points a request for one
// of those provider hosts at the loopback fake (scripts/fake-llm-sse.mjs). Path and query are kept.
//   ZUMI_FIXTURE_LLM_URL=http://127.0.0.1:<port> NODE_OPTIONS="--require <abs path to this file>" <launcher>
// Electron main: global fetch is Node's, so this applies IF the packaged build honours NODE_OPTIONS (unverified).
// Tauri: the Rust host spawns `node sidecar/main.mjs` and inherits the environment, so this applies there.
const PROVIDER_HOSTS = new Set([
  'generativelanguage.googleapis.com', 'api.groq.com', 'openrouter.ai', 'opencode.ai',
]);

function target(env = process.env) {
  const raw = env.ZUMI_FIXTURE_LLM_URL;
  if (!raw) return null;
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) {
    throw new Error('fetch-to-loopback: ZUMI_FIXTURE_LLM_URL must be http on loopback');
  }
  return u;
}

// Returns the URL string to really fetch for `input` (unchanged unless it names a provider host).
function rewrite(input, to) {
  const href = typeof input === 'string' ? input : (input && input.href) || (input && input.url);
  if (!href || !to) return input;
  let u;
  try { u = new URL(href); } catch { return input; }
  if (!PROVIDER_HOSTS.has(u.hostname)) return input;
  return `${to.origin}${u.pathname}${u.search}`;
}

function install(realFetch = globalThis.fetch, env = process.env) {
  const to = target(env);
  if (!to) return realFetch;
  return function fixtureFetch(input, init) { return realFetch(rewrite(input, to), init); };
}

// Loading as a preload with the env var set patches fetch; loading without it (the unit test) only exports.
if (process.env.ZUMI_FIXTURE_LLM_URL) globalThis.fetch = install();

module.exports = { PROVIDER_HOSTS, target, rewrite, install };
