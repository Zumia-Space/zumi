// T-31 Tauri P3-C: one-time "Import from Zumi 0.2.9" (non-secret settings only). RED-first test.
// Plain Node, no window, no network, no Electron. Fixture Electron profiles are built in a temp dir.
//   node scripts/check-tauri-profile-import.mjs   (exit 1 on any failure)
//
// Rules under test (CoS spec, binding):
//   - copy ONLY allow-listed non-secret keys; unknown keys are skipped and listed (allow-list, not deny-list);
//   - NEVER copy a secret (BYOK keys, board user/pass/token/PIN, cloud token, any *.bin / *.import / *.last4);
//   - the Electron profile is READ-ONLY (byte-identical afterwards, no mutating fs call under it);
//   - merge without overwriting what the user already set in Tauri; dry-run first; idempotent;
//   - a vi/en/zh "re-enter your API keys / sign in to the Board" checklist afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
let fail = 0;
const ok = (cond, name, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? '  ' + detail : ''}`); };
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP_BASE || os.tmpdir(), 'zumi-pi-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp only */ } });

let mod;
try { mod = await import('../tauri/sidecar/profile-import.mjs'); } catch (e) { ok(false, 'profile-import.mjs loads', String(e && e.message)); process.exit(1); }
const { createProfileImport, detectProfile, ALLOW_KEYS, SPECIAL_KEYS, KNOWN_SKIP, checklist } = mod;
const { readSettings, saveSettings } = await import('../tauri/sidecar/adapters.mjs');

// ---------- fixtures ----------
const SECRET = 'SECRETSENTINEL-9f3a71c2d4e85b60';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let n = 0;
const fresh = (name) => { const d = path.join(tmp, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (dir, rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
const ROOM_ID = 'a1b2c3d4e5f6';
const VRM_BYTES = Buffer.from('fake-vrm');

const PLAIN = (modelPath) => ({
  uiLang: 'vi', developerMode: true, sendClientNamesToAi: false,
  aiMode: 'byok', aiProvider: 'gemini', aiDefaultsLegacy: false, chatModel: 'google/gemini-2.5-flash',
  roleModels: { do: { model: 'gemini-2.5-pro', effort: 'high' } },
  roleModelsByProvider: { openrouter: { do: { model: 'acme/pro', effort: 'low' } } },
  voiceEnabled: false, voiceSpeed: 1.25, voiceVolume: 0.8, thinkSound: true, speakTypedWhenMicOff: true,
  voiceProviderEn: 'kokoro', voiceProviderVi: 'google', voiceReplyLang: 'auto',
  voiceGoogle: { en: 'en-US-Neural2-C', vi: 'vi-VN-Neural2-A' }, voiceGemini: { model: 'gemini-3.8-flash-tts', voice: 'Kore' },
  voiceCustom: { base: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy' },
  talkLevel: 'quiet', talkVoiceLang: 'vi', talkQuietHours: { on: true, start: '22:00', end: '07:00' }, talkAsksBreakQuiet: false, talkCheckins: false,
  chair3d: 'painted', sceneRoom: 'current', hudStyle: 'a',
  model: 'user', userModelPath: modelPath,
  room: ROOM_ID, roomChoiceV2: true, importedRooms: [{ id: ROOM_ID, fileBase: 'mine.glb', manifest: null }],
  // known keys that must NOT travel (see KNOWN_SKIP)
  requireBoardPin: true, boardPort: 51234, wardrobeGate: { modelSha256: 'abc' }, wardrobeUndo: null, talkMute: { until: 1 }, talkLastVersion: '0.2.9',
  roomDefaultPath: 'D:/x/room.glb', hudVoiceMuted: true, defaultRoomGoodSha: 'f'.repeat(64),
});

function makeProfile({ withSecrets = false, unknown = false, settingsOverride = {}, rooms = true, userModel = true } = {}) {
  const base = fresh('electron');
  const userDataDir = path.join(base, 'AppData', 'Zumi');
  const zumiDataDir = path.join(base, 'Programs', 'Zumi-data');
  const modelPath = path.join(base, 'models', 'me.vrm');
  if (userModel) put(base, 'models/me.vrm', VRM_BYTES);
  const settings = { ...PLAIN(modelPath), ...settingsOverride };
  if (unknown) Object.assign(settings, { mysteryFlag: true, futureThing: { a: 1 }, 'x-extra': 'v' });
  if (withSecrets) Object.assign(settings, { apiKey: `sk-or-v1-${SECRET}`, boardPass: SECRET, boardToken: SECRET, boardUser: 'demo-user', pin: '1234', openrouterKey: SECRET });
  put(userDataDir, 'settings.json', JSON.stringify(settings, null, 2));
  if (rooms) {
    put(userDataDir, `rooms/${ROOM_ID}/room.glb`, Buffer.from('glb-bytes'));
    put(userDataDir, `rooms/${ROOM_ID}/check.json`, '{"warnings":[],"stats":null}');
  }
  put(zumiDataDir, 'laneboard/events.ndjson', '{"e":1}\n');
  if (withSecrets) {
    for (const f of ['jev-key.bin', 'gemini-key.bin', 'groq-key.bin', 'opencode-key.bin', 'leda-key.bin', 'gemini-tts-key.bin', 'elevenlabs-key.bin',
      'custom-openai-tts-key.bin', 'custom-zumia-tts-key.bin', 'cloud-token.bin', 'board-secrets.bin']) put(userDataDir, f, `${SECRET}-${f}`);
    for (const f of ['jev-key.import', 'jev-key.last4']) put(userDataDir, f, SECRET);
    put(userDataDir, 'board-secrets.meta.json', JSON.stringify({ failedAttempts: 1, lockoutUntil: 0, note: SECRET }));
    put(zumiDataDir, 'laneboard/owner.token', SECRET);
  }
  return { base, userDataDir, zumiDataDir, modelPath, profile: { userDataDir, zumiDataDir } };
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const snapshot = (dir) => walk(dir).sort().map((f) => `${path.relative(dir, f)}:${sha(fs.readFileSync(f))}`).join('\n');
const newTarget = (initial = null) => { const d = fresh('tauri-data'); if (initial) saveSettings(d, initial); return d; };

// ---------- 1. detection ----------
{
  const f = makeProfile();
  const appData = path.join(f.base, 'AppData');
  const d = detectProfile({ appData, installParents: [path.join(f.base, 'Programs')] });
  ok(d.found === true && d.userDataDir === f.userDataDir && d.zumiDataDir === f.zumiDataDir, 'detect: %APPDATA%\\Zumi + Zumi-data beside the install are both found');
  const none = detectProfile({ appData: path.join(f.base, 'nowhere'), installParents: [] });
  ok(none.found === false && !none.userDataDir, 'detect: no profile -> found false');
  const bad = fresh('bad'); put(bad, 'Zumi/settings.json', '{not json');
  ok(detectProfile({ appData: bad, installParents: [] }).found === false, 'detect: an unreadable settings.json is not a profile');
  const onlyZd = fresh('zd'); put(onlyZd, 'Zumi-data/laneboard/events.ndjson', '');
  const zd = detectProfile({ appData: path.join(onlyZd, 'none'), installParents: [onlyZd] });
  ok(zd.found === false, 'detect: a Zumi-data folder alone (no settings.json) is not enough to offer an import');
}

// ---------- 2. dry-run writes nothing, lists exactly the allow-listed keys ----------
{
  const f = makeProfile();
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const before = snapshot(target);
  const plan = imp.plan(f.profile);
  ok(snapshot(target) === before && !fs.existsSync(path.join(target, 'settings.json')), 'dry-run: the Tauri data dir is untouched');
  const keys = plan.copy.map((c) => c.key).sort();
  const expected = ['aiDefaultsLegacy', 'aiMode', 'aiProvider', 'chair3d', 'chatModel', 'developerMode', 'hudStyle', 'importedRooms', 'model', 'roleModels', 'roleModelsByProvider',
    'room', 'roomChoiceV2', 'sceneRoom', 'sendClientNamesToAi', 'speakTypedWhenMicOff', 'talkAsksBreakQuiet', 'talkCheckins', 'talkLevel', 'talkQuietHours', 'talkVoiceLang',
    'thinkSound', 'uiLang', 'userModelPath', 'voiceCustom', 'voiceEnabled', 'voiceGemini', 'voiceGoogle', 'voiceProviderEn', 'voiceProviderVi', 'voiceReplyLang', 'voiceSpeed', 'voiceVolume'].sort();
  ok(JSON.stringify(keys) === JSON.stringify(expected), 'dry-run: copy list == the expected allow-listed keys', `got ${keys.join(',')}`);
  const skipped = Object.fromEntries(plan.skipped.map((s) => [s.key, s.reason]));
  for (const k of ['requireBoardPin', 'boardPort', 'wardrobeGate', 'wardrobeUndo', 'talkMute', 'talkLastVersion', 'roomDefaultPath', 'hudVoiceMuted', 'defaultRoomGoodSha']) {
    ok(typeof skipped[k] === 'string' && skipped[k], `dry-run: known non-portable key ${k} is skipped with a reason`);
  }
  ok(plan.rooms.length === 1 && plan.rooms[0].id === ROOM_ID, 'dry-run: the imported room is listed');
}

// ---------- 3. apply: values land in Tauri settings ----------
{
  const f = makeProfile();
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const rep = imp.apply(f.profile);
  const s = readSettings(target);
  ok(s.uiLang === 'vi' && s.voiceSpeed === 1.25 && s.aiMode === 'byok' && s.talkQuietHours.start === '22:00' && s.hudStyle === 'a', 'apply: plain values copied');
  ok(s.model === 'user' && s.userModelPath === f.modelPath, 'apply: user model is referenced in place (path kept, file not copied)');
  ok(!fs.existsSync(path.join(target, 'me.vrm')) && walk(target).every((p) => !p.endsWith('.vrm')), 'apply: no .vrm is copied');
  ok(s.room === ROOM_ID && s.roomChoiceV2 === true && Array.isArray(s.importedRooms) && s.importedRooms[0].id === ROOM_ID, 'apply: room pick + imported room entry');
  ok(fs.readFileSync(path.join(target, 'rooms', ROOM_ID, 'room.glb'), 'utf8') === 'glb-bytes' && !fs.existsSync(path.join(target, 'rooms', ROOM_ID, 'check.json')), 'apply: the room.glb is copied (check.json is not: unvetted compound content)');
  ok(!('requireBoardPin' in s) && !('boardPort' in s) && !('wardrobeGate' in s) && !('talkMute' in s), 'apply: non-portable keys are not copied');
  ok(rep.copied.includes('uiLang') && Array.isArray(rep.skipped) && Array.isArray(rep.needsReentry) && rep.needsReentry.length >= 2, 'apply: report has copied / skipped / needsReentry');
}

// ---------- 4. merge: never overwrite what the user set in Tauri ----------
{
  const f = makeProfile();
  const target = newTarget({ uiLang: 'zh', voiceSpeed: 1.0, model: 'user', userModelPath: 'D:/tauri-pick.vrm', talkLevel: 'quiet' });
  const imp = createProfileImport({ dataDir: target });
  const plan = imp.plan(f.profile);
  const c = Object.fromEntries(plan.conflicts.map((x) => [x.key, x]));
  ok(c.uiLang && c.uiLang.current === 'zh' && c.uiLang.incoming === 'vi', 'merge: a differing Tauri value is a conflict (current vs incoming)');
  ok(plan.same.includes('talkLevel') && !c.talkLevel, 'merge: an equal value is "same", not a conflict');
  ok(c.model && c.model.autoDefault === true, 'merge: model conflicts are flagged autoDefault (Tauri sets them on first boot)');
  imp.apply(f.profile);
  const s = readSettings(target);
  ok(s.uiLang === 'zh' && s.voiceSpeed === 1.0 && s.userModelPath === 'D:/tauri-pick.vrm', 'merge: apply keeps the Tauri values by default');
  ok(s.hudStyle === 'a', 'merge: keys the user had not set are still filled in');
  imp.apply(f.profile, { overwrite: ['uiLang'] });
  ok(readSettings(target).uiLang === 'vi' && readSettings(target).voiceSpeed === 1.0, 'merge: overwrite[] replaces only the named key');
  const t2 = newTarget({ aiProvider: 'openrouter' });
  createProfileImport({ dataDir: t2 }).apply(f.profile);
  ok(!('roleModels' in readSettings(t2)), 'merge: roleModels (active-provider slot) is not copied under a different provider');
}

// ---------- 5. secrets never travel ----------
{
  const f = makeProfile({ withSecrets: true, unknown: true, settingsOverride: { chatModel: `sk-or-v1-${SECRET}`, voiceGoogle: { en: 'e', vi: `AIza${SECRET}${SECRET}` } } });
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const plan = imp.plan(f.profile);
  const rep = imp.apply(f.profile);
  const blob = [JSON.stringify(plan), JSON.stringify(rep), ...walk(target).map((p) => fs.readFileSync(p, 'utf8'))].join('\n');
  ok(!blob.includes(SECRET), 'secrets: the sentinel appears nowhere in the plan, the report or any file under the Tauri data dir');
  const names = walk(target).map((p) => path.basename(p));
  ok(!names.some((nm) => /(-key\.(bin|import|last4)|token|secret)/i.test(nm) && nm !== 'profile-import.json'), 'secrets: no key/token/secret file is created in the Tauri data dir', names.join(','));
  const s = readSettings(target);
  for (const k of ['apiKey', 'boardPass', 'boardToken', 'boardUser', 'pin', 'openrouterKey', 'requireBoardPin']) ok(!(k in s), `secrets: settings key ${k} is not copied`);
  ok(!('chatModel' in s) && JSON.stringify(plan.skipped).includes('looks_secret'), 'secrets: an allow-listed key whose VALUE looks like a key is skipped (looks_secret)');
  ok(!('voiceGoogle' in s), 'secrets: a nested secret-looking value skips the whole key');
  ok(rep.needsReentry.includes('api_keys') && rep.needsReentry.includes('board_login') && rep.needsReentry.includes('board_pin'), 'secrets: the report asks for API keys, Board login and PIN re-entry');
  // The allow-list itself must hold nothing secret-shaped.
  ok([...ALLOW_KEYS, ...SPECIAL_KEYS].every((k) => !/key|token|pass|pin$|secret|cred|auth/i.test(k)), 'allow-list: no allowed key name is secret-shaped');
}

// ---------- 6. unknown keys skipped and listed ----------
{
  const f = makeProfile({ unknown: true });
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const rep = imp.apply(f.profile);
  const s = readSettings(target);
  ok(!('mysteryFlag' in s) && !('futureThing' in s) && !('x-extra' in s), 'unknown: unknown keys are not copied (allow-list, not deny-list)');
  ok(['mysteryFlag', 'futureThing', 'x-extra'].every((k) => rep.unknown.includes(k)), 'unknown: they are listed in the report');
}

// ---------- 7. the source profile is read-only ----------
{
  const f = makeProfile({ withSecrets: true, unknown: true });
  const before = snapshot(f.base);
  const calls = [];
  const spy = new Proxy(fs, { get(t, p) {
    const v = t[p];
    if (typeof v !== 'function') return v;
    if (/^(write|append|unlink|rm|rename|mkdir|copyFile|truncate|chmod|utimes|symlink|link|open|createWriteStream|cp)/.test(String(p))) return (...a) => { calls.push([String(p), String(a[0])]); return v.apply(t, a); };
    return v.bind(t);
  } });
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target, fs: spy });
  imp.plan(f.profile); imp.apply(f.profile); imp.apply(f.profile);
  ok(snapshot(f.base) === before, 'read-only: every file under the Electron profile is byte-identical after plan + apply + apply');
  const touched = calls.filter(([, p]) => path.resolve(p).startsWith(path.resolve(f.base)));
  ok(touched.length === 0, 'read-only: no mutating fs call targets a path under the source profile', JSON.stringify(touched));
  ok(calls.length > 0 && calls.every(([, p]) => path.resolve(p).startsWith(path.resolve(target))), 'read-only: the spy saw writes, and every one is under the Tauri data dir');
}

// ---------- 8. allow-list completeness: every documented settings key is classified ----------
{
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/migration/data-schema.json'), 'utf8'));
  const all = new Set([...ALLOW_KEYS, ...SPECIAL_KEYS, ...Object.keys(KNOWN_SKIP)]);
  const missing = schema.settingsKeys.map((k) => k.key).filter((k) => !all.has(k));
  ok(missing.length === 0, 'allow-list: every key in data-schema.json is allowed, special or knowingly skipped', missing.join(','));
  ok([...ALLOW_KEYS, ...SPECIAL_KEYS].every((k) => !(k in KNOWN_SKIP)), 'allow-list: a key is never both allowed and skipped');
  const src = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/profile-import.mjs'), 'utf8');
  ok(!/\.bin['"`]/.test(src.replace(/\/\/.*$/gm, '')) || /SECRET_FILE_NAMES/.test(src), 'allow-list: secret files are named only in the explicit presence-check table');
}

// ---------- 9. idempotence + once ----------
{
  const f = makeProfile();
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  ok(imp.status(f.profile).offer === true, 'once: a fresh Tauri profile with a 0.2.9 profile present is offered the import');
  imp.apply(f.profile);
  const s1 = fs.readFileSync(path.join(target, 'settings.json'));
  const snap1 = snapshot(path.join(target, 'rooms'));
  const rep2 = imp.apply(f.profile);
  ok(Buffer.compare(s1, fs.readFileSync(path.join(target, 'settings.json'))) === 0 && snapshot(path.join(target, 'rooms')) === snap1, 'idempotent: a second apply changes no byte');
  ok(rep2.copied.length === 0 && rep2.rooms.length === 0, 'idempotent: the second report copies nothing');
  ok(imp.status(f.profile).offer === false && imp.status(f.profile).done === true, 'once: after an import the first-run offer is gone (Settings can still re-run)');
  const t2 = newTarget();
  const imp2 = createProfileImport({ dataDir: t2 });
  imp2.dismiss();
  ok(imp2.status(f.profile).offer === false && !fs.existsSync(path.join(t2, 'settings.json')), 'once: dismiss stops the offer and imports nothing');
  ok(createProfileImport({ dataDir: newTarget() }).status({ userDataDir: null, zumiDataDir: null, found: false }).offer === false, 'once: nothing to import -> no offer');
}

// ---------- 10. model + room edge cases ----------
{
  const f = makeProfile({ userModel: false });
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const plan = imp.plan(f.profile);
  imp.apply(f.profile);
  const s = readSettings(target);
  ok(!('model' in s) && !('userModelPath' in s) && plan.skipped.some((x) => x.key === 'model' && x.reason === 'model_file_missing'), 'model: a user model file that no longer exists is skipped (model_file_missing)');
  const g = makeProfile({ settingsOverride: { model: 'zumi-default-0910', userModelPath: undefined } });
  const t2 = newTarget();
  createProfileImport({ dataDir: t2 }).apply(g.profile);
  ok(readSettings(t2).model === 'zumi-default-0910', 'model: a bundled model id is copied as the id');
  const h = makeProfile({ rooms: false });
  const t3 = newTarget();
  const rep = createProfileImport({ dataDir: t3 }).apply(h.profile);
  const s3 = readSettings(t3);
  ok(!('importedRooms' in s3) && s3.room !== ROOM_ID && rep.skipped.some((x) => x.key === 'importedRooms'), 'room: an imported room whose folder is gone is skipped, and the room pick is not copied');
  // room v1 "Zumi's Office" was removed (owner, 2026-10-26): an Electron profile that saved it imports as default-v2 (Night City)
  const v1 = makeProfile({ settingsOverride: { room: 'default', roomChoiceV2: true } });
  const tv1 = newTarget();
  const v1plan = createProfileImport({ dataDir: tv1 }).plan(v1.profile);
  createProfileImport({ dataDir: tv1 }).apply(v1.profile);
  ok(readSettings(tv1).room === 'default-v2' && readSettings(tv1).roomChoiceV2 === true && !JSON.stringify(v1plan).includes('"value":"default"'), "room: a saved v1 'default' imports as default-v2 (v1 removed)", JSON.stringify({ room: readSettings(tv1).room }));
  const bad = makeProfile({ settingsOverride: { importedRooms: [{ id: '../../evil', fileBase: 'x' }, { id: ROOM_ID, fileBase: 'ok' }] } });
  const t4 = newTarget();
  createProfileImport({ dataDir: t4 }).apply(bad.profile);
  ok(!fs.existsSync(path.join(t4, 'rooms', '..', '..', 'evil')) && (readSettings(t4).importedRooms || []).every((r) => r.id === ROOM_ID), 'room: an id that is not a 12-hex content id is refused');
}

// ---------- 11. the checklist ----------
{
  const items = { en: checklist('en', ['api_keys', 'board_login', 'board_pin'], { providers: ['OpenRouter', 'Gemini'] }), vi: checklist('vi', ['api_keys', 'board_login', 'board_pin'], { providers: ['OpenRouter', 'Gemini'] }), zh: checklist('zh', ['api_keys', 'board_login', 'board_pin'], { providers: ['OpenRouter', 'Gemini'] }) };
  for (const l of ['en', 'vi', 'zh']) {
    ok(items[l].items.length === 3 && items[l].items.every((i) => i.id && i.title && i.body), `checklist ${l}: three items with id, title, body`);
  }
  ok(JSON.stringify(items.en.items.map((i) => i.id)) === JSON.stringify(items.vi.items.map((i) => i.id)) && JSON.stringify(items.vi.items.map((i) => i.id)) === JSON.stringify(items.zh.items.map((i) => i.id)), 'checklist: same ids and order in every language');
  ok(/API key/i.test(items.en.items[0].title) && /Board/.test(items.en.items[1].title), 'checklist en: names the API keys and the Board sign-in');
  ok(/khoá API/.test(items.vi.items[0].title) && /Bảng/.test(items.vi.items[1].title), 'checklist vi: "khoá API" and "Bảng"');
  ok(/API/.test(items.zh.items[0].title) && /[一-鿿]/.test(items.zh.items[0].title), 'checklist zh: Chinese text with the API keys');
  ok(!/[ắằẳẵặấầẩẫậđơưệộ]/.test(JSON.stringify(items.en)) && items.vi.items[0].title !== items.en.items[0].title, 'checklist: en has no Vietnamese, vi differs from en');
  ok(items.en.items[0].body.includes('OpenRouter') && items.en.items[0].body.includes('Gemini'), 'checklist: the API-key item names the providers that had a key');
  ok(checklist('en', ['api_keys', 'board_login']).items.length === 2 && checklist('fr', ['api_keys']).lang === 'en', 'checklist: only the needed items; unknown language falls back to en');
  ok(!JSON.stringify(items).includes(SECRET), 'checklist: carries no secret');
}


// ---------- 12. the four rpc handlers: fixed source, validated arguments ----------
const METHODS = ['settings.importDetect', 'settings.importPlan', 'settings.importApply', 'settings.importDismiss'];
{
  const { createImportRpc } = mod;
  ok(typeof createImportRpc === 'function', 'rpc: createImportRpc is exported');
  const f = makeProfile({ withSecrets: true, unknown: true });
  const target = newTarget();
  const rpc = createImportRpc({ dataDir: target, detect: () => ({ found: true, ...f.profile }) });
  const baseJson = JSON.stringify(f.userDataDir).slice(1, -1); // the profile folder as it would appear inside JSON (a user .vrm path elsewhere is a legitimate settings value)
  ok(METHODS.every((m) => typeof rpc[m] === 'function') && Object.keys(rpc).length === 4, 'rpc: exactly the four approved methods');
  const d = rpc['settings.importDetect']();
  ok(d.found === true && d.offer === true && !JSON.stringify(d).includes(baseJson), 'rpc: importDetect answers found/offer/done/dismissed and no path');
  const pl = rpc['settings.importPlan']();
  ok(pl.ok === true && pl.copy.length > 10 && !JSON.stringify(pl).includes(baseJson) && pl.rooms.every((r) => typeof r === 'string'), 'rpc: importPlan carries keys/values and room ids, never a source path');
  ok(!JSON.stringify(pl).includes(SECRET), 'rpc: importPlan carries no secret');
  for (const m of ['settings.importDetect', 'settings.importPlan', 'settings.importDismiss']) {
    ok(rpc[m]({ userDataDir: 'C:/evil' }).error === 'no_arguments' && rpc[m]('C:/evil').error === 'no_arguments', m + ': any argument (a path) is refused');
  }
  ok(!fs.existsSync(path.join(target, 'settings.json')) && !fs.existsSync(path.join(target, 'profile-import.json')), 'rpc: refused calls and plans wrote nothing');
  for (const bad of [{ path: 'C:/x' }, { userDataDir: 'C:/x' }, { overwrite: 'uiLang' }, 'C:/x', 5]) {
    const r = rpc['settings.importApply'](bad);
    ok(r.ok === false && ['bad_field', 'bad_args', 'bad_overwrite'].includes(r.error), 'importApply refuses ' + JSON.stringify(bad));
  }
  const unk = rpc['settings.importApply']({ overwrite: ['uiLang', 'apiKey'] });
  ok(unk.ok === false && unk.error === 'bad_overwrite' && unk.field === 'apiKey', 'importApply: an overwrite key outside the import allow-list is refused with an explicit error');
  for (const k of ['requireBoardPin', 'jev-key.bin', '__proto__', 'boardPort']) ok(rpc['settings.importApply']({ overwrite: [k] }).error === 'bad_overwrite', 'importApply: overwrite ' + k + ' refused');
  ok(rpc['settings.importApply']({ lang: 'fr' }).error === 'bad_lang' && rpc['settings.importApply']({ lang: 5 }).error === 'bad_lang', 'importApply: lang outside en/vi/zh is refused');
  ok(!fs.existsSync(path.join(target, 'settings.json')), 'importApply: refusals wrote nothing');
  const r = rpc['settings.importApply']({ overwrite: [], lang: 'zh' });
  ok(r.ok === true && r.checklist.lang === 'zh' && r.checklist.items.length >= 3 && Array.isArray(r.providers) && r.providers.includes('OpenRouter'), 'importApply: applies, localised checklist + provider names');
  ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(baseJson), 'importApply: the report has no secret and no source path');
  ok(rpc['settings.importDetect']().offer === false && rpc['settings.importDetect']().done === true, 'rpc: detect reflects the import afterwards');
  const none = createImportRpc({ dataDir: newTarget(), detect: () => ({ found: false, userDataDir: null, zumiDataDir: null }) });
  ok(none['settings.importApply']({}).error === 'no_profile' && none['settings.importPlan']().error === 'no_profile' && none['settings.importDetect']().found === false, 'rpc: without a profile apply/plan answer no_profile');
  const dz = createImportRpc({ dataDir: newTarget(), detect: () => ({ found: true, ...f.profile }) });
  dz['settings.importDismiss']();
  ok(dz['settings.importDetect']().offer === false && dz['settings.importDetect']().dismissed === true, 'rpc: dismiss ("Never") stops the offer');
}

// ---------- 13. wiring: inventory, generated allow-list + shim, sidecar, Rust ACL tests ----------
{
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/migration/api-inventory.json'), 'utf8'));
  for (const m of METHODS) {
    const e = inv.apis.find((a) => a.name === m);
    ok(e && e.tauriOnly === true && e.kind === 'invoke' && !e.guestOnly && /^tauri\/sidecar\/main\.mjs/.test(e.handler || ''), 'inventory: ' + m + ' is tauriOnly, invoke, not guestOnly, sidecar handler');
    ok(e && e.args.every((a) => !/path|dir|file|source/i.test(a)), 'inventory: ' + m + ' takes no path-like argument', e && e.args.join(','));
  }
  const apply = inv.apis.find((a) => a.name === 'settings.importApply');
  ok(apply && JSON.stringify(apply.args) === '["opts"]', 'inventory: importApply takes the single opts object');
  const allow = fs.readFileSync(path.join(ROOT, 'tauri/src-tauri/src/rpc_allow_list.rs'), 'utf8');
  const shim = fs.readFileSync(path.join(ROOT, 'tauri/shim/zumi-shim.js'), 'utf8');
  const sidecar = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/main.mjs'), 'utf8');
  for (const m of METHODS) {
    ok(allow.includes('"' + m + '"'), 'allow-list: ' + m + ' is generated');
    ok(shim.includes('$invoke("' + m + '"'), 'shim: ' + m + ' is generated');
  }
  ok(/\.\.\.createImportRpc\(/.test(sidecar) && /detectProfileForHost\(/.test(sidecar) && /process\.env\.APPDATA/.test(sidecar), 'sidecar: the four handlers are spread in, the source is detected from %APPDATA% inside the sidecar');
  const acl = fs.readFileSync(path.join(ROOT, 'tauri/src-tauri/src/acl_tests.rs'), 'utf8');
  for (const m of ['importDetect', 'importPlan', 'importApply', 'importDismiss']) ok(new RegExp('fn settings_' + m + '_is_main_webview_only').test(acl), 'rust: an ACL test for settings.' + m);
}

// ---------- 14. renderer: i18n keys (en/vi/zh), pure logic, markup ----------
{
  const { TABLES } = await import('../src/renderer/i18n.js');
  const keys = Object.keys(TABLES.en).filter((k) => k.startsWith('import.'));
  const need = ['import.title', 'import.apply', 'import.later', 'import.never', 'import.close', 'import.card', 'import.run', 'import.none', 'import.resultTitle', 'import.checklistH',
    'import.check.api_keys.t', 'import.check.api_keys.b', 'import.check.board_login.t', 'import.check.board_login.b', 'import.check.board_pin.t', 'import.check.ui_prefs.t',
    'import.check.ui_prefs.b', 'import.check.board_data.t', 'import.check.voice_cache.t'];
  ok(need.every((k) => keys.includes(k)), 'i18n: the import keys exist', need.filter((k) => !keys.includes(k)).join(','));
  ok(['vi', 'zh'].every((l) => JSON.stringify(Object.keys(TABLES[l]).filter((k) => k.startsWith('import.')).sort()) === JSON.stringify(keys.slice().sort())), 'i18n: vi and zh carry exactly the same import keys as en');
  // 26-10: the source app is named from the DETECTED install ({app}); no locale hardcodes a version number.
  ok(['en', 'vi', 'zh'].every((l) => Object.entries(TABLES[l]).filter(([k]) => k.startsWith('import.')).every(([, v]) => !/0.2.9/.test(v))), 'i18n: no import string hardcodes "0.2.9"');
  ok(['en', 'vi', 'zh'].every((l) => ['import.title', 'import.intro', 'import.card', 'import.none'].every((k) => /{app}/.test(TABLES[l][k] || ''))), 'i18n: title, intro, card and none carry the {app} placeholder in en/vi/zh');
  ok(/khoá API/.test(TABLES.vi['import.check.api_keys.t'] || '') && /Bảng/.test(TABLES.vi['import.check.board_login.t'] || ''), 'i18n vi: "khoá API" / "Bảng" in the checklist');
  // the renderer shows the checklist by id; ids and the sidecar's own texts must agree
  const sidecarIds = ['api_keys', 'board_login', 'board_pin', 'ui_prefs', 'board_data', 'voice_cache', 'model_readd'];
  ok(sidecarIds.every((id) => checklist('en', [id]).items.length === 1 && TABLES.en['import.check.' + id + '.t'] && TABLES.en['import.check.' + id + '.b']), 'i18n: every checklist id the sidecar can return has a title + body key');
  let ui = null;
  try { ui = await import('../src/renderer/profile-import.js'); } catch (e) { ok(false, 'renderer: profile-import.js loads', String(e && e.message)); }
  if (ui) {
    ok(typeof ui.summarize === 'function' && typeof ui.initProfileImport === 'function' && typeof ui.shouldOffer === 'function', 'renderer: exports summarize, shouldOffer, initProfileImport');
    const sum = ui.summarize({ ok: true, copy: [{ key: 'a' }, { key: 'b' }], same: ['c'], conflicts: [{ key: 'model', autoDefault: true }, { key: 'uiLang', autoDefault: false }], skipped: [{ key: 'x' }], unknown: ['u1', 'u2'] });
    ok(sum.copy === 2 && sum.kept === 3 && sum.skipped === 3 && sum.preselect.join() === 'model', 'renderer: summarize counts copy / kept / skipped(+unknown) and pre-selects autoDefault conflicts only');
    ok(ui.shouldOffer({ found: true, offer: true }) === true && ui.shouldOffer({ found: true, offer: false }) === false && ui.shouldOffer(null) === false, 'renderer: the first-run prompt shows only on offer');
  }
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  for (const id of ['import-dialog', 'import-apply', 'import-later', 'import-never', 'import-card', 'import-run']) ok(new RegExp('id="' + id + '"').test(html), 'markup: #' + id);
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  ok(/initProfileImport\(/.test(app), 'app.js: initProfileImport is wired');
}


// ---------- 15. GATE P3-C fixes: leaf-level schema, paths, links, guard, snapshot ----------
{
  const { detectProfileForHost, describeSchema } = mod;
  const SENT = Array.from({ length: 11 }, (_, i) => `SECRETSENTINEL-${String(i + 1).padStart(2, '0')}-9f3a71c2d4e85b60`);
  const NESTED = {
    roleModels: { do: { model: 'google/gemini-2.5-pro', effort: 'high', apiKey: SENT[0] }, arr: [{ password: SENT[1] }], plan: { model: 'acme/pro', effort: 'low' }, off: ['check', { token: SENT[1] }] },
    roleModelsByProvider: { custom: { token: SENT[2], baseUrl: `https://x.example.com/v1?key=${SENT[3]}` }, openrouter: { do: { model: 'acme/pro', effort: 'low' } } },
    voiceCustom: { base: `https://tts.example.com/v1?api_key=${SENT[4]}`, apiKey: SENT[5], model: 'tts-1', voice: 'alloy' },
    voiceCustomZumia: { url: `https://z.example.com/tts/${SENT[6]}` },
    voiceEleven: { voiceId: 'abcdefgh12345678', model: 'eleven_flash_v2_5', xiApiKey: SENT[7] },
    talkQuietHours: { on: true, start: '22:00', end: '07:00', boardPin: SENT[8] },
    importedRooms: [{ id: ROOM_ID, fileBase: 'mine.glb', manifest: { name: 'My room', apiKey: SENT[9] } }],
    chatModel: SENT[10] + SENT[10],
  };
  const f = makeProfile({ settingsOverride: NESTED });
  const target = newTarget();
  const imp = createProfileImport({ dataDir: target });
  const plan = imp.plan(f.profile);
  const rep = imp.apply(f.profile);
  const blob = [JSON.stringify(plan), JSON.stringify(rep), ...walk(target).map((p) => fs.readFileSync(p, 'utf8'))].join('\n');
  ok(!blob.includes('SECRETSENTINEL'), 'leaf: none of the 11 nested sentinels reaches the plan, the report or any file under the Tauri data dir');
  const s = readSettings(target);
  ok(s.roleModels && s.roleModels.do.model === 'google/gemini-2.5-pro' && s.roleModels.do.effort === 'high' && s.roleModels.plan.effort === 'low' && !('apiKey' in s.roleModels.do) && !('arr' in s.roleModels), 'leaf: roleModels keeps only {role:{model,effort}}');
  ok(JSON.stringify(s.roleModels.off) === '["check"]', 'leaf: roleModels.off keeps only the three role names');
  ok(s.roleModelsByProvider && s.roleModelsByProvider.openrouter.do.model === 'acme/pro' && !('custom' in s.roleModelsByProvider), 'leaf: roleModelsByProvider keeps the clean provider slot, drops the secret-laden one');
  ok(!('voiceCustom' in s) && !('voiceCustomZumia' in s) && !('chatModel' in s), 'leaf: a custom URL with a query or a path token, and a token-like model id, drop the whole group');
  ok(s.voiceEleven && s.voiceEleven.voiceId === 'abcdefgh12345678' && !('xiApiKey' in s.voiceEleven), 'leaf: voiceEleven keeps its two declared fields only');
  ok(JSON.stringify(s.talkQuietHours) === '{"on":true,"start":"22:00","end":"07:00"}', 'leaf: talkQuietHours is rebuilt as exactly {on,start,end}');
  ok(s.importedRooms.length === 1 && JSON.stringify(Object.keys(s.importedRooms[0]).sort()) === '["fileBase","id","manifest"]' && JSON.stringify(s.importedRooms[0].manifest) === '{"name":"My room"}', 'leaf: importedRooms[].manifest keeps only name/author/license/attribution strings');
  const skippedKeys = plan.skipped.map((x) => x.key);
  for (const k of ['roleModels.do.apiKey', 'roleModelsByProvider.custom', 'voiceEleven.xiApiKey', 'talkQuietHours.boardPin', 'importedRooms[0].manifest.apiKey']) ok(skippedKeys.some((x) => x.startsWith(k)), `leaf: the dropped field ${k} is listed as skipped`, skippedKeys.join(','));
  // every string leaf of every copied value passes a token test, and no compound value is copied unvetted
  const leafStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach((x) => leafStrings(x, out)); return out; };
  const { tokenLike } = mod;
  ok(typeof tokenLike === 'function' && leafStrings({ ...s, userModelPath: '', importedRooms: [], voiceEleven: null }).every((x) => !tokenLike(x)), 'leaf: no copied string leaf is token-like');
  // extra / secret-named fields in a small config are reported, never copied
  const g = makeProfile({ settingsOverride: { talkQuietHours: { on: true, start: '22:00', end: '07:00', extra: 1 }, voiceGemini: { model: 'm', voice: 'Kore', sessionCookie: 'x' }, hudStyle: { nested: true }, uiLang: ['vi'] } });
  const t5 = newTarget();
  const r5 = createProfileImport({ dataDir: t5 }).apply(g.profile);
  ok(!('hudStyle' in readSettings(t5)) && !('uiLang' in readSettings(t5)), 'leaf: an object or array where a primitive is declared is refused');
  ok(r5.skipped.some((x) => x.key === 'talkQuietHours.extra') && r5.skipped.some((x) => x.key === 'voiceGemini.sessionCookie'), 'leaf: extra fields are skipped and reported by path');

  // ---- paths: refused WITHOUT touching the file system ----
  const BAD = ['//attacker.example/share/me.vrm', '\\\\attacker\\share\\me.vrm', '//?/C:/Windows/x.vrm', '\\\\?\\C:\\Windows\\x.vrm', '\\\\.\\pipe\\x.vrm', 'C:/Windows/System32/../x.vrm', 'me.vrm', 'C:\\x\\me.vrm:stream', '/etc/me.vrm', 'C:me.vrm'];
  for (const bad of BAD) {
    const h = makeProfile({ userModel: false, settingsOverride: { userModelPath: bad } });
    const seen = [];
    const spyFs = new Proxy(fs, { get(t, p) { const v = t[p]; if (typeof v !== 'function') return v; return (...a) => { seen.push([String(p), String(a[0])]); return v.apply(t, a); }; } });
    const t6 = newTarget();
    const imp6 = createProfileImport({ dataDir: t6, fs: spyFs });
    const pl = imp6.plan(h.profile);
    imp6.apply(h.profile);
    const touched = seen.filter(([, a]) => a === bad || a.replace(/\\/g, '/').includes('attacker') || a.replace(/\\/g, '/').includes('Windows/') || a.endsWith('me.vrm'));
    ok(touched.length === 0, 'path: ' + JSON.stringify(bad) + ' is refused with no fs call on it', JSON.stringify(touched));
    ok(pl.skipped.some((x) => x.key === 'model' && x.reason === 'model_path_not_local') && pl.notImported.includes('model_readd') && !('userModelPath' in readSettings(t6)), 'path: ' + JSON.stringify(bad) + ' -> model_path_not_local + a "re-add the model" checklist item');
  }
  {
    const h = makeProfile();
    const t7 = newTarget();
    const noFixed = createProfileImport({ dataDir: t7, isFixedDrive: () => false });
    ok(noFixed.plan(h.profile).skipped.some((x) => x.reason === 'model_path_not_local') && !('userModelPath' in readSettings(t7)), 'path: a drive that is not a fixed local drive is refused');
    const t8 = newTarget();
    createProfileImport({ dataDir: t8, isFixedDrive: () => true }).apply(h.profile);
    ok(readSettings(t8).userModelPath === h.modelPath, 'path: a plain local absolute .vrm on a fixed drive is accepted');
    ok(createProfileImport({ dataDir: newTarget(), isFixedDrive: () => true }).plan(makeProfile({ userModel: false }).profile).notImported.includes('model_readd'), 'path: a missing model file also asks the user to re-add the model');
  }

  // ---- links: junctions are never followed out of the profile ----
  function junction(target, link) { try { fs.symlinkSync(target, link, 'junction'); return true; } catch { return false; } }
  {
    const h = makeProfile({ rooms: false });
    const outside = fresh('outside'); put(outside, `${ROOM_ID}/room.glb`, 'OUTSIDE-GLB');
    if (junction(outside, path.join(h.userDataDir, 'rooms'))) {
      const t = newTarget();
      const r = createProfileImport({ dataDir: t }).apply(h.profile);
      ok(!fs.existsSync(path.join(t, 'rooms', ROOM_ID)) && r.rooms.length === 0, 'links: <profile>/rooms as a junction to an outside folder is not followed');
    } else ok(true, 'links: (junction creation unavailable here; skipped)');
    const h2 = makeProfile({ rooms: false });
    const out2 = fresh('outside2'); put(out2, 'room.glb', 'OUTSIDE-GLB');
    fs.mkdirSync(path.join(h2.userDataDir, 'rooms'), { recursive: true });
    if (junction(out2, path.join(h2.userDataDir, 'rooms', ROOM_ID))) {
      const t = newTarget();
      createProfileImport({ dataDir: t }).apply(h2.profile);
      ok(!fs.existsSync(path.join(t, 'rooms', ROOM_ID)), 'links: <profile>/rooms/<id> as a junction is not followed');
    } else ok(true, 'links: (skipped)');
    const h3 = makeProfile();
    const realCopy = fresh('realcopy'); fs.cpSync(h3.userDataDir, path.join(realCopy, 'Zumi'), { recursive: true });
    const linkRoot = path.join(fresh('linkroot'), 'Zumi');
    if (junction(path.join(realCopy, 'Zumi'), linkRoot)) {
      const appData = path.dirname(linkRoot);
      ok(detectProfile({ appData, installParents: [] }).found === false, 'links: a %APPDATA%\\Zumi that is itself a junction is not a profile');
      ok(createProfileImport({ dataDir: newTarget() }).plan({ userDataDir: linkRoot, zumiDataDir: null }).error === 'no_profile', 'links: plan refuses a junction profile root');
    } else ok(true, 'links: (skipped)');
    const h4 = makeProfile();
    const zdReal = fresh('zdreal'); put(zdReal, `rooms/${ROOM_ID}/room.glb`, 'ZD-GLB');
    const parent = fresh('parent');
    if (junction(zdReal, path.join(parent, 'Zumi-data'))) {
      const dp = detectProfile({ appData: path.dirname(h4.userDataDir), installParents: [parent] });
      ok(dp.found === true && dp.zumiDataDir === null, 'links: a Zumi-data folder that is a junction is ignored');
    } else ok(true, 'links: (skipped)');
    // rooms are copied from a plain tree: no check.json (unvetted compound content) and a size cap
    const h5 = makeProfile();
    const t5b = newTarget();
    createProfileImport({ dataDir: t5b }).apply(h5.profile);
    ok(fs.existsSync(path.join(t5b, 'rooms', ROOM_ID, 'room.glb')) && !fs.existsSync(path.join(t5b, 'rooms', ROOM_ID, 'check.json')), 'rooms: room.glb is copied; check.json is not (it is unvetted compound content)');
    const h6 = makeProfile({ settingsOverride: { importedRooms: [{ id: ROOM_ID, fileBase: '../../Windows/x.glb' }] } });
    const t6b = newTarget();
    createProfileImport({ dataDir: t6b }).apply(h6.profile);
    ok(!(readSettings(t6b).importedRooms || []).some((r) => /\.\./.test(r.fileBase || '')), 'rooms: a fileBase with path segments is not copied');
  }

  // ---- the self-test / demo / shots guard is a tested function ----
  {
    const h = makeProfile();
    const appData = path.dirname(h.userDataDir);
    ok(typeof detectProfileForHost === 'function', 'guard: detectProfileForHost is exported');
    ok(detectProfileForHost({ selfTestActive: false, appData, hostDir: path.join(h.base, 'Programs', 'Zumi', 'bin') }).found === true, 'guard: a normal launch detects the profile');
    for (const active of [true, 1, 'selftest']) ok(detectProfileForHost({ selfTestActive: active, appData, hostDir: null }).found === false, 'guard: selfTestActive=' + JSON.stringify(active) + ' never looks at the real profile');
    ok(detectProfileForHost({ selfTestActive: undefined, appData, hostDir: null }).found === false, 'guard: an undefined flag fails closed');
    const sidecar = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/main.mjs'), 'utf8');
    ok(/detectProfileForHost\(\{\s*selfTestActive: Object\.values\(st\.info\)\.some\(Boolean\)/.test(sidecar), 'guard: main.mjs passes every self-test flag (st.info) into detectProfileForHost');
  }

  // ---- the allow-list schema is pinned: adding or loosening a key must be a deliberate test edit ----
  {
    const snapFile = path.join(ROOT, 'scripts/fixtures/profile-import-schema.snapshot.json');
    ok(typeof describeSchema === 'function' && fs.existsSync(snapFile), 'snapshot: describeSchema() and the pinned snapshot exist');
    if (typeof describeSchema === 'function' && fs.existsSync(snapFile)) {
      ok(JSON.stringify(describeSchema(), null, 2) === fs.readFileSync(snapFile, 'utf8').trim(), 'snapshot: the allow-list schema equals the pinned snapshot (edit scripts/fixtures/profile-import-schema.snapshot.json deliberately)');
      const d = describeSchema();
      ok(Object.values(d).every((v) => v !== 'any' && JSON.stringify(v).indexOf('plainObject') < 0), 'snapshot: no key accepts an arbitrary object');
    }
  }
}


// ---------- 16. re-review R1: strict formats for free-text leaves; R2: the .vrm itself ----------
{
  const { isFixedLocalDrive } = mod;
  const GOOD_MODELS = ['gemini-2.5-flash-lite-preview-06-17', 'qwen3-235b-a22b-thinking-2507', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct:free', 'mixtral-8x7b-instruct', 'gpt-4o-mini'];
  const BAD_MODELS = ['zzc1-550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'ghp-abcd1234-efgh5678', 'abcd1234efgh567', 'Ab12.Cd34.Ef56.Gh78', 'x/' + 'a1b2c3d4e5f6a7b8', 'Google/Gemini-Pro', 'm'.repeat(90)];
  for (const m of GOOD_MODELS) {
    const t = newTarget();
    createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: { chatModel: m, roleModels: { do: { model: m, effort: 'low' } } } }).profile);
    ok(readSettings(t).chatModel === m && readSettings(t).roleModels.do.model === m, 'format: a real model id is kept: ' + m);
  }
  for (const m of BAD_MODELS) {
    const t = newTarget();
    const rep = createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: { chatModel: m, roleModels: { do: { model: m, effort: 'low' } } } }).profile);
    ok(!('chatModel' in readSettings(t)) && !('roleModels' in readSettings(t)) && rep.skipped.some((x) => x.key === 'chatModel'), 'format: ' + JSON.stringify(m.slice(0, 44)) + ' is refused as a model id');
  }
  for (const v of ['abcd1234-ef56-7890-abcd-1234ef567890', 'zzc1-550e8400-e29b-41d4-a716-446655440000', 'Ab12Cd34Ef56Gh7']) {
    const t = newTarget();
    createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: { aiProvider: v, sceneRoom: v, chair3d: v } }).profile);
    const s = readSettings(t);
    ok(!('aiProvider' in s) && !('sceneRoom' in s) && !('chair3d' in s), 'format: an opaque slug is refused for aiProvider / sceneRoom / chair3d: ' + v.slice(0, 20));
  }
  {
    const t = newTarget();
    createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: { voiceGoogle: { en: 'zzc6-Ab12-Cd34-Ef56-Gh78', vi: 'vi-VN-Chirp3-HD-Leda' } } }).profile);
    ok(!('voiceGoogle' in readSettings(t)), 'format: a hyphen-split token in a voice name drops the voice group');
    const t2 = newTarget();
    createProfileImport({ dataDir: t2 }).apply(makeProfile({ settingsOverride: { voiceGoogle: { en: 'en-US-Chirp3-HD-Leda', vi: 'vi-VN-Chirp3-HD-Leda' } } }).profile);
    ok(readSettings(t2).voiceGoogle && readSettings(t2).voiceGoogle.en === 'en-US-Chirp3-HD-Leda', 'format: a real voice name is kept');
  }
  const man = (m) => ({ importedRooms: [{ id: ROOM_ID, fileBase: 'mine.glb', manifest: m }] });
  for (const [field, bad] of [['name', 'my password is hunter2!'], ['license', 'ghp-AbCd1234-EfGh5678'], ['attribution', 'Ab12Cd34Ef56Gh7'], ['author', 'see https://evil.example/a'], ['name', 'x'.repeat(81)], ['attribution', '550e8400-e29b-41d4-a716-446655440000'], ['name', 'token: abc'], ['license', 'www.example.com/key']]) {
    const t = newTarget();
    createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: man({ name: 'Cozy Room', [field]: bad }) }).profile);
    const mm = (readSettings(t).importedRooms || [{}])[0].manifest || {};
    ok(!(field in mm), 'format: manifest.' + field + ' ' + JSON.stringify(bad.slice(0, 30)) + ' is not copied');
    ok(!JSON.stringify(readSettings(t)).includes(bad), 'format: that manifest text is nowhere in the Tauri settings');
  }
  {
    const t = newTarget();
    createProfileImport({ dataDir: t }).apply(makeProfile({ settingsOverride: man({ name: 'Cozy Room', author: 'Nguyễn Văn A', license: 'CC-BY-4.0', attribution: "Room by Anna (2024) & friends, CC-BY" }) }).profile);
    const mm = readSettings(t).importedRooms[0].manifest;
    ok(mm.name === 'Cozy Room' && mm.author === 'Nguyễn Văn A' && mm.license === 'CC-BY-4.0' && /Anna/.test(mm.attribution), 'format: normal room credits (names, licence, punctuation, Vietnamese) are kept');
  }

  // ---- R2: lstat the .vrm and every segment, resolve it, check the drive type of the RESOLVED path ----
  const wrap = (over) => new Proxy(fs, { get(t, p) { const v = t[p]; if (typeof v !== 'function') return v; return (...a) => (over[p] ? over[p](v, t, ...a) : v.apply(t, a)); } });
  const linkStat = (real) => ({ isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, size: real.size });
  {
    const h = makeProfile();
    const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
    // 1. the .vrm itself is a symlink / reparse point
    let t = newTarget();
    let r = createProfileImport({ dataDir: t, isFixedDrive: () => true, fs: wrap({ lstatSync: (v, th, p, ...a) => (same(p, h.modelPath) ? linkStat(v.call(th, p)) : v.call(th, p, ...a)) }) }).plan(h.profile);
    ok(r.skipped.some((x) => x.key === 'model' && x.reason === 'model_path_not_local') && r.notImported.includes('model_readd'), 'vrm: a .vrm that is itself a link is refused');
    // 2. a directory segment on the way is a link (it could point at a UNC share)
    t = newTarget();
    r = createProfileImport({ dataDir: t, isFixedDrive: () => true, fs: wrap({ lstatSync: (v, th, p, ...a) => (same(p, path.dirname(h.modelPath)) ? linkStat(v.call(th, p)) : v.call(th, p, ...a)) }) }).plan(h.profile);
    ok(r.skipped.some((x) => x.reason === 'model_path_not_local') && r.copy.every((c) => c.key !== 'userModelPath'), 'vrm: a link in the directory chain is refused');
    // 3. the RESOLVED path is on a drive that is not fixed (the typed letter looked fine)
    const seenDrives = [];
    t = newTarget();
    r = createProfileImport({ dataDir: t, isFixedDrive: (l) => { seenDrives.push(l.toUpperCase()); return l.toUpperCase() !== 'E'; }, fs: wrap({ realpathSync: (v, th, p, ...a) => (same(p, h.modelPath) ? 'E:\\elsewhere\\me.vrm' : v.call(th, p, ...a)) }) }).plan(h.profile);
    ok(r.skipped.some((x) => x.reason === 'model_path_not_local') && seenDrives.includes('E'), 'vrm: the drive type is checked on the RESOLVED path, not only the typed one');
    // 4. resolved to a UNC / verbatim path
    for (const real of ['\\\\srv\\share\\me.vrm', '\\\\?\\UNC\\srv\\share\\me.vrm']) {
      t = newTarget();
      r = createProfileImport({ dataDir: t, isFixedDrive: () => true, fs: wrap({ realpathSync: (v, th, p, ...a) => (same(p, h.modelPath) ? real : v.call(th, p, ...a)) }) }).plan(h.profile);
      ok(r.skipped.some((x) => x.reason === 'model_path_not_local'), 'vrm: a path that resolves to ' + real.slice(0, 12) + '... is refused');
    }
    // 5. nothing is opened: only lstat/realpath/stat-style calls reach the file
    const calls = [];
    createProfileImport({ dataDir: newTarget(), isFixedDrive: () => true, fs: wrap({ openSync: (v, th, p, ...a) => { calls.push(['open', p]); return v.call(th, p, ...a); }, readFileSync: (v, th, p, ...a) => { calls.push(['read', String(p)]); return v.call(th, p, ...a); } }) }).plan(h.profile);
    ok(!calls.some(([, p]) => same(p, h.modelPath)), 'vrm: the model file is never opened or read');
    // 6. the happy path still works with the real fs
    t = newTarget();
    createProfileImport({ dataDir: t, isFixedDrive: () => true }).apply(h.profile);
    ok(readSettings(t).userModelPath === h.modelPath, 'vrm: a plain local .vrm is still accepted');
  }
  {
    ok(typeof isFixedLocalDrive === 'function', 'drive: isFixedLocalDrive is exported');
    if (typeof isFixedLocalDrive === 'function') {
      const letter = os.tmpdir()[0];
      ok(isFixedLocalDrive(letter) === true, 'drive: the temp drive (' + letter + ':) is a fixed drive');
      ok(isFixedLocalDrive('A') === false && isFixedLocalDrive('B') === false, 'drive: floppy letters are refused');
      ok(isFixedLocalDrive('1') === false && isFixedLocalDrive('') === false && isFixedLocalDrive('CC') === false, 'drive: a non-letter argument is refused');
      const free = 'QXYWVUTSRPONMLKJIHGFEDCBA'.split('').find((L) => !fs.existsSync(L + ':\\'));
      ok(free ? isFixedLocalDrive(free) === false : true, 'drive: a letter with no volume fails closed');
      // a subst-mapped drive is refused (subst needs no privilege)
      const sub = 'ZYXWVU'.split('').find((L) => !fs.existsSync(L + ':\\'));
      if (sub && process.platform === 'win32') {
        const { spawnSync } = await import('node:child_process');
        const made = spawnSync('subst', [sub + ':', tmp], { windowsHide: true }).status === 0;
        if (made) {
          try { ok(isFixedLocalDrive(sub) === false, 'drive: a subst-mapped drive (' + sub + ':) is refused'); }
          finally { spawnSync('subst', [sub + ':', '/d'], { windowsHide: true }); }
        } else ok(true, 'drive: (subst unavailable here; skipped)');
      }
    }
  }
}

// ---------- 16. the source app is named from the detected Electron install (26-10), never a hardcoded number ----------
{
  const { createProfileImport: mk } = mod;
  const asarOf = (files) => { // minimal Electron asar: pickle header + concatenated bodies
    let off = 0; const entries = {}; const bodies = [];
    for (const [name, text] of Object.entries(files)) { const b = Buffer.from(text); entries[name] = { size: b.length, offset: String(off) }; off += b.length; bodies.push(b); }
    const json = Buffer.from(JSON.stringify({ files: entries }));
    const pad = (4 - (json.length % 4)) % 4;
    const head = Buffer.alloc(16); head.writeUInt32LE(4, 0); head.writeUInt32LE(8 + json.length + pad, 4); head.writeUInt32LE(4 + json.length + pad, 8); head.writeUInt32LE(json.length, 12);
    return Buffer.concat([head, json, Buffer.alloc(pad), ...bodies]);
  };
  const pkg = (version, name = 'zumi-desktop') => JSON.stringify({ name, version });
  const withInstall = (kind, version, name) => {
    const f = makeProfile();
    const res = path.join(f.base, 'Programs', 'Zumi', 'resources');
    if (kind === 'dir') put(res, 'app/package.json', pkg(version, name));
    else if (kind === 'asar') put(res, 'app.asar', asarOf({ 'package.json': pkg(version, name) }));
    return { f, parents: [path.join(f.base, 'Programs')], appData: path.dirname(f.userDataDir) };
  };
  for (const kind of ['dir', 'asar']) {
    const w = withInstall(kind, '0.2.10');
    const d = detectProfile({ appData: w.appData, installParents: w.parents });
    ok(d.sourceVersion === '0.2.10', `source version (${kind}): the Electron install at 0.2.10 is reported as 0.2.10`, String(d.sourceVersion));
    const st = mk({ dataDir: newTarget() }).status(d);
    ok(st.sourceVersion === '0.2.10', `source version (${kind}): importDetect carries it`, String(st.sourceVersion));
  }
  {
    const w = withInstall('none');
    const d = detectProfile({ appData: w.appData, installParents: w.parents });
    ok(d.sourceVersion === null, 'source version: no Electron install found -> null', String(d.sourceVersion));
    ok(mk({ dataDir: newTarget() }).status(d).sourceVersion === null, 'source version: importDetect says null when undetectable');
  }
  for (const [label, version, name] of [['a version with junk', '0.2.10; calc', undefined], ['a non-version string', 'latest', undefined], ['another app', '9.9.9', 'someone-else']]) {
    const w = withInstall('dir', version, name);
    ok(detectProfile({ appData: w.appData, installParents: w.parents }).sourceVersion === null, `source version: ${label} is not trusted -> null`);
  }
  { // two installs that disagree: ambiguous, so no number at all
    const w = withInstall('dir', '0.2.10');
    put(path.join(w.f.base, 'Programs', 'Zumi-old', 'resources'), 'app/package.json', pkg('0.2.9'));
    ok(detectProfile({ appData: w.appData, installParents: w.parents }).sourceVersion === null, 'source version: two different installs -> null (never guess)');
  }
  // ---------- 17. the CURRENT install is the one the Zumi desktop / Start-menu shortcuts point at (CoS 5da004c7da70) ----------
  // an owner PC can keep ~12 side-by-side installs (<installs dir>/Zumi-<sha>/); the 0.2.10 kit repointed both Zumi.lnk files
  // at Zumi-c2d733a. Shortcuts present + readable + agreeing decide; missing both -> the old beside-Zumi-data scan, but only
  // with exactly one candidate; disagreeing or unreadable shortcuts -> null (the dialog says "Zumi (desktop)").
  {
    // Minimal MS-SHLLINK file: header (HasLinkInfo [+ IsUnicode]) + LinkInfo with VolumeID + LocalBasePath (ANSI, and the
    // Unicode copy when `unicode`). The shape Windows' WScript.Shell CreateShortcut writes for a local .exe target.
    const lnkOf = (target, { unicode = true } = {}) => {
      const head = Buffer.alloc(0x4c);
      head.writeUInt32LE(0x4c, 0);
      Buffer.from('0114020000000000c000000000000046', 'hex').copy(head, 4);
      head.writeUInt32LE(0x02 | (unicode ? 0x80 : 0), 0x14); // HasLinkInfo | IsUnicode
      const vol = Buffer.alloc(0x11); vol.writeUInt32LE(0x11, 0); vol.writeUInt32LE(3, 4); vol.writeUInt32LE(0x10, 12);
      const ansi = Buffer.concat([Buffer.from(target, 'latin1'), Buffer.alloc(1)]); // non-latin1 chars degrade, as an ANSI path would
      const suffix = Buffer.alloc(1);
      const hdr = unicode ? 0x24 : 0x1c;
      const volOff = hdr, baseOff = volOff + vol.length, sufOff = baseOff + ansi.length;
      const parts = [vol, ansi, suffix];
      let uniBaseOff = 0, uniSufOff = 0;
      if (unicode) { uniBaseOff = sufOff + suffix.length; const ub = Buffer.concat([Buffer.from(target, 'utf16le'), Buffer.alloc(2)]); uniSufOff = uniBaseOff + ub.length; parts.push(ub, Buffer.alloc(2)); }
      const body = Buffer.concat(parts);
      const li = Buffer.alloc(hdr);
      li.writeUInt32LE(hdr + body.length, 0); li.writeUInt32LE(hdr, 4); li.writeUInt32LE(1, 8); // VolumeIDAndLocalBasePath
      li.writeUInt32LE(volOff, 12); li.writeUInt32LE(baseOff, 16); li.writeUInt32LE(0, 20); li.writeUInt32LE(sufOff, 24);
      if (unicode) { li.writeUInt32LE(uniBaseOff, 28); li.writeUInt32LE(uniSufOff, 32); }
      return Buffer.concat([head, li, body, Buffer.alloc(4)]); // + empty terminal block
    };
    // anh's layout: <base>/_zumi-selftest/Zumi-aaaa (0.2.8) + Zumi-c2d733a (0.2.10); user data %APPDATA%/Zumi; the
    // shortcuts at <appData>/Microsoft/Windows/Start Menu/Programs/Zumi.lnk and <userProfile>/Desktop/Zumi.lnk.
    const world = ({ start, desktop, extra = [] } = {}) => {
      const f = makeProfile();
      const appData = path.dirname(f.userDataDir);
      const userProfile = path.join(f.base, 'User');
      const kit = path.join(f.base, '_zumi-selftest');
      const install = (dir, version, kind) => {
        put(path.join(kit, dir), 'Zumi.exe', 'MZ');
        if (kind === 'dir') put(path.join(kit, dir, 'resources'), 'app/package.json', pkg(version));
        else put(path.join(kit, dir, 'resources'), 'app.asar', asarOf({ 'package.json': pkg(version) }));
      };
      install('Zumi-aaaa', '0.2.8', 'dir');
      install('Zumi-c2d733a', '0.2.10', 'asar');
      for (const [dir, v] of extra) install(dir, v, 'dir');
      const exe = (dir) => path.join(kit, dir, 'Zumi.exe');
      const startLnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Zumi.lnk');
      const deskLnk = path.join(userProfile, 'Desktop', 'Zumi.lnk');
      const write = (file, v) => { if (v === undefined) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.isBuffer(v) ? v : lnkOf(exe(v))); };
      write(startLnk, start); write(deskLnk, desktop);
      return { appData, userProfile, kit, parents: [kit], shortcuts: [startLnk, deskLnk], exe };
    };
    const det = (w) => detectProfile({ appData: w.appData, installParents: w.parents, shortcuts: w.shortcuts }).sourceVersion;
    {
      const w = world({ start: 'Zumi-c2d733a', desktop: 'Zumi-c2d733a' });
      ok(det(w) === '0.2.10', 'shortcut: both shortcuts -> Zumi-c2d733a decides 0.2.10 among 2 installs (0.2.8 + 0.2.10)', String(det(w)));
      const host = mod.detectProfileForHost({ selfTestActive: false, appData: w.appData, userProfile: w.userProfile, hostDir: path.join(w.kit, 'tauri') });
      ok(host.sourceVersion === '0.2.10', 'shortcut: detectProfileForHost reads <APPDATA>/.../Start Menu/Programs/Zumi.lnk and <USERPROFILE>/Desktop/Zumi.lnk', String(host.sourceVersion));
    }
    {
      const w = world({ start: 'Zumi-aaaa', desktop: 'Zumi-aaaa' });
      ok(det(w) === '0.2.8', 'shortcut: the shortcut, not the newest folder, decides (both -> Zumi-aaaa = 0.2.8)', String(det(w)));
    }
    ok(det(world({ start: 'Zumi-c2d733a' })) === '0.2.10', 'shortcut: Start-menu shortcut only (no desktop one) -> 0.2.10');
    ok(det(world({ desktop: 'Zumi-c2d733a' })) === '0.2.10', 'shortcut: desktop shortcut only (no Start-menu one) -> 0.2.10');
    ok(det(world({ start: 'Zumi-c2d733a', desktop: 'Zumi-aaaa' })) === null, 'shortcut: the two shortcuts disagree -> null (neutral label)');
    ok(det(world({ start: 'Zumi-c2d733a', desktop: Buffer.from('not a shell link at all') })) === null, 'shortcut: an unreadable shortcut -> null (neutral label)');
    ok(det(world({ start: lnkOf('C:\\Windows\\notepad.exe'), desktop: lnkOf('C:\\Windows\\notepad.exe') })) === null, 'shortcut: the target is not a Zumi install -> null');
    ok(det(world({})) === null, 'shortcut: no shortcut and 2+ installs -> null (the folder scan never guesses)');
    {
      const w = world({}); fs.rmSync(path.join(w.kit, 'Zumi-aaaa'), { recursive: true, force: true });
      ok(det(w) === '0.2.10', 'shortcut: no shortcut and exactly one install -> that install (beside-Zumi-data fallback kept)', String(det(w)));
      const w2 = world({ extra: [['Zumi-bbbb', '0.2.10']] }); fs.rmSync(path.join(w2.kit, 'Zumi-aaaa'), { recursive: true, force: true });
      ok(det(w2) === null, 'shortcut: no shortcut and two installs even at the same version -> null (exactly one candidate only)');
    }
    {
      const w = world({}); const uni = path.join(w.kit, 'Zumi-ti\u1ebfng-vi\u1ec7t');
      put(uni, 'Zumi.exe', 'MZ'); put(path.join(uni, 'resources'), 'app/package.json', pkg('0.2.10'));
      fs.mkdirSync(path.dirname(w.shortcuts[0]), { recursive: true }); fs.writeFileSync(w.shortcuts[0], lnkOf(path.join(uni, 'Zumi.exe')));
      ok(det(w) === '0.2.10', 'shortcut: a Unicode target path is read from the Unicode LocalBasePath', String(det(w)));
      fs.writeFileSync(w.shortcuts[0], lnkOf(path.join(uni, 'Zumi.exe'), { unicode: false }));
      ok(det(w) === null, 'shortcut: an ANSI-only target that does not resolve -> null');
    }
    const mainSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
    ok(/detectProfileForHost\(\{[^}]*userProfile: process\.env\.USERPROFILE/.test(mainSrc), 'main.mjs passes USERPROFILE (the Desktop shortcut) to detectProfileForHost');
    const srcPI = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'profile-import.mjs'), 'utf8');
    const lnkCode = srcPI.slice(srcPI.indexOf('function parseShellLinkTarget'), srcPI.indexOf('export function detectProfileForHost'));
    ok(lnkCode.length > 200 && !/spawn|exec|powershell|wscript/i.test(lnkCode) && !/powershell|wscript/i.test(srcPI), 'the .lnk target is parsed in-process (no PowerShell / child process)');
  }
  {
    const ui2 = await import('../src/renderer/profile-import.js');
    const i18n = await import('../src/renderer/i18n.js');
    ok(typeof ui2.sourceLabel === 'function', 'renderer: exports sourceLabel');
    if (typeof ui2.sourceLabel === 'function') {
      ok(ui2.sourceLabel({ sourceVersion: '0.2.10' }) === 'Zumi 0.2.10', 'label: 0.2.10 detected -> "Zumi 0.2.10"');
      for (const bad of [null, {}, { sourceVersion: null }, { sourceVersion: '' }, { sourceVersion: 'x; y' }]) ok(ui2.sourceLabel(bad) === 'Zumi (desktop)', 'label: undetectable (' + JSON.stringify(bad) + ') -> neutral "Zumi (desktop)"');
      for (const l of ['en', 'vi', 'zh']) {
        i18n.setLocale(l);
        const ver = i18n.t('import.title', { app: ui2.sourceLabel({ sourceVersion: '0.2.10' }) }) + i18n.t('import.intro', { app: 'Zumi 0.2.10' });
        ok(/0\.2\.10/.test(ver) && !/0\.2\.9/.test(ver), `label (${l}): the dialog title/intro say 0.2.10`);
        const neu = i18n.t('import.title', { app: ui2.sourceLabel(null) }) + i18n.t('import.none', { app: ui2.sourceLabel(null) });
        ok(/Zumi \(desktop\)/.test(neu) && !/\d+\.\d+\.\d+/.test(neu), `label (${l}): undetectable version -> neutral label, no number`);
      }
      i18n.setLocale('en');
    }
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
