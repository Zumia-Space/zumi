// The two store public keys (active + offline spare), the same text the Rust host compiles in (tauri/market-keys/*.pub,
// pack_host.rs STORE_KEYS). check:market-store-host asserts the copies are equal, so the two verifiers can never disagree.
// The store origin the official app reads (FABLE-MARKET2 §1.4: a separate public repo, one release tag holding index + zips).
import { parsePublicKey } from './market-sign.mjs';

export const STORE_PUB_TEXT = Object.freeze([
  "untrusted comment: minisign public key 6E723592DAF0A2EB\nRWTrovDakjVybkmd3LgVrHMq3Mu0tPdjP72bmIZMI/k9u/i8ovIBg6mU\n",
  "untrusted comment: minisign public key 1A32D99D5E3FC1F0\nRWTwwT9endkyGo8oHFbCPzCSeVF7IpAMxpcNWmPsWnP8zydXfH6WW8TM\n",
]);
export const STORE_KEYS = Object.freeze(STORE_PUB_TEXT.map(parsePublicKey));
export const STORE_URL = 'https://github.com/Zumia-Space/zumi-market/releases/download/store/';

/** ZUMI_MARKET_STORE (an https base or an absolute local folder) replaces the origin, for tests and the owner's local store.
 * It moves only where the files come from: the index must still verify with the compiled keys, so no build trusts more. */
export function storeSource(env = process.env) {
  const v = (env.ZUMI_MARKET_STORE || '').trim();
  if (!v) return STORE_URL;
  if (/^https:\/\//.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return /^[A-Za-z]:[\\/]|^\//.test(v) ? v : STORE_URL;
}
