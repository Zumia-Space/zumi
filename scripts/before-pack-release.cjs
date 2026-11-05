// electron-builder beforePack hook for the RELEASE build (package.json build.beforePack). Throws, so nothing is packed,
// when the third-party licence gate is RED for the release flavour (UNVERIFIED asset, unmapped file, missing licence text,
// owner-only file leaked into the release bundle). The owner build runs the same gate as a WARN from scripts/builder-selftest.cjs.
const { runLicenceGate } = require('./lib/licence-gate.cjs');

module.exports = async function beforePackRelease(ctx) {
  runLicenceGate('release', ctx.outDir);
};
