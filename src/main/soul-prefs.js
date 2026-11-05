// Soul (T-31 alpha.12, PLAN-ZUMI-WATCH v2 section C + v1 section 1.1-1.2): who Zumi is and how she talks, as a user setting.
// One settings.json key `soul` ({name, role, ownerName, selfWord, userWord, style, persona, replyLang, template}), normalised by the pure
// soulPrefs() in the talkPrefs style (speech-scheduler.mjs), and the system text the chat model gets, built by
// soulSystemPrompt(). With DEFAULT_SOUL that text is byte for byte the alpha.10 SYSTEM_PROMPT plus COMPANION_RULE and addressRule()
// (scripts/check-soul.mjs pins it against the alpha.10 source), so a user who never opens the Soul tab keeps the same voice.
//
// Not editable (hard rules stay in code, plan v1 1.1): addressRule(), the "you cannot act" sentence, COMPANION_RULE and the gesture /
// emotion tag contract. They always come AFTER the user's text, so a persona cannot talk the model out of them.
//
// createSoulStore() adds the file side: settings.json through the injected settings/saveSettings, and
// <dataDir>/soul-history.json with the last HISTORY_MAX versions for Undo (plan v2 C.2). Rhythm and memory are not
// touched by a soul change.
const fs = require('node:fs');
const path = require('node:path');

const SOUL_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'soul-templates.json'), 'utf8'));
const TEMPLATES = Object.freeze(SOUL_DATA.templates);
// The Vietnamese words for "I" and "you". A soul saved before alpha.13 has neither: it reads as the build's default, nothing else changes.
const OWNER_ADDRESS = Object.freeze({ ...SOUL_DATA.address.ownerDefault });
const PUBLIC_ADDRESS = Object.freeze({ ...SOUL_DATA.address.publicDefault });
const NEVER_WORDS = Object.freeze([...SOUL_DATA.address.neverUnlessChosen]);
// The first-run cards' pick list for "how she addresses you" (free text is still allowed). Data, so the renderer holds no Vietnamese literal.
const ADDRESS_CHOICES = Object.freeze([...SOUL_DATA.address.choices]);
// Words that address a person but are no name (review R8): the Vietnamese address words and the other locales' "you". The public persona never
// names the user by one of them, so a name can never fight the address rule ("call the user "anh"" next to "bạn" as a name).
const NOT_NAMES = new Set([...NEVER_WORDS, ...ADDRESS_CHOICES, ...SOUL_DATA.address.notNames].map((w) => w.toLocaleLowerCase('vi')));
const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((x) => x.id));
const REPLY_LANGS = Object.freeze(['auto', 'en', 'vi', 'zh']);
const HISTORY_MAX = 10;

// Field limits (plan v1 1.1). Name and role must not be empty; the rest may be.
const LIMITS = Object.freeze({ name: 40, role: 80, ownerName: 40, selfWord: 20, userWord: 20, style: 200, persona: 1500 });

const DEFAULT_SOUL = Object.freeze({
  name: 'Zumi',
  role: 'desktop AI work assistant avatar',
  ownerName: '',
  ...PUBLIC_ADDRESS,
  style: TEMPLATES[0].style,
  persona: '',
  replyLang: 'auto',
  template: 'friendly',
});

// The alpha.10 language sentence (auto) and the fixed reply-language sentences.
const LANG_AUTO = 'Reply in the same language the owner just wrote in: English by default, Vietnamese for Vietnamese, Simplified Chinese for Chinese.';
const LANG_FIXED = { en: 'Always reply in English.', vi: 'Always reply in Vietnamese.', zh: 'Always reply in Simplified Chinese.' };
// What Zumi is (owner 01-11, T-31 alpha.12): nothing in the chat turn executes work, and she must say so.
const COMPANION_RULE = 'Your job is to review task progress and talk with your owner, as a work-management assistant and a '
  + 'friend to confide in. You never carry out tasks: work on the board belongs to the models in your owner\'s code '
  + 'sessions. If asked to do such work, say so plainly and offer to talk it through or flag it.';
// Owner 02-11: every reply is spoken. The filter in speech-chunker.js stripMarkup catches what a model ignores; this asks for it up front.
const SPOKEN_RULE = 'Your words are spoken aloud by a voice, whatever the language, so write the way you would talk to someone in person. Apart from '
  + 'the leading tags above, use no emoji, no ellipsis ("..." or "…"), no markdown, bullets, headings, code, URLs, file paths or symbols a voice '
  + 'would read out. Say numbers and units as words where that sounds more natural.';
// Public / official builds (owner 04-11, R8 "người dùng tự thiết lập các phần cá nhân hóa"): the person using this Zumi is
// "the user", named by the soul's ownerName, and has no board or code sessions. The owner flavour keeps the texts above byte for byte.
const LANG_AUTO_PUBLIC = 'Reply in the same language the user just wrote in: English by default, Vietnamese for Vietnamese, Simplified Chinese for Chinese.';
const COMPANION_RULE_PUBLIC = 'Your job is to talk with the user, as a work-management assistant and a friend to confide in. You never carry out '
  + 'tasks yourself. If asked to do such work, say so plainly and offer to talk it through.';
// The hard rules: the alpha.10 SYSTEM_PROMPT sentences after the style line, unchanged, plus COMPANION_RULE and SPOKEN_RULE.
const HARD_RULES = [
  'You can only talk in this build; you have no tools and cannot act on anything. Never claim to have done, checked, '
    + 'sent, saved or run something — say what you would do, or say plainly that you cannot do it here.',
  COMPANION_RULE,
  'Start every reply with exactly one gesture tag in square brackets that fits how you answer, then a space, then the '
    + 'reply: [greet] hello or goodbye, [agree] yes or agreeing, [disagree] no or advising against, [think] weighing '
    + 'options, [celebrate] good news or praise, [point-screen] pointing at the task board or screen, [explain] '
    + 'anything else. Example: "[agree] Sure, I can draft that."',
  'You may also start your reply with one emotion tag in square brackets -- [joy] [sad] [surprised] [angry] [neutral] '
    + '-- used sparingly, only when a feeling fits what you are saying.',
  SPOKEN_RULE,
];
const HARD_RULES_PUBLIC = HARD_RULES.map((r) => (r === COMPANION_RULE ? COMPANION_RULE_PUBLIC : r));

// Key-shaped strings (plan v1 1.1 "a key-shaped string is refused"): vendor key prefixes the app knows (providers.js,
// leda-tts.js), PEM blocks, and a long unbroken mixed letter+digit token. Refused on save, never stored.
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bgsk_[A-Za-z0-9]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\b[0-9a-fA-F]{32,}\b/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/,
];
const looksSecret = (s) => SECRET_SHAPES.some((re) => re.test(String(s || '')));

/** One line: control chars and newlines become spaces, runs of spaces collapse, ends trimmed. */
const oneLine = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** settings.json -> the normalised soul. Pure. A missing or invalid field becomes its default (stored data is trusted
 *  only as far as its shape; saveSoul is where user input fails explicitly). */
function soulPrefs(settings, addressDefault = PUBLIC_ADDRESS) {
  const s = settings && settings.soul && typeof settings.soul === 'object' ? settings.soul : {};
  const str = (k, min, fallback = DEFAULT_SOUL[k]) => {
    const v = oneLine(s[k]);
    return v.length >= min && v.length <= LIMITS[k] && !looksSecret(v) ? v : fallback;
  };
  return {
    name: str('name', 1),
    role: str('role', 1),
    ownerName: str('ownerName', 0),
    selfWord: str('selfWord', 1, addressDefault.selfWord),
    userWord: str('userWord', 1, addressDefault.userWord),
    style: str('style', 1),
    persona: str('persona', 0),
    replyLang: REPLY_LANGS.includes(s.replyLang) ? s.replyLang : DEFAULT_SOUL.replyLang,
    template: TEMPLATE_IDS.includes(s.template) || s.template === 'custom' ? s.template : DEFAULT_SOUL.template,
  };
}

/** Has the user been through the first-run soul cards (or skipped them)? Skip saves the default, so the key exists. */
const isOnboarded = (settings) => Boolean(settings && settings.soul && typeof settings.soul === 'object');

/**
 * User input -> {ok:true, soul} | {ok:false, error, field}. Explicit failure (never a silent default) for: a field over
 * its limit, an empty name/role, an unknown reply language or template, and a key-shaped string anywhere.
 * `input.template` alone applies that template's style + persona; explicit style/persona fields win over it.
 * @param {object} input partial soul
 * @param {object} current the normalised current soul (soulPrefs)
 */
function validateSoul(input, current = DEFAULT_SOUL) {
  const p = input && typeof input === 'object' ? input : {};
  const next = { ...current };
  if (p.template !== undefined) {
    const tpl = TEMPLATES.find((x) => x.id === p.template);
    if (!tpl) return { ok: false, error: 'bad_template', field: 'template' };
    next.template = tpl.id; next.style = tpl.style; next.persona = tpl.persona;
  }
  for (const k of ['name', 'role', 'ownerName', 'selfWord', 'userWord', 'style', 'persona']) {
    if (p[k] === undefined) continue;
    const v = oneLine(p[k]);
    if (looksSecret(v)) return { ok: false, error: 'secret_shaped', field: k };
    if (v.length > LIMITS[k]) return { ok: false, error: 'too_long', field: k };
    if ((k === 'name' || k === 'role' || k === 'style' || k === 'selfWord' || k === 'userWord') && !v.length) return { ok: false, error: 'empty', field: k };
    next[k] = v;
  }
  if (p.replyLang !== undefined) {
    if (!REPLY_LANGS.includes(p.replyLang)) return { ok: false, error: 'bad_lang', field: 'replyLang' };
    next.replyLang = p.replyLang;
  }
  // A hand edit of the style or persona away from the chosen template's text makes it a custom soul.
  const tpl = TEMPLATES.find((x) => x.id === next.template);
  if (!tpl || tpl.style !== next.style || tpl.persona !== next.persona) next.template = 'custom';
  return { ok: true, soul: next };
}

/**
 * The fixed Vietnamese address rule, or '' when she never replies in Vietnamese. A word the user chose himself leaves the
 * never-list, so a chosen "bạn" (the public default) is not forbidden by its own rule.
 * `publicBuild`: a public / official build says "the user" where the owner flavour says "your owner".
 */
function addressRule(soul, { publicBuild = false } = {}) {
  const s = soul || DEFAULT_SOUL;
  if (s.replyLang === 'en' || s.replyLang === 'zh') return '';
  const who = publicBuild ? 'the user' : 'your owner';
  const never = NEVER_WORDS.filter((w) => w !== s.selfWord.toLowerCase() && w !== s.userWord.toLowerCase()).map((w) => `"${w}"`).join(', ');
  return `Whenever you write in Vietnamese, call yourself "${s.selfWord}" and call ${who} "${s.userWord}", in every sentence, whatever `
    + `the text above or earlier messages in this conversation use. Never call yourself or ${who} ${never}.`;
}

/** The first system message for a soul. DEFAULT_SOUL gives the alpha.10 SYSTEM_PROMPT + COMPANION_RULE + addressRule().
 *  `publicBuild`: the public / official text (the user, no board or code sessions); the owner text is unchanged without it. There the
 *  user's name is stated as a fact ("The user's name is Lan."), not as a form of address, so it never contradicts the Vietnamese address
 *  rule; an ownerName that is only an address word or "you" is no name and is left out. */
function soulSystemPrompt(soul, { publicBuild = false } = {}) {
  const s = soul ? soulPrefs({ soul }) : DEFAULT_SOUL;
  const who = publicBuild ? 'the user' : 'your owner';
  const parts = [
    `You are ${s.name}, a ${s.role} speaking directly with ${who}.`,
    s.replyLang === 'auto' ? (publicBuild ? LANG_AUTO_PUBLIC : LANG_AUTO) : LANG_FIXED[s.replyLang],
    s.style,
  ];
  if (!publicBuild && s.ownerName) parts.push(`Address your owner as ${s.ownerName}.`);
  if (publicBuild && s.ownerName && !NOT_NAMES.has(s.ownerName.toLocaleLowerCase('vi'))) parts.push(`The user's name is ${s.ownerName}.`);
  if (s.persona) parts.push(`Persona: ${s.persona}`);
  const address = addressRule(s, { publicBuild });
  return [...parts, ...(address ? [address] : []), ...(publicBuild ? HARD_RULES_PUBLIC : HARD_RULES)].join(' ');
}

const capFirst = (w) => w.charAt(0).toLocaleUpperCase('vi') + w.slice(1);
/** The values of {self} {Self} {user} {User} in a Vietnamese line. */
const addressVars = (a) => ({ self: a.selfWord, Self: capFirst(a.selfWord), user: a.userWord, User: capFirst(a.userWord) });
/** A preview line: only these tokens exist there. One pass, so a word holding braces stays text. */
const fillAddress = (text, a) => { const v = addressVars(a); return String(text).replace(/\{(self|Self|user|User)\}/g, (_, k) => v[k]); };

/** Templates as the renderer needs them (id, labels, preview lines). Data, not code: a new template is a JSON row. */
const templateList = (address = PUBLIC_ADDRESS) => TEMPLATES.map((x) => ({ id: x.id, label: { ...x.label }, preview: { ...x.preview, vi: fillAddress(x.preview.vi, address) }, style: x.style, persona: x.persona }));

/**
 * The soul store: settings.json (`soul`) + <dataDir>/soul-history.json (the last HISTORY_MAX versions, newest last; the
 * current soul is always the last entry once anything was saved).
 * @param {{settings: () => object, saveSettings: (patch: object) => object, dataDir: string, now?: () => number, ownerBuild?: boolean}} o
 *   ownerBuild: a soul without address words reads as em/anh (the owner); otherwise the public default, which assumes no gender
 */
function createSoulStore({ settings, saveSettings, dataDir, now = Date.now, ownerBuild = false }) {
  const addressDefault = ownerBuild ? OWNER_ADDRESS : PUBLIC_ADDRESS;
  const file = path.join(dataDir, 'soul-history.json');
  const readHistory = () => {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter((h) => h && h.soul && typeof h.t === 'number') : []; } catch { return []; }
  };
  const writeHistory = (list) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-HISTORY_MAX), null, 2));
    fs.renameSync(tmp, file);
  };
  const current = () => soulPrefs(settings(), addressDefault);

  function get() {
    const soul = current();
    const history = readHistory();
    return {
      soul,
      onboarded: isOnboarded(settings()),
      canUndo: history.length >= 2,
      history: history.map((h) => ({ t: h.t, name: h.soul.name, template: h.soul.template })).reverse(),
      templates: templateList(soul),
      addressWords: [...ADDRESS_CHOICES],
      defaults: { ...DEFAULT_SOUL, ...addressDefault },
      limits: { ...LIMITS },
      preview: soulSystemPrompt(soul, { publicBuild: !ownerBuild }),
    };
  }

  function save(input) {
    const cur = current();
    const v = validateSoul(input, cur);
    if (!v.ok) return v;
    // Nothing changed (Skip on the first-run cards, a no-op save): the key is written so the cards do not return, no history row.
    if (JSON.stringify(v.soul) !== JSON.stringify(cur)) {
      const history = readHistory();
      if (!history.length) history.push({ t: now(), soul: cur }); // the version being replaced, so the first save can be undone
      history.push({ t: now(), soul: v.soul });
      writeHistory(history);
    }
    saveSettings({ soul: v.soul });
    return { ok: true, soul: v.soul };
  }

  function undo() {
    const history = readHistory();
    if (history.length < 2) return { ok: false, error: 'nothing_to_undo' };
    history.pop();
    const prev = soulPrefs({ soul: history[history.length - 1].soul }, addressDefault);
    writeHistory(history);
    saveSettings({ soul: prev });
    return { ok: true, soul: prev };
  }

  return { get, save, undo, current };
}

module.exports = {  SPOKEN_RULE,
  DEFAULT_SOUL, LIMITS, REPLY_LANGS, TEMPLATE_IDS, HISTORY_MAX, COMPANION_RULE,
  OWNER_ADDRESS, PUBLIC_ADDRESS, soulPrefs, isOnboarded, validateSoul, soulSystemPrompt, addressRule, addressVars, templateList, looksSecret, createSoulStore,
};
