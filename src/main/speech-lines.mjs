// Speech line pool (T-31 talk-mode, 19-10): the fixed EN/VI templates from PLAN.md section 3.2, plus the pure
// renderer that fills them from local board data. No model, no network, no Electron: speech-scheduler.mjs calls
// renderLine() for every proactive line, so scripts/check-talk-mode.mjs can exercise the whole pool under plain Node.
//
// Why the pool lives in main as JSON (plan F1): the packaged app ships src/main/** but not src/renderer/i18n.js, so a
// main-process scheduler cannot import the renderer's i18n table. A .json file is also outside check-ui-lang's scan
// (that guard only reads src/main/*.js), which is what lets the VI lines exist here instead of a .js literal.
//
// Safety: every rendered line goes through sanitizeSpeech() (quick-speech.js), the same whitelist that keeps board
// text out of the voice. It strips urls, paths, markup and task codes, so a task id can never be spoken (plan F5).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeSpeech } = require('./quick-speech.js');
// One Vietnamese-detection heuristic in the app: local-tts.js:184 exports the same accent class the reply path uses.
const { isVietnamese } = require('./local-tts.js');
const { addressVars, PUBLIC_ADDRESS } = require('./soul-prefs.js');

const DATA = JSON.parse(fs.readFileSync(new URL('./speech-lines.json', import.meta.url), 'utf8'));

/** The kinds the scheduler may enqueue (plan section 2). `checkin` is the check-in summary (Fable review item 7; its hours
 *  come from the rhythm core since alpha.12). `watch` is a read-only watcher finding (T-31 alpha.12, watch-rules.mjs). */
export const KINDS = ['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'event', 'idle', 'watch'];

export const LINE_KEYS = Object.freeze(Object.keys(DATA.en));
export const MOODS = Object.freeze(Object.fromEntries(LINE_KEYS.map((k) => [k, DATA.en[k].mood])));

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : d;
};

/** `{var}` substitution; an absent var becomes '' (only used by a variant that was chosen for its presence). */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] == null ? '' : String(vars[key])));
}

/** Pick the template key for a kind + payload. Variant rules (plan 3.1): with/without a step, one/many. */
function chooseKey(table, kind, payload, title, step) {
  if (payload.key && table[payload.key]) return payload.key; // idle pool rotation names its template
  switch (kind) {
    case 'ask': {
      // ask.many names the first title; without a usable title (a code-only title sanitises to '') use the generic line.
      if (num(payload.n) > 1) return title ? 'ask.many' : 'ask.generic';
      if (title && step) return 'ask.step';
      if (title) return 'ask.plain';
      return 'ask.generic';
    }
    case 'step': {
      // Fable review item 6: only outcome === 'done' is a finished step. Anything else (a bare edit or a step
      // change) is progress, never the misleading "{step} is done".
      if (payload.outcome === 'blocked') return 'step.blocked';
      if (payload.outcome !== 'done') return 'progress.one';
      return title && step ? 'step.done' : 'step.done.plain';
    }
    case 'progress':
      return num(payload.n) > 1 ? 'progress.many' : 'progress.one';
    case 'morning': {
      const n = num(payload.n);
      return n <= 0 ? 'morning.none' : n === 1 ? 'morning.one' : 'morning.some';
    }
    case 'welcome':
      return num(payload.u) + num(payload.a) > 0 ? 'welcome.some' : 'welcome.none';
    case 'checkin':
      // The check-in summary (Fable review item 7): anything waiting is the "N things" line; open watcher findings
      // (alpha.12, W6) add "N need a second look".
      if (num(payload.w) > 0) return num(payload.n) > 0 ? 'checkin.review' : 'checkin.reviewOnly';
      return num(payload.n) > 0 ? 'checkin.some' : 'checkin.none';
    case 'watch':
      // One finding names its rule's line; a batch of several is one "N things" line (watch-host.mjs batches).
      if (num(payload.n) > 1) return 'watch.many';
      return table[`watch.${payload.rule}`] && title ? `watch.${payload.rule}` : 'watch.generic';
    case 'event': {
      // Fable review item 10: one input convention only, kind='event' + payload.event='boardLost'.
      return `event.${String(payload.event || 'poke')}`;
    }
    case 'idle':
      return title && step ? 'idle.still' : 'idle.quiet';
    default:
      return kind;
  }
}

/**
 * Render one proactive line.
 * @param {'ask'|'step'|'progress'|'morning'|'welcome'|'checkin'|'event'|'idle'} kind
 * @param {object} payload  ask: {key,title,step} | step: {title,step,outcome} | progress: {title,step,n}
 *                          | morning: {n} | welcome: {u,a} | checkin: {n,time} | event: {event,...} | idle: {key,title,step}
 * @param {'en'|'vi'} lang    the talk voice language (plan 1: proactive lines only)
 * @param {{selfWord:string,userWord:string}} [address]  the soul's words for {self}/{user} in the VI lines; absent = the public default
 * @returns {{ speak: string, show: string, key: string, showKey: string, mood: string|null }}
 *   speak = the (possibly no-title) spoken variant; show = the full subtitle text. Both are sanitised and <= 90 chars;
 *   under the EN + Vietnamese-text rule (plan F4) they differ: speak is the no-title line, show keeps the title.
 */
export function renderLine(kind, payload = {}, lang = 'en', address = PUBLIC_ADDRESS) {
  const table = DATA[lang === 'vi' ? 'vi' : 'en'];
  const p = payload || {};
  // Caps tightened by the Fable review (item 9): a 35-char title and a 30-char step; both are sanitised first.
  const title = sanitizeSpeech(p.title, 35);
  const step = sanitizeSpeech(p.step, 30);
  const version = sanitizeSpeech(p.version, 20);
  // The check-in clock is spoken as a word, never "12:00": sanitizeSpeech strips ':' (its whitelist keeps urls and
  // host:port out of the voice), so the neutral window id maps to a spoken label per language in speech-lines.json.
  const time = ((DATA.checkinTime || {})[lang === 'vi' ? 'vi' : 'en'] || {})[p.time] || '';
  const key = chooseKey(table, kind, p, title, step);
  const entry = table[key];
  if (!entry) return { speak: '', show: '', key, showKey: key, mood: null };
  // progress.one needs a title + step; an empty payload would otherwise render " moved on to ." .
  if (key === 'progress.one' && !title && !step) return { speak: '', show: '', key, showKey: key, mood: entry.mood ?? null };

  const vars = {
    ...addressVars(address),
    title, step, version, time, name: sanitizeSpeech(p.name, 40),
    n: String(num(p.n)), u: String(num(p.u)), a: String(num(p.a)), w: String(num(p.w)), c: String(num(p.c)),
  };

  // F4: with the EN voice, a Vietnamese title/step would be handed to Kokoro (which cannot speak it). Keep the full
  // text in the subtitle, but speak a variant without that text where one exists (ask -> generic, step done -> the
  // no-step line, idle.still -> idle.quiet). If no safe variant exists, speak='' so the scheduler emits a subtitle
  // instead of sending VI text to the EN voice. VI voice language keeps the full line on purpose.
  const viVar = isVietnamese(title) || isVietnamese(step) || isVietnamese(vars.name);
  let speakKey = key;
  if (lang !== 'vi' && viVar) {
    if (key.startsWith('ask.')) speakKey = 'ask.generic';
    else if (key === 'step.done') speakKey = 'step.done.plain';
    else if (key === 'idle.still') speakKey = 'idle.quiet';
    else if (key.startsWith('watch.')) speakKey = 'watch.generic';
  }
  const speakEntry = table[speakKey] || entry;

  const showRaw = fill(entry.text, vars);
  let speakRaw = speakKey === key ? showRaw : fill(speakEntry.text, vars);
  if (lang !== 'vi' && isVietnamese(speakRaw)) speakRaw = '';
  // Every line goes through the 90-char speech cap (plan 3.3). An empty speak means "subtitle only".
  const show = sanitizeSpeech(showRaw, 90);
  const speak = sanitizeSpeech(speakRaw, 90);
  return { speak, show, key: speakKey, showKey: key, mood: entry.mood ?? null };
}
