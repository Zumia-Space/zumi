// T-31-MOBILE B2 (vendor bump to Laneboard b6d8417): a CLOSED fixture board for the news-feed checks, written through the vendored
// Laneboard's own write path and its own timers (no hand-made journal lines). What it holds, on a fixed clock:
//   news     a cos-report on the board-wide NEWS thread (tasks [E-1], "Chốt" first line), a cos-event on W-2, a coordinator reply on E-1
//   noise    a supervisor R1 chain on E-1 (L1 -> L2 -> L3, the board's own nudge.raise), a guard-B4 idle notice on W-2 (idle.mark),
//            an owner status re-brief on W-2 (status noise: hidden unless the toggle is on), an owner note (never news to him)
// The owner feed (vendor/laneboard/public/news.js) must show the three news items only, and the toggle must add only the re-brief.
// Local only: a temp data dir; nothing reaches a live board.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const H = 3600000, MIN = 60000;
export const NEWS_FIXTURE = {
  report: 'Chốt: bản 3124 đã build xong, chờ anh cài.\nChi tiết: APK nằm trong thư mục apk-3124.',
  event: 'Không kết nối được API để thử model nhạc.',
  reply: 'Đã chạy lại bước build, xong lúc 10:40.',
  note: 'Anh ghi chú: xem lại màu nút.',
};

/** Builds the fixture under dataDir (must be empty or absent) and closes the board. Returns { ownerToken, at } (at: the fixture's clock end). */
export async function buildNewsFixture({ laneboardDir, dataDir, nowMs = Date.now() }) {
  const { createBoard } = await import(pathToFileURL(path.join(laneboardDir, 'src', 'board.mjs')).href);
  fs.mkdirSync(dataDir, { recursive: true });
  // 02:00Z two days back = 09:00 ICT, inside the supervisor's awake hours; the chain needs ~6 h, so it ends 15:00 ICT the same day
  const d = new Date(nowMs - 2 * 24 * H);
  const T0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 2, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const clock = { ms: T0 };
  const board = createBoard({ dataDir, now: () => clock.ms, roleSlots: false, supervisorSince: iso(T0 - 24 * H), supervisorConfig: { digestHourIct: 24 }, guardsSince: iso(T0 - 24 * H) });
  try {
    const owner = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();
    let n = 0;
    const req = (op, target_id, data) => ({ version: 1, request_id: `news-fixture-${++n}`, op, target_id, data });
    const coord = board.write(owner, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
    const w = (op, id, data) => board.write(coord, req(op, id, data));
    const ow = (op, id, data) => board.write(owner, req(op, id, data));
    const step = (id, state, extra = {}) => ({ id, label: id, zone: 'build', state, ...extra });
    const qc = { goal_check: 'node check -> PASS', phases: [{ id: 'p1', label: 'Build', state: 'active' }], open_questions: [] }; // guard B: goal QC at open
    w('task.create', 'E-1', { title: 'Ứng dụng điện thoại', lane: 'CoS', ...qc, steps: [step('build', 'active', { sub: `run:x@${iso(T0)}` })] });
    w('task.create', 'W-2', { title: 'Trang web', lane: 'Worker B', ...qc, steps: [step('copy', 'todo')] });
    clock.ms += 4 * H + MIN; board.sweepSupervisor(); board.sweepIdle();
    clock.ms += 61 * MIN; board.sweepSupervisor();
    clock.ms += 61 * MIN; board.sweepSupervisor();
    clock.ms += MIN; w('feedback.add', 'NEWS', { kind: 'cos-report', text: NEWS_FIXTURE.report, tasks: ['E-1'] });
    clock.ms += MIN; w('feedback.add', 'W-2', { kind: 'cos-event', text: NEWS_FIXTURE.event, tasks: ['W-2'] });
    clock.ms += MIN; w('feedback.add', 'E-1', { kind: 'reply', text: NEWS_FIXTURE.reply });
    clock.ms += MIN; ow('rebrief.request', 'W-2', { mode: 'status' });
    clock.ms += MIN; ow('feedback.add', 'E-1', { kind: 'note', text: NEWS_FIXTURE.note });
    return { ownerToken: owner, at: iso(clock.ms) };
  } finally { board.close(); }
}
