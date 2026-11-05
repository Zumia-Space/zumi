// T-31-MOBILE: the AI key and the client-name list for the phone's pairing bundle travel together or not at all. The phone
// masks its board digest with this list, so a key shared with a list that failed to read would send client names to the
// provider unmasked. loadRedactNames (board-redact.mjs) turns a missing or corrupt file into [], right for its callers but
// not here, hence the strict read. A list over the phone's limit gets no key either: never cut, never refused by the phone
// after the old token was already revoked.
import fs from 'node:fs';

export const PHONE_REDACT_MAX_BYTES = 600; // tauri/zumi-mobile pair.rs REDACT_MAX_BYTES (UTF-8 bytes of the JSON)

/** -> the names, or null when the file is missing, unreadable, corrupt or not an array. [] only when it says []. */
export function readRedactStrict(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j.filter((n) => typeof n === 'string' && n.trim() && !/\p{Cc}/u.test(n)) : null;
  } catch { return null; }
}

/** @returns {{ai: object|null, redact: string[]}} `ai` is the key only when the list is known and fits. */
export function phoneAiAndRedact(names, phoneAi) {
  if (!Array.isArray(names) || Buffer.byteLength(JSON.stringify(names), 'utf8') > PHONE_REDACT_MAX_BYTES) return { ai: null, redact: [] };
  return { ai: phoneAi(), redact: names };
}
