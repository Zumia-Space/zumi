// Gesture cache: LLM-composed speech gestures kept across turns and restarts, keyed by
//   intent | energy | speech-length bucket | deixis | rigVersion
// rigVersion folds in the rig/schema source and the loaded model file, so a rig change or a different model (the F-04
// lock) makes every older entry stale; stale or invalid entries are dropped on load. Shipped library seeds are not
// stored here. Pure data structure: persistence is the caller's (main writes the JSON file).
export const CACHE_FORMAT = 1;

// FNV-1a 32-bit over the command JSON: identifies a command for the denylist and de-duplication.
export function commandHash(cmd) {
  const s = JSON.stringify(cmd);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export class GestureCache {
  // check(command) -> { ok, command } re-validates every entry on load (the schema/rig gate is the caller's).
  constructor({ rigVersion, check, perKey = 6, maxEntries = 400, maxBytes = 2_000_000, random = Math.random, now = () => Date.now() }) {
    this.rigVersion = rigVersion;
    this.check = check;
    this.perKey = perKey; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.random = random; this.now = now;
    this.byKey = new Map(); // key -> [entry]
    this.deny = new Set();
    this.last = new Map(); // key -> hash last picked (no immediate repeat)
    this.dropped = { stale: 0, invalid: 0, denied: 0 };
  }

  // Load what main read from disk. Never throws: a corrupt file is an empty cache.
  load(text) {
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!data || data.format !== CACHE_FORMAT || !Array.isArray(data.entries)) return this;
    for (const h of Array.isArray(data.deny) ? data.deny : []) if (typeof h === 'string') this.deny.add(h);
    for (const e of data.entries) {
      if (!e || typeof e.key !== 'string' || !e.command) { this.dropped.invalid++; continue; }
      if (!e.key.endsWith(`|${this.rigVersion}`)) { this.dropped.stale++; continue; }
      if (this.deny.has(commandHash(e.command))) { this.dropped.denied++; continue; }
      const v = this.check(e.command);
      if (!v.ok) { this.dropped.invalid++; continue; }
      this.insert({ ...e, command: v.command });
    }
    this.evict();
    return this;
  }

  insert(e) {
    const list = this.byKey.get(e.key) || [];
    const h = commandHash(e.command);
    if (list.some((x) => commandHash(x.command) === h)) return false;
    list.push(e);
    this.byKey.set(e.key, list);
    return true;
  }

  // entry: { command, source, model, brief, rigReport } (already validated + rig-checked by the caller)
  add(key, entry) {
    if (!key.endsWith(`|${this.rigVersion}`)) return false;
    const h = commandHash(entry.command);
    if (this.deny.has(h)) return false;
    const ok = this.insert({ key, createdAt: this.now(), lastPlayedAt: 0, plays: 0, ...entry });
    this.evict();
    return ok;
  }

  variants(key) { return this.byKey.get(key) || []; }
  size() { let n = 0; for (const l of this.byKey.values()) n += l.length; return n; }

  // Random variant for the key, never the same one twice in a row; marks it played.
  pick(key) {
    const list = this.variants(key);
    if (!list.length) return null;
    const last = this.last.get(key);
    const pool = list.length > 1 ? list.filter((e) => commandHash(e.command) !== last) : list;
    const e = pool[Math.floor(this.random() * pool.length)];
    e.lastPlayedAt = this.now();
    e.plays = (e.plays || 0) + 1;
    this.last.set(key, commandHash(e.command));
    return e;
  }

  denyCommand(cmd) {
    const h = commandHash(cmd);
    this.deny.add(h);
    for (const [k, list] of this.byKey) this.byKey.set(k, list.filter((e) => commandHash(e.command) !== h));
  }

  // Caps: perKey variants (oldest-played go first), then maxEntries and maxBytes by least recently played.
  evict() {
    const lru = (a, b) => (a.lastPlayedAt || a.createdAt || 0) - (b.lastPlayedAt || b.createdAt || 0);
    for (const [k, list] of this.byKey) {
      if (list.length > this.perKey) { list.sort(lru); this.byKey.set(k, list.slice(list.length - this.perKey)); }
    }
    const all = () => [...this.byKey.values()].flat();
    let entries = all();
    while (entries.length > this.maxEntries || (entries.length && JSON.stringify(this.toJSON()).length > this.maxBytes)) {
      const victim = entries.sort(lru)[0];
      const list = this.byKey.get(victim.key).filter((e) => e !== victim);
      if (list.length) this.byKey.set(victim.key, list); else this.byKey.delete(victim.key);
      entries = all();
    }
  }

  toJSON() {
    return { format: CACHE_FORMAT, rigVersion: this.rigVersion, deny: [...this.deny], entries: [...this.byKey.values()].flat() };
  }
}
