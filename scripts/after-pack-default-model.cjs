'use strict';
// electron-builder afterPack hook for the release build (package.json build.afterPack): ships the default avatar and
// re-hashes the staged default room (room-v2; T-31 0.2.11; room v1 removed by owner decision 2026-10-26).
// The owner build (scripts/builder-selftest.cjs) calls the same function from its own afterPack.
const { stageIntoResources } = require('./lib/default-vrm.cjs');
const { verifyStagedRooms } = require('./lib/pinned-rooms.cjs');

module.exports = async function afterPack(ctx) {
  const dst = stageIntoResources(ctx.appOutDir);
  console.log(`  • default avatar staged (sha256 verified): ${dst}`);
  const rooms = verifyStagedRooms(ctx.appOutDir);
  console.log(`  • default rooms staged (sha256 verified): ${rooms.length} files`);
};
