'use strict';
// Owner token-usage COST ESTIMATE (T-31 owner-admin + usage, Fable ruling 05-10: "Keep the cost estimate
// (OpenRouter price per model), labelled 'uoc tinh' in the UI"). A small, editable USD-per-Mtok table shipped with
// the app (usage-prices.json, rewritten from the provider's public list by `npm run update:usage-prices`) -- see that
// file's `_source` and each entry's `source` for where each number came from. A model
// missing from the table, or one marked unverified/null, contributes 0 and `priced: false`, so the Settings UI can
// show "estimate unavailable" instead of a silently wrong number (Ousterhout "define errors out of existence" would
// NOT apply here -- a wrong cost estimate is worse than an explicit "can't estimate" row).
const PRICES = require('./usage-prices.json');

// Look up (T-31 zumi-roles): a `lookup` call on OpenRouter also ran one web search, a flat per-request fee on top of tokens
// (usage-prices.json `_webSearch`, see its source). Counted per ledger line that sent it (usage-ledger.js `searches`), success or not.
const WEB_SEARCH_USD = PRICES._webSearch && typeof PRICES._webSearch.usdPerRequest === 'number' ? PRICES._webSearch.usdPerRequest : 0;

function estimateCostUsd(model, inTok, outTok) {
  const p = PRICES[model];
  if (!p || p.unverified || typeof p.inputPerMtok !== 'number' || typeof p.outputPerMtok !== 'number') {
    return { usd: 0, priced: false };
  }
  const usd = ((Number(inTok) || 0) / 1e6) * p.inputPerMtok + ((Number(outTok) || 0) / 1e6) * p.outputPerMtok;
  return { usd, priced: true };
}

// Adds {estCostUsd, priced, webSearchUsd} to each aggregateUsage() row, without aggregateUsage itself knowing about
// prices (usage-ledger.js stays pure counting; this is the only module that knows a price table exists). estCostUsd
// = tokens (when priced) + web searches; priced says whether the token part is known.
function withEstimatedCost(rows) {
  return rows.map((r) => {
    const { usd, priced } = estimateCostUsd(r.model, r.in, r.out);
    const webSearchUsd = (Number(r.searches) || 0) * WEB_SEARCH_USD;
    return { ...r, estCostUsd: usd + webSearchUsd, priced, webSearchUsd };
  });
}

module.exports = { PRICES, WEB_SEARCH_USD, estimateCostUsd, withEstimatedCost };
