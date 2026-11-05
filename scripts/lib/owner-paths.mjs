// Default paths of the owner's machines for the dev checks and tools that need a real model, room, voice cache or tool
// checkout. The values live in the one owner-only values file, src/main/owner-values.json (read by src/main/owner-values.js),
// which stays out of the public source (ZUMI_ONLY, scripts/lib/zumi-only.cjs). Without that file every key answers its
// fallback: pass the path by flag or env instead. With it, a key it lacks is a hard error (a typo must not silently change
// an owner run).
import { ownerValue } from '../../src/main/owner-values.js';

/** The owner's path for `key`; `fallback` when this tree has no owner values file (the public source). */
export const ownerPath = ownerValue;
