// T-31 parity step 6 (local part): the AI/BYOK handlers that need no network.
//
//   brainKey.status / brainKey.clear   the key store (vault adapter, step 5); the renderer only ever gets
//                                      { provider, saved, last4, checked, encryption } (brain-key.js), never the key
//   usage.summary                      the local usage ledger, read only
//   reflexJev.classify                 the local rule tier, then Jev only when flavour.reflexEgress is true
//   ai.openKeyPage / talk.openSource   the VERDICT only (`__host.aiKeyPageVerdict` / `__host.citedUrlVerdict`); the Rust
//                                      host runs the shell open after its own re-validation (app_open in guest.rs)
//
// NETWORK: this module never opens one itself. Every module that could is handed a fetch injected by main.mjs (the egress
// guard); the defaults are `closedFetch`, so a missing injection can never fall back to the global `fetch` (brain-key.js
// and reflex-jev.js default to it). The Jev call is enabled ONLY by the resolved flavour's `reflexEgress` (GATE-step6-hosts
// Q5), and its fetch is the guard's openrouter.ai set. The local classifier is not vendored, so a public build is rules ->
// neutral, byte-identical to before.
import { createRequire } from 'node:module';

import { decideExternalUrl } from './adapters.mjs';
import { closedFetch } from './egress.mjs';

const require = createRequire(import.meta.url);
const { aggregateUsage, appendUsage } = require('../../src/main/usage-ledger.js');
const { withEstimatedCost } = require('../../src/main/usage-cost.js');
const { createReflexJev } = require('../../src/main/reflex-jev.js');
const { loadLocalReflexClassifier } = require('../../src/main/reflex-jev-local.js');

export { closedFetch };

const NEUTRAL = Object.freeze({ reaction: 'neutral', confidence: 0, source: 'neutral', ms: 0 });
const CITED_MAX = 100; // main.js rememberCited keeps the last 100 cited URLs

/**
 * @param {{ ai: ReturnType<import('./ai-settings.mjs').createAiSettings>, secretStores: () => Promise<object>,
 *           dataDir: string, logRefusal?: (d: object) => void, log?: (m: string) => void,
 *           reflexEgress?: boolean, jevFetch?: Function }} o
 */
export function createAiCore({ ai, secretStores, dataDir, logRefusal = () => {}, log = () => {}, reflexEgress = false, jevFetch = closedFetch }) {
  let brainKey = null;
  const brainKeyStore = async () => {
    if (!brainKey) brainKey = (await secretStores()).brainKey({ fetchImpl: closedFetch, getProvider: ai.providerId });
    return brainKey;
  };

  // Jev reflex, built lazily so a public build never touches the key file. Egress is exactly the resolved flavour flag;
  // off keeps today's classifier (rules -> neutral, the local model is not vendored). The call ledger/cap is NOT ported
  // (GATE-step6-hosts Q2); usage lines are, like Electron's onUsage.
  let reflexJev = null;
  const reflexJevStore = async () => {
    if (!reflexJev) {
      reflexJev = (await secretStores()).reflexJev({
        egressAllowed: reflexEgress,
        loadLocal: loadLocalReflexClassifier,
        fetchImpl: reflexEgress ? jevFetch : closedFetch,
        onUsage: (rec) => { try { appendUsage(dataDir, rec); } catch { /* never a classify failure */ } },
        log: (m) => log(`[reflex-jev] ${m}`),
      });
    }
    return reflexJev;
  };

  const citedUrls = new Set();
  return {
    brainKeyStatus: async () => (await brainKeyStore()).status(),
    brainKeyClear: async () => (await brainKeyStore()).clear(),

    // main.js usage:summary: { today, rows } for today and the last 30 days; any failure reads as "no data".
    usageSummary() {
      try {
        const { today, rows } = aggregateUsage(dataDir, { days: 30 });
        return { today, rows: withEstimatedCost(rows) };
      } catch {
        return { today: null, rows: [] };
      }
    },

    // main.js reflexjev:classify: the text is trimmed and capped at 2000 characters; blank or non-string = neutral.
    async reflexClassify(text) {
      if (typeof text !== 'string' || !text.trim()) return { ...NEUTRAL };
      return (await reflexJevStore()).classify(text.trim().slice(0, 2000));
    },

    // main.js ai:open-key-page: main owns the URL (the provider table); the page passes none.
    keyPageVerdict: () => ({ action: 'openExternal', url: ai.provider().keyPageURL }),

    // main.js rememberCited: a Look up reply's source links (http(s) only, chat-brain keeps them so).
    rememberCited(sources) {
      for (const s of Array.isArray(sources) ? sources : []) if (s && typeof s.url === 'string') citedUrls.add(s.url);
      while (citedUrls.size > CITED_MAX) citedUrls.delete(citedUrls.values().next().value);
    },

    // main.js talk:openSource: exactly a cited URL, through the `cited` channel of decideExternalUrl; a refusal is
    // logged (reason + origin only) like Electron's. A non-string is refused without a log line (Electron returns false).
    citedUrlVerdict(url) {
      if (typeof url !== 'string') return { action: 'refuse', reason: 'bad_url' };
      const d = decideExternalUrl(url, { cited: citedUrls });
      if (d.action !== 'openExternal') {
        log(`[talk] refused source link ${d.reason}${d.origin ? ' ' + d.origin : ''}`);
        logRefusal(d);
      }
      return d;
    },
  };
}
