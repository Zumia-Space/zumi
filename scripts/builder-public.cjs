'use strict';
// electron-builder config of the PUBLIC payload (open-core ADR 2026-10-28, worklist B4): the release config (package.json
// "build") minus every Zumi-only asset of scripts/lib/zumi-only.cjs -- the default avatar, the default room with its plates,
// the room videos. No afterPack: nothing is injected, so the app starts on its empty stage ("No model yet" + "Open VRM file…",
// no room). scripts/check-third-party.mjs --flavour public lists THIS config; wiring a `dist:public` command to it is C1/E9.
const { runLicenceGate } = require('./lib/licence-gate.cjs');
const path = require('path');
const { ZUMI_ONLY, isZumiOnly } = require('./lib/zumi-only.cjs');
const { PUBLIC_CREDITS, writePublicCredits } = require('./lib/public-credits.cjs');

const base = { ...require('../package.json').build };
delete base.afterPack;
// owner ruling 28-10: the public THIRD_PARTY_LICENSES.md names no room-image provenance. beforePack generates it from the repo
// file (out/public-credits, gitignored) and it ships under the same name; loading this config writes nothing.
const fromOf = (e) => (typeof e === 'string' ? e : e.from);

module.exports = {
  ...base,
  files: [...base.files, ...ZUMI_ONLY.map((p) => `!${p}`)],
  extraResources: base.extraResources.filter((e) => !isZumiOnly(fromOf(e)))
    .map((e) => (fromOf(e) === 'THIRD_PARTY_LICENSES.md' ? { from: PUBLIC_CREDITS, to: 'THIRD_PARTY_LICENSES.md' } : e)),
  // the public credits file first, then the public rules: UNVERIFIED and every open legal item are hard fails (licence-gate.cjs)
  beforePack: async (ctx) => { writePublicCredits(path.join(__dirname, '..')); runLicenceGate('public', ctx.outDir); },
};
