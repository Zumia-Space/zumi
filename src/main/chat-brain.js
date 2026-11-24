'use strict';
// BYO chat brain: the user's own OpenRouter
// key, called directly from main, bypassing cloud.js's staging transport entirely. Reuses reflex-jev.js's already-
// imported key: same account, same jev-key.bin, same one-time jev-key.import flow — this module never writes or
// deletes an import file itself, it only reads the bin reflex-jev.js already decrypted into. cloud.js is untouched;
// when this module has no key, talk stays exactly as it was (cloud.js, or off).
// Deliberately NOT the full BYO-providers design (the providers plan): one hardcoded model, one
// allowlisted origin, plain-text reply only (no JSON schema, no gesture-compose — Jev's reflex already gives an
// instant reaction; analysis stays null and every reply carries `explains: false`, so the renderer never shows its
// "could not explain this turn" line for a turn that never asked the model for an explanation).
// Speech gesture (T-31 QC-cuoi fix a, 09-10): the reply carries ONE speech intent, in the SAME {intent, brief,
// energy, deixis} shape cloud.js's turn contract and the demo fixtures use, so the renderer's TalkDirector maps it
// to a gesture exactly as it does on the fixture path (cache > library > built-in, one gesture at speech start).
// Before this, every live turn returned intent 'none' and the 13 library gestures never played with real chat.
// The model is asked to open its reply with a one-word tag ("[agree] Sure..."); the tag is stripped before the
// text reaches the UI/TTS. No tag (or an unknown one) -> a deterministic rule over the reply text picks the intent,
// so a model that ignores the instruction still never leaves a reply motionless.
// Streaming (T-31 voice round 6, 09-10): round 5 measured first audio p50 3.4 s / p95 11.0 s, and the voice was under
// 0.9 s of it -- the rest was waiting for the WHOLE non-streamed reply. turnStream() streams the completion (SSE),
// strips the gesture tag on the fly, and hands the renderer the reply as soon as the first speakable clause exists
// (same 24-char first-chunk rule Kokoro uses, speech-chunker.js); the rest of the text keeps flowing to main.js, which
// feeds it into Kokoro (kokoro-tts.js speakLive) and the reply bubble. The gesture/intent is still decided ONCE, at
// that first clause, so it still fires once at speech start (1e1977f behaviour). A stream that fails before its first
// clause falls back to one non-streamed call (logged); one that breaks after it keeps what was already said (logged).
// Latency hygiene that never changes the owner's model (BYOK: the model is the owner's choice, opts.model):
//  - Provider pin: OpenRouter load-balances every call across providers (round 5: StreamLake / OpenInference / Baidu,
//    1.5-7.0 s for the same kind of line). After a call whose first token came within PIN_MAX_FIRST_TOKEN_MS, the
//    next calls ask for that same provider first (`provider: { order: [name], allow_fallbacks: true }` -- OpenRouter's
//    documented routing field; fallbacks stay on, so a down provider never fails the chat). A slow or failed call
//    drops the pin and lets OpenRouter route freely again. Per app session, in memory only.
//  - Reasoning off: OpenRouter exposes `reasoning: { enabled: false }` per request (measured 09-10 on
//    deepseek-v4-flash: 0 reasoning tokens with it, 50-137 without; `effort:'low', exclude:true` still spent 137 hidden
//    tokens, so "exclude" is not enough). Non-reasoning models ignore it. If a model refuses it (HTTP 400 naming
//    reasoning: mandatory-reasoning endpoints), the call is retried once without it and the session stops sending it.
//  Both are logged on every turn line (provider=, pin=, reasoning=, reasoningTokens=).
// Models by role (T-31 board-roles, owner 09-10): the chat reply is the "Do" role. opts.getRoute(defaultModel) returns
// the owner's Do choice {model, effort} (role-models.js; settings.json `roleModels`), read at the start of every turn,
// so a change in Settings applies to the next turn without a restart. effort 'off' keeps the reasoning-off hygiene
// above; 'low'|'medium'|'high' sends OpenRouter's `reasoning: { effort }` instead. A model switch drops the provider
// pin and any reasoning refusal remembered for the previous model.
// Plan / Check / Look up (T-31 zumi-roles, ASTRA-SPEC.md + CoS decisions 10-10): opts.getRoles(defaultModel, models)
// returns the four roles {model, effort, on} (role-models.js resolveRoles), read per turn like getRoute. Budget per
// turn: the reply + at most one Plan call + at most one Check call; Look up is the reply's OWN call on the Look up
// model with OpenRouter's web plugin (0 extra calls). role-triggers.js decides when each joins; a simple turn stays
// exactly one POST. Every role call is one usage line with its own `kind` (plan|check|lookup), success or failure.
//  - Plan: before the reply, one short non-streamed outline call (8 s); the outline goes to the reply as a hidden
//    system message and to the renderer (head.planned/outline: the "Planned" chip). Fails/times out -> no outline.
//  - Look up: the reply streams from the Look up model with `plugins:[{id:'web'}]`, no provider pin (the pin belongs
//    to the Do model); url_citation annotations become `sources` on live.final. Fails before the first clause ->
//    the plain Do model, non-streamed, no web search (a refused key, 401/402/403: no second call, one error).
//  - Check: AFTER the reply's stream ended (speech already started, never delayed), one non-streamed review call
//    (10 s): "OK" or one correction sentence -> live.checked. Fails -> nothing shown. Never spoken.
const fs = require('node:fs');
const path = require('node:path');
const { createKeyStore, scrub } = require('./reflex-jev.js');
const { createStreamChunker } = require('./speech-chunker.js');
const { wantsPlan, wantsCheck, wantsLookup } = require('./role-triggers.js');
// T-31 BYOK: the provider table. chat-brain stays OpenAI-compatible and merely routes through { baseURL + key + model }.
const crypto = require('node:crypto');
const { PROVIDERS, isProviderId, chatUrl, headersFor, providerModels } = require('./providers.js');

// Same list as cloud.js's INTENTS minus 'none' (a real reply always gets a gesture) and renderer talk/intents.js.
const SPEECH_INTENTS = ['greet', 'agree', 'disagree', 'point-screen', 'think', 'celebrate', 'explain'];
// Emotion tags (T-31 0.2.3 B1 item 2): a small inline-tag set the model may lead its reply with, in addition to the
// gesture tag, so the face can change with the reply. Each maps to a VRM expression preset the renderer ships
// (src/renderer/reflex/schema.js EXPRESSIONS; 'relaxed' is this model's calm/neutral preset -- there is no 'neutral'
// preset). Anything else that looks like a tag is stripped and ignored.
const EMOTIONS = ['joy', 'sad', 'surprised', 'angry', 'neutral'];
const EMOTION_PRESETS = { joy: 'happy', sad: 'sad', surprised: 'surprised', angry: 'angry', neutral: 'relaxed' };
const emotionPreset = (tag) => EMOTION_PRESETS[tag] || null;
// Tag stripping: only a KNOWN gesture or emotion tag leaves the display and the voice, leading or inside. Any other bracket is what the model wrote ("[A] là đúng",
// "[docs](https://a.com)", "arr[i]") and stays. A tag a model invents therefore shows as written.
const LEAD_TAG = /^\s*\[\s*([a-z][a-z-]*)\s*\]/i;
// Motion (T-31-ROOM motion P4): the agent may lead with ONE `[move: words]` tag (the room's seated motion: src/renderer/reflex/seated-motion.js
// parseMotionText, the same grammar as the chat's /move command). It is stripped from the display and the voice wherever it stands; only
// a leading one counts. The text goes back to the renderer as `motion`, which validates it; nothing here interprets it.
const COMPOSE_MAX_TOKENS = 900; // a seated motion's JSON (src/main/motion-compose.js: at most 8 s of elements) fits well under it
const MOVE_LEAD = /^\s*\[\s*move\s*:\s*([^\]\n]{1,200})\]/i;
const MOVE_TAG = /[ \t]*\[\s*move\s*:[^\]\n]{0,200}\]/gi;
const MOVE_RULE = 'In the 3D room you sit at your desk. To move, you may START a reply with one tag [move: words] (it is never shown or spoken). '
  + 'Words: stretch, nod, shake, shrug, wave, think, lean-back, hover, mouse, chin, glance@board, point@board (also @user @screen @keys @window @left @right), '
  + 'an activity (typing, reading, thinking, idle) and energy=low|mid|high. Use it only when a movement fits, at most once per reply.';
const KNOWN_TAG = /[ \t]*\[\s*(?:greet|agree|disagree|point-screen|think|celebrate|explain|joy|sad|surprised|angry|neutral)\s*\]/gi;
// Fallback rule over the reply (and the owner's line for board questions). Order matters: first match wins.
const INTENT_RULES = [
  ['greet', /^\s*(hi|hello|hey|good (morning|afternoon|evening)|welcome back|xin chào|chào)\b/i],
  ['celebrate', /\b(congrat\w*|woo+|yay|hooray|great news|fantastic news|amazing news|huge win)\b|chúc mừng/i],
  ['disagree', /^\s*(no\b|nope|not really|i (don't|do not) (think|recommend)|i('d| would) (not|advise against)|unfortunately|sorry,? (but )?i can('|no)t|i can('|no)t)|không nên/i],
  ['agree', /^\s*(yes|yeah|yep|sure|of course|absolutely|definitely|okay|ok\b|sounds good|got it|agreed|great,? let's|deal)\b|^\s*(vâng|dạ được|được ạ|được)/i],
  ['think', /^\s*(hmm+|let me think|good question|it depends|that depends|tough one)\b/i],
];
const BOARD_WORDS = /\b(board|task|tasks|lane|waiting on)\b|bảng việc/i;
function ruleIntent(reply, message) {
  for (const [intent, re] of INTENT_RULES) if (re.test(reply)) return intent;
  if (BOARD_WORDS.test(String(message || '')) && BOARD_WORDS.test(reply)) return 'point-screen';
  return 'explain';
}
// raw model text -> { reply (tag-free), intent, by: 'tag'|'rules', emotion (VRM preset | null) }. A leading gesture
// and/or a leading emotion tag (in either order) are the model's choice; a leading unknown tag is stripped and counts
// as no tag (the rule intent then decides). See cleanReply() for exactly what is stripped, and where.
function parseReplyIntent(raw, message) {
  const text = String(raw || '');
  let rest = text;
  let intentTag = null;
  let emotionTag = null;
  let motion = null;
  for (let i = 0; i < 3; i++) {
    const mv = MOVE_LEAD.exec(rest);
    if (mv && !motion) { motion = mv[1].trim(); rest = rest.slice(mv[0].length); continue; }
    const m = LEAD_TAG.exec(rest);
    if (!m) break;
    const k = m[1].toLowerCase();
    if (!intentTag && SPEECH_INTENTS.includes(k)) intentTag = k;
    else if (!emotionTag && EMOTIONS.includes(k)) emotionTag = k;
    else break; // unknown/duplicate leading tag: leave it for the strip pass below
    rest = rest.slice(m[0].length);
  }
  const reply = cleanReply(rest);
  const emotion = emotionPreset(emotionTag);
  const moved = motion ? { motion } : {};
  if (intentTag) return { reply, intent: intentTag, by: 'tag', emotion, ...moved };
  return { reply, intent: ruleIntent(reply, message), by: 'rules', emotion, ...moved };
}
const gestureFor = (intent, emotion = null) => ({ intent, brief: intent, energy: 'mid', deixis: intent === 'point-screen' ? 'board' : 'none', emotion });
// Strip any known gesture/emotion tag, leaving other bracketed text alone
// (T-31 0.2.3 B1 item 1). Nothing else changes on screen, spacing included.
const cleanReply = (t) => String(t || '').replace(KNOWN_TAG, '').replace(MOVE_TAG, '').trim();

// Streaming twin of parseReplyIntent(): raw model deltas in, tag-free text out, never a half tag. A trailing
// unclosed "[agr" is held back until it closes (stripped) or stops looking like a tag (released). lead()/emotion():
// undefined = not decided yet, null = no leading tag of that kind, otherwise the model's gesture / emotion preset.
// Up to two leading tags are read, a gesture and/or an emotion, in either order (T-31 0.2.3 B1 item 2).
function createReplyParser() {
  let raw = '';
  let clean = '';
  let lead;
  let emotion;
  let motion = null;
  function decideLead() {
    if (lead !== undefined) return;
    let s = raw.replace(/^\s+/, '');
    if (!s) return;
    if (s[0] !== '[') { lead = null; emotion = null; return; }
    let foundIntent = null;
    let foundEmotion = null;
    let consumedAny = false;
    for (;;) {
      if (/^\s*\[\s*move\s*:/i.test(s)) { // a move tag: wait for its "]" (up to its length cap), then take it
        const mv = MOVE_LEAD.exec(s);
        if (!mv) { if (s.length <= 220 && !s.includes('\n')) return; lead = null; emotion = null; return; }
        if (!motion) motion = mv[1].trim();
        s = s.slice(mv[0].length); consumedAny = true; continue;
      }
      const m = /^\s*\[\s*([a-z][a-z-]*)\s*\]/i.exec(s);
      if (!m) break;
      const k = m[1].toLowerCase();
      if (!foundIntent && SPEECH_INTENTS.includes(k)) foundIntent = k;
      else if (!foundEmotion && EMOTIONS.includes(k)) foundEmotion = k;
      else if (!consumedAny) { lead = null; emotion = null; return; } // a leading unknown tag: no model-chosen intent
      else break; // an extra/unknown tag after the first: leave it for the strip pass
      s = s.slice(m[0].length);
      consumedAny = true;
    }
    if (foundIntent || foundEmotion || motion) {
      const more = s.replace(/^\s+/, '');
      // A second leading tag (emotion behind gesture, or vice versa) may still be streaming in: finalize only once
      // real text follows, or the next "[" clearly is not a tag; end() finalizes a reply that is nothing but tags.
      if (more && more[0] !== '[') { lead = foundIntent; emotion = emotionPreset(foundEmotion); return; }
      if (more[0] === '[' && (more.includes(']') || more.length > 20)) { lead = foundIntent; emotion = emotionPreset(foundEmotion); }
      return;
    }
    if (s.includes(']') || s.length > 20) { lead = null; emotion = null; } // clearly not a leading tag: wait no more
  }
  function safeRaw() {
    const i = raw.lastIndexOf('[');
    if (i >= 0 && raw.indexOf(']', i) < 0 && raw.length - i <= 16 && /^\s*\[\s*[a-z-]*\s*$/.test(raw.slice(i))) return raw.slice(0, i);
    if (i >= 0 && raw.indexOf(']', i) < 0 && raw.length - i <= 220 && /^\[\s*move\s*:[^\n]*$/i.test(raw.slice(i))) return raw.slice(0, i); // a move tag still streaming
    return raw;
  }
  function advance(next) {
    if (!next.startsWith(clean)) return ''; // cannot happen with cleanReply(); never re-speak or reorder text
    const added = next.slice(clean.length);
    clean = next;
    return added;
  }
  return {
    push(delta) { raw += delta; decideLead(); return advance(cleanReply(safeRaw())); },
    end() { if (lead === undefined) { lead = null; emotion = null; } return advance(cleanReply(raw)); },
    lead: () => lead, emotion: () => emotion, motion: () => motion, clean: () => clean, raw: () => raw,
  };
}

// The streamed reply main.js holds for one turn: the text so far, change events, the final result, and the Check
// role's verdict on it (always settles: null when Check did not run or failed).
function createLiveReply() {
  let text = '';
  let resolveFinal;
  let resolveChecked;
  const subs = new Set();
  const final = new Promise((r) => { resolveFinal = r; });
  const checked = new Promise((r) => { resolveChecked = r; });
  return {
    text: () => text,
    final, // -> { ok, reply, error?, sources: [{url, title}] }
    checked, // -> { verdict: 'ok'|'fix', text } | null
    onText(cb) { subs.add(cb); return () => subs.delete(cb); },
    push(t) { text = t; for (const cb of subs) { try { cb(t); } catch { /* a listener never breaks the stream */ } } },
    end(fin) { subs.clear(); resolveFinal(fin); },
    check(c) { resolveChecked(c || null); },
  };
}

// Barge-in (T-31-ROOM-live-b P1 item 3): the renderer's turn id owns the streamed request's AbortController, so the
// same id that stops playback and Kokoro (talk:ttsAbandon) also cuts the LLM request. Module-level on purpose: the
// Tauri sidecar rebuilds the brain on a provider change while a turn may still be streaming.
const activeTurns = new Map(); // turnId -> AbortController, only while that turn's stream is running
function abortTurn(turnId) {
  const ctl = typeof turnId === 'string' ? activeTurns.get(turnId) : null;
  if (!ctl || ctl.signal.aborted) return false;
  ctl.abort();
  return true;
}

const ALLOWED_ORIGIN = 'https://openrouter.ai';
const CHAT_PATH = '/api/v1/chat/completions';
const MODEL = 'deepseek/deepseek-v4-flash'; // price per Mtok: usage-prices.json (refreshed by scripts/refresh-usage-prices.mjs)
// The owner's model choice (settings.json `chatModel`, BYOK) must look like an OpenRouter model id; anything else
// falls back to MODEL rather than being sent upstream.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]{0,100}$/i;
// Product rule (T-31 role-ui-port step 7, CoS 10-10): Zumi never lists or runs a Claude model in its own Settings or
// chat; the owner's lane models (Opus/Sonnet/Haiku) appear only on his Board tab. A Claude model is an `anthropic/`
// id, an id or name containing "claude", or a router: a list entry the catalog marks as one (`router`, see
// fetchModelList), or a known router id -- openrouter/* and the two third-party routers in the catalog
// (typesafe/jev-router and nvidia/switchyard: their docs, read 2026-10-10, show Claude models in their pools). A router
// picks the model per request, so it can pick a Claude model. One router is exempt: openrouter/free "selects a free
// model at random from the available free models on OpenRouter" (docs guides/routing/routers/free-router, read
// 2026-10-10), and no Claude model is free there (catalog read 2026-10-10: 35 Claude ids, none priced $0 or `:free`;
// scripts/refresh-usage-prices.mjs fails if one ever is). Lives here, next to MODEL_ID_RE, because this module is the
// one that sends a model id: a hand-set settings.json `chatModel` or a stored role choice of one falls back to the
// default. role-models.js re-exports it for the Settings lists.
const FREE_ROUTER_RE = /^openrouter\/free$/i;
const ROUTER_ID_RE = /^(?:openrouter\/.|typesafe\/jev-router$|nvidia\/switchyard$)/i;
function isClaudeModel(m) {
  const obj = Boolean(m) && typeof m === 'object';
  const id = String((obj ? m.id : m) || '');
  const name = String((obj ? m.name : '') || '');
  const router = (ROUTER_ID_RE.test(id) || (obj && m.router === true)) && !FREE_ROUTER_RE.test(id);
  return router || /^anthropic\//i.test(id) || /claude/i.test(id) || /claude/i.test(name);
}
// Effort levels a role can carry (role-models.js shares this list). 'off' = reasoning disabled per request.
const EFFORTS = ['off', 'low', 'medium', 'high'];
// The provider's public model list (Settings > Models by role picker). No key is sent: the list is public.
const MODELS_PATH = '/api/v1/models';
const MODELS_TIMEOUT_MS = 8000;
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000; // non-streamed calls only (postChat's timeoutMs)
// Streamed turns use two limits instead of one whole-request deadline. WHY: the free tier measured 10 s for a SHORT
// reply (spare PC, 22-10), so the old single 20 s total cut a long answer that was still streaming steadily -- and it
// could not tell "slow to start" from "stalled mid-answer". FIRST_TOKEN_MS covers headers + the first content delta
// (the model thinking); IDLE_MS is the largest gap allowed between stream chunks after that first delta.
const FIRST_TOKEN_MS = 30000;
const IDLE_MS = 15000;
const PIN_MAX_FIRST_TOKEN_MS = 2500; // a call this fast keeps (or sets) the provider pin; slower or failed drops it
const NO_FALLBACK_STATUS = new Set([401, 402, 403]); // the key/account was refused: a second call cannot succeed
// Models by role (header comment): budgets and prompts of the Plan / Check calls, and the Look up web plugin.
const PLAN_TIMEOUT_MS = 8000;
const PLAN_MAX_TOKENS = 200;
const OUTLINE_MAX_CHARS = 800;
const CHECK_TIMEOUT_MS = 10000;
const CHECK_MAX_TOKENS = 150;
const CHECK_TEXT_MAX_CHARS = 320; // one sentence of <= 40 words
const SOURCES_MAX = 5;
const PLAN_PROMPT = 'Write at most 5 one-line steps to answer this; no answer, no preamble.';
const OUTLINE_RULE = 'Follow this outline, do not list it: ';
const CHECK_PROMPT = 'You review an assistant reply. Reply exactly `OK`, or one correction sentence (<= 40 words) if there is a factual or logic error.';
// OpenRouter web search (docs features/web-search, read 10-10): Exa engine, 5 results, $0.007 per request. The custom
// search_prompt keeps links out of the reply text, so the voice never reads a URL; the app shows the sources itself.
const WEB_PLUGIN = [{ id: 'web', engine: 'exa', max_results: SOURCES_MAX, search_prompt: 'A web search was run just now. Use these results in your reply. Write plain text with no links, URLs or citation marks; the app shows the sources separately.' }];
const MESSAGE_MAX_CHARS = 2000;
// The host's memory block (memory-notes.mjs recall: notes about 800 estimated tokens, worst case ~3100 chars, then up to 4 matching past turns in 2400 chars); a hard ceiling.
const MEMORY_BLOCK_MAX_CHARS = 6000;
const VOICE_NOTE_MAX_CHARS = 300; // the host's anti-repeat note (voice-note.mjs): a short hint, never a block
const TOOLS_REFUSED_STATUS = new Set([400, 404, 422]); // what a provider answers when the model has no tool use (OpenRouter: 404 'No endpoints found that support tool use')
const HISTORY_MAX = 6;
// R6c C item 5: images attached to ONE message. They go to the model in that request's last user message and nowhere else: not into the
// history the page sends back, not into memory, not into a log. The limits are checked here, whatever the page says.
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_MAX_COUNT = 4;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** The page's `images` -> [{ mime, data }] (base64, no prefix), [] when there are none, or null when anything is wrong with them. */
function cleanImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > IMAGE_MAX_COUNT) return null;
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || !IMAGE_MIMES.includes(x.mime) || typeof x.data !== 'string' || x.data.length < 8 || !BASE64_RE.test(x.data)) return null;
    if (Math.floor((x.data.length * 3) / 4) > IMAGE_MAX_BYTES) return null;
    out.push({ mime: x.mime, data: x.data });
  }
  return out;
}
// Can this model read images? Only from what we know: OpenRouter's own list says so per model (architecture.input_modalities), Gemini
// models do, Groq names its vision models. Anything else, or a model nobody lists, is "no": never send an image to a model that may refuse it.
function modelReadsImages(providerId, modelId, listEntry) {
  const id = String(modelId || '').toLowerCase();
  if (providerId === 'openrouter') return Boolean(listEntry && listEntry.images === true);
  if (providerId === 'gemini') return /^gemini-/.test(id);
  if (providerId === 'groq') return /vision|llama-4-(scout|maverick)/.test(id);
  return false;
}
// The first system message (T-31 alpha.12 soul): built from the user's soul by soul-prefs.js. SYSTEM_PROMPT is the default
// soul's text, the alpha.10 literal plus the companion rule (scripts/check-soul.mjs pins it against the alpha.10 source); the
// "cannot act" sentence, the companion rule and the gesture/emotion tag contract are fixed in soul-prefs.js and always follow the user's text.
const { soulSystemPrompt, addressRule, soulPrefs } = require('./soul-prefs.js');
const SYSTEM_PROMPT = soulSystemPrompt(null);
// T-31 board-aware (owner brief 07-10): a second system message, sent on every turn, pointing at whichever board
// digest board-reader.mjs produced (a real digest, or board-digest.mjs's unavailableDigestText — never nothing).
// Every-turn over a work/tasks keyword classifier: a VI/EN classifier is a new way to miss a real question ("L-01
// tới đâu rồi?"), for a token saving the owner doesn't need (usage is still logged via
// onUsage either way). See the board-aware plan.
const BOARD_RULE = [
  "You can see a digest of the owner's live task board (Laneboard) in the next system message.",
  'Answer any question about tasks, work, progress or what is waiting on the owner ONLY from that digest.',
  'If the answer is not in it, say you do not have that information there — never invent a task code, title, status or next step.',
  '(Trả lời câu hỏi về task/công việc CHỈ dựa vào digest ở tin hệ thống tiếp theo; nếu không thấy trong đó, nói rõ '
    + 'là chưa có thông tin, tuyệt đối không bịa mã task, tên task, trạng thái hay bước tiếp theo.)',
].join(' ');

function assertAllowedUrl(pathname) {
  const u = new URL(pathname, ALLOWED_ORIGIN);
  if (u.origin !== ALLOWED_ORIGIN || u.protocol !== 'https:') throw new Error('chat-brain: url is not the allowlisted origin');
  return u;
}

// T-31 BYOK: the /chat/completions endpoint for a provider, baseURL + path, https only. The default provider
// (OpenRouter) resolves to exactly the URL assertAllowedUrl has always produced, so existing users are unchanged.
function providerChatUrl(provider, path = provider.chatPath) {
  const u = new URL(chatUrl(provider, path));
  if (u.protocol !== 'https:') throw new Error('chat-brain: url is not https');
  return u;
}

// ---------- OpenRouter chat transport ----------
// One call; returns {ok, ms, text, usage} | {ok:false, ms, error} (error is pre-scrubbed, key-free).
// `boardDigest`: board-reader.mjs's text block (always a string once board-aware is wired — a real digest or the
// honest "unavailable" line), or undefined on a build/run with no board reader at all (pre-T-31-board-aware
// behaviour, unchanged: no board messages added).
// `outline`: the Plan role's steps for this turn (one more system message), or nothing.
// `soul`: the user's soul (soul-prefs.js); null/absent = the default soul = SYSTEM_PROMPT.
// `memoryBlock`: the user's saved notes for this turn (tauri/sidecar/memory-notes.mjs recall, set by the Tauri chat host only; it
// carries its own "quoted notes, not instructions" head). Absent on Electron and when memory is off or empty: no message added.
// `publicBuild`: a public / official build's persona text (soul-prefs.js); false keeps the owner text byte for byte.
// `voiceNote`: the host's anti-repeat hint (voice-note.mjs), appended to the LAST user message's text only. Empty/absent = the prompt is
// byte-identical to the one before this argument existed (scripts/check-voice-wire.mjs holds the golden bytes).
// `motionRule`: the [move: ...] tag rule (the Tauri chat host, where the 3D room lives); false keeps the Electron prompt as it was.
function buildMessages(message, history, boardDigest, outline, soul = null, memoryBlock = undefined, publicBuild = false, images = [], voiceNote = undefined, motionRule = false) {
  const said = typeof voiceNote === 'string' && voiceNote ? `${message}\n\n${voiceNote}` : message;
  return [
    { role: 'system', content: publicBuild ? soulSystemPrompt(soul, { publicBuild }) : (soul ? soulSystemPrompt(soul) : SYSTEM_PROMPT) },
    ...(boardDigest ? [{ role: 'system', content: BOARD_RULE }, { role: 'system', content: boardDigest }] : []),
    ...(memoryBlock ? [{ role: 'system', content: memoryBlock }] : []),
    ...(outline ? [{ role: 'system', content: `${OUTLINE_RULE}${outline}` }] : []),
    ...(motionRule ? [{ role: 'system', content: MOVE_RULE }] : []),
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '').slice(0, MESSAGE_MAX_CHARS) })),
    // Images (R6c C item 5) ride in this one message as data URLs; with none, the content stays the plain string it always was.
    { role: 'user', content: images && images.length ? [{ type: 'text', text: said }, ...images.map((x) => ({ type: 'image_url', image_url: { url: `data:${x.mime};base64,${x.data}` } }))] : said },
  ];
}
// routing: { provider: '<pinned name>' | null, reasoningOff: bool, effort?: EFFORTS, effortOk?: bool } -- see the
// header comment. Never touches `model`. effort 'off'/absent -> `{enabled:false}` while reasoningOff holds; a real
// effort -> `{effort}` until the model refuses it (effortOk false), then the model's own default (no field).
function reasoningField(routing) {
  if (!routing) return null;
  if (routing.effort && routing.effort !== 'off') return routing.effortOk === false ? null : { effort: routing.effort };
  return routing.reasoningOff ? { enabled: false } : null;
}
// Gemini's OpenAI-compatible route takes `reasoning_effort` (Google docs: gemini-api/docs/openai + /docs/thinking,
// last updated 2026-10-14 -- the Gemini reasoning-effort notes). Only provider id `gemini`
// gets this field; OpenRouter keeps `reasoning` below and Groq/OpenCode take neither. The SAME docs say
// `reasoning_effort` and `extra_body.google.thinking_config` conflict, so this module never sends `extra_body`.
// "Off" is not one value across families: 2.5 Flash/Flash-Lite accept "none", while 2.5 Pro and every 3.x model
// cannot turn thinking off -- off becomes the LOWEST level the docs give for that family. A model id the docs do not
// cover gets NO field at all (never guess).
function geminiFamily(model) {
  const id = String(model || '').toLowerCase();
  if (/^gemini-2\.5-flash-lite(?:$|[-.])/.test(id)) return '25-flash-lite';
  if (/^gemini-2\.5-flash(?:$|[-.])/.test(id)) return '25-flash';
  if (/^gemini-2\.5-pro(?:$|[-.])/.test(id)) return '25-pro';
  if (/^gemini-3(?:\.\d+)?-flash-lite(?:$|[-.])/.test(id)) return '3-flash-lite';
  if (/^gemini-3(?:\.\d+)?-flash(?:$|[-.])/.test(id)) return '3-flash';
  return null;
}
function geminiReasoningEffort(model, routing) {
  const family = geminiFamily(model);
  if (!family || !routing) return null;
  if (routing.effort && routing.effort !== 'off') return routing.effortOk === false ? null : routing.effort;
  if (!routing.reasoningOff) return null;
  if (family === '25-flash' || family === '25-flash-lite') return 'none';
  if (family === '3-flash-lite') return 'minimal';
  return 'low'; // 2.5 Pro and 3.x Flash: lowest supported non-off level (3.8-flash has no "minimal"; 2.5 Pro's 1,024 budget)
}
function requestBody(model, messages, routing, stream, { maxTokens = 500, plugins = null, provider = PROVIDERS.openrouter, tools = null, toolChoice = 'auto' } = {}) {
  const b = { model, messages, temperature: 0.7, max_tokens: maxTokens };
  if (tools && tools.length) { b.tools = tools; b.tool_choice = toolChoice; } // R6f: the reply model's memory tool (turnStream only)
  // `usage: {include}` is OpenRouter-only too: Google's OpenAI-compatible endpoint answers HTTP 400 to it (measured live 22-10 on the
  // spare PC with a Gemini key: every streamed turn was refused until the field was dropped), so their stream body stays plain.
  if (stream) { b.stream = true; if (provider.id === 'openrouter') b.usage = { include: true }; }
  // `reasoning`, the web plugin and the provider pin are OpenRouter request fields; Groq gets a plain body so an
  // unknown field can never make it 400 (T-31 BYOK). Gemini gets only its documented `reasoning_effort` below.
  if (provider.id === 'openrouter') {
    const reasoning = reasoningField(routing);
    if (reasoning) b.reasoning = reasoning;
    if (routing && routing.provider) b.provider = { order: [routing.provider], allow_fallbacks: true };
    if (plugins) b.plugins = plugins;
  } else if (provider.id === 'gemini') {
    // Gemini BYOK (T-31): the role effort used to be dropped here. `extra_body` is deliberately absent (docs conflict).
    const effort = geminiReasoningEffort(model, routing);
    if (effort) b.reasoning_effort = effort;
  }
  return JSON.stringify(b);
}

// The provider's model list -> { ok:true, models:[{id, name, reasoning:true|false|null, router}] } | { ok:false, error, models:[] }.
// Text-output models only; `reasoning` = the model lists the `reasoning` parameter (null when the host does not say);
// `router` = the catalog marks it a router (architecture.tokenizer "Router"), which isClaudeModel drops.
async function fetchModelList(fetchImpl = fetch, provider = PROVIDERS.openrouter) {
  // T-31 BYOK: the free providers do not share OpenRouter's /models shape, and the table already holds the ids we send.
  if (provider.id !== 'openrouter') return { ok: true, models: providerModels(provider) };
  const url = providerChatUrl(provider, 'models');
  try {
    const res = await fetchImpl(url.href, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `http_${res.status}`, models: [] };
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.data)) return { ok: false, error: 'bad_response', models: [] };
    const models = [];
    for (const m of j.data) {
      if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) continue;
      const outputs = m.architecture && Array.isArray(m.architecture.output_modalities) ? m.architecture.output_modalities : null;
      if (outputs && !outputs.includes('text')) continue;
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 80) : m.id;
      const router = Boolean(m.architecture && m.architecture.tokenizer === 'Router');
      const inputs = m.architecture && Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities : null;
      models.push({ id: m.id, name, reasoning: params ? params.includes('reasoning') : null, router, images: inputs ? inputs.includes('image') : null });
    }
    return { ok: true, models };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, error: timeout ? 'timeout' : 'network', models: [] };
  }
}

async function callChat(message, history, key, { fetchImpl = fetch, boardDigest, outline, soul = null, memoryBlock, voiceNote, images = [], model = MODEL, routing = null, provider = PROVIDERS.openrouter, publicBuild = false, motionRule = false } = {}) {
  return postChat(buildMessages(message, history, boardDigest, outline, soul, memoryBlock, publicBuild, images, voiceNote, motionRule), key, { fetchImpl, model, routing, provider });
}
// T-31-MAUS P3: ONE model call with tool definitions, for the Rust agent loop (host-only `__host.modelTurn`). It is the model
// call only: the reply's tool calls come back as data and NOTHING is executed here; the loop runs them through its own gate.
// Failure is a code word (never the key, a header or the body). The loop writes the usage ledger itself, so no onUsage here.
const MODEL_TURN_MAX_MESSAGES = 200;
const MODEL_TURN_TIMEOUT_MS = 60000;
async function postModelTurn(messages, tools, key, { fetchImpl = fetch, model, provider, maxTokens = 1000, signal = null }) {
  const t0 = Date.now();
  try {
    const body = JSON.stringify({ model, messages, tools, tool_choice: tools.length ? 'auto' : undefined, temperature: 0.2, max_tokens: maxTokens });
    const res = await fetchImpl(providerChatUrl(provider).href, { method: 'POST', redirect: 'error', headers: headersFor(provider, key), body, signal: signal ? AbortSignal.any([AbortSignal.timeout(MODEL_TURN_TIMEOUT_MS), signal]) : AbortSignal.timeout(MODEL_TURN_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: classifyUpstreamError(res.status).code, status: res.status, ms: Date.now() - t0 };
    const j = await res.json().catch(() => null);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) return { ok: false, error: 'bad_response', ms: Date.now() - t0 };
    const toolCalls = [];
    for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      const f = c && c.function;
      let args;
      try { args = JSON.parse(f && typeof f.arguments === 'string' ? f.arguments : '{}'); } catch { return { ok: false, error: 'bad_tool_args', ms: Date.now() - t0 }; }
      if (!f || typeof f.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'bad_tool_args', ms: Date.now() - t0 };
      toolCalls.push({ id: typeof c.id === 'string' ? c.id : `call-${toolCalls.length}`, name: f.name, args });
    }
    const u = j.usage;
    // No usage = no cost: the loop cannot enforce its cap on a turn it cannot price, so this is an error, not a zero.
    if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) return { ok: false, error: 'no_usage', ms: Date.now() - t0 };
    return { ok: true, text: typeof msg.content === 'string' ? msg.content.slice(0, 4000) : '', toolCalls, usage: { in: u.prompt_tokens, out: u.completion_tokens, total: u.total_tokens || (u.prompt_tokens + u.completion_tokens) }, model, ms: Date.now() - t0 };
  } catch (e) {
    if (signal && signal.aborted) return { ok: false, error: 'cancelled', ms: Date.now() - t0 };
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, error: timeout ? 'timeout' : 'upstream', ms: Date.now() - t0 };
  }
}
// One non-streamed call with ready-made messages (the reply's fallback, and the Plan / Check role calls).
async function postChat(messages, key, { fetchImpl = fetch, model = MODEL, routing = null, maxTokens, timeoutMs = TIMEOUT_MS, provider = PROVIDERS.openrouter } = {}) {
  const t0 = Date.now();
  const url = providerChatUrl(provider);
  const body = requestBody(model, messages, routing, false, { maxTokens, provider });
  try {
    const res = await fetchImpl(url.href, {
      method: 'POST',
      redirect: 'error', // a bearer is never forwarded across a redirect
      headers: headersFor(provider, key),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Two timings (QC-cuoi round 5 finding): OpenRouter answers a non-streaming call with its status/headers at once
    // and only sends the body when the model is done, so the old "ms at headers" read ~0.8 s on turns whose reply
    // really took up to 12.7 s. `ms` is now the whole call (body parsed); `headersMs` is kept for the split.
    const headersMs = Date.now() - t0;
    if (!res.ok) {
      const f = await failureInfo(res);
      return { ok: false, ms: headersMs, headersMs, status: res.status, quota: res.status === 429, insufficient: f.insufficient, reasoningRefused: f.reasoningRefused, error: scrub(`http_${res.status}`, key) };
    }
    const j = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    const text = msg && typeof msg.content === 'string' ? msg.content.trim() : null;
    if (!text) return { ok: false, ms, headersMs, error: 'bad_response' };
    const u = j.usage || null;
    const usage = u ? { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, total: u.total_tokens || 0 } : null;
    return { ok: true, ms, headersMs, text: text.slice(0, 4000), usage, provider: typeof j.provider === 'string' ? j.provider : null, reasoningTokens: reasoningTokensOf(u) };
  } catch (e) {
    const ms = Date.now() - t0;
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, ms, error: scrub(timeout ? 'timeout' : (e && e.message) || String(e), key) };
  }
}
const reasoningTokensOf = (u) => (u && u.completion_tokens_details && typeof u.completion_tokens_details.reasoning_tokens === 'number' ? u.completion_tokens_details.reasoning_tokens : null);
// A refused response's body is read ONCE and used only for classification: (a) a 400 that names reasoning (the model
// refuses reasoning-off -> retried once without it), (b) a billing reason under any status. The body is never logged
// or returned: it can echo request content, and some gateways echo the credential.
const BILLING_BODY_RE = /\binsufficient\b[^\n]{0,60}\b(?:funds?|credits?|balance|quota)\b|\bquota[- ]?billing\b|\bout of credits?\b/i;
async function failureInfo(res) {
  const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  return {
    insufficient: BILLING_BODY_RE.test(String(body).slice(0, 4000)),
    reasoningRefused: res.status === 400 && /reason/i.test(body),
  };
}
// Provider failure -> the code the renderer maps to a plain line, and whether a retry can help. Measured 20-10 on
// OpenCode: a bad credential is 401 "Invalid credential"; an empty account is 402 "Insufficient account funds". The
// STATUS decides first for 401/403 (a refused key cannot be a money problem, even if the body also mentions quota):
// only then does an insufficient-funds/credit body or a 402 count as credit, whatever the other status. A refused
// key/account (auth) or an empty account (credit) can never succeed on a retry; a busy provider (429) and the generic
// upstream failures can.
function classifyUpstreamError(status, insufficient = false) {
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (insufficient || status === 402) return { code: 'credit', retryable: false };
  if (status === 429) return { code: 'quota', retryable: true };
  return { code: 'upstream', retryable: true };
}

// Streamed call (SSE). onDelta(text) gets each content delta as it arrives; reasoning deltas are not content and
// are ignored. `plugins` (Look up): the web plugin; its url_citation annotations come back as `sources`.
// -> { ok:true, ms, headersMs, firstTokenMs, text, usage, provider, reasoningTokens, sources }
//  | { ok:false, ms, headersMs?, firstTokenMs?, status?, reasoningRefused?, error, gotContent, sources } (error pre-scrubbed).
const THOUGHT_SIGNATURE_MAX = 20000; // a Gemini thought signature is a few KB of base64; anything far larger is not one
async function streamChat(messages, key, { fetchImpl = fetch, model = MODEL, routing = null, plugins = null, onDelta = () => {}, provider = PROVIDERS.openrouter, firstTokenTimeoutMs = FIRST_TOKEN_MS, idleTimeoutMs = IDLE_MS, tools = null, toolChoice = 'auto', signal: turnSignal = null } = {}) {
  const t0 = Date.now();
  const url = providerChatUrl(provider);
  let headersMs;
  let firstTokenMs = null;
  let text = '';
  let usage = null;
  let upProvider = null; // the upstream provider name reported in the SSE (distinct from the BYOK `provider` descriptor)
  const sources = [];
  const calls = []; // R6f: tool calls, assembled from the deltas by index ({ id, name, args: the JSON text so far })
  const fail = (error, extra = {}) => ({ ok: false, ms: Date.now() - t0, headersMs, firstTokenMs, error: scrub(error, key), gotContent: text.length > 0, text, provider: upProvider, sources, ...extra });
  // One controller enforces both limits (see FIRST_TOKEN_MS / IDLE_MS). `timeoutKind` names which one fired, so the
  // caller sees `timeout_first_token` vs `timeout_idle` instead of the old generic `timeout`.
  const ctrl = new AbortController();
  let timeoutKind = null;
  let timer = null;
  const arm = (ms, kind) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timeoutKind = kind; ctrl.abort(); }, ms);
    if (timer.unref) timer.unref(); // like AbortSignal.timeout: never hold the process open
  };
  // `turnSignal` (barge-in, see activeTurns): aborting it cuts the request like a timeout does, with its own kind.
  const onTurnAbort = () => { timeoutKind = 'aborted'; ctrl.abort(); };
  try {
    if (turnSignal) {
      if (turnSignal.aborted) return fail('aborted'); // before any request: nothing was sent
      turnSignal.addEventListener('abort', onTurnAbort, { once: true });
    }
    arm(firstTokenTimeoutMs, 'timeout_first_token'); // starts before fetch: headers are part of the first-token budget
    const res = await fetchImpl(url.href, {
      method: 'POST',
      redirect: 'error',
      headers: { ...headersFor(provider, key), accept: 'text/event-stream' },
      body: requestBody(model, messages, routing, true, { plugins, provider, tools, toolChoice }),
      signal: ctrl.signal,
    });
    headersMs = Date.now() - t0;
    if (!res.ok) {
      const f = await failureInfo(res);
      return fail(`http_${res.status}`, { status: res.status, quota: res.status === 429, insufficient: f.insufficient, reasoningRefused: f.reasoningRefused });
    }
    if (!res.body) return fail('no_stream_body');
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
    for await (const piece of res.body) {
      // A chunk already buffered when the barge-in landed must not reach the voice or the stored reply.
      if (turnSignal && turnSignal.aborted) return fail('aborted');
      // Any arriving chunk proves the stream is alive; after the first content delta the gap between chunks is what
      // IDLE_MS bounds (a keep-alive also counts as a chunk).
      if (firstTokenMs !== null) arm(idleTimeoutMs, 'timeout_idle');
      buf += typeof piece === 'string' ? piece : dec.decode(piece, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // blank separators and ": OPENROUTER PROCESSING" keep-alives
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; continue; }
        let j;
        try { j = JSON.parse(data); } catch { return fail('bad_stream_event'); }
        if (j.error) return fail(`stream_error_${String(j.error.code || 'upstream').slice(0, 40)}`);
        if (typeof j.provider === 'string') upProvider = j.provider;
        if (j.usage) usage = j.usage;
        const choice = j.choices && j.choices[0];
        const delta = choice && choice.delta;
        addSources(sources, delta && delta.annotations);
        addSources(sources, choice && choice.message && choice.message.annotations);
        for (const c of delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (firstTokenMs === null) { firstTokenMs = Date.now() - t0; arm(idleTimeoutMs, 'timeout_idle'); }
          // A delta names its call by `index`; Gemini's OpenAI-compatible stream sends none, so a call with a new id is a new slot and one with no id
          // continues the last one (a call joined into slot 0 would drop both).
          let at = Number.isInteger(c && c.index) ? c.index : -1;
          if (at < 0) { at = c && typeof c.id === 'string' && c.id ? calls.findIndex((x) => x && x.id === c.id) : calls.length - 1; if (at < 0) at = calls.length; }
          const slot = calls[at] || (calls[at] = { id: '', name: '', args: '' });
          if (c && typeof c.id === 'string') slot.id = c.id;
          // Gemini 3 hands each call's thought signature as extra_content.google.thought_signature and answers 400 when the confirmation request does not echo it.
          const sig = c && c.extra_content && c.extra_content.google && c.extra_content.google.thought_signature;
          if (typeof sig === 'string' && sig && sig.length <= THOUGHT_SIGNATURE_MAX) slot.extra = { google: { thought_signature: sig } };
          if (c && c.function && typeof c.function.name === 'string') slot.name += c.function.name;
          if (c && c.function && typeof c.function.arguments === 'string' && slot.args.length < 4000) slot.args += c.function.arguments;
        }
        const piece2 = delta && typeof delta.content === 'string' ? delta.content : '';
        if (piece2) {
          if (firstTokenMs === null) { firstTokenMs = Date.now() - t0; arm(idleTimeoutMs, 'timeout_idle'); }
          if (text.length < 4000) { text += piece2; onDelta(piece2); }
        }
      }
    }
    if (!done) return fail(text ? 'stream_cut' : 'stream_ended_empty');
    const toolCalls = [];
    for (const c of calls) { // a call whose arguments are not a JSON object is dropped, never half applied
      let args = null;
      try { args = JSON.parse(c && c.args ? c.args : '{}'); } catch { args = null; }
      if (c && c.name && args && typeof args === 'object' && !Array.isArray(args)) toolCalls.push({ id: c.id || `call-${toolCalls.length}`, name: c.name, args, ...(c.extra ? { extra: c.extra } : {}) });
    }
    if (!text.trim() && !toolCalls.length) return fail('bad_response');
    const u = usage ? { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, total: usage.total_tokens || 0 } : null;
    return { ok: true, ms: Date.now() - t0, headersMs, firstTokenMs, text, usage: u, provider: upProvider, reasoningTokens: reasoningTokensOf(usage), sources, toolCalls };
  } catch (e) {
    if (timeoutKind) return fail(timeoutKind);
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(timeout ? 'timeout' : (e && e.message) || String(e));
  } finally {
    if (timer) clearTimeout(timer);
    if (turnSignal) turnSignal.removeEventListener('abort', onTurnAbort);
  }
}
// OpenRouter url_citation annotations (they can repeat across deltas) -> [{url, title}], http(s) only, deduped by
// url, at most SOURCES_MAX. Plain data for the renderer's Sources row; never parsed as markup.
function addSources(out, annotations) {
  if (!Array.isArray(annotations)) return;
  for (const a of annotations) {
    const c = a && a.type === 'url_citation' ? a.url_citation : null;
    if (!c || typeof c.url !== 'string' || out.length >= SOURCES_MAX) continue;
    let u;
    try { u = new URL(c.url); } catch { continue; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || out.some((s) => s.url === u.href)) continue;
    out.push({ url: u.href, title: typeof c.title === 'string' ? c.title.trim().slice(0, 120) : '' });
  }
}
// The Check role's answer -> { verdict:'ok', text:'' } | { verdict:'fix', text } | null (empty).
function parseCheck(raw) {
  const s = cleanReply(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^[`"'*\s]*ok[`"'*.!\s]*$/i.test(s)) return { verdict: 'ok', text: '' };
  return { verdict: 'fix', text: s.replace(/^correction:\s*/i, '').slice(0, CHECK_TEXT_MAX_CHARS) };
}

// ---------- the module main.js wires to IPC (talk:status / talk:turn, in place of cloud.js, only when a key exists) ----------
// opts: { safeStorage, dir, fetchImpl, log, onUsage }
//   No daily turn cap on any build (owner 12-11 "Bỏ hạn mức đi nhé"; BYOK: the user's own key pays).
//   onUsage({model, kind:'chat'|'plan'|'check'|'lookup', in, out, total, ms, ok}): called once per REAL call attempt
//     (success or failure), never for a no-key refusal (no call was made). Swallowed here -- a
//     usage-ledger problem must never surface as a chat failure.
//   model: the owner's model id (settings.json `chatModel`, applied on OpenRouter ONLY -- fix round 2); absent/invalid/
//     Claude -> the provider TABLE's free Do id when a provider is passed (BYOK, fix r item 2), else the legacy MODEL.
//     This is the DEFAULT model; the Do role (getRoute) may pick another one per turn.
//   legacyDefaults: true (main.js, pinned pre-BYOK user) keeps the exact pre-BYOK defaults while on OpenRouter -- the
//     MODEL id and the old per-role resolution -- so an existing user is never moved onto the free table (fix round 2).
//   getRoute(defaultModel) -> {model, effort} | null: the owner's Do-role choice (see the header comment).
//   getRoles(defaultModel, models|null) -> { plan, check, lookup: {model, effort, on} } | null: the other roles
//     (header comment). `models` is the provider list this module has cached (Settings loads it), so a default Check
//     model differs from Do's exactly as Settings shows it. Absent -> Plan / Check / Look up never run.
function createChatBrain(opts = {}) {
  const log = opts.log || (() => {});
  // T-31 alpha.12: opts.getSoul() -> the user's soul (soul-prefs.js soulPrefs), read on every turn like getRoute, so a
  // Soul tab save applies from the next reply with no rebuild. Absent or throwing -> the default soul (SYSTEM_PROMPT).
  const soulOf = () => { try { return opts.getSoul ? opts.getSoul() || null : null; } catch { return null; } };
  // The other roles' text reaches the owner too (the Check correction is shown, the Plan outline shapes the reply), so they carry the same words.
  // opts.publicBuild (the Tauri chat host: not ownerAdmin): the persona and address rule say "the user", with no board sentence.
  const publicBuild = opts.publicBuild === true;
  const motionRule = opts.motionRule === true; // T-31-ROOM motion P4: the Tauri host asks for the [move: ...] tag rule
  const withAddress = (prompt) => { const soul = soulOf(); const rule = addressRule(soulPrefs({ soul }), { publicBuild }); return rule ? `${prompt} ${rule}` : prompt; };
  // T-31 BYOK: the active provider descriptor (accepts an id or a descriptor). Absent/unknown -> OpenRouter, which is
  // exactly today's behaviour, so every existing path and check is unchanged; main.js always passes the resolved one.
  const baseProvider = (opts.provider && typeof opts.provider === 'object' && opts.provider.id) ? opts.provider
    : (isProviderId(opts.provider) ? PROVIDERS[opts.provider] : PROVIDERS.openrouter);
  // OpenCode Go asks for the client's own user agent and a session id stable for the conversation. One id per brain: a rebuild is a provider or mode change.
  const provider = baseProvider.clientIdentity
    ? { ...baseProvider, clientHeaders: { 'user-agent': `zumi/${opts.appVersion || 'dev'}`, 'x-opencode-session': crypto.randomUUID() } }
    : baseProvider;
  // A provider with no key test learns from real calls whether its key works (brain-key.js noteChatResult).
  const usesCliLogin = () => provider.id === 'opencode-go' && Boolean(opts.cliLoginKey) && opts.cliLoginKey() !== null;
  const noteKey = (check, key) => { if (!provider.keyTest && opts.onKeyResult) { try { opts.onKeyResult(check, String(key).slice(-4)); } catch (e) { log(`onKeyResult failed: ${(e && e.message) || e}`); } } };
  // Only a 401 speaks about the key: what Go means by a 403 is not documented (a limit, a model outside the plan).
  const failedTurn = (f, message, status, key) => { if (status === 401) noteKey('rejected', key); return { ok: false, error: { code: f.code, message, retryable: f.retryable, providerId: provider.id, ...(status === 403 ? { forbidden: true } : {}), ...(usesCliLogin() ? { cliLogin: true } : {}) } }; };
  // T-31 fix r item 2: an explicit provider (main.js always passes one) means the BYOK path: with no stored Do choice
  // the default model is the provider TABLE's free Do id, for every provider including OpenRouter -- so a free key is
  // never billed on the paid OpenRouter default. The legacy no-provider construction (older callers/tests) keeps
  // today's MODEL, so its behaviour is byte-for-byte unchanged.
  // T-31 fix round 2: a legacy (pre-BYOK) user must NOT move. main.js pins `aiDefaultsLegacy` once at startup; while a
  // legacy user stays on OpenRouter, this construction is exactly the old no-provider one (the MODEL id and the old
  // per-role resolution). A legacy user who moved to another provider cannot send the OpenRouter-only id, so they --
  // and every new user -- get that provider's free defaults. main.js reads `legacyOpenRouter` to keep the roles card
  // showing the same models this module sends.
  const explicitProvider = Boolean(opts.provider);
  const legacyOpenRouter = opts.legacyDefaults === true && provider.id === 'openrouter';
  const modelOk = (id) => typeof id === 'string' && provider.modelIdRe.test(id) && !isClaudeModel(id);
  // Read-only here on purpose: reflex-jev.js owns the one import flow. The store is per provider (OpenRouter keeps the
  // shared jev-key.bin; a BYOK provider gets its own file), so switching provider never deletes another key.
  const keys = opts.safeStorage ? createKeyStore({ safeStorage: opts.safeStorage, dir: opts.dir, log: () => {}, name: provider.keyName, shape: provider.keyShape }) : null;
  // T-31 BYOK error mapping (20-10): one classifier for every provider. 401/403 = the key/account was refused (auth),
  // 402 or an insufficient-funds/credit body = the account is empty (credit), 429 = the provider is busy (quota), and
  // everything else keeps today's generic 'upstream'. Each error carries the matching `retryable` flag: a refused key
  // or an empty account is NOT retryable; a busy provider and a generic upstream failure are.
  const failureOf = (r) => classifyUpstreamError(r.status, r.insufficient === true);
  // T-31 fix round 2 item 2: `chatModel` is the pre-BYOK OpenRouter model id (there is no picker UI for it). Apply it
  // ONLY on OpenRouter -- otherwise the OpenRouter-only `deepseek/...` id would be POSTed to Groq/Gemini after a switch.
  const storedDefaultModel = provider.id === 'openrouter' && modelOk(opts.model) ? opts.model : null;
  const fallbackModel = (explicitProvider && !legacyOpenRouter) ? provider.models.do : MODEL;
  const defaultModel = storedDefaultModel || fallbackModel;
  if (opts.model && defaultModel !== opts.model) log(`chat-brain: settings chatModel is not an allowed model id (Claude/router or malformed); using ${fallbackModel}`);
  let model = defaultModel; // the model of the current turn: the Do role's choice, applied by applyRoute()
  // Per-session latency hygiene state (header comment): the provider pin, whether reasoning-off is still sent, and
  // the Do role's effort (+ whether this model still accepts it).
  const routing = { provider: null, reasoningOff: true, effort: 'off', effortOk: true };
  // BYOK: an unset role takes this provider's own TABLE default (free per-role id), for every provider including
  // OpenRouter, so a new user runs the free models (T-31 fix r item 2). A stored role choice (by:'user') and an
  // explicitly set `chatModel` (the Do choice) always win, so existing users keep exactly what they picked. A legacy
  // (pre-BYOK) OpenRouter user gets null here, so their unset roles keep the old per-role resolution (fix round 2);
  // the legacy no-provider construction keeps OpenRouter's shared defaults untouched too.
  const providerDefaultFor = (name, r) => {
    if (!explicitProvider || legacyOpenRouter) return null;
    if (r && r.by === 'user') return null;
    if (name === 'do' && storedDefaultModel) return null;
    return provider.models[name];
  };
  function currentRoute() {
    const r = opts.getRoute ? opts.getRoute(defaultModel) : null;
    const wanted = providerDefaultFor('do', r) || (r && r.model);
    return {
      model: modelOk(wanted) ? wanted : defaultModel,
      effort: r && EFFORTS.includes(r.effort) ? r.effort : 'off',
    };
  }
  function applyRoute() {
    const r = currentRoute();
    if (r.model !== model) {
      log(`chat-brain: Do role model switched (${model} -> ${r.model}); provider pin and reasoning refusals reset`);
      model = r.model;
      routing.provider = null; routing.reasoningOff = true; routing.effortOk = true;
    }
    routing.effort = r.effort;
  }
  const reportUsage = (rec) => { if (opts.onUsage) { try { opts.onUsage(rec); } catch (e) { log(`onUsage failed: ${(e && e.message) || e}`); } } };
  // opts.cliLoginKey (OpenCode Go only, chat-host.mjs): null = not chosen, '' = chosen but not logged in. Chosen never falls back to a pasted key.
  const readKey = () => { const cli = provider.id === 'opencode-go' && opts.cliLoginKey ? opts.cliLoginKey() : null; return cli === null ? keys && keys.read() : cli; };
  const hasKey = () => Boolean(readKey());
  // T-31-MAUS P3 (host-only `__host.modelTurn`): { messages, tools, model? } -> { ok, text, toolCalls, usage, model, ms } | { ok:false, error }.
  // In-flight model turns by the caller's request id: the Rust loop aborts one on a kill or a cancel (modelTurnCancel).
  const turnAborts = new Map();
  async function modelTurn(req) {
    const r = req && typeof req === 'object' ? req : {};
    if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > MODEL_TURN_MAX_MESSAGES || (r.tools !== undefined && !Array.isArray(r.tools))) return { ok: false, error: 'bad_request' };
    // N2: a model the loop named but this module would not send is refused, never swapped for the default model: the
    // loop priced the model it named. Absent (null/undefined) keeps the default model; the Rust loop never sends that.
    if (r.model != null && !modelOk(r.model)) return { ok: false, error: 'bad_model' };
    const key = readKey();
    if (!key) return { ok: false, error: 'no_key' };
    // BYOK: the user's own key pays; an agent turn is bounded only by the per-task cap the Rust loop enforces (tool_gate.rs: 0.50 USD, 40 steps).
    const id = typeof r.requestId === 'string' && r.requestId.length > 0 && r.requestId.length <= 80 ? r.requestId : null;
    const ctrl = new AbortController();
    if (id) turnAborts.set(id, ctrl);
    try {
      return await postModelTurn(r.messages, r.tools || [], key, { fetchImpl: opts.fetchImpl, model: r.model != null ? r.model : model, provider, maxTokens: Number.isInteger(r.maxTokens) && r.maxTokens > 0 ? Math.min(r.maxTokens, 1000) : 1000, signal: ctrl.signal });
    } finally {
      if (id) turnAborts.delete(id);
    }
  }
  // Aborts the provider fetch of one in-flight modelTurn; unknown or finished ids are not an error.
  function cancelModelTurn(id) {
    const ctrl = typeof id === 'string' ? turnAborts.get(id) : null;
    if (ctrl) ctrl.abort();
    return { ok: true, aborted: Boolean(ctrl) };
  }
  const noTools = new Set(); // models the provider refused the memory tool for (R6f)
  let modelsCache = null; // the provider's model list (listModels below), { at, models }
  // A role that may run this turn: switched on, with a model id and effort this module would send.
  function roleOf(name, roles = opts.getRoles ? opts.getRoles(defaultModel, modelsCache ? modelsCache.models : null) : null) {
    const r = roles && roles[name];
    if (!r || r.on === false) return null;
    const m = providerDefaultFor(name, r) || r.model;
    return modelOk(m) && EFFORTS.includes(r.effort) ? { ...r, model: m } : null;
  }
  // One Plan / Check call: its own model + effort, no provider pin, never a retry (the budget is one call per role).
  async function callRole(kind, role, messages, key, { maxTokens, timeoutMs }) {
    const r = await postChat(messages, key, { fetchImpl: opts.fetchImpl, model: role.model, routing: { reasoningOff: true, effort: role.effort, effortOk: true }, maxTokens, timeoutMs, provider });
    const u = r.usage || {};
    reportUsage({ model: role.model, kind, in: u.in || 0, out: u.out || 0, total: u.total || 0, ms: r.ms, ok: r.ok });
    return r;
  }
  // -> the outline text, or null (logged either way, metadata only).
  async function planFor(g, role) {
    const r = await callRole('plan', role, [{ role: 'system', content: withAddress(PLAN_PROMPT) }, { role: 'user', content: g.message }], g.key, { maxTokens: PLAN_MAX_TOKENS, timeoutMs: PLAN_TIMEOUT_MS });
    const outline = r.ok ? cleanReply(r.text).slice(0, OUTLINE_MAX_CHARS) : '';
    if (!outline) { log(`chat-brain: plan skipped (${r.ok ? 'empty_outline' : r.error}) model=${role.model} ms=${r.ms}`); return null; }
    log(`chat-brain: plan ok model=${role.model} effort=${role.effort} ms=${r.ms} usageTotal=${r.usage ? r.usage.total : 'n/a'}`);
    return outline;
  }
  // After the reply ended: -> { verdict, text } | null (Check off, not triggered, or failed -- logged).
  async function checkFor(g, reply) {
    const role = roleOf('check');
    if (!role || !wantsCheck(g.message, reply)) return null;
    const r = await callRole('check', role, [{ role: 'system', content: withAddress(CHECK_PROMPT) }, { role: 'user', content: `Question:\n${g.message}\n\nReply:\n${reply}` }], g.key, { maxTokens: CHECK_MAX_TOKENS, timeoutMs: CHECK_TIMEOUT_MS });
    const v = r.ok ? parseCheck(r.text) : null;
    if (!v) { log(`chat-brain: check skipped (${r.ok ? 'empty_verdict' : r.error}) model=${role.model} ms=${r.ms}`); return null; }
    log(`chat-brain: check ${v.verdict} model=${role.model} effort=${role.effort} ms=${r.ms} usageTotal=${r.usage ? r.usage.total : 'n/a'}`);
    return v;
  }
  const plannedOf = (g) => (g.outline ? { planned: true, outline: g.outline } : {});
  // T-31-ROOM motion P5b: one non-streamed call on the owner's Do model and key for the motion composer (src/main/motion-compose.js
  // builds the messages); a usage line of kind 'compose'. Never logs the brief or the answer.
  async function composeMotion(messages, { timeoutMs }) {
    const key = readKey();
    if (!key) return { ok: false, error: 'no_key' };
    const route = currentRoute();
    const r = await callRole('compose', { model: route.model, effort: route.effort }, messages, key, { maxTokens: COMPOSE_MAX_TOKENS, timeoutMs });
    log(`chat-brain: compose ${r.ok ? 'ok' : r.error} model=${route.model} ms=${r.ms}`);
    return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error };
  }

  function status() {
    if (!hasKey()) return { enabled: false, mode: 'off', reason: `no ${provider.label} key saved` };
    return { enabled: true, mode: 'byo', reason: null, provider: provider.label, model: currentRoute().model };
  }

  // look: the Look up role when this call was the reply on the Look up model (kind 'lookup'), else the Do model.
  const usageOf = (r, look = null) => { const u = r.usage || {}; reportUsage({ model: look ? look.model : model, kind: look ? 'lookup' : 'chat', in: u.in || 0, out: u.out || 0, total: u.total || 0, ms: r.ms, ok: r.ok, ...(look ? { web: Boolean(provider.webSearch) } : {}) }); };
  const reasoningLabel = () => (routing.effort !== 'off' ? (routing.effortOk ? routing.effort : 'model-default') : (routing.reasoningOff ? 'off' : 'model-default'));
  const routeLog = (r) => `provider=${r.provider || 'n/a'} pin=${routing.provider || 'none'} reasoning=${reasoningLabel()} reasoningTokens=${r.reasoningTokens ?? 'n/a'}`;
  function updatePin(r) {
    if (r.ok && r.provider && typeof r.firstTokenMs === 'number' && r.firstTokenMs <= PIN_MAX_FIRST_TOKEN_MS) routing.provider = r.provider;
    else routing.provider = null;
  }
  function noteReasoningRefusal(r) {
    if (!r.reasoningRefused) return false;
    if (routing.effort !== 'off') {
      if (!routing.effortOk) return false;
      routing.effortOk = false;
      log(`chat-brain: model=${model} refused reasoning effort=${routing.effort} (http_400); retrying with the model's default reasoning while this model is in use`);
      return true;
    }
    if (!routing.reasoningOff) return false;
    routing.reasoningOff = false;
    log(`chat-brain: model=${model} refused reasoning-off (http_400); retrying with the model's default reasoning for this session`);
    return true;
  }
  // `host`: what only the host may add to a turn ({ memoryBlock, voiceNote }), never read from the page's object `p` (Electron's main.js passes
  // the page's talk:turn payload through as-is). The block is cut to MEMORY_BLOCK_MAX_CHARS whatever the caller sends.
  function gate(p, host = null) {
    const key = readKey();
    applyRoute();
    if (!key) return { stop: { ok: false, error: { code: 'talk_off', message: `no ${provider.label} key saved`, retryable: false } } };
    return {
      key,
      message: String((p && p.message) || '').slice(0, MESSAGE_MAX_CHARS),
      history: Array.isArray(p && p.history) ? p.history.slice(-HISTORY_MAX) : [],
      // boardDigest: a plain string from board-reader.mjs, fetched by the IPC handler before calling turn() (main.js
      // owns the ESM import; chat-brain.js stays CJS and board-blind beyond this one optional string).
      boardDigest: typeof (p && p.boardDigest) === 'string' ? p.boardDigest : undefined,
      memoryBlock: host && typeof host.memoryBlock === 'string' && host.memoryBlock ? host.memoryBlock.slice(0, MEMORY_BLOCK_MAX_CHARS) : undefined,
      // The anti-repeat note (voice-note.mjs), host only, cut to VOICE_NOTE_MAX_CHARS. Only the reply's own request carries it:
      // `message` (history, memory grounding, Plan, Check) stays the user's words.
      voiceNote: host && typeof host.voiceNote === 'string' && host.voiceNote ? host.voiceNote.slice(0, VOICE_NOTE_MAX_CHARS) : undefined,
      // R6f: the reply model's memory tool, from the host only ({ tool, apply(args) -> { result } }); the page can never supply one.
      memoryTool: host && host.memoryTool && host.memoryTool.tool && typeof host.memoryTool.apply === 'function' ? host.memoryTool : null,
      // null = the page sent something that is not a list of allowed images (turnStream / turn refuse it before any call).
      images: cleanImages(p && p.images),
    };
  }

  // One non-streamed call (+ one retry if the model refuses reasoning-off) -> the turn() result shape. Always the Do
  // model, never the web plugin; a Plan outline of this turn is still followed.
  async function nonStreamed(g, why) {
    const { key, message, history, boardDigest, outline, memoryBlock, voiceNote, images } = g;
    let r = await callChat(message, history, key, { fetchImpl: opts.fetchImpl, boardDigest, outline, soul: soulOf(), memoryBlock, voiceNote, images, model, routing, provider, publicBuild, motionRule });
    // Logged for success AND failure alike -- a real call left the provider either way (usage-ledger plan item 2).
    usageOf(r);
    if (!r.ok && noteReasoningRefusal(r)) { r = await callChat(message, history, key, { fetchImpl: opts.fetchImpl, boardDigest, outline, soul: soulOf(), memoryBlock, voiceNote, images, model, routing, provider, publicBuild, motionRule }); usageOf(r); }
    if (!r.ok) {
      const f = failureOf(r);
      log(`chat-brain turn failed: ${r.error} (${f.code}${f.retryable ? '' : ', not retryable'})${why ? ` (non-streamed fallback after: ${why})` : ''}`);
      return failedTurn(f, r.error, r.status, key);
    }
    const parsed = parseReplyIntent(r.text, message);
    if (!parsed.reply) { log('chat-brain turn failed: reply was only a gesture tag'); return { ok: false, error: { code: 'upstream', message: 'bad_response', retryable: true } }; }
    noteKey('works', key);
    // Metadata only — never the message or the reply text — so a real turn is verifiable from the app log alone.
    log(`chat-brain: turn ok model=${model} stream=0${why ? ' fallback=1' : ''} latencyMs=${r.ms} headersMs=${r.headersMs} usageTotal=${r.usage ? r.usage.total : 'n/a'} ${routeLog(r)} intent=${parsed.intent} intentBy=${parsed.by}${outline ? ' planned=1' : ''}`);
    return { ok: true, reply: parsed.reply, analysis: null, explains: false, gesture: gestureFor(parsed.intent, parsed.emotion), emotion: parsed.emotion, motion: parsed.motion, model, latencyMs: r.ms, usage: r.usage, ...plannedOf(g) };
  }

  // R6c C item 5: a turn whose images are wrong, or whose model cannot read images, ends here: no call, nothing leaves the machine.
  // The head is a failed turn like any other (code no_vision / bad_image); the renderer shows its own words for each.
  async function imageStop(g) {
    if (g.images === null) return { ok: false, error: { code: 'bad_image', message: 'bad_image', retryable: false } };
    if (!g.images.length) return null;
    let entry = null;
    if (provider.id === 'openrouter') { const l = await listModels(); entry = l.ok ? l.models.find((m) => m.id === model) : null; }
    if (modelReadsImages(provider.id, model, entry)) return null;
    log(`chat-brain: no_vision (${g.images.length} image(s) not sent) model=${model}`); // count only: never the bytes
    return { ok: false, error: { code: 'no_vision', message: 'no_vision', retryable: false, providerId: provider.id } };
  }

  async function turn(p) {
    const g = gate(p);
    if (g.stop) return g.stop;
    return (await imageStop(g)) || nonStreamed(g, null);
  }

  // Streamed turn -> Promise<{ head, live }>. `head` is what talk:turn returns to the renderer (turn() shape plus
  // streaming:true and timing), resolved at the first speakable clause; `live` (createLiveReply, main-process only)
  // carries the rest of the text and the final reply. A non-streamed fallback or a refusal returns live: null.
  // timing: epoch ms { requestAt, firstTokenAt, firstClauseAt } so the renderer can line them up with its own clock.
  // Models by role (header comment): a Plan outline first when the message asks for one (head.planned/outline), the
  // reply on the Look up model + web plugin when it needs fresh facts (final.sources), a Check after the reply ended.
  async function turnStream(p, host = null) {
    const g = gate(p, host);
    if (g.stop) return { head: g.stop, live: null };
    const stop = await imageStop(g);
    if (stop) return { head: stop, live: null };
    const timing = { requestAt: Date.now(), firstTokenAt: null, firstClauseAt: null };
    const turnId = p && typeof p.turnId === 'string' && p.turnId && p.turnId.length <= 128 ? p.turnId : null;
    const turnCtl = new AbortController();
    if (turnId) activeTurns.set(turnId, turnCtl); // from here a barge-in (abortTurn) cuts the plan wait and the stream
    const roles = opts.getRoles ? opts.getRoles(defaultModel, modelsCache ? modelsCache.models : null) : null;
    const planRole = roleOf('plan', roles);
    const lookRole = roleOf('lookup', roles);
    // A message with images stays on the Do model: no Plan outline, no Look up, no Check (those roles would not see the picture).
    const seeing = g.images.length > 0;
    g.outline = !seeing && planRole && wantsPlan(g.message) ? await planFor(g, planRole) : null;
    const look = !seeing && lookRole && wantsLookup(g.message) ? lookRole : null;
    // The Look up call has its own routing: never the Do model's provider pin or remembered refusals.
    const lookRouting = look ? { provider: null, reasoningOff: true, effort: look.effort, effortOk: true } : null;
    const turnModel = look ? look.model : model;
    const messages = buildMessages(g.message, g.history, g.boardDigest, g.outline, soulOf(), g.memoryBlock, publicBuild, g.images, g.voiceNote, motionRule);
    const live = createLiveReply();
    let parser;
    let chunker;
    let headSent = false;
    let intent = null;
    let intentBy = null;
    let emotion = null;
    let resolveHead;
    const headP = new Promise((r) => { resolveHead = r; });
    const sendHead = () => {
      headSent = true;
      timing.firstClauseAt = Date.now();
      intent = parser.lead() || ruleIntent(parser.clean(), g.message);
      intentBy = parser.lead() ? 'tag' : 'rules';
      emotion = parser.emotion() || null;
      live.push(parser.clean());
      resolveHead({ ok: true, streaming: true, reply: parser.clean(), analysis: null, explains: false, gesture: gestureFor(intent, emotion), emotion, motion: parser.motion(), model: turnModel, latencyMs: timing.firstClauseAt - timing.requestAt, usage: null, timing, ...plannedOf(g) });
    };
    const feed = (added) => {
      if (!added) return;
      chunker.push(added);
      if (headSent) live.push(parser.clean());
      else if (parser.lead() !== undefined && chunker.count() > 0) sendHead();
    };
    // R6f: the reply model may hold the host's memory tool (a Look up call never does: it has its own routing). One request either way; a
    // model the provider refuses the tool for is asked again without it, and not offered it again while this model is in use.
    let tools = g.memoryTool && !look && !noTools.has(turnModel) ? [g.memoryTool.tool] : null;
    let thread = messages;
    let toolChoice = 'auto';
    const attempt = () => {
      parser = createReplyParser();
      chunker = createStreamChunker();
      return streamChat(thread, g.key, {
        fetchImpl: opts.fetchImpl, model: turnModel, routing: lookRouting || routing, plugins: look ? WEB_PLUGIN : null, provider, tools, toolChoice,
        onDelta: (d) => { if (timing.firstTokenAt === null) timing.firstTokenAt = Date.now(); feed(parser.push(d)); },
        signal: turnCtl.signal,
      });
    };
    // Barge-in: keep only what was already pushed (nothing after the abort: no parser.end() flush), no Check, no retry,
    // no non-streamed fallback; the head is a plain failure when no clause had gone out yet.
    const endAborted = (r) => {
      if (r.headersMs !== undefined) usageOf(r, look); // a request really went out; an abort before it is no call
      const reply = headSent ? live.text() : '';
      log(`chat-brain: turn aborted (barge-in) model=${turnModel} headSent=${headSent ? 1 : 0} keptChars=${reply.length}`);
      if (!headSent) resolveHead({ ok: false, error: { code: 'aborted', message: 'aborted', retryable: false } });
      live.end({ ok: false, reply, error: 'aborted', emotion, sources: [] });
      live.check(null);
    };
    const lookLog = (r) => `provider=${r.provider || 'n/a'} pin=none reasoning=${look.effort} reasoningTokens=${r.reasoningTokens ?? 'n/a'}`;

    (async () => {
      let r = await attempt();
      if (r.error === 'aborted') return endAborted(r);
      usageOf(r, look);
      if (!look && !r.ok && !headSent && noteReasoningRefusal(r)) {
        r = await attempt();
        if (r.error === 'aborted') return endAborted(r);
        usageOf(r);
      }
      if (tools && !r.ok && !r.reasoningRefused && !headSent && TOOLS_REFUSED_STATUS.has(r.status)) { noTools.add(turnModel); tools = null; log(`chat-brain: model=${turnModel} refused the memory tool (http_${r.status}); asking again without it while this model is in use`); r = await attempt(); if (r.error === 'aborted') return endAborted(r); usageOf(r); }
      // R6f: the model changed a saved note. The host applies the call; the result goes back to the model and the reply streams once more, so it
      // confirms in one sentence. Only a turn that called the tool pays this second request. A reply that already started speaking is left as it is.
      if (r.ok && r.toolCalls && r.toolCalls.length && g.memoryTool) {
        const calls = r.toolCalls.slice(0, 2);
        const done = [];
        for (const c of calls) { let result = ''; try { if (c.name === g.memoryTool.tool.function.name) result = String((await g.memoryTool.apply(c.args)).result || ''); } catch (e) { log(`chat-brain: memory tool failed: ${scrub((e && e.message) || String(e), g.key)}`); } done.push({ c, result: result || 'Nothing was changed.' }); }
        if (!headSent && !parser.raw().trim()) {
          thread = [...messages, { role: 'assistant', content: null, tool_calls: done.map(({ c }) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) }, ...(c.extra ? { extra_content: c.extra } : {}) })) }, ...done.map(({ c, result }) => ({ role: 'tool', tool_call_id: c.id, content: result }))];
          toolChoice = 'none';
          r = await attempt();
          if (r.error === 'aborted') return endAborted(r);
          usageOf(r);
        }
      }
      const routeLine = look ? lookLog(r) : routeLog(r); // before updatePin, so `pin=` says what THIS call asked for
      if (!look) updatePin(r); // the pin is the Do model's; a Look up call neither sets nor drops it
      const sources = look ? r.sources : [];
      const roleTags = `${g.outline ? ' planned=1' : ''}${look ? ` lookup=1 sources=${sources.length}` : ''}`;
      if (!headSent) {
        // Short reply that ended before its first chunk boundary: the whole reply is the first clause.
        if (r.ok) { feed(parser.end()); if (!headSent && parser.clean()) { chunker.end(); sendHead(); } }
        if (!headSent) {
          const why = r.ok ? 'stream_reply_empty' : r.error;
          live.end({ ok: false, reply: '', error: why, sources: [] });
          live.check(null);
          // A refused key/account (401/402/403) or an out-of-funds body is never worth a second call. A 429 on a FREE
          // provider (gemini/groq) is that tier's quota -- also no second call. On OpenRouter a 429 keeps the PREVIOUS
          // behaviour (one non-streamed fallback, T-31 fix r item 6): a paid key's rate limit can clear on a retry, and
          // when it does not the fallback still yields the same 'quota' code. Holds on the Look up path too.
          const noFallback = NO_FALLBACK_STATUS.has(r.status) || r.insufficient === true || (r.quota && provider.id !== 'openrouter');
          if (!r.ok && noFallback) {
            const f = failureOf(r);
            log(`chat-brain turn failed: ${r.error} (stream${look ? ' lookup' : ''}; ${f.code}, no fallback)`);
            resolveHead(failedTurn(f, r.error, r.status, g.key));
            return;
          }
          if (look) {
            log(`chat-brain: lookup failed before the first clause (${why}) model=${look.model}; falling back to one non-streamed Do call without web search`);
            resolveHead(await nonStreamed(g, `lookup_${why}`));
            return;
          }
          log(`chat-brain: stream failed before the first clause (${why}); falling back to one non-streamed call`);
          resolveHead(await nonStreamed(g, why));
          return;
        }
      }
      feed(parser.end());
      const reply = parseReplyIntent(parser.raw(), g.message).reply;
      emotion = parser.emotion() || null;
      const ms = (n) => (typeof n === 'number' ? n - timing.requestAt : 'n/a');
      if (r.ok) {
        if (reply) noteKey('works', g.key);
        log(`chat-brain: turn ok model=${turnModel} stream=1 firstTokenMs=${ms(timing.firstTokenAt)} firstClauseMs=${ms(timing.firstClauseAt)} latencyMs=${r.ms} headersMs=${r.headersMs} usageTotal=${r.usage ? r.usage.total : 'n/a'} ${routeLine} intent=${intent} intentBy=${intentBy} emotion=${emotion || 'none'}${roleTags}`);
        live.end({ ok: true, reply, emotion, usage: r.usage, latencyMs: r.ms, sources });
        // Check starts only now: the reply is final and already being spoken, so it never delays the voice.
        live.check(seeing ? null : await checkFor(g, reply));
      } else {
        // Already speaking: keep what was said, say plainly in the log that the rest never came.
        log(`chat-brain: stream broke after the first clause (${r.error}); keeping the ${reply.length} chars already received. model=${turnModel} firstTokenMs=${ms(timing.firstTokenAt)} firstClauseMs=${ms(timing.firstClauseAt)} ${routeLine} intent=${intent} intentBy=${intentBy} emotion=${emotion || 'none'}${roleTags}`);
        live.end({ ok: false, reply, error: r.error, emotion, latencyMs: r.ms, sources });
        live.check(null);
      }
    })().catch((e) => {
      const msg = scrub((e && e.message) || String(e), g.key);
      log(`chat-brain turn failed: internal ${msg}`);
      live.end({ ok: false, reply: parser ? cleanReply(parser.raw()) : '', error: 'internal', sources: [] });
      live.check(null);
      if (!headSent) resolveHead({ ok: false, error: { code: 'upstream', message: 'internal', retryable: true } });
    }).finally(() => { if (turnId && activeTurns.get(turnId) === turnCtl) activeTurns.delete(turnId); });

    const head = await headP;
    return { head, live: head.streaming ? live : null };
  }

  // Settings > Models by role picker: the provider's model list, cached for MODELS_TTL_MS (a failed fetch is not cached).
  async function listModels() {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return { ok: true, models: modelsCache.models };
    // BYOK: the free providers are not fetched; the table's per-role ids are the list (no network, no key sent).
    const r = provider.id === 'openrouter' ? await fetchModelList(opts.fetchImpl) : { ok: true, models: providerModels(provider) };
    if (r.ok) modelsCache = { at: Date.now(), models: r.models };
    else log(`chat-brain: model list unavailable (${r.error})`);
    return r;
  }

  return { status, turn, turnStream, abortTurn, composeMotion, hasKey, modelTurn, cancelModelTurn, listModels, defaultModel, provider, legacyOpenRouter, routing: () => ({ ...routing }) };
}

module.exports = { MOVE_RULE, createChatBrain, abortTurn, buildMessages, callChat, streamChat, parseCheck, fetchModelList, assertAllowedUrl, parseReplyIntent, createReplyParser, ruleIntent, isClaudeModel, classifyUpstreamError, SPEECH_INTENTS, EMOTIONS, EMOTION_PRESETS, ALLOWED_ORIGIN, CHAT_PATH, MODELS_PATH, MODEL, MODEL_ID_RE, EFFORTS, SYSTEM_PROMPT, BOARD_RULE, PIN_MAX_FIRST_TOKEN_MS, FIRST_TOKEN_MS, IDLE_MS };
