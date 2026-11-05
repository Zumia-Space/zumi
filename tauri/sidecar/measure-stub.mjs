// T-31 first-answer-time metric: a measurement-only chat provider. NEVER part of a user build.
//
// What it is: a provider entry in the SAME registry the real ones live in (src/main/providers.js PROVIDERS, extended in
// place like free-llm-presets.mjs does), plus a fetch that answers the OpenAI-compatible chat call instantly. The chat
// brain, role routing, the stream parser/chunker, the live reply and the events are the real code, so first-answer time
// measures our pipeline, not the model.
//
// Guards (CoS-approved, all binding):
//   - reachable only from argv `--measure-stub-provider` (main.mjs), no setting, no env var, no UI;
//   - tauri/stage-bundle.mjs STAGE_EXCLUDED leaves this file out of the staged (public) bundle, and
//     scripts/check-tauri-measure-stub.mjs fails if the marker below appears anywhere a user build ships;
//   - 0 ms latency, a fixed reply, no network, no real API key, no paid call: the fetch below never opens a socket and the
//     "key" is a fixed placeholder that only satisfies the key-store shape;
//   - it replaces ONLY the provider's network call. The placeholder is stored and read through the REAL safeStorage (the
//     vault: its synchronous spawns stay in the measured path) and the transport sits beneath the egress guard.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { createKeyStore } = createRequire(import.meta.url)('../../src/main/reflex-jev.js');

// The one place this string may appear. The static check greps every shipped tree for it.
export const MEASURE_STUB_MARKER = 'ZUMI_MEASURE_STUB_7c1e';
export const MEASURE_STUB_ID = 'measurestub';
export const MEASURE_STUB_REPLY = 'Measure stub reply. This is a fixed answer.';
const PLACEHOLDER_KEY = 'measure-stub-placeholder';
const MODEL = 'measure-stub';
export const MEASURE_STUB_ORIGIN = 'https://measure-stub.invalid';

export const MEASURE_STUB_PROVIDER = Object.freeze({
  id: MEASURE_STUB_ID,
  label: `Measure stub (${MEASURE_STUB_MARKER})`,
  baseURL: 'https://measure-stub.invalid/v1', // chat-brain demands https; the stub fetch never resolves it
  chatPath: 'chat/completions',
  modelIdRe: /^measure-stub$/,
  keyName: MEASURE_STUB_ID,
  keyPrefix: '',
  keyShape: /^measure-stub-placeholder$/,
  keyTest: Object.freeze({ method: 'GET', url: 'https://measure-stub.invalid/v1/models', auth: 'bearer' }),
  keyPageURL: 'https://measure-stub.invalid/',
  notice: null,
  freeNote: null,
  models: Object.freeze({ plan: MODEL, do: MODEL, check: MODEL, lookup: MODEL }),
  guide: Object.freeze({ en: [], vi: [], zh: [] }),
});

const USAGE = { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 };

/** The chat endpoint: instant, offline. Streamed -> one SSE data frame + [DONE]; otherwise a plain completion. */
export function measureStubFetch(_url, init) {
  let stream = false;
  try { stream = JSON.parse(String((init && init.body) || '{}')).stream === true; } catch { /* a plain call */ }
  if (!stream) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ provider: 'MeasureStub', choices: [{ message: { content: MEASURE_STUB_REPLY } }], usage: USAGE }) });
  }
  const frames = [
    `data: ${JSON.stringify({ provider: 'MeasureStub', choices: [{ delta: { content: MEASURE_STUB_REPLY } }] })}\n\n`,
    `data: ${JSON.stringify({ usage: USAGE, choices: [{ delta: {} }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return Promise.resolve({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield f; })() });
}

/**
 * Register the stub in `table` (the shared PROVIDERS object) and give back what main.mjs wires in: the provider id, the
 * offline transport and its origin (for the egress guard). The fixed placeholder key is written through the caller's REAL
 * `safeStorage` into the same key-store file a user's key lives in, so hasKey() and every decrypt behave as for a real
 * keyed provider. Without OS encryption this throws: a silent fallback would send talk to the cloud fixture instead.
 */
export function installMeasureStub({ table, dataDir, safeStorage }) {
  if (!Object.prototype.hasOwnProperty.call(table, MEASURE_STUB_ID)) table[MEASURE_STUB_ID] = MEASURE_STUB_PROVIDER;
  fs.mkdirSync(dataDir, { recursive: true });
  const keys = createKeyStore({ safeStorage, dir: dataDir, name: MEASURE_STUB_PROVIDER.keyName, shape: MEASURE_STUB_PROVIDER.keyShape });
  const written = keys.write(PLACEHOLDER_KEY);
  if (!written.ok) throw new Error(`measure stub: could not store the placeholder key (${written.error})`);
  return { providerId: MEASURE_STUB_ID, fetch: measureStubFetch, egressOrigin: MEASURE_STUB_ORIGIN };
}
