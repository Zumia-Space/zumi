// Watcher host v1, board only (T-31 alpha.12, PLAN-ZUMI-WATCH v1 2.2-2.3 + 4, v2 E + F). Glue between one board read
// and three outputs, read-only by construction:
//   - the HUD "Watch" card: feed() -> up to MAX_FEED open findings;
//   - one spoken/subtitled line through the speech scheduler's `say('watch', payload)`, batched by the rhythm core
//     (one turn per rhythm.batchMs, at most rhythm.nudgeBudgetToday per local day);
//   - one board inbox item per finding key for the coordinator, once. Every inbox write resets the task's board activity
//     (Laneboard markActivity), so a repeat would hide the very stall the board reports. `relay(body)` is agent-core's
//     wrapper with the op already fixed to inbox.submit: this module cannot name an op at all. A failed relay (locked board,
//     mirror, network) is retried at most every RELAY_RETRY_MS; a key counts as sent only on a 2xx. At most
//     RELAY_MAX_PER_POLL go out per poll. A finding that clears is dropped, never announced.
// No fs, no timers, no network: it runs on the HUD's board poll (hud-host.mjs onState) and keeps its dedupe memo through
// the injected `memo` ({load, save}), which agent-core.mjs backs with <dataDir>/watch-state.json.
// watchLevel 'off' (Settings > Agent & Soul): onState returns at once -- no rules, no line, no relay, empty feed.
import { runRules, inboxLine } from './watch-rules.mjs';

export const MAX_FEED = 5;
export const WATCH_LEVELS = Object.freeze(['on', 'off']);
const MEMO_KEYS_MAX = 200;
const RELAY_RETRY_MS = 10 * 60_000;
const RELAY_MAX_PER_POLL = 5;

/** settings.json -> 'on' | 'off' (default on). */
export const watchLevelOf = (settings) => (settings && WATCH_LEVELS.includes(settings.watchLevel) ? settings.watchLevel : 'on');

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/**
 * @param {object} o
 * @param {(body: object) => Promise<{status: number}>} [o.relay]  inbox.submit only, op fixed by the caller; absent = no inbox items
 * @param {(kind: 'watch', payload: object) => {action: string}} o.say  the speech scheduler's enqueue
 * @param {() => object} o.rhythm  rhythm.get() (batchMs, receiptMs, nudgeBudgetToday)
 * @param {() => object} o.settings  settings.json (watchLevel)
 * @param {{load: () => object|null, save: (memo: object) => void}} [o.memo]
 * @param {() => number} [o.now]
 * @param {(m: string) => void} [o.log]
 */
export function createWatchHost({ relay = null, say, rhythm, settings, memo = null, now = Date.now, log = () => {} }) {
  const loaded = (() => { try { return (memo && memo.load()) || {}; } catch { return {}; } })();
  const relayedAt = new Map(Object.entries(loaded.relayedAt || {}));   // key -> last relay attempt (ms)
  const spokenKeys = new Set(Array.isArray(loaded.spokenKeys) ? loaded.spokenKeys : []); // keys already in a spoken turn
  let spokenDay = loaded.spokenDay || '';
  let spokenToday = Number(loaded.spokenToday) || 0;
  let lastSpokenAt = Number(loaded.lastSpokenAt) || -Infinity;
  const failedAt = new Map(); // key -> time of the last failed send (ms), memory only: a restart may retry
  const inFlight = new Set();
  let open = new Map(); // key -> finding (+ firstSeen, lastSeen)
  let waitingCount = 0;

  const persist = () => {
    if (!memo) return;
    const keep = (m) => Object.fromEntries([...m].slice(-MEMO_KEYS_MAX));
    try { memo.save({ relayedAt: keep(relayedAt), spokenKeys: [...spokenKeys].slice(-MEMO_KEYS_MAX), spokenDay, spokenToday, lastSpokenAt: Number.isFinite(lastSpokenAt) ? lastSpokenAt : null }); }
    catch (e) { log(`watch memo save failed: ${(e && e.message) || e}`); }
  };
  const level = () => watchLevelOf(settings());
  const cadence = () => { try { return rhythm() || {}; } catch { return {}; } };

  // One send at a time: the bridge's request_id is String(Date.now()) (board-bridge.mjs relay), so two sends in one millisecond
  // would collide and the board would answer 409 request_id_reused.
  const sendQueue = [];
  let sending = false;
  async function pump() {
    if (sending) return;
    sending = true;
    while (sendQueue.length) { const [f, t] = sendQueue.shift(); await relayOne(f, t); }
    sending = false;
  }
  const enqueueRelay = (f, t) => { inFlight.add(f.key); sendQueue.push([f, t]); pump(); };

  async function relayOne(f, t) {
    let status = null;
    try {
      const r = await relay({ target_id: f.task, data: { kind: 'report', text: inboxLine(f) } });
      status = r && r.status;
      log(`watch relay ${f.rule} ${f.task} -> ${status}`);
    } catch (e) { log(`watch relay ${f.rule} ${f.task} failed: ${(e && e.message) || e}`); }
    inFlight.delete(f.key);
    if (status >= 200 && status < 300) { relayedAt.set(f.key, t); failedAt.delete(f.key); persist(); } else failedAt.set(f.key, t);
  }

  /** One board read. Returns {added, relayed, said} for the caller's log and the tests. */
  async function onState(state) {
    if (level() === 'off') { open = new Map(); waitingCount = 0; return { added: [], relayed: [], said: null, off: true }; }
    const t = now();
    const cad = cadence();
    const { findings, waitingCount: w } = runRules(state, { at: t, receiptMs: cad.receiptMs });
    waitingCount = w;
    const next = new Map();
    const added = [];
    for (const f of findings) {
      const prev = open.get(f.key);
      next.set(f.key, { ...f, firstSeen: prev ? prev.firstSeen : t, lastSeen: t });
      if (!prev) added.push(f);
    }
    open = next; // a finding that cleared is simply gone (never announced)

    // Inbox: one item per key, ever. Not batched (the coordinator is a machine), but capped per poll.
    const relayed = [];
    for (const f of typeof relay === 'function' ? open.values() : []) {
      if (relayed.length >= RELAY_MAX_PER_POLL) break;
      if (relayedAt.has(f.key) || inFlight.has(f.key)) continue;
      if (failedAt.has(f.key) && t - failedAt.get(f.key) < RELAY_RETRY_MS) continue;
      relayed.push(f.key);
      enqueueRelay(f, t); // not awaited: a slow board must never delay the HUD feed; relayOne logs its own outcome
    }

    // Voice: findings not yet spoken, one turn per batchMs window, within today's budget.
    if (localDay(t) !== spokenDay) { spokenDay = localDay(t); spokenToday = 0; }
    const fresh = [...open.values()].filter((f) => !spokenKeys.has(f.key));
    let said = null;
    const batchMs = Number(cad.batchMs) || 30 * 60_000;
    const budget = Number.isFinite(cad.nudgeBudgetToday) ? cad.nudgeBudgetToday : 6;
    if (fresh.length && t - lastSpokenAt >= batchMs && spokenToday < budget) {
      const payload = fresh.length === 1
        ? { rule: fresh[0].rule, title: fresh[0].title, step: fresh[0].step || '', c: fresh[0].c || 0 }
        : { n: fresh.length };
      const r = say('watch', payload) || {};
      if (r.action === 'speak' || r.action === 'subtitle' || r.action === 'hold') {
        for (const f of fresh) spokenKeys.add(f.key);
        spokenToday++; lastSpokenAt = t;
        said = { payload, action: r.action, keys: fresh.map((f) => f.key) };
      }
    }
    if (added.length || relayed.length || said) persist();
    return { added, relayed, said };
  }

  /** The HUD Watch card: the newest open findings first, capped. */
  const feed = () => (level() === 'off' ? [] : [...open.values()].sort((a, b) => b.firstSeen - a.firstSeen || a.key.localeCompare(b.key)).slice(0, MAX_FEED)
    .map((f) => ({ rule: f.rule, task: f.task, title: f.title, step: f.step || '', c: f.c || 0, since: f.since || null, firstSeen: f.firstSeen })));

  return {
    onState,
    feed,
    count: () => (level() === 'off' ? 0 : open.size),
    waitingCount: () => waitingCount,
    level,
    _test: { open: () => open, relayedAt: () => relayedAt },
  };
}
