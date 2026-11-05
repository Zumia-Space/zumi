// said.jsonl (T-31 alpha.12, PLAN-ZUMI-WATCH v2 B.2): the last lines Zumi actually said, as a ring buffer of RING_MAX
// lines `{t, kind, text}` in <dataDir>/said.jsonl. Written from the speech scheduler's ack (a line the renderer showed or
// spoke), read later by the alpha.13 composer so she does not repeat an opening. No UI in alpha.12.
//
// Local only: the text is what was already on screen; it never leaves the PC from here.
import fs from 'node:fs';
import path from 'node:path';

export const RING_MAX = 10;
const TEXT_MAX = 300;

/** @param {{dataDir: string, max?: number}} o */
export function createSaidLog({ dataDir, max = RING_MAX }) {
  const file = path.join(dataDir, 'said.jsonl');
  const read = () => {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j && typeof j.t === 'number' && typeof j.text === 'string') out.push(j); } catch { /* a torn line is skipped; the next write drops it */ }
    }
    return out.slice(-max);
  };
  /** Append one said line; the oldest beyond `max` drops. Returns the kept list. */
  function append({ t, kind, text }) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    if (!clean || typeof t !== 'number') return read();
    const list = [...read(), { t, kind: String(kind || ''), text: clean }].slice(-max);
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, list.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    return list;
  }
  return { append, list: read, file };
}
