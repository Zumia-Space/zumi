// Owner-controlled name list for digest redaction (T-31 board-aware privacy, CoS decision 07-10): by default no
// client/company/person name on the board reaches the LLM. <userData>/redact-names.json is a plain JSON array of
// strings, seeded once at first run; the owner can hand-edit it any time (never overwritten once it exists — the
// one-time seed is the only write this module ever makes). board-digest.mjs owns the actual masking (pure, no
// I/O); this module only owns getting the name list on and off disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The first-run seed. The owner's starting list (real client names) lives in redact-seed-owner.json beside this module,
// a Zumi-only file (scripts/lib/zumi-only.cjs): owner builds ship it; public builds and the public source do not, so a
// public install seeds an empty list the user fills in.
export const SEED_NAMES = loadRedactNames(fileURLToPath(new URL('./redact-seed-owner.json', import.meta.url)));

/** Writes `names` to `file` only if it does not already exist yet. Never overwrites an owner edit. Returns
 *  whether it wrote (false when the file was already there). */
export function seedRedactNamesIfMissing(file, names = SEED_NAMES) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(names, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

/** The current name list, or [] when the file is missing, corrupt, or not a JSON array of strings. Never throws. */
export function loadRedactNames(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j.filter((n) => typeof n === 'string' && n.trim()) : [];
  } catch { return []; }
}
