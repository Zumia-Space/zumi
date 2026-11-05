// T-31 visual gate 14, D1b: the room-shots instrument must FAIL when no room is selected or a look_target is undefined.
//   node scripts/check-room-shots-verdict.mjs
import fs from 'node:fs';
import { roomShotsVerdict } from '../src/renderer/shots/room.js';

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };
const good = { selected: 'default', targetA: 'clock', targetB: 'desk_1', message: 'too big' };

ok(roomShotsVerdict(good).ok === true, 'a selected room + two real look_targets + refusal message passes');
ok(roomShotsVerdict({ ...good, selected: 'none' }).ok === false, "selected 'none' fails (Tauri 'Zumi still has no room')");
ok(roomShotsVerdict({ ...good, selected: undefined }).ok === false, 'selected undefined fails');
ok(roomShotsVerdict({ ...good, targetA: undefined }).ok === false, 'look_target A undefined fails');
ok(roomShotsVerdict({ ...good, targetB: undefined }).ok === false, 'look_target B undefined fails');
ok(roomShotsVerdict({ ...good, targetA: 'undefined' }).ok === true, "the string 'undefined' is not special-cased (only a missing value fails)");
ok(roomShotsVerdict({ ...good, message: null }).ok === false, 'a missing refusal message fails (previous behaviour kept)');
ok(roomShotsVerdict({ ...good, targetA: undefined, targetB: undefined, glanceSkipReason: 'no view with look_targets' }).ok === true, 'an explicit glanceSkipReason skips only the glance assertions');
ok(roomShotsVerdict({ ...good, selected: 'none', targetA: undefined, glanceSkipReason: 'x' }).ok === false, 'a skipped glance never hides a missing room');
const both = roomShotsVerdict({ selected: 'none', targetA: undefined, targetB: undefined, message: 'x' });
ok(both.problems.length === 3, 'every problem is listed', JSON.stringify(both.problems));

const src = fs.readFileSync(new URL('../src/renderer/shots/room.js', import.meta.url), 'utf8');
ok(/shots\.finish\(\{ ok: verdict\.ok/.test(src), 'runRoomShots reports finish ok from the verdict, not from the message alone');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
