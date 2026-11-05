#!/usr/bin/env node
// Seeds a board over HTTP from fixtures/demo.json. Like every writer it only uses POST /api/v1/write.
//   node scripts/seed.mjs --url http://127.0.0.1:8787 --owner-token-file data/owner.token --out data/demo-tokens.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legacyRowToRequests } from '../src/adapt-legacy.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Small synthetic PNG (two coloured panels) so the demo has a real attachment without shipping binaries. */
export function demoPng(w = 240, h = 120) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, left = x < w / 2 - 4, gap = Math.abs(x - w / 2) < 4;
    const [r, g, b] = gap ? [10, 10, 10] : left ? [59 + y / 3, 130, 246] : [167, 139 - y / 4, 250];
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function seed(url, ownerToken, { fixture = path.join(FIXTURES, 'demo.json') } = {}) {
  const spec = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const run = crypto.randomBytes(4).toString('hex');
  let n = 0;
  const write = async (token, body) => {
    const res = await fetch(`${url}/api/v1/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) throw new Error(`${body.op} ${body.target_id} -> ${res.status} ${JSON.stringify(out)}`);
    return out;
  };
  const state = async () => (await fetch(`${url}/api/v1/state`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();

  const tokens = { owner: ownerToken };
  for (const t of spec.tokens) {
    const { name, ...data } = t;
    tokens[name] = (await write(ownerToken, { version: 1, request_id: `seed-${run}-${++n}`, op: 'token.issue', target_id: name, data })).token;
  }
  for (const rel of spec.legacy_rows || []) {
    const row = JSON.parse(fs.readFileSync(path.join(path.dirname(fixture), rel), 'utf8'));
    for (const req of legacyRowToRequests(row, { prefix: `seed-${run}` })) await write(tokens.coordinator, req);
  }
  for (const w of spec.writes) {
    let target = w.target_id, data = { ...w.data };
    const s = await state();
    const ref = /^\$(inbox|feedback):([^:]+):(\w+)$/.exec(target);
    if (ref) target = (ref[1] === 'inbox' ? s.inbox.find(i => i.task_id === ref[2] && i.kind === ref[3] && !i.resolution) : s.feedback.find(f => f.task_id === ref[2] && f.kind === ref[3]))?.id;
    const reply = /^\$feedback:([^:]+):(\w+)$/.exec(data.reply_to || '');
    if (reply) data.reply_to = s.feedback.find(f => f.task_id === reply[1] && f.kind === reply[2])?.id;
    if (data.data_base64 === '$png:hero') data.data_base64 = demoPng().toString('base64');
    await write(tokens[w.as], { version: 1, request_id: `seed-${run}-${++n}`, op: w.op, target_id: target, ...(w.expected_revision != null ? { expected_revision: w.expected_revision } : {}), data });
  }
  return tokens;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const url = arg('--url') || 'http://127.0.0.1:8787';
  const ownerToken = fs.readFileSync(arg('--owner-token-file') || 'data/owner.token', 'utf8').trim();
  const out = arg('--out') || 'data/demo-tokens.json';
  const tokens = await seed(url, ownerToken);
  fs.writeFileSync(out, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  console.log(`seeded ${url}; session tokens written to ${out} (keep it private)`);
}
