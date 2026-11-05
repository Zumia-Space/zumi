'use strict';
// T-31 BYOK (owner decision 16-10): let users run Zumi on their OWN API key -- free-tier providers, and paid ones
// such as OpenCode (CORRECTION 17-10). One table, one place.
// Every provider below exposes an OpenAI-compatible /chat/completions with streaming, so chat-brain.js routes the
// existing client through { baseURL + key + model } and nothing else changes for OpenRouter users.
//   gemini     https://generativelanguage.googleapis.com/v1beta/openai/   (Google AI Studio key, AIza...)
//   groq       https://api.groq.com/openai/v1                             (Groq console key, gsk_...)
//   openrouter https://openrouter.ai/api/v1                               (today's base URL, sk-or-...)
//   opencode   https://opencode.ai/inference/openai/v1                     (OpenCode Console/Zen key, oc_sk_.../sk-...)
// Sources: the free-models report of 16-10 (verified 2026-10-16, incl. its ## Review corrections) and
//          the OpenCode free-tier report of 16-10 -- for OpenCode see its "## CORRECTION 17-10" (real calls):
//          the *-free ids are 403 outside the OpenCode app, so OpenCode is a PAID BYOK provider only (paid ids bill the
//          user's OpenCode Console credits; 402 "Insufficient account funds" at balance 0).
//   - Section 2a: OpenAI-compatible base URLs.
//   - Section 3a/3b: the exact "get your key" steps + key page links (kept in the guide below, all 3 UI languages).
//   - Section 3c: the minimal key-test calls (keyTest below).
//   - Section 4 (corrected): the per-role default models. Zumi's four roles map onto that table as
//       do = chat, plan & check = summarise, lookup = quick reflex.
//   - OpenCode (CORRECTION 17-10): all four roles send the paid `deepseek-v4.1-flash` id. The paid GLM twin is not
//     measured, so summarise uses the same verified paid id rather than a guess.
// DEFAULT_PROVIDER is the product default for a NEW user with no key: the owner's answer is still pending, so it is
// a single constant here (gemini for now). The owner answer changes ONE line.
//
// Owner-visible strings (labels, guide steps) are English/VI/ZH by design and live in this table (cross-checked by
// scripts/check-ui-lang.mjs, which allow-lists this one file with that reason). Never a key here, never a secret.
const MODEL_OR_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]{0,100}$/i; // OpenRouter/Groq shape (needs a "/")
const MODEL_PLAIN_ID = /^[a-z0-9][a-z0-9._:-]{0,100}$/i; // Gemini shape (no "/", e.g. gemini-3.5-flash-lite)
// Either shape (T-31 fix r item 3): the role picker accepts whatever the SELECTED provider sends, so a Gemini id
// (no "/") is a valid choice too. Still rejects a URL or junk (no "/" in the plain branch, no ":" in the id branch).
const MODEL_ID_ANY = /^(?:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]{0,100}|[a-z0-9][a-z0-9._:-]{0,100})$/i;
// CORRECTION 17-10: the OpenCode *-free ids are refused (403) outside the OpenCode app -- OpenCode is a PAID BYOK
// provider. A profile saved while it was listed as free may still carry one, so the paid id replaces it at load time
// (main.js migrateOpencodeModels) and it is the only id this table sends.
const OPENCODE_PAID_MODEL = 'deepseek-v4.1-flash';
const OPENCODE_RETIRED_IDS = new Set(['deepseek-v4.1-flash-free', 'glm-5.3-flash-free']);
const paidOpencodeModel = (id) => (OPENCODE_RETIRED_IDS.has(id) ? OPENCODE_PAID_MODEL : id);
// Rewrite the retired free ids in one stored role slot ({plan,do,check,lookup,off}): every other role entry and value
// is kept as-is, and the SAME object is returned when nothing changed (the caller only saves on a change). Pure.
function migrateOpencodeRoleModels(slot) {
  if (!slot || typeof slot !== 'object') return slot;
  let changed = false;
  const next = {};
  for (const [role, v] of Object.entries(slot)) {
    const model = v && typeof v === 'object' && typeof v.model === 'string' ? paidOpencodeModel(v.model) : null;
    if (model && model !== v.model) { next[role] = { ...v, model }; changed = true; } else next[role] = v;
  }
  return changed ? next : slot;
}

const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    sendsEffort: true, // requestBody's `reasoning_effort`; check:role-pop-layout pins it
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    chatPath: 'chat/completions',
    modelIdRe: MODEL_PLAIN_ID,
    keyName: 'gemini', // key file base: <userData>/gemini-key.bin (see reflex-jev.js createKeyStore)
    keyPrefix: 'AIza',
    // T-31 fix round 4: the shape must match the documented Google AI Studio key format -- `AIza` + 35 chars, 39
    // total (same regex as leda-tts.js KEY_SHAPE). The old loose `{16,220}` accepted any vendor's key, so a Groq /
    // OpenRouter / OpenCode key could be saved as Gemini when its key test was unreachable, then 401 in chat.
    keyShape: /^AIza[0-9A-Za-z_-]{35}$/,
    keyTest: { method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'header', header: 'x-goog-api-key' },
    keyPageURL: 'https://aistudio.google.com/apikey',
    notice: 'settings.trainNoticeFreeTier', // free tier: content may be used to improve Google's products (REPORT 3d)
    freeNote: 'settings.freeNoCard', // "Dùng miễn phí" list annotation: Gemini needs no card
    models: { plan: 'gemini-3.8-flash', do: 'gemini-3.5-flash-lite', check: 'gemini-3.8-flash', lookup: 'gemini-3.5-flash-lite' },
    guide: {
      en: [
        'Open the Google AI Studio key page and sign in with any Google account.',
        'Click "Create API key" and choose or create a project.',
        'Copy the key (it starts with AIza).',
        'Paste it into the field below and press Save.',
        'Press "Test key" — a green OK means chat is on.',
      ],
      vi: [
        'Mở trang khoá Google AI Studio và đăng nhập bằng tài khoản Google.',
        'Bấm "Create API key" rồi chọn hoặc tạo một project.',
        'Sao chép khoá (bắt đầu bằng AIza).',
        'Dán khoá vào ô bên dưới rồi bấm Lưu.',
        'Bấm "Thử khoá" — hiện OK xanh là chat đã bật.',
      ],
      zh: [
        '打开 Google AI Studio 密钥页面，用任意 Google 账号登录。',
        '点击 "Create API key"，选择或新建一个项目。',
        '复制密钥（以 AIza 开头）。',
        '粘贴到下面的输入框，然后点击保存。',
        '点击"测试密钥"——显示绿色 OK 即表示聊天已开启。',
      ],
    },
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    chatPath: 'chat/completions',
    modelIdRe: MODEL_OR_ID,
    keyName: 'groq',
    keyPrefix: 'gsk_',
    // T-31 fix round 4: the shape must start with the documented `gsk_` prefix. The old loose `{16,220}` accepted
    // any vendor's key, so a Gemini / OpenRouter / OpenCode key could be saved as Groq when its key test was
    // unreachable, then 401 in chat.
    keyShape: /^gsk_[A-Za-z0-9_-]{16,220}$/,
    keyTest: { method: 'GET', url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
    keyPageURL: 'https://console.groq.com/keys',
    notice: null, // Groq: "By default, Groq does not retain customer data" (training not stated, REPORT 2)
    models: { plan: 'openai/gpt-oss-120b', do: 'openai/gpt-oss-120b', check: 'openai/gpt-oss-120b', lookup: 'openai/gpt-oss-20b' },
    guide: {
      en: [
        'Open the Groq console keys page and sign in (Google, GitHub or email).',
        'Click "Create API Key", name it and copy it (it starts with gsk_).',
        'Paste it into the field below and press Save.',
        'Press "Test key" — a green OK means chat is on.',
      ],
      vi: [
        'Mở trang khoá Groq console và đăng nhập (Google, GitHub hoặc email).',
        'Bấm "Create API Key", đặt tên rồi sao chép khoá (bắt đầu bằng gsk_).',
        'Dán khoá vào ô bên dưới rồi bấm Lưu.',
        'Bấm "Thử khoá" — hiện OK xanh là chat đã bật.',
      ],
      zh: [
        '打开 Groq 控制台密钥页面并登录（Google、GitHub 或邮箱）。',
        '点击 "Create API Key"，命名后复制密钥（以 gsk_ 开头）。',
        '粘贴到下面的输入框，然后点击保存。',
        '点击"测试密钥"——显示绿色 OK 即表示聊天已开启。',
      ],
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    webSearch: true, // chat-brain requestBody sends the web plugin to this provider only; the roles card reads this (check:role-pop-layout pins the two)
    sendsEffort: true, // requestBody's `reasoning` field; same pin
    baseURL: 'https://openrouter.ai/api/v1',
    chatPath: 'chat/completions',
    modelIdRe: MODEL_OR_ID,
    keyName: 'jev', // the EXISTING store: <userData>/jev-key.bin (shared with the Jev reflex, unchanged)
    keyPrefix: 'sk-or-',
    keyShape: /^sk-or-[A-Za-z0-9_-]{20,200}$/,
    keyTest: { method: 'GET', url: 'https://openrouter.ai/api/v1/key', auth: 'bearer' },
    keyPageURL: 'https://openrouter.ai/keys',
    notice: null, // depends on the upstream provider (REPORT 2)
    freeLabel: 'OpenRouter free', // the "Dùng miễn phí" list shows this provider as its free router
    models: { plan: 'google/gemma-4-26b-a4b-it:free', do: 'google/gemma-4-31b-it:free', check: 'google/gemma-4-26b-a4b-it:free', lookup: 'openrouter/free' },
    guide: {
      en: [
        'Open the OpenRouter keys page and sign in.',
        'Click "Create key", name it and copy it (it starts with sk-or-).',
        'Paste it into the field below and press Save.',
        'Press "Test key" — a green OK means chat is on.',
      ],
      vi: [
        'Mở trang khoá OpenRouter và đăng nhập.',
        'Bấm "Create key", đặt tên rồi sao chép khoá (bắt đầu bằng sk-or-).',
        'Dán khoá vào ô bên dưới rồi bấm Lưu.',
        'Bấm "Thử khoá" — hiện OK xanh là chat đã bật.',
      ],
      zh: [
        '打开 OpenRouter 密钥页面并登录。',
        '点击 "Create key"，命名后复制密钥（以 sk-or- 开头）。',
        '粘贴到下面的输入框，然后点击保存。',
        '点击"测试密钥"——显示绿色 OK 即表示聊天已开启。',
      ],
    },
  },
  // OpenCode Console (formerly "Zen"): the same key for OpenAI-compatible, Anthropic and Google endpoints. Per-user key
  // ONLY -- one shared Zumi key to serve every user is forbidden by the ToS (opencode-free-1610 REPORT section 2g).
  // CORRECTION 17-10: OpenCode is a PAID BYOK provider (the user's own Console credits); it is NOT in the free list.
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    baseURL: 'https://opencode.ai/inference/openai/v1',
    chatPath: 'chat/completions',
    // The paid ids are bare (`deepseek-v4.1-flash`): the `opencode/<id>` form is the OpenCode config only, the
    // endpoint takes the id as-is (CORRECTION 17-10; same id shape as section 2b). No "/", so the plain id shape.
    modelIdRe: MODEL_PLAIN_ID,
    keyName: 'opencode', // key file base: <userData>/opencode-key.bin (per-user key, never shared)
    // No documented single prefix: Console keys are `oc_sk_...` (new) or the legacy `sk-...` (read 2026-10-16), so the
    // shape accepts either and the bad-format line names no prefix (settings.keyBadFormatNoPrefix).
    // T-31 fix round item 1: the shape must REJECT the other vendors' known prefixes (Gemini `AIza`, OpenRouter
    // `sk-or-`, Groq `gsk_`). Without this, a wrong-vendor key passes the shape, and if the key test is unreachable
    // (429/5xx/offline) a Gemini/OpenRouter/Groq key could be stored under OpenCode and then 401 in chat.
    keyPrefix: '',
    keyShape: /^(?!AIza|sk-or-|gsk_)[A-Za-z0-9_-]{16,240}$/,
    // The minimal validation call (opencode-free-1610 REPORT section 2b): GET the model list with the bearer. Measured
    // 17-10: it still returns 200 with zero balance, so it validates the key only -- never that chat is payable.
    keyTest: { method: 'GET', url: 'https://opencode.ai/inference/v1/models', auth: 'bearer' },
    keyPageURL: 'https://opencode.ai/console',
    notice: 'settings.opencodeNotice', // paid BYOK: Console credits (CORRECTION 17-10)
    // All four roles send the measured paid id (CORRECTION 17-10). The paid GLM twin is unverified, so no guess.
    models: { plan: OPENCODE_PAID_MODEL, do: OPENCODE_PAID_MODEL, check: OPENCODE_PAID_MODEL, lookup: OPENCODE_PAID_MODEL },
    guide: {
      en: [
        'Open the OpenCode console and sign in (create an account if you do not have one).',
        'This provider is paid: chat uses your OpenCode Console credits, so top them up first.',
        'Create an API key and copy it.',
        'Paste it into the field below and press Save.',
        'Press "Test key" to check the key — it only checks the key; chat also needs credit in your OpenCode Console.',
      ],
      vi: [
        'Mở OpenCode console và đăng nhập (tạo tài khoản nếu chưa có).',
        'Nhà cung cấp này là bản trả phí: chat trừ vào credit trong OpenCode Console của bạn, nên nạp credit trước.',
        'Tạo API key rồi sao chép.',
        'Dán khoá vào ô bên dưới rồi bấm Lưu.',
        'Bấm "Thử khoá" để kiểm tra khoá — chỉ kiểm tra khoá thôi; chat còn cần credit trong OpenCode Console của bạn.',
      ],
      zh: [
        '打开 OpenCode console 并登录（没有账号请先注册）。',
        '该服务商为付费服务：聊天会扣除你 OpenCode Console 中的额度，请先充值。',
        '创建 API key 并复制。',
        '粘贴到下面的输入框，然后点击保存。',
        '点击"测试密钥"检查密钥——它只检查密钥；聊天还需要你 OpenCode Console 中的额度。',
      ],
    },
  },
  // OpenCode Go (owner subscription, PLAN-ZUMI-SESSION section 0): the same model id through the Go gateway, so chat stops spending
  // Console credit. Owner build only (ownerOnly; the direct API is a grey area for anyone else, plan Q1/Q4).
  // keyTest is null on purpose: measured 02-11, GET /inference/go/v1/models answers 200 with NO key, so it proves nothing. Only a real
  // chat reply marks the key as working (brain-key.js noteChatResult). Own key file, so pasting a Go key never overwrites a Console key;
  // whether the two keys are the same one is not documented.
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    ownerOnly: true,
    clientIdentity: true, // Go asks clients for their own user agent and a stable x-opencode-session (createChatBrain fills them)
    baseURL: 'https://opencode.ai/inference/go/openai/v1',
    chatPath: 'chat/completions',
    modelIdRe: MODEL_PLAIN_ID,
    keyName: 'opencode-go', // key file base: <userData>/opencode-go-key.bin
    keyPrefix: '',
    keyShape: /^(?!AIza|sk-or-|gsk_)[A-Za-z0-9_-]{16,240}$/,
    keyTest: null,
    keyPageURL: 'https://opencode.ai/console',
    notice: 'settings.opencodeGoNotice',
    models: { plan: OPENCODE_PAID_MODEL, do: OPENCODE_PAID_MODEL, check: OPENCODE_PAID_MODEL, lookup: OPENCODE_PAID_MODEL },
    guide: {
      en: [
        'Open the OpenCode console and sign in to the account that has the Go subscription.',
        'Copy the API key from the Go page.',
        'Paste it into the field below and press Save.',
        'The key cannot be checked in advance: send one chat message. A reply means the key works.',
      ],
      vi: [
        'Mở OpenCode console và đăng nhập tài khoản có gói Go.',
        'Sao chép API key ở trang Go.',
        'Dán khoá vào ô bên dưới rồi bấm Lưu.',
        'Khoá này không kiểm trước được: gửi một câu chat, có trả lời là khoá dùng được.',
      ],
      zh: [
        '打开 OpenCode console，登录拥有 Go 订阅的账号。',
        '复制 Go 页面上的 API key。',
        '粘贴到下面的输入框，然后点击保存。',
        '此密钥无法提前检查：发送一条聊天消息，收到回复即表示密钥可用。',
      ],
    },
  },
};

const DEFAULT_PROVIDER = 'gemini';
const PROVIDER_IDS = ['gemini', 'groq', 'openrouter', 'opencode']; // "Tự nhập khoá": every provider, today's order + OpenCode (ownerOnly ones are added by selectableProvider's callers)
// "Dùng miễn phí" is the same table shown as a free-model list: Gemini ("no card"), Groq, OpenRouter free. OpenCode
// is PAID (CORRECTION 17-10: its *-free ids are 403 outside the OpenCode app), so it appears only in "Tự nhập khoá".
// The list only reorders/annotates the picker; it never changes the active provider or how a request is sent.
const FREE_PROVIDER_IDS = ['gemini', 'groq', 'openrouter'];
// The two-choice header in Settings > AI & Usage (owner 16-10). Stored in settings.json `aiMode`; a NEW user starts on
// "free", a pinned legacy (pre-BYOK) user keeps "byok" (main.js aiMode()).
const MODES = ['free', 'byok'];
const isMode = (m) => MODES.includes(m);
// The provider ids the picker shows for a mode (a copy-free reference; callers must not mutate it).
const providerIdsForMode = (mode) => (mode === 'byok' ? PROVIDER_IDS : FREE_PROVIDER_IDS);
// T-31 follow-up item 1: OpenCode is paid, so "Dùng miễn phí" must never list or select it. A profile left in free mode
// with OpenCode pinned (OpenCode WAS in the free list before CORRECTION 17-10) is therefore shown in "Tự nhập khoá",
// with OpenCode selected. Display only: the stored mode is left as-is (the existing migration handles the saved ids).
const pickerMode = (mode, providerId) => (providerId === 'opencode' || providerId === 'opencode-go' ? 'byok' : (isMode(mode) ? mode : 'free'));
// T-31 fix round item 3: resolve the two-choice mode as a PURE function (main.js calls it; check-byok behaviour-tests
// it). A stored valid choice wins; absent/invalid -> "free" for a new user, "byok" for a pinned legacy (pre-BYOK) user.
const resolveMode = (stored, legacy) => (isMode(stored) ? stored : (legacy ? 'byok' : 'free'));
// T-31 fix round item 3: does the paid, pre-BYOK legacy default still apply? ONLY in "Tự nhập khoá" (byok) mode.
// Choosing "Dùng miễn phí" is an explicit opt-in to the free table models, so free mode sends the table's free ids
// even for a legacy user -- keeping the picker label ("OpenRouter free") and the model actually sent in step.
const effectiveLegacyDefaults = (legacy, mode) => Boolean(legacy) && mode === 'byok';
// The picker option text for a provider in a mode: "free" names the free-model providers (freeLabel, plus a short
// note such as "no card needed"), "byok" lists every provider by its plain label. `t` localises the note key. Lives
// here (not in the renderer) so the label is unit-testable next to the table it reads (T-31 fix round item 3).
function optionLabel(id, mode, t) {
  const p = PROVIDERS[id];
  if (!p) return id;
  if (mode !== 'free') return p.label;
  const base = p.freeLabel || p.label;
  return p.freeNote ? `${base} — ${t(p.freeNote)}` : base;
}
const isProviderId = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, id);
/** May this build select this provider? An ownerOnly entry does not exist for a public build, stored or asked for. */
const selectableProvider = (id, ownerBuild) => isProviderId(id) && (!PROVIDERS[id].ownerOnly || ownerBuild === true);
const OWNER_ONLY_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].ownerOnly));
const providerOf = (id) => (isProviderId(id) ? PROVIDERS[id] : PROVIDERS[DEFAULT_PROVIDER]);
const providerLabel = (id) => providerOf(id).label;

// The active provider: the user's own choice wins; a user who never chose but already has an OpenRouter key stays on
// OpenRouter (migration-free -- existing users keep exactly what works today); everyone else gets DEFAULT_PROVIDER.
// T-31 fix r item 1: main.js calls this ONCE at startup and PERSISTS the answer (settings.json aiProvider); after
// that only an explicit user choice changes the provider, so clearing or re-pasting a key can never flip it silently.
function resolveProviderId(stored, hasOpenRouterKey) {
  if (isProviderId(stored)) return stored;
  if (hasOpenRouterKey) return 'openrouter';
  return DEFAULT_PROVIDER;
}

// Role choices are stored PER PROVIDER (T-31 fix r item 5). settings.json keeps the ACTIVE provider's slot in
// `roleModels` (the flat {plan,do,check,lookup,off} shape every reader already uses) and snapshots the OTHER
// providers in `roleModelsByProvider` keyed by provider id. Switching provider snapshots the live slot and restores
// the target's, so switching back brings that provider's choices back. Pure: takes/returns plain objects, no fs.
// A legacy flat `roleModels` (an existing user, no ByProvider map) IS the OpenRouter slot: the first switch away
// snapshots it under `openrouter`, which is the migration.
function switchRoleSlots(byProvider, fromId, liveSlot, toId) {
  const next = { ...(byProvider && typeof byProvider === 'object' ? byProvider : {}) };
  if (isProviderId(fromId)) next[fromId] = (liveSlot && typeof liveSlot === 'object') ? liveSlot : {};
  const target = isProviderId(toId) ? next[toId] : null;
  return { live: (target && typeof target === 'object') ? target : {}, byProvider: next };
}

// baseURL + path with exactly one slash between them, whatever the caller stored for the trailing slash.
function chatUrl(provider, path = provider.chatPath) {
  const base = String(provider.baseURL).replace(/\/+$/, '');
  return new URL(`${base}/${String(path).replace(/^\/+/, '')}`).href;
}

// Every one of these endpoints is OpenAI-compatible and takes the key as a bearer token (REPORT section 4 note).
function headersFor(provider, key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(provider.clientHeaders || {}) };
}

// The provider's own model list, built from the per-role defaults (Settings > Models by role). No network: the free
// providers do not share OpenRouter's /models shape, and the table already holds the ids we send.
function providerModels(provider) {
  const seen = new Set();
  const out = [];
  for (const role of ['plan', 'do', 'check', 'lookup']) {
    const id = provider.models[role];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id, reasoning: null, router: false });
  }
  return out;
}

module.exports = {
  DEFAULT_PROVIDER, PROVIDER_IDS, FREE_PROVIDER_IDS, MODES, PROVIDERS,
  isProviderId, selectableProvider, OWNER_ONLY_PROVIDER_IDS, providerOf, providerLabel, resolveProviderId, switchRoleSlots,
  isMode, providerIdsForMode, pickerMode, resolveMode, effectiveLegacyDefaults, optionLabel,
  chatUrl, headersFor, providerModels,
  MODEL_OR_ID, MODEL_PLAIN_ID, MODEL_ID_ANY,
  OPENCODE_PAID_MODEL, OPENCODE_RETIRED_IDS, paidOpencodeModel, migrateOpencodeRoleModels,
};
