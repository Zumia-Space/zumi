#!/usr/bin/env node
// Owner-voice flag writer (T-31 talk-mode, PLAN section 10.2). CoS runs this ON ANH'S PC after his "launch now".
// It writes/removes `<userData>/owner-voice.json` = `{ "v": 1, "zumiaVoice": true }` -- the per-install switch that
// lists the owner's Zumia cloud voice route (no key, vi). It NEVER touches settings.json.
//
// Control-plane contract (CLAUDE.md): back up any existing file to <backup root>/<ts>/ (the owner values' ownerVoiceBackup,
// else <home>/.zumi-backup/zumi-owner-voice); write through a
// temp file then rename; read the file back and pin it by content hash; idempotent (a second --on does nothing);
// auto-rollback (restore the backup) if the read-back fails; print ONE line for the dossier Log.
//
//   node scripts/owner-voice.mjs --on|--off|--status [--dir <userData>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

export const FLAG_NAME = 'owner-voice.json';
export const FLAG_CONTENT = { v: 1, zumiaVoice: true };
export const DEFAULT_BACKUP_ROOT = ownerPath('ownerVoiceBackup', path.join(os.homedir(), '.zumi-backup', 'zumi-owner-voice'));

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function defaultDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'Zumi');
  return path.join(os.homedir(), '.zumi');
}

/** True iff the file exists and is exactly the owner flag shape (no URL, no secret). */
function flagOn(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(j) && typeof j === 'object' && j.v === 1 && j.zumiaVoice === true;
  } catch { return false; }
}

/**
 * @param {{dir:string, action:'on'|'off'|'status', backupRoot?:string, now?:()=>number, readBack?:()=>Buffer}} o
 *   readBack: test-only injection of the read-back step (default: read the file itself; throws when it is gone).
 */
export function runOwnerVoice({ dir, action, backupRoot = DEFAULT_BACKUP_ROOT, now = Date.now, readBack = null } = {}) {
  const file = path.join(dir, FLAG_NAME);
  const read = readBack || (() => fs.readFileSync(file));
  const exists = () => fs.existsSync(file);
  const stamp = () => new Date(now()).toISOString();
  const line = (result, backup = null) => console.log(`${stamp()} action=${action} backup=${backup || '-'} result=${result}`);

  if (action === 'status') {
    const on = exists() && flagOn(file);
    line(on ? 'on' : 'off');
    return { ok: true, on };
  }

  if (action === 'on') {
    if (exists()) { line('already-on'); return { ok: true, idempotent: true }; } // idempotent: a second --on does nothing
    fs.mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify(FLAG_CONTENT, null, 2)}\n`;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    let got = null;
    try { got = read(); } catch { got = null; }
    if (!got || sha(Buffer.from(got)) !== sha(Buffer.from(body))) { // read-back failed: roll back (delete the new file)
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      line('readback-failed-rolled-back');
      return { ok: false, reason: 'readback' };
    }
    line('on');
    return { ok: true, sha: sha(Buffer.from(body)) };
  }

  if (action === 'off') {
    if (!exists()) { line('already-off'); return { ok: true, idempotent: true }; }
    const ts = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupRoot, ts);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, FLAG_NAME));
    fs.unlinkSync(file);
    let stillThere = false;
    try { stillThere = Boolean(read()); } catch { stillThere = false; } // default readBack throws once the file is gone
    if (stillThere) { // the delete did not stick: restore the backup
      try { fs.copyFileSync(path.join(backupDir, FLAG_NAME), file); } catch { /* best effort */ }
      line('rollback', backupDir);
      return { ok: false, reason: 'readback', backup: backupDir };
    }
    line('off', backupDir);
    return { ok: true, backup: backupDir };
  }

  throw new Error(`unknown action: ${action}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const action = args.includes('--on') ? 'on' : args.includes('--off') ? 'off' : args.includes('--status') ? 'status' : null;
  const di = args.indexOf('--dir');
  const dir = di >= 0 && args[di + 1] ? path.resolve(args[di + 1]) : defaultDir();
  if (!action) { console.error('usage: node scripts/owner-voice.mjs --on|--off|--status [--dir <userData>]'); process.exit(2); }
  const r = runOwnerVoice({ dir, action });
  process.exit(r.ok ? 0 : 1);
}
