// Where an installed room pack is (T-31-ROOM-slim). The room loaders ask this one question; market-host.mjs is the only writer
// of <data>/packs/<id> (atomic rename on install, `<id>.remove-pending` while a remove waits for the next start).
import fs from 'node:fs';
import path from 'node:path';

/** The painted default room (Night City) as a Marketplace pack. Its room.json is the pinned resources-pinned/room-v2 one. */
export const NIGHT_CITY_PACK = 'room.night-city';
const PACK_ID = /^[a-z]+\.[a-z0-9-]+$/;

/** `<data>/packs/<id>` when that pack is installed (its manifest is there) and not waiting for removal; else null. */
export function installedPackDir(dataDir, id) {
  if (typeof id !== 'string' || !PACK_ID.test(id)) return null;
  const dir = path.join(dataDir, 'packs', id);
  if (fs.existsSync(path.join(dataDir, 'packs', `${id}.remove-pending`))) return null;
  return fs.existsSync(path.join(dir, 'zumi-pack.json')) ? dir : null;
}
