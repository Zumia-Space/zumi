// T-31-MOBILE M3 (GATE-M3.md fix 8): the desktop side of phone pairing, against a local mock board on 127.0.0.1.
// Negative first: the page channel still refuses token.*, and revokeDeviceToken refuses anything that is not the
// phone token this app minted (tok-1 included) with no write sent. Then: the issue body is exactly the fixed one, the
// bundle carries exactly seven fields, a pairing revokes the previous phone token first and stops when that fails.
// Secrets here are fakes. Usage: node scripts/check-phone-pair.mjs   (exit 0 = pass)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridge, PHONE_TOKEN_LABEL } from '../src/main/board-bridge.mjs';
import { createLiveBoard } from '../src/main/board-live.mjs';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';
import { readRedactStrict, phoneAiAndRedact, PHONE_REDACT_MAX_BYTES } from '../tauri/sidecar/phone-extras.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');
const USER = 'kei-fake-user';
const PASS = 'fake-nginx-pass-7x7x';
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); } };

// ---- mock board: tokens + writes, every request recorded ----
const seen = [];
let tokens = [];
let revokeAnswer = null; // force a revoke answer: { status, body }
function resetBoard() {
  seen.length = 0;
  revokeAnswer = null;
  tokens = [
    { id: 'tok-1', name: 'owner', role: 'owner', revoked_at: null },
    { id: 'tok-7', name: 'phone-20261031-aaaa', role: 'owner', label: PHONE_TOKEN_LABEL, device: true, revoked_at: null },
    { id: 'tok-8', name: 'phone-20261031-bbbb', role: 'owner', label: 'other', device: true, revoked_at: null },
    { id: 'tok-9', name: 'phone-20261031-cccc', role: 'owner', label: PHONE_TOKEN_LABEL, revoked_at: null }, // not a device token
  ];
}
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, csrf: req.headers['x-requested-with'], body: body ? JSON.parse(body) : null });
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/api/v1/tokens') return send(200, tokens);
    if (req.method === 'POST' && req.url === '/api/v1/write') {
      const w = JSON.parse(body);
      if (w.op === 'token.issue') { const id = `tok-${tokens.length + 20}`; tokens.push({ id, name: w.target_id, role: w.data.role, label: w.data.label, device: w.data.device === true, revoked_at: null }); return send(200, { ok: true, id, revision: 1, token: `lb_${'Q'.repeat(43)}` }); }
      if (w.op === 'token.revoke') { if (revokeAnswer) return send(revokeAnswer.status, revokeAnswer.body); const t = tokens.find((x) => x.id === w.target_id); t.revoked_at = 'now'; return send(200, { ok: true, id: t.id, revision: 0 }); }
      return send(200, { ok: true });
    }
    return send(404, { error: 'not_found' });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const upstream = `http://127.0.0.1:${mock.address().port}`;
const writes = () => seen.filter((s) => s.method === 'POST');

try {
  // ---- 1. negative: the page channel never forwards token.* (unchanged bridge rule) ----
  resetBoard();
  const bridge = createBridge({ upstreamOrigin: upstream, getToken: () => '', getBasicAuth: () => ({ user: USER, pass: PASS }), publicDir });
  const port = await bridge.port();
  for (const op of ['token.issue', 'token.revoke']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/write`, { method: 'POST', headers: { ...bridge.callerHeaders(), 'Content-Type': 'application/json', 'X-Requested-With': 'laneboard' }, body: JSON.stringify({ op, target_id: 'phone-x', data: { role: 'owner', device: true } }) });
    check(`page channel refuses ${op} (403 before upstream)`, r.status === 403 && writes().length === 0, r.status);
  }

  // ---- 2. negative: revokeDeviceToken refuses every token that is not ours, with no write ----
  for (const [id, name, why] of [['tok-1', 'owner', 'tok-1 (owner)'], ['tok-7', 'phone-20261031-zzzz', 'name mismatch'], ['tok-8', 'phone-20261031-bbbb', 'other label'], ['tok-9', 'phone-20261031-cccc', 'not a device token']]) {
    resetBoard();
    const r = await bridge.revokeDeviceToken({ id, name });
    check(`revokeDeviceToken refuses ${why}`, r.ok === false && r.error === 'not_a_phone_token' && writes().length === 0, r);
  }
  resetBoard();
  revokeAnswer = { status: 500, body: { error: 'boom' } };
  const r500 = await bridge.revokeDeviceToken({ id: 'tok-7', name: 'phone-20261031-aaaa' });
  check('revokeDeviceToken fails closed on an unexpected answer', r500.ok === false && r500.status === 500, r500);
  for (const [status, error] of [[404, 'token_not_found'], [409, 'already_revoked']]) {
    resetBoard();
    revokeAnswer = { status, body: { error } };
    const r = await bridge.revokeDeviceToken({ id: 'tok-7', name: 'phone-20261031-aaaa' });
    check(`revokeDeviceToken treats ${status} ${error} as already gone`, r.ok === true && r.gone === error, r);
  }

  // ---- 3. positive: the issue body is exactly the fixed one; revoke sends the id ----
  resetBoard();
  const issued = await bridge.issueDeviceToken({ now: new Date('2026-11-01T05:00:00Z') });
  const w = writes()[0];
  check('issueDeviceToken: one write, Basic auth, CSRF header', writes().length === 1 && w.auth === `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` && w.csrf === 'laneboard', w && { auth: Boolean(w.auth), csrf: w.csrf });
  check('issueDeviceToken: op token.issue, name phone-<date>-<hex4>, data exactly { role owner, device true, label phone-test }',
    w.body.op === 'token.issue' && /^phone-20261101-[0-9a-f]{4}$/.test(w.body.target_id) && JSON.stringify(w.body.data) === JSON.stringify({ role: 'owner', device: true, label: PHONE_TOKEN_LABEL }) && /^zumi-host-/.test(w.body.request_id), w.body);
  check('issueDeviceToken returns the revealed token, id and name', issued.ok && issued.token.startsWith('lb_') && issued.id && issued.name === w.body.target_id, { ...issued, token: issued.token ? 'lb_…' : null });
  resetBoard();
  const rv = await bridge.revokeDeviceToken({ id: 'tok-7', name: 'phone-20261031-aaaa' });
  check('revokeDeviceToken revokes our phone token by id', rv.ok && writes().length === 1 && writes()[0].body.op === 'token.revoke' && writes()[0].body.target_id === 'tok-7' && JSON.stringify(writes()[0].body.data) === '{}', rv);
  await bridge.close();

  // ---- 4. board-live phone.pair: previous revoked first; a failed revoke stops the pairing; bundle shape ----
  const dir = path.join(root, `.check-phone-pair-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir, publicDir, upstream, allowTestUpstream: true });
    check('pair refused while the board is not configured', (await lb.phone.pair()).error === 'locked_or_unconfigured');
    lb.secrets.configureOs({ user: USER, pass: PASS, token: '' });
    resetBoard();
    revokeAnswer = { status: 500, body: { error: 'boom' } };
    const stopped = await lb.phone.pair({ previous: { id: 'tok-7', name: 'phone-20261031-aaaa' }, nowS: 1_793_000_000 });
    check('a failed revoke of the previous phone token stops the pairing (nothing minted)', !stopped.ok && /^previous_not_revoked/.test(stopped.error) && !writes().some((x) => x.body.op === 'token.issue'), stopped);
    resetBoard();
    const extras = { ai: { provider: 'openrouter', key: 'sk-or-v1-fakefakefakefakefake0000', model: 'google/gemma-4-31b-it:free' }, voice: { owner: true, voiceProviderVi: 'zumia-owner', voiceProviderEn: 'kokoro', voiceReplyLang: 'auto', talkVoiceLang: 'vi' }, redact: ['Fake Client Co'] };
    const p = await lb.phone.pair({ previous: { id: 'tok-7', name: 'phone-20261031-aaaa' }, nowS: 1_793_000_000, extras });
    const ops = writes().map((x) => x.body.op);
    check('pairing revokes the previous phone token, then issues one', p.ok && JSON.stringify(ops) === '["token.revoke","token.issue"]', ops);
    const b = JSON.parse(p.bundle);
    check('bundle v2 has exactly v, kind, iat, user, pass, token, name, ai, voice, redact', JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['ai', 'iat', 'kind', 'name', 'pass', 'redact', 'token', 'user', 'v', 'voice']) && b.v === 2 && b.kind === 'zumi-phone-pair' && b.iat === 1_793_000_000 && b.user === USER && b.pass === PASS && b.name === p.name, Object.keys(b));
    check('bundle ai is exactly { provider, key, model } and voice is the host object', JSON.stringify(b.ai) === JSON.stringify(extras.ai) && JSON.stringify(b.voice) === JSON.stringify(extras.voice), b.ai && Object.keys(b.ai));
    resetBoard();
    const bare = JSON.parse((await lb.phone.pair({ nowS: 1_793_000_000 })).bundle);
    {
      // negative first: a list that cannot be trusted or does not fit never travels with the key
      const dir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.phone-extras-'));
      const file = path.join(dir, 'redact-names.json');
      const key = { provider: 'openrouter', key: 'x', model: null };
      const shared = () => phoneAiAndRedact(readRedactStrict(file), () => key);
      check('list file missing: no key', shared().ai === null);
      fs.writeFileSync(file, '{not json');
      check('list file corrupt: no key', shared().ai === null);
      fs.writeFileSync(file, '{"a":1}');
      check('list file not an array: no key', shared().ai === null);
      fs.writeFileSync(file, JSON.stringify(['ệ'.repeat(Math.ceil(PHONE_REDACT_MAX_BYTES / 3))]));
      check('over the limit in UTF-8 bytes though under it in characters: no key', JSON.stringify(readRedactStrict(file)).length < PHONE_REDACT_MAX_BYTES && shared().ai === null && shared().redact.length === 0);
      fs.writeFileSync(file, '[]');
      check('an empty list the file really says: key shared', shared().ai === key && shared().redact.length === 0);
      fs.writeFileSync(file, JSON.stringify(['Fake Client Co', 7, '  ']));
      check('names travel with the key, junk entries dropped', shared().ai === key && JSON.stringify(shared().redact) === '["Fake Client Co"]');
      fs.rmSync(dir, { recursive: true, force: true });
    }
    check('bundle redact is the host list', JSON.stringify(b.redact) === JSON.stringify(extras.redact));
    check('no extras: ai and voice are null (no key travels), redact is an empty list', bare.ai === null && bare.voice === null && bare.v === 2 && JSON.stringify(bare.redact) === '[]');
    check('the bundle never carries the PC\'s own token', !p.bundle.includes('lb_FAKE'));
    await lb.close();

    // ---- 5. sidecar: the phone names exist in the owner build only ----
    const mk = (ownerAdmin) => createBoardHost({ safeStorage: fakeSafeStorage, dataDir: dir, flavour: { name: ownerAdmin ? 'owner' : 'public', values: { ownerAdmin } }, settings: () => ({}), saveSettings: () => {}, env: {}, idleLock: false });
    const pub = mk(false);
    check('public build: no phone.status / __host.phonePairBundle / __host.phoneUnpair', !pub.handlers['phone.status'] && !pub.handlers['__host.phonePairBundle'] && !pub.handlers['__host.phoneUnpair']);
    const own = mk(true);
    check('owner build: phone.status answers without a secret', JSON.stringify(own.handlers['phone.status']()) === '{"paired":false}');
    pub.dispose?.(); own.dispose?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} finally {
  mock.close();
}
console.log(`\ncheck-phone-pair: ${pass} passed, ${fail} failed`);
// exitCode, not process.exit(): exiting while the mock's sockets are still closing tripped a libuv assertion (REVIEW-M3 F2)
process.exitCode = fail ? 1 : 0;
