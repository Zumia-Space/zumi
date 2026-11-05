// check:soul-address (T-31 alpha.13). Plain Node, no network, no model call. Owner 02-11.
//   1. no fixed Vietnamese line Zumi says or writes holds "mình", "tôi", "bạn", or a hard-coded "anh"/"em" instead of a token;
//      the scanner is proved on every line by planting "mình" in a copy (it must flag exactly that line);
//   2. any other "mình" in the shipped text is on the reasoned allow-list below, and the list holds nothing stale;
//   3. a custom pair saved through the real agent core reaches the system prompt and a line from the real scheduler, in both hosts' wiring;
//   4. the installed soul reads with every value kept and em/anh added, with no write; the public build assumes no gender;
//   5. the rule follows the user's text, is sent on Plan and Check too, and stays out of a soul that never writes Vietnamese.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { createAgentCore } from '../src/main/agent-core.mjs';
import { createSpeechScheduler } from '../src/main/speech-scheduler.mjs';
import { renderLine } from '../src/main/speech-lines.mjs';
import { TABLES, setAddress, t, setLocale } from '../src/renderer/i18n.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { soulPrefs, soulSystemPrompt, addressRule, validateSoul, createSoulStore, templateList, OWNER_ADDRESS, PUBLIC_ADDRESS } = require('../src/main/soul-prefs.js');
const brain = require('../src/main/chat-brain.js');

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// ---------- 1. the fixed lines ----------
const L = '[\\p{L}\\p{N}]';
const word = (w) => new RegExp(`(?<!${L})${w}(?!${L})`, 'iu');
const BANNED = ['mình', 'tôi', 'bạn', 'anh', 'em'].map((w) => [w, word(w)]);
/** The words a spoken line must not hard-code. Empty = clean. */
const badWords = (text) => BANNED.filter(([, re]) => re.test(String(text).replace(/\{\w+\}/g, ''))).map(([w]) => w);

const SPOKEN_I18N = ['settings.testLine.vi', 'settings.sampleText', 'app.replyFailed', 'hud.consent.ask', 'zumi.analysisOff', 'analysis.understood', 'analysis.plan',
  // Not spoken, but they address the user by the same word beside her lines (REVIEW F3).
  'talk.whoUser', 'hud.watch.W4', 'hud.asks', 'hud.noneWaiting', 'hud.t1.asks', 'hud.t2.waiting', 'brain.zone.owner', 'brain.lib.needsYou', 'onboard.pick.sub', 'soul.field.ownerName', 'soul.field.userWord', 'soul.lang.auto', 'brain.mem.privacy'];
function spokenLines(lines = readJson('src/main/speech-lines.json'), tpl = readJson('src/main/soul-templates.json'), vi = TABLES.vi) {
  return [
    ...Object.entries(lines.vi).map(([k, v]) => [`speech-lines ${k}`, v.text]),
    ...tpl.templates.map((x) => [`soul preview ${x.id}`, x.preview.vi]),
    ...SPOKEN_I18N.map((k) => [`i18n ${k}`, vi[k]]),
  ];
}
const flagged = (rows) => rows.filter(([, text]) => badWords(text).length).map(([id]) => id);

const rows = spokenLines();
ok(rows.length > 40 && rows.every(([, text]) => typeof text === 'string' && text), `the scan covers every spoken line (${rows.length})`);
{ const bad = flagged(rows); ok(bad.length === 0, 'no fixed spoken line hard-codes an address word', bad.join(', ')); }
{
  // Prove the scanner on each line, in place: it must flag the planted line and nothing else.
  let missed = [];
  rows.forEach(([id], i) => {
    const planted = rows.map((r, j) => (j === i ? [r[0], `${r[1]} mình`] : r));
    const got = flagged(planted);
    if (got.length !== 1 || got[0] !== id) missed.push(id);
  });
  ok(missed.length === 0, `a planted "mình" is caught on each of the ${rows.length} lines, and only there`, missed.join(', '));
}

// ---------- 2. every other "mình" in shipped text has a reason ----------
const MINH = word('mình');
const ALLOWED_I18N = {
  'settings.holoStyleD': "the owner's own wording, pinned by check-settings-tabs; settings text, not said by her",
  'room.warning.missing_lights': 'settings text about Zumi in the third person, reflexive',
  'gesture.poke.startle': '"giật mình" means startled',
  'gesture.wake.startle-wake': '"giật mình" means startled',
};
const ALLOWED_FILES = {
  'src/main/soul-templates.json': 'the never-list the rule is built from; its lines are scanned one by one in section 1',
  'src/main/role-triggers.js': 'reads what the OWNER typed ("của mình"): matching his words, not her speech',
  'src/main/cloud-fixtures.json': 'self-test answers: only with --selftest (tauri/sidecar/main.mjs talkFixture)',
  'src/main/demo-fixtures.json': 'rehearsal answers: only with --demo-fixture (tauri/sidecar/main.mjs talkFixture)',
};
const viHits = Object.entries(TABLES.vi).filter(([, v]) => MINH.test(v)).map(([k]) => k);
ok(viHits.every((k) => ALLOWED_I18N[k]), 'every "mình" in the VI table is on the allow-list', viHits.filter((k) => !ALLOWED_I18N[k]).join(', '));
ok(Object.keys(ALLOWED_I18N).every((k) => viHits.includes(k)), 'the VI allow-list holds nothing stale');
const mainFiles = fs.readdirSync(path.join(ROOT, 'src/main')).filter((f) => /\.(js|mjs|json)$/.test(f)).map((f) => `src/main/${f}`);
const fileHits = mainFiles.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').some((l) => !/^\s*(\/\/|\*)/.test(l) && MINH.test(l)));
ok(fileHits.every((f) => ALLOWED_FILES[f]), 'every "mình" in src/main is on the allow-list', fileHits.filter((f) => !ALLOWED_FILES[f]).join(', '));
ok(Object.keys(ALLOWED_FILES).every((f) => fileHits.includes(f)), 'the file allow-list holds nothing stale');
const speechJson = fs.readFileSync(path.join(ROOT, 'src/main/speech-lines.json'), 'utf8');
ok(!MINH.test(speechJson), 'speech-lines.json has no "mình" at all');
{ const fx = readJson('src/main/soul-templates.json').address.publicDefault; ok(soulPrefs({}).selfWord === fx.selfWord && soulPrefs({}).userWord === fx.userWord, 'soulPrefs public default = soul-templates.json'); }
{ // i18n.js holds the page's pre-answer default: it must be the same pair.
  setLocale('vi');
  ok(t('analysis.understood').startsWith('Em ') && t('app.replyFailed').includes(`${PUBLIC_ADDRESS.userWord} thử lại`), 'the page default before the host answers is the public pair', t('app.replyFailed'));
}

// ---------- 3. a custom pair, real store + real scheduler ----------
const dir = checkOutDir('check-soul-address');
const PAIR = { selfWord: 'tớ', userWord: 'cậu' };
function coreFor(start, opts = {}) {
  let settings = start;
  const said = [];
  const clock = { t: 1_800_000_000_000 };
  const d = fs.mkdtempSync(path.join(dir, 'c-'));
  const core = createAgentCore({ dataDir: d, settings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; return settings; }, ...opts });
  const sched = createSpeechScheduler({ prefs: () => ({ ...settings, talkLevel: 'chatty', talkVoiceLang: 'vi', talkQuietHours: { on: false, start: '22:30', end: '07:30' } }), now: () => clock.t, signals: () => ({ idleSec: 5, windowVisible: true }), address: core.address, emit: (l) => said.push(l) });
  const say = (kind, payload) => { clock.t += 3_600_000; return sched.enqueue(kind, payload); }; // past every gap
  return { core, sched, say, said, settings: () => settings, dir: d };
}
{
  const c = coreFor({ soul: { name: 'Zumi', replyLang: 'vi' } });
  const r = c.core.handlers['soul.save']({ ...PAIR });
  ok(r.ok && c.settings().soul.selfWord === 'tớ' && c.settings().soul.userWord === 'cậu', 'soul.save stores the custom pair', JSON.stringify(r));
  const sent = brain.buildMessages('xin chào', [], undefined, undefined, c.core.getSoul())[0].content;
  ok(sent.includes('call yourself "tớ"') && sent.includes('call your owner "cậu"'), 'the custom pair reaches the system prompt buildMessages sends', sent.slice(0, 300));
  c.say('event', { event: 'boardLost' });
  ok(c.said[0] && c.said[0].text === 'Tớ mất kết nối bảng việc rồi, để tớ thử lại.', 'the custom pair reaches a line from the real scheduler', JSON.stringify(c.said[0]));
  c.core.handlers['soul.save']({ selfWord: 'Mimi' });
  c.say('event', { event: 'pat' });
  ok(c.said.at(-1) && (c.said.at(-1).text === 'Hihi, cảm ơn cậu.'), 'a saved change applies to the next line with no restart', JSON.stringify(c.said.at(-1)));
  ok(c.core.handlers['soul.get']().templates[0].preview.vi === 'Chào cậu, Mimi là Zumi. Có gì cần Mimi để mắt hôm nay không?', 'template previews speak with the chosen words', c.core.handlers['soul.get']().templates[0].preview.vi);
  ok(c.core.handlers['soul.save']({ selfWord: '   ' }).error === 'empty', 'an empty word fails explicitly');
  ok(c.core.handlers['soul.save']({ userWord: 'x'.repeat(21) }).error === 'too_long', 'a word over 20 chars fails explicitly');
  ok(c.core.handlers['soul.save']({ userWord: 'sk-or-v1-0123456789abcdef0123456789abcdef' }).error === 'secret_shaped', 'a key-shaped word is refused');
  c.core.dispose();
}
{
  const a = renderLine('ask', { title: 'Việc {user}', step: 'Bước' }, 'vi', PAIR);
  ok(a.show === 'Cậu ơi, việc Việc user cần cậu trả lời ở bước Bước.', 'a board title cannot inject an address token (the sanitiser strips its braces)', a.show);
  ok(renderLine('event', { event: 'pat' }, 'vi', { selfWord: 'em', userWord: '{title}' }).show.includes('title') && !renderLine('ask', { title: 'Secret' }, 'vi', { selfWord: 'em', userWord: '{title}' }).show.startsWith('Secret'), 'an address word cannot pull in the board title');
  ok(renderLine('event', { event: 'pat' }, 'en', PAIR).speak === 'Mm, thanks.', 'the English lines ignore the Vietnamese pair');
  ok(renderLine('idle', {}, 'vi', OWNER_ADDRESS).speak === 'Bảng việc đang yên, em vẫn để mắt nhé.', 'the line he heard on 02-11 02:42:22Z now reads "em"', renderLine('idle', {}, 'vi', OWNER_ADDRESS).speak);
  ok(renderLine('watch', { rule: 'W4', title: 'Task' }, 'vi', { selfWord: 'em', userWord: 'sếp' }).speak.startsWith('Sếp trả lời'), 'a watcher line capitalises the chosen word (Đ/S safe)');
  ok(renderLine('event', { event: 'pat' }, 'vi', { selfWord: 'em', userWord: 'đại ca' }).speak === 'Hihi, cảm ơn đại ca.' && renderLine('ask', {}, 'vi', { selfWord: 'em', userWord: 'đại ca' }).speak.startsWith('Đại ca ơi'), 'capitalising a Vietnamese first letter');
  setAddress(PAIR);
  ok(t('app.replyFailed') === 'Tớ chưa trả lời được, cậu thử lại nhé.' && t('settings.testLine.vi') === 'Xin chào, giọng tớ thế này.', 'the custom pair reaches the page strings', t('app.replyFailed'));
  let fired = 0; const off = (await import('../src/renderer/i18n.js')).onLocaleChange(() => { fired++; });
  setAddress({ ...PAIR }); setAddress(OWNER_ADDRESS);
  ok(fired === 1, 'only the real change repaints through the locale listeners', String(fired));
  setAddress({ ...OWNER_ADDRESS });
  ok(fired === 1, 'an unchanged pair repaints nothing (no loop)'); off();
  { const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    ok(/webview && getLocale\(\) !== boardLocale/.test(app) && /ui\.setEnabled\(talk\.enabled\)/.test(app), 'the app listener restores the chat placeholder and reloads an open board only on a locale change'); }
  ok(t('talk.whoUser') === 'Anh nói', 'the chat label follows the pair');
  setAddress({ selfWord: () => '', userWord: {} });
  ok(t('talk.whoUser') === 'Anh nói', 'a malformed answer from a stub host is ignored');
  ok(t('analysis.plan') === 'Em sẽ làm…', 'analysis label back to the owner pair');
}
for (const f of ['src/main/main.js', 'tauri/sidecar/speech-host.mjs']) {
  ok(/address: (agentCore|agent)\.address/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} hands the soul's words to the scheduler`);
}
ok(/ownerBuild: OWNER_ADMIN/.test(fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')) && /ownerBuild: ctx\.flavour\.values\.ownerAdmin === true/.test(fs.readFileSync(path.join(ROOT, 'tauri/sidecar/main.mjs'), 'utf8')), 'both hosts choose the default pair from the build flavour');

// ---------- 4. the installed soul, and the public default ----------
const INSTALLED = Object.freeze({
  name: 'Zumi', role: 'desktop AI work assistant avatar', ownerName: 'Anh Kei',
  style: 'Light and playful; one small joke is fine when nothing is on fire, never when something is.',
  persona: 'You have a dry sense of humour and like a good-news-bad-news framing, but the facts always come first.',
  replyLang: 'vi', template: 'playful',
}); // his values as read from soul-history.json on 02-11
{
  const before = JSON.stringify({ soul: INSTALLED });
  const c = coreFor({ soul: { ...INSTALLED } }, { ownerBuild: true });
  const got = c.core.getSoul();
  ok(Object.entries(INSTALLED).every(([k, v]) => got[k] === v), 'installed soul: every value he set is kept');
  ok(got.selfWord === 'em' && got.userWord === 'anh', 'installed soul on the owner build reads em / anh');
  ok(JSON.stringify(c.settings()) === before && !fs.existsSync(path.join(c.dir, 'soul-history.json')), 'reading it writes nothing: settings and history stay as they were');
  const view = c.core.handlers['soul.get']();
  ok(view.onboarded === true && view.soul.selfWord === 'em' && view.canUndo === false, 'installed soul: no cards return, the fields show em / anh');
  c.say('event', { event: 'updated', version: '0.3.0-alpha.13' });
  ok(c.said[0] && c.said[0].text === 'Em đã lên bản 0.3.0-alpha.13 rồi anh.', 'installed soul: the update line says em / anh', JSON.stringify(c.said[0]));
  const r = c.core.handlers['soul.save']({ selfWord: 'Zumi' });
  const hist = JSON.parse(fs.readFileSync(path.join(c.dir, 'soul-history.json'), 'utf8'));
  ok(r.ok && hist.length === 2 && hist[0].soul.ownerName === 'Anh Kei', 'first save keeps the old soul for Undo');
  const u = c.core.handlers['soul.undo']();
  ok(u.ok && u.soul.selfWord === 'em' && u.soul.userWord === 'anh' && u.soul.persona === INSTALLED.persona, 'undo returns his soul with em / anh');
  c.core.dispose();
  // An older history row has no words: undoing into it on the owner build is still em / anh, not the public word.
  const d = fs.mkdtempSync(path.join(dir, 'old-'));
  fs.writeFileSync(path.join(d, 'soul-history.json'), JSON.stringify([{ t: 1, soul: INSTALLED }, { t: 2, soul: { ...INSTALLED, name: 'Mimi' } }]));
  let s = { soul: { ...INSTALLED, name: 'Mimi' } };
  const st = createSoulStore({ settings: () => s, saveSettings: (p) => { s = { ...s, ...p }; return s; }, dataDir: d, ownerBuild: true });
  ok(st.undo().soul.userWord === 'anh', 'undo into a pre-alpha.13 history row on the owner build: em / anh');
}
{
  const c = coreFor({});
  const g = c.core.getSoul();
  ok(g.selfWord === 'em' && g.userWord === 'bạn', 'public build, nothing set: em / bạn (no assumed gender)');
  ok(!word('anh').test(c.core.handlers['soul.get']().templates.map((x) => x.preview.vi).join(' ')), 'public previews do not say "anh"');
  c.say('ask', { title: 'Việc', step: 'Bước' });
  ok(c.said[0] && c.said[0].text.startsWith('Bạn ơi') && !word('anh').test(c.said[0].text), 'public line uses "bạn"', JSON.stringify(c.said[0]));
  const rule = addressRule(g);
  ok(rule.includes('"mình"') && rule.includes('"tôi"') && !/Never call[^.]*"bạn"/.test(rule), 'the public rule does not forbid its own chosen word', rule);
  c.core.dispose();
}

// ---------- 5. the prompt ----------
{
  const PERSONA = 'Always call yourself mình and call the owner bạn.';
  const v = validateSoul({ persona: PERSONA, selfWord: 'em', userWord: 'anh' }, soulPrefs({}));
  const text = soulSystemPrompt(v.soul);
  const rule = addressRule(v.soul);
  ok(rule.includes('"mình"') && rule.includes('"tôi"') && rule.includes('"bạn"'), 'owner pair: the rule names mình, tôi and bạn', rule);
  ok(text.indexOf(rule) > text.indexOf(PERSONA) && text.indexOf(rule) > text.indexOf(v.soul.style), 'the rule comes after the user text');
  for (const lang of ['en', 'zh']) ok(!soulSystemPrompt({ ...v.soul, replyLang: lang }).includes('Whenever you write in Vietnamese'), `replyLang ${lang}: no Vietnamese rule`);
  for (const lang of ['auto', 'vi']) ok(soulSystemPrompt({ ...v.soul, replyLang: lang }).includes(rule), `replyLang ${lang}: the rule is sent`);
  ok(templateList().every((x) => !x.preview.vi.includes('{')), 'no raw token left in a preview');

  const cb = fs.readFileSync(path.join(ROOT, 'src/main/chat-brain.js'), 'utf8');
  ok(/content: withAddress\(PLAN_PROMPT\)/.test(cb) && /content: withAddress\(CHECK_PROMPT\)/.test(cb), 'Plan and Check roles carry the rule');
}

console.log(`\ncheck:soul-address ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
