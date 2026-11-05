'use strict';
// The PUBLIC flavour names no room asset. The repo THIRD_PARTY_LICENSES.md keeps the rows for the builds that carry them; a public payload ships it without every line that
// names a Zumi-only room asset (room-v2, the plates, the room videos), none of which ship there. The avatar row stays.
// Used by tauri/stage-bundle.mjs (public stage) and scripts/builder-public.cjs (Electron public config).
const fs = require('fs');
const path = require('path');
const { isZumiOnly } = require('./zumi-only.cjs');

const roomAsset = (p) => isZumiOnly(p) && !/\.vrm$/i.test(p) && !/LICENSE-zumi-default/i.test(p);

/** THIRD_PARTY_LICENSES.md text minus every line that names a Zumi-only room asset in backticks. */
function publicCreditsText(text) {
  return text.split('\n').filter((l) => ![...l.matchAll(/`([^`]+)`/g)].some((m) => roomAsset(m[1]))).join('\n');
}

/** Rewrite a staged copy of THIRD_PARTY_LICENSES.md in place as the public text. */
function toPublicCredits(file) {
  fs.writeFileSync(file, publicCreditsText(fs.readFileSync(file, 'utf8')));
}

// The Electron public credits file (repo-relative, under the gitignored out/). Written by the build step only (builder-public.cjs
// beforePack, and check-third-party.mjs before it lists the public config); requiring the config writes nothing.
const PUBLIC_CREDITS = 'out/public-credits/THIRD_PARTY_LICENSES.md';

/** Write PUBLIC_CREDITS from the repo THIRD_PARTY_LICENSES.md; returns its repo-relative posix path. */
function writePublicCredits(root) {
  fs.mkdirSync(path.join(root, path.dirname(PUBLIC_CREDITS)), { recursive: true });
  fs.writeFileSync(path.join(root, PUBLIC_CREDITS), publicCreditsText(fs.readFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8')));
  return PUBLIC_CREDITS;
}

module.exports = { PUBLIC_CREDITS, publicCreditsText, toPublicCredits, writePublicCredits };
