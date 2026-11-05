// T-31 chair fix: static checks of SeatFit against the pinned room-v2 (no browser, no model file).
//   - every view reads its painted seat top (0.45 m) and a plausible seat front edge
//   - the painted keyboards (work, room) unproject onto the desk: ~0.37-0.45 m long, ahead of the chair, over the desktop prism
//   - adjustSeat() lands the thigh underside on the cushion (contact -5 mm .. +30 mm) in every view, keeps talk's
//     authored height, and drops work's old -0.15 m sink offset
//   - the fitted hip-joint midpoint lies over the PAINTED seat (inside its seat_top silhouette polygon) in every view,
//     and in work it sits back in the chair (within 12 cm of the painted backrest front), not at the desk
// The per-frame skinned check (legs vs seat/backrest/column/floor/desk, empty-chair gap, hands near the keys, over
// 60 consecutive frames per view) runs headless against the built renderer:
// the 09-10 chair work check-chair60.mjs.
//   node scripts/check-seat-fit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeatFit } from '../src/renderer/room/seat-fit.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const room = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources-pinned/room-v2/room.json'), 'utf8'));
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const fit = new SeatFit({ engine: {} });
fit.setRoomJson(room);
for (const v of ['talk', 'work', 'room']) {
  const f = fit.views[v];
  ok(f && Math.abs(f.seatTopY - 0.45) < 0.02, `${v}: seat top ${f && f.seatTopY} m`);
  ok(f && f.frontFwd > 0.15 && f.frontFwd < 0.35, `${v}: seat front edge ${f && f.frontFwd.toFixed(3)} m ahead of the column`);
}
const inPoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > p.z) !== (zj > p.z) && p.x < ((xj - xi) * (p.z - zi)) / (zj - zi) + xi) c = !c; } return c; };
for (const v of ['work', 'room']) {
  const k = fit.views[v].keys;
  ok(Boolean(k), `${v}: painted keyboard found`);
  if (!k) continue;
  ok(k.lenLR > 0.33 && k.lenLR < 0.47, `${v}: keyboard length ${k.lenLR.toFixed(3)} m`);
  const desk = room.views[v].occluders.find((o) => o.name === 'desktop').geometry.polygonXZ;
  for (const [name, c] of Object.entries(k.corners)) ok(inPoly(c, desk), `${v}: keyboard corner ${name} lies on the desktop`);
  const fwd = k.center.x * fit.views[v].facing.x + k.center.z * fit.views[v].facing.z;
  ok(fwd > 0.35 && fwd < 0.8, `${v}: keyboard ${fwd.toFixed(3)} m ahead of the chair column`);
}
// adjustSeat with this model's measured numbers (zumi-default-0910-v2-candidate, measured in the renderer)
fit.model = { L1: 0.353, L2: 0.4155, hipJointY: 0.8815, ankleY: 0.1138, clearance: 0.0756, handLen: { left: 0.1437, right: 0.1437 } };
const dropM = 0.3344;
for (const v of ['talk', 'work', 'room']) {
  const seat = { ...room.views[v].zumi_seat };
  const adj = fit.adjustSeat(seat, v, dropM);
  const s = seat.scale || 1;
  const hipY = -dropM * s + fit.model.hipJointY * s + adj.offset[1];
  const contact = hipY - fit.model.clearance * s - fit.views[v].seatTopY;
  ok(contact >= -0.005 && contact <= 0.03, `${v}: thigh underside ${(contact * 100).toFixed(1)} cm above the seat top`);
  if (v === 'talk') ok(adj.offset[1] === 0, 'talk: authored height kept (plate-registered head row)');
  if (v === 'work') ok(adj.offset[1] > -0.1, `work: old -0.15 m sink offset replaced (${adj.offset[1].toFixed(3)})`);
  const vv = room.views[v], hip = { x: seat.pos[0] + adj.offset[0], z: seat.pos[2] + adj.offset[2] };
  const seatPoly = vv.occluders.find((o) => o.name === 'seat_top').geometry.points.map((p) => [p[0], p[2]]);
  ok(inPoly(hip, seatPoly), `${v}: hip joint (${hip.x.toFixed(3)}, ${hip.z.toFixed(3)}) over the painted seat silhouette`);
  if (v === 'work') {
    const f = fit.views.work.facing, fwd = (p) => p[0] * f.x + p[2] * f.z;
    const backFront = Math.max(...vv.occluders.find((o) => o.name === 'chair_backrest').geometry.points.filter((p) => p[1] >= 0.45 && p[1] <= 0.75).map(fwd));
    const gap = hip.x * f.x + hip.z * f.z - backFront;
    ok(gap > 0.06 && gap < 0.12, `work: hip joint ${(gap * 100).toFixed(1)} cm ahead of the painted backrest (sits in the chair, not at the desk)`);
  }
}
console.log(fails ? `\n${fails} FAILED` : '\nall seat-fit checks pass');
process.exit(fails ? 1 : 0);
