// T-31 free LLM BYOK presets (owner approval 6259, attested on T-31-TAURI step free-llm-pick; BRIEF-free-llm FL-1).
//
// TAURI ONLY. src/main/** is the frozen Electron tree; nothing here edits it. The frozen table in
// src/main/providers.js is a plain object, and every frozen consumer (brain-key.js, chat-brain.js, main.js) resolves a
// provider through `isProviderId(id) ? PROVIDERS[id] : ...`, i.e. an own property of that object. The Tauri build
// therefore EXTENDS that same table at load: the four existing entries stay byte-identical, and Cloudflare Workers AI
// (default preset #4) plus Mistral (advanced only) are added here. Electron never imports this file, so its list is
// unchanged.
//
// Source of truth for the preset set and its order: the free-LLM BYOK research notes, section 3, as
// corrected by "## Opus review (22-10)" (the corrections win), plus its Z.ai verdict: DO NOT ADD Z.ai.
//   default order: Gemini, Groq, OpenRouter :free, Cloudflare    advanced: Mistral
// No key is bundled, no key-shaped string lives here, and no provider limit is hard-coded: each preset carries the
// official limits page so the UI can say "Check your provider's limits page" instead of showing numbers that rot.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PROVIDERS } = require('../../src/main/providers.js');

// Cloudflare Workers AI's OpenAI-compatible base URL (RESEARCH section 3): the account id is a PATH segment, so it is
// validated as exactly 32 hex characters BEFORE substitution. A value like `../` can therefore never reach the URL.
export const CLOUDFLARE_BASE_URL_TEMPLATE = 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1';
export const CLOUDFLARE_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

/** True only for 32 hex characters (case-insensitive), the Cloudflare Account ID shape. */
export function validateCloudflareAccountId(value) {
  return typeof value === 'string' && CLOUDFLARE_ACCOUNT_ID_RE.test(value);
}

/** The preset's resolved base URL. Throws on anything that is not a 32-hex account id (never interpolates it). */
export function cloudflareBaseUrl(accountId) {
  if (!validateCloudflareAccountId(accountId)) throw new Error('bad_cloudflare_account_id');
  return CLOUDFLARE_BASE_URL_TEMPLATE.replace('{ACCOUNT_ID}', accountId);
}

const CLOUDFLARE_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MISTRAL_MODEL = 'mistral-small-latest';

// The two providers the Tauri build adds. Field shape matches src/main/providers.js exactly, so the frozen
// brain-key.js / chat-brain.js / api-core.mjs read them with no special case. Key-page links and the Cloudflare model
// id come from RESEARCH section 3; both token shapes are the providers' documented formats (no key is shipped).
const CLOUDFLARE_PROVIDER = {
  id: 'cloudflare',
  label: 'Cloudflare Workers AI',
  baseURL: CLOUDFLARE_BASE_URL_TEMPLATE,
  chatPath: 'chat/completions',
  modelIdRe: /^@cf\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]{0,100}$/i,
  keyName: 'cloudflare',
  keyPrefix: '',
  keyShape: /^[A-Za-z0-9_-]{40}$/, // dashboard API tokens are 40 characters
  // Minimal free validation call: the token-verify endpoint (no inference, no tokens spent).
  keyTest: { method: 'GET', url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', auth: 'bearer' },
  keyPageURL: 'https://dash.cloudflare.com/profile/api-tokens',
  notice: null, // Cloudflare states it does not train on Customer Content (RESEARCH)
  models: { plan: CLOUDFLARE_MODEL, do: CLOUDFLARE_MODEL, check: CLOUDFLARE_MODEL, lookup: CLOUDFLARE_MODEL },
  guide: {
    en: [
      'Sign up at dash.cloudflare.com (the free plan is enough).',
      'Copy your Account ID from the dashboard.',
      'Create an API token with the Workers AI permission.',
      'Paste the Account ID and the token below, then press Save.',
      'Press "Test key" — a green OK means the token works.',
    ],
    vi: [
      'Đăng ký tại dash.cloudflare.com (gói miễn phí là đủ).',
      'Sao chép Account ID trong dashboard.',
      'Tạo API token có quyền Workers AI.',
      'Dán Account ID và token vào ô bên dưới rồi bấm Lưu.',
      'Bấm "Thử khoá" — hiện OK xanh là token dùng được.',
    ],
    zh: [
      '在 dash.cloudflare.com 注册（免费套餐即可）。',
      '在控制台复制你的 Account ID。',
      '创建一个拥有 Workers AI 权限的 API token。',
      '在下面填入 Account ID 和 token，然后点击保存。',
      '点击"测试密钥"——显示绿色 OK 即表示 token 可用。',
    ],
  },
};

// ADVANCED only, never a default: the Opus review found Mistral's API terms are limited to business customers, so the
// app must not present it as a free default for everyone.
const MISTRAL_PROVIDER = {
  id: 'mistral',
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  chatPath: 'chat/completions',
  modelIdRe: /^[a-z0-9][a-z0-9._:-]{0,100}$/i,
  keyName: 'mistral',
  keyPrefix: '',
  keyShape: /^[A-Za-z0-9]{32}$/, // Studio API keys are 32 alphanumeric characters
  keyTest: { method: 'GET', url: 'https://api.mistral.ai/v1/models', auth: 'bearer' },
  keyPageURL: 'https://console.mistral.ai/api-keys',
  // Free mode may train on inputs/outputs; opt-out lives in Mistral Studio (RESEARCH, Opus review).
  notice: 'settings.mistralFreeTrainingNotice',
  models: { plan: MISTRAL_MODEL, do: MISTRAL_MODEL, check: MISTRAL_MODEL, lookup: MISTRAL_MODEL },
  guide: {
    en: [
      'Open console.mistral.ai and sign up.',
      'Stay on the free mode (no card needed).',
      'Create an API key and copy it (it is shown once).',
      'Paste it below and press Save.',
      'Optional: opt out of training under Privacy in Mistral Studio.',
    ],
    vi: [
      'Mở console.mistral.ai và đăng ký.',
      'Giữ ở chế độ miễn phí (không cần thẻ).',
      'Tạo API key rồi sao chép (chỉ hiện một lần).',
      'Dán khoá vào ô bên dưới rồi bấm Lưu.',
      'Tuỳ chọn: tắt dùng dữ liệu để huấn luyện trong Privacy của Mistral Studio.',
    ],
    zh: [
      '打开 console.mistral.ai 并注册。',
      '保持免费模式（无需银行卡）。',
      '创建 API key 并复制（只显示一次）。',
      '粘贴到下面的输入框，然后点击保存。',
      '可选：在 Mistral Studio 的 Privacy 中关闭训练数据使用。',
    ],
  },
};

export const TAURI_EXTRA_PROVIDERS = Object.freeze({
  cloudflare: CLOUDFLARE_PROVIDER,
  mistral: MISTRAL_PROVIDER,
});

// The preset metadata the renderer needs (FL-2). No limit numbers: only the official page. `requiresAccountId` is the
// one preset that needs an extra field; `requiresAge18` / `notices` are consumed by FL-2's confirm + notices.
export const TAURI_FREE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'gemini', advanced: false, defaultModel: 'gemini-3.8-flash',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits', limitsNoteKey: 'settings.presetCheckLimits',
    requiresAccountId: false, requiresAge18: true, notices: ['developerService', 'geminiEea', 'geminiFreeTier'],
  }),
  Object.freeze({
    id: 'groq', advanced: false, defaultModel: 'openai/gpt-oss-120b',
    limitsUrl: 'https://console.groq.com/docs/rate-limits', limitsNoteKey: 'settings.presetCheckLimits',
    requiresAccountId: false, requiresAge18: true, notices: ['developerService'],
  }),
  Object.freeze({
    id: 'openrouter', advanced: false, defaultModel: 'openrouter/free',
    limitsUrl: 'https://openrouter.ai/docs/api-reference/limits', limitsNoteKey: 'settings.presetCheckLimits',
    requiresAccountId: false, requiresAge18: true, notices: ['developerService'],
  }),
  Object.freeze({
    id: 'cloudflare', advanced: false, defaultModel: CLOUDFLARE_MODEL,
    limitsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/', limitsNoteKey: 'settings.presetCheckLimits',
    requiresAccountId: true, requiresAge18: false, notices: ['developerService'],
  }),
]);

export const TAURI_ADVANCED_PRESETS = Object.freeze([
  Object.freeze({
    id: 'mistral', advanced: true, defaultModel: MISTRAL_MODEL,
    limitsUrl: 'https://docs.mistral.ai/admin/billing-usage/usage-limits', limitsNoteKey: 'settings.presetCheckLimits',
    requiresAccountId: false, requiresAge18: false, notices: ['developerService', 'mistralTraining'],
  }),
]);

/** The four default presets, in the order the brief fixes. */
export const TAURI_PRESET_ORDER = Object.freeze(TAURI_FREE_PRESETS.map((p) => p.id));
/** Advanced entries, shown only when asked for. */
export const TAURI_ADVANCED_ORDER = Object.freeze(TAURI_ADVANCED_PRESETS.map((p) => p.id));

// Fixed ids for the official limits pages, opened through the existing allow-listed guide mechanism
// (`talk.openGuide` -> the Rust host -> `__host.voiceGuideVerdict` -> voice.guideVerdict). The page only ever names
// one of these ids; the URL always comes from this table, never from the renderer.
export const PRESET_LIMIT_GUIDES = Object.freeze(Object.fromEntries(
  [...TAURI_FREE_PRESETS, ...TAURI_ADVANCED_PRESETS].map((p) => [`preset-limits-${p.id}`, p.limitsUrl]),
));
export const presetLimitGuideId = (id) => `preset-limits-${id}`;

/**
 * The read-only answer behind `ai.presetList`. Descriptors only: ids, order, flags, the official limits URL, labels and
 * the key-page guide steps. Never a key, a key shape or a token. The renderer cannot import this module (node:module),
 * so this is how the Tauri picker gets the FULL preset list and the labels the frozen renderer table does not carry.
 */
export function presetList() {
  const table = tauriProviders();
  const withUi = (p) => ({ ...p, label: table[p.id].label, notice: table[p.id].notice, guide: table[p.id].guide });
  return { free: TAURI_FREE_PRESETS.map(withUi), advanced: TAURI_ADVANCED_PRESETS.map(withUi) };
}

/**
 * Add the Tauri-only providers to the frozen table, in place and idempotently. Every frozen consumer resolves ids
 * through that object, so no frozen file has to learn about a second list. Returns the table.
 */
export function registerTauriPresets(table = PROVIDERS) {
  for (const [id, provider] of Object.entries(TAURI_EXTRA_PROVIDERS)) {
    if (!Object.prototype.hasOwnProperty.call(table, id)) table[id] = provider;
  }
  return table;
}

/** The registered table (registers first, so a caller never sees a partial list). */
export function tauriProviders() {
  return registerTauriPresets(PROVIDERS);
}

/**
 * The active provider descriptor, with Cloudflare's Account ID substituted in. The Account ID comes from settings and
 * is validated before it reaches the URL; when absent/invalid the descriptor carries `configError` and NO base URL, so
 * a request can never be assembled with an unvalidated path segment.
 */
export function resolveTauriProvider(id, settings = {}) {
  const provider = PROVIDERS[id];
  if (!provider) return null;
  if (provider.id !== 'cloudflare') return provider;
  const accountId = settings && settings.cloudflareAccountId;
  if (!validateCloudflareAccountId(accountId)) {
    return { ...provider, baseURL: null, configError: 'cloudflare_account_id' };
  }
  return { ...provider, baseURL: cloudflareBaseUrl(accountId) };
}
