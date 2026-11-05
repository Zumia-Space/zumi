// Checks the app's local board host (src/main/laneboard-host.mjs over vendor/laneboard) without Electron:
// first-run seed through Laneboard's seed path, server-derived current_step, one valid step change (200), one
// waiting-before-done change (400 with the violation list, nothing stored), the loopback Host guard, no re-seed on
// restart, a v0.2 data dir imported once, and a rule-breaking v0.2 dir refused whole with its files untouched.
// Work dirs go to selftest-boardcheck/ (gitignored) and are wiped first, so every run is a first run.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openLocalBoard, readLegacyTasks } from '../src/main/laneboard-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'selftest-boardcheck');
const laneboardDir = path.join(root, 'vendor', 'laneboard');
const sampleFixture = path.join(root, 'src', 'main', 'sample-board.json');
const legacyFixture = path.join(root, 'scripts', 'fixtures', 'legacy-v0.2');
fs.rmSync(work, { recursive: true, force: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
const tokenOf = (b) => decodeURIComponent(/#token=([^&]+)/.exec(b.url)[1]);
const hashDir = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));

function req(b, method, p, { body, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: host || `127.0.0.1:${b.port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const r = http.request({ host: '127.0.0.1', port: b.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const state = async (b) => (await req(b, 'GET', '/api/v1/state', { token: tokenOf(b) })).json;
let n = 0;
const stepUpdate = (b, step, st, rev) => req(b, 'POST', '/api/v1/write', { token: tokenOf(b), body: { version: 1, request_id: `check-${++n}-${Date.now()}`, op: 'step.update', target_id: step, expected_revision: rev, data: { state: st } } });
const task = (s, id) => s.tasks.find((t) => t.id === id);
const step = (t, id) => t.steps.find((s) => s.id === `${t.id}/${id}`);

// ---------- fresh install ----------
{
  const dir = path.join(work, 'fresh');
  let b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture });
  check('fresh data dir -> seeded through Laneboard seed path', b.outcome === 'seeded' && fs.existsSync(path.join(dir, 'laneboard', 'events.ndjson')), b.outcome);
  const page = await req(b, 'GET', '/');
  const assets = await Promise.all(['/app.js', '/styles.css', '/markdown.js'].map((p) => req(b, 'GET', p)));
  const remoteRef = /(src|href)=["']https?:|@import|url\(\s*["']?https?:|fetch\(\s*["']https?:/i;
  check('Laneboard page served with self-only CSP, no remote refs', page.status === 200 && /default-src 'self'/.test(page.headers['content-security-policy'] || '') && ![page, ...assets].some((x) => remoteRef.test(x.text)), { status: page.status });
  const appJs = assets[0].text;
  const controls = { stepSelect: /data-step-state=/.test(appJs), statusSelect: /data-task-status=/.test(appJs), violations: /class="violations"/.test(appJs), history: /function historyCard/.test(appJs) && /api\/v1\/events\?task=/.test(appJs) };
  check('page ships step-state + task-status selects, inline violation list, history card', Object.values(controls).every(Boolean) && assets[2].status === 200, controls);
  const s1 = await state(b);
  check('exactly one sample task', s1.tasks.length === 1 && s1.tasks[0].id === 'VM-01', s1.tasks.map((t) => t.id));
  // Product rule: the local board never names lane models (Opus/Sonnet/Haiku role slots) -- laneboard-host.mjs opens
  // it with roleSlots:false, so the page has no "Workers by task" table to draw.
  check('local board has no role slots (roleSlots:false): no task.roles, no top-level roles', s1.tasks.every((t) => !('roles' in t)) && !('roles' in s1), s1.tasks.map((t) => Object.keys(t.roles || {})));
  check('no forced UI language: the page starts in its own default (English, like the web board)', !/[#&]lang=/.test(b.url), b.url.replace(/token=[^&]+/, 'token=…'));
  const asks0 = (s1.asks || []).filter((a) => a.task_id === 'VM-01' && a.status === 'open');
  check('the sample task has one open question on its waiting step (s3)', asks0.length === 1 && asks0[0].step_id === 's3', asks0.map((a) => [a.id, a.step_id, a.status]));
  const hz = (await req(b, 'GET', '/healthz')).json || {};
  const pinned = fs.readFileSync(path.join(laneboardDir, 'VERSION'), 'utf8').trim();
  check('/healthz release = the pinned commit (vendor RELEASE)', typeof hz.release === 'string' && hz.release.length >= 7 && pinned.startsWith(hz.release), hz.release);
  const t1 = task(s1, 'VM-01');
  check('current_step is server-derived (first active = s2)', t1.current_step && t1.current_step.id === 'VM-01/s2', t1.current_step);

  const ok = await stepUpdate(b, 'VM-01/s2', 'done', step(t1, 's2').rev);
  const t2 = task(await state(b), 'VM-01');
  check('valid step change -> 200, current_step moves to s3 (waiting)', ok.status === 200 && step(t2, 's2').state === 'done' && t2.current_step.id === 'VM-01/s3', { status: ok.status, current: t2.current_step });

  const st = await req(b, 'POST', '/api/v1/write', { token: tokenOf(b), body: { version: 1, request_id: `check-${++n}-${Date.now()}`, op: 'task.update', target_id: 'VM-01', expected_revision: t2.rev, data: { status: 'blocked' } } });
  const t2b = task(await state(b), 'VM-01');
  check('task status change -> 200, stored', st.status === 200 && t2.status !== 'blocked' && t2b.status === 'blocked', { status: st.status, from: t2.status, to: t2b.status });

  const no = await stepUpdate(b, 'VM-01/s4', 'done', step(t2, 's4').rev);
  const t3 = task(await state(b), 'VM-01');
  const v = (no.json && no.json.violations) || [];
  check('waiting-before-done -> 400 listing the violation, nothing stored', no.status === 400 && no.json.error === 'waiting_before_done' && v.some((x) => x.error === 'waiting_before_done' && x.task === 'VM-01' && x.step === 's3') && step(t3, 's4').state === 'blocked', { status: no.status, body: no.json });

  const hist = (await req(b, 'GET', '/api/v1/events?task=VM-01&limit=1000', { token: tokenOf(b) })).json || [];
  const has = (op, target, key, val) => hist.some((e) => e.op === op && e.target_id === target && e.data && e.data[key] === val);
  check('task history lists the step + status changes, not the refused one', has('step.update', 'VM-01/s2', 'state', 'done') && has('task.update', 'VM-01', 'status', 'blocked') && !has('step.update', 'VM-01/s4', 'state', 'done') && hist.every((e) => e.target_id === 'VM-01' || e.target_id.startsWith('VM-01/')), hist.map((e) => `${e.op} ${e.target_id}`));

  const rebind = await req(b, 'GET', '/api/v1/state', { host: 'evil.example' });
  check('foreign Host header refused (403, DNS rebinding)', rebind.status === 403, { status: rebind.status });
  const anon = await req(b, 'GET', '/api/v1/state');
  check('no token -> internal tasks hidden', anon.status === 200 && anon.json.tasks.length === 0, { tasks: anon.json && anon.json.tasks.length });

  const firstPort = b.port;
  b.close();
  await new Promise((r) => setTimeout(r, 100));
  b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture, port: firstPort });
  const s4 = await state(b);
  check('restart: opened, not re-seeded, change kept', b.outcome === 'opened' && s4.tasks.length === 1 && step(task(s4, 'VM-01'), 's2').state === 'done', b.outcome);
  check('restart on the remembered port: same origin, so the page finds its own browser storage again', b.port === firstPort, { first: firstPort, now: b.port });
  // the remembered port is taken by something else: the board still opens, on another free port
  const blocker = http.createServer(() => {});
  const takenPort = b.port;
  b.close();
  await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => blocker.listen(takenPort, '127.0.0.1', r));
  b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture, port: takenPort });
  check('remembered port taken: falls back to a free port', b.port && b.port !== takenPort && (await state(b)).tasks.length === 1, { wanted: takenPort, got: b.port });
  b.close();
  await new Promise((r) => blocker.close(r));
}

// ---------- a v0.2 data dir (written by the installed v0.2 app) is imported once ----------
{
  const dir = path.join(work, 'legacy');
  fs.cpSync(legacyFixture, dir, { recursive: true });
  const before = hashDir(dir);
  const legacy = readLegacyTasks(dir);
  let b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture });
  const s = await state(b);
  const same = legacy.every((l) => { const t = task(s, l.code); return t && t.title === l.title && JSON.stringify(t.steps.map((x) => x.state)) === JSON.stringify(l.steps); });
  check('v0.2 dir migrated: same tasks, titles, step states', b.outcome === 'migrated' && s.tasks.length === legacy.length && same, { outcome: b.outcome, imported: b.migration && b.migration.imported });
  check('migration report written, v0.2 files untouched, no staging left', fs.existsSync(path.join(dir, 'laneboard', 'migration-report.json')) && JSON.stringify(hashDir(dir)) === JSON.stringify(before) && !fs.existsSync(path.join(dir, '.laneboard-import')));
  b.close();
  b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture });
  check('second launch opens the imported board (no re-import)', b.outcome === 'opened' && (await state(b)).tasks.length === legacy.length, b.outcome);
  b.close();
}

// ---------- a v0.2 dir that breaks the board rules is refused whole ----------
{
  const dir = path.join(work, 'legacy-bad');
  fs.cpSync(legacyFixture, dir, { recursive: true });
  const tasks = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  tasks[0].steps[3].state = 'done'; // s4 done while s3 still waits
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks, null, 1));
  const before = hashDir(dir);
  const b = await openLocalBoard({ laneboardDir, root: dir, sampleFixture });
  const v = (b.refused && b.refused.violations) || [];
  check('rule-breaking v0.2 dir refused with every violation', b.outcome === 'refused' && v.some((x) => x.error === 'waiting_before_done' && x.task === 'VM-01' && x.step === 's3'), b.refused);
  check('refusal writes nothing: no laneboard dir, v0.2 files untouched', !fs.existsSync(path.join(dir, 'laneboard')) && !fs.existsSync(path.join(dir, 'laneboard.importing')) && !fs.existsSync(path.join(dir, '.laneboard-import')) && JSON.stringify(hashDir(dir)) === JSON.stringify(before));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`board check: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
