'use strict';
// The OpenCode CLI's Go login as the key source of the OpenCode Go provider (T-31 alpha.13, owner 02-11, owner build, off until he clicks).
// Reads one entry of the CLI's auth.json at call time and hands the key to the caller's one request. Nothing is cached here or written
// anywhere. No failure carries a detail: a JSON.parse message can quote the file, so only a yes or no leaves this module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = 'opencode-go'; // the only entry ever taken; the file also holds the CLI's other logins
const defaultAuthFile = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

/** -> the Go key, or null when the file or the entry is missing or unusable. `shape`: the provider's keyShape. */
function readCliGoKey({ file = defaultAuthFile(), shape }) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[ENTRY];
    const key = entry && entry.key;
    return typeof key === 'string' && shape.test(key) ? key : null;
  } catch {
    return null;
  }
}

module.exports = { readCliGoKey, defaultAuthFile };
