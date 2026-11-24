// T-31 parity step 6 (network half): the AI/chat handlers and their push events. Gate: GATE-step6-hosts.md.
//
// This module owns the network half of the AI surface, reusing the frozen Electron modules UNCHANGED:
//   src/main/chat-brain.js   talk.turn / talk.status / talk.gesture / talk.brainInfo, the stream, the role calls
//   src/main/brain-key.js    brainKey.save / test, ai.testKey
//   src/main/role-models.js  roles.get / set / setOn / reset / models (the same pure rules)
//   src/main/board-reader.mjs  the board digest for a turn (the preview's liveBoard view is genuinely unconfigured)
//   src/main/cloud.js        talk.status fallback and talk.gesture (the flavour's cloudBase; no base -> off)
//
// Keys only ever travel through the vault adapter (`safeStorage`) into the same encrypted `*-key.bin` files Electron
// writes. No key is logged, returned or emitted. Errors keep the modules' own strings (http_<status>, timeout, network,
// bad_response, stream_error_*, talk_off, the quota provider-named shape) plus the egress code words.
//
// Electron reference: src/main/main.js :965-1038 (talk), :1084-1200 (roles), :1015-1072 (ai). Frozen: not edited.
import path from 'node:path';
import { createRequire } from 'node:module';

import { seedRedactNamesIfMissing, loadRedactNames } from '../../src/main/board-redact.mjs';
import { readRedactStrict } from './phone-extras.mjs';
import { createBoardReader } from '../../src/main/board-reader.mjs';
import { MEMORY_TOOL, applyMemoryCall, newMemoryTurn, ownWords } from './memory-chat.mjs';
import { NOTES_HEAD } from './memory-notes.mjs';
import { voiceNoteOf, VOICE_NOTE_RING } from '../../src/main/voice-note.mjs';

const require = createRequire(import.meta.url);
const { PROVIDERS } = require('../../src/main/providers.js');
const { createChatBrain } = require('../../src/main/chat-brain.js');
const { readCliGoKey } = require('../../src/main/opencode-cli-login.js');
const { createKeyStore } = require('../../src/main/reflex-jev.js');
const { resolveRoles, setRoleChoice, resetRoleChoice, setRoleOn, WIRED_ROLES, withoutClaude } = require('../../src/main/role-models.js');
const { appendUsage } = require('../../src/main/usage-ledger.js');
const { createCloud } = require('../../src/main/cloud.js');
const { soulPrefs } = require('../../src/main/soul-prefs.js');
const { createMotionComposer } = require('../../src/main/motion-compose.js');

// main.js's liveReplies TTL (60 s): the renderer/voice holds the rest of the stream by turnId.
const LIVE_REPLY_TTL_MS = 60000;

// The no-live-board view (step 6; step 10a passes the real liveBoard, this stays the fallback when a caller builds the
// chat host alone, e.g. a focused unit). board-reader.mjs short-circuits before any network call on this status.
const OFFLINE_LIVE_BOARD = Object.freeze({
  status: () => ({ mode: 'local', configured: false, locked: true }),
  bridgePort: async () => null,
});

// Redact the active key from text that leaves the sidecar. Condition 7: a provider reply (or the fixture's reply) that
// echoes the key must not put it in an rpc result or an event. Electron's chat-brain scrubs errors, not reply text;
// this is the Tauri-side net the gate asks for. While a partial key sits at the tail, hold it back (replyMore is the
// cumulative text, so nothing is lost: the next push carries it, redacted once complete).
export function keyRedactor(key) {
  if (typeof key !== 'string' || !key) return (s) => String(s ?? '');
  return function redact(text) {
    const s = String(text ?? '');
    let cut = s.length;
    const max = Math.min(key.length - 1, s.length);
    for (let n = max; n > 0; n--) if (s.endsWith(key.slice(0, n))) { cut = s.length - n; break; }
    return s.slice(0, cut).split(key).join('***');
  };
}

/**
 * @param {{ dataDir: string, settings: () => object, saveSettings: (patch: object) => object,
 *           ai: object, secretStores: () => Promise<object>, safeStorage: object, flavour: {values: object},
 *           emit: (channel: string, payload: unknown) => boolean, aiCore: { rememberCited: (s: unknown) => void },
 *           egress: { provider: Function, cloud: Function, mirror: Function },
 *           boardFetch?: Function, liveBoard?: object, log?: (m: string) => void }} o
 */
export function createChatHost({
  dataDir, settings, saveSettings, ai, secretStores, safeStorage, flavour, emit, aiCore,
  egress, boardFetch = null, liveBoard, log = () => {},
  // Step 12-1: the --settings-shots fixtures only. `chatFetch`/`providerFetch` replace the provider endpoints for
  // THIS run (never a normal one); `roleFixture` supplies the Models-by-role list. All null outside a shots launch.
  roleFixture = null, chatFetch = null, providerFetch = null,
  cliAuthFile = undefined, // a check's fixture file; undefined = the CLI's own auth.json
  // Electron main.js:1845: a --selftest run (and a --demo-fixture rehearsal) talks to recorded answers, never a server:
  // `cloudFixtureFile` switches the cloud to createCloud's 'fixture' mode. null on every normal launch.
  cloudFixtureFile = null,
  // T-31 alpha.12 agent-core seams: the user's soul (read every turn) and the rhythm's `chat` event on a good reply.
  getSoul = null, onReplyOk = null, appVersion = null,
  // launch-scope memory (memory-notes.mjs): `recall(message)` -> the notes block for this turn, or null. null = no memory.
  memory = null,
}) {
  const fv = (flavour && flavour.values) || {};
  const ownerAdmin = fv.ownerAdmin === true;

  // Board digest: the same reader Electron builds, over the SAME liveBoard step 10a's board rpcs use (the constant
  // view stays only as the no-host fallback) and the flavour's mirror (owner builds only). Redaction follows the same
  // owner setting; the name list is seeded once, never overwritten.
  const redactFile = path.join(dataDir, 'redact-names.json');
  try { seedRedactNamesIfMissing(redactFile); } catch { /* a read-only data dir only means no seed */ }
  // `boardFetch` is main.mjs's reader transport: the live bridge's dynamic loopback port through the base fetch, and
  // the fixed owner mirror through the step-6 guard. egress.mirror alone would refuse the bridge (its port is not a
  // static allowed origin), leaving every live read "offline"; without it, the mirror keeps the guard.
  const boardReader = createBoardReader({
    liveBoard: liveBoard || OFFLINE_LIVE_BOARD,
    mirrorOrigin: fv.boardMirror || null,
    fetchImpl: boardFetch || egress.mirror,
    getRedact: () => ({ sendClientNames: settings().sendClientNamesToAi === true, names: loadRedactNames(redactFile), mask: settings().uiLang === 'vi' ? '[khách hàng]' : '[client]' }),
    log: (m) => log(`[board-reader] ${m}`),
  });

  // Cloud transport (talk.status fallback + talk.gesture): the flavour's cloudBase only; no base is Electron's honest
  // "this build has no talk server configured". No device token in the preview -> talk stays off (cloud.status()).
  const cloud = createCloud({
    mode: cloudFixtureFile ? 'fixture' : 'auto', fixtureFile: cloudFixtureFile || undefined,
    base: fv.cloudBase || null, safeStorage, tokenDir: dataDir,
    fetchImpl: egress.cloud, log: (m) => log(`[talk] ${m}`),
  });

  const onUsage = (rec) => { try { appendUsage(dataDir, rec); } catch { /* never a chat failure */ } };
  // The OpenCode CLI login as Go's key source: owner build, Go selected, and only after his click (settings goCliLogin, a boolean; the key is
  // read per call and never stored). The renderer gets { active, source } and nothing else.
  const cliChosen = () => ownerAdmin && ai.providerId() === 'opencode-go' && settings().goCliLogin === true;
  const cliRead = () => readCliGoKey({ file: cliAuthFile, shape: PROVIDERS['opencode-go'].keyShape });
  const cliView = () => (cliChosen() ? { active: Boolean(cliRead()), source: 'opencode-cli' } : { active: false, source: 'key-file' });
  const buildChatBrain = () => createChatBrain({
    safeStorage, dir: dataDir, appVersion, motionRule: true, // the [move: ...] tag (T-31-ROOM motion P4): the 3D room lives in this host
    cliLoginKey: () => (cliChosen() ? cliRead() || '' : null),
    onKeyResult: (check, usedLast4) => { brainKey().then((b) => b.noteChatResult(check, usedLast4)).catch((e) => log(`[chat-brain] key result not saved: ${(e && e.message) || e}`)); },
    // main.js: model = free mode ? undefined : settings.chatModel; provider/legacy read per build.
    model: ai.mode() === 'free' ? undefined : settings().chatModel,
    onUsage,
    provider: ai.provider(),
    legacyDefaults: ai.legacyDefaults(),
    getRoute: (defaultModel) => resolveRoles(settings().roleModels, defaultModel).roles.do,
    getRoles: (defaultModel, models) => resolveRoles(settings().roleModels, defaultModel, (roleFixture && roleFixture.roleModels()) || models).roles,
    getSoul: () => (typeof getSoul === 'function' ? getSoul() : null),
    publicBuild: !ownerAdmin, // the persona says "the user", with no board / code-session sentence (soul-prefs.js)
    fetchImpl: chatFetch || egress.provider,
    log: (m) => log(`[chat-brain] ${m}`),
  });
  let chatBrain = buildChatBrain();
  const motionComposer = createMotionComposer({ callModel: (messages, opts) => chatBrain.composeMotion(messages, opts) }); // reads the brain live (rebuild())

  let brainKeyMod = null;
  const brainKey = async () => {
    if (!brainKeyMod) brainKeyMod = (await secretStores()).brainKey({ fetchImpl: providerFetch || egress.provider, getProvider: ai.providerId });
    return brainKeyMod;
  };

  // Which providers have a saved key (booleans only, never a key or its last4). The talk panel's "switch provider"
  // action needs this to offer a preset the user can actually run; `ai.presetList` carries it under `keys`.
  const keyPresence = () => {
    const out = {};
    for (const p of Object.values(PROVIDERS)) {
      try { out[p.id] = Boolean(createKeyStore({ safeStorage, dir: dataDir, name: p.keyName, shape: p.keyShape }).read()); }
      catch { out[p.id] = false; }
    }
    if (cliView().active) out['opencode-go'] = true;
    return out;
  };

  // The plaintext key, read from the same vault-backed store, only to redact it out of reply text. Never logged.
  const keyStores = new Map();
  const keyForScrub = () => {
    try {
      if (cliChosen()) return cliRead();
      const p = ai.provider();
      if (!keyStores.has(p.id)) keyStores.set(p.id, createKeyStore({ safeStorage, dir: dataDir, name: p.keyName, shape: p.keyShape }));
      return keyStores.get(p.id).read();
    } catch { return null; }
  };

  let turnSeq = 0; // the latest talk.turn; a memory call of an older one is dropped (R6f)
  // M2 (T-31-YOKI): the last VOICE_NOTE_RING final replies of this session, RAM only, never written anywhere. Typed and voice turns share
  // talk.turn, so one ring serves both. Feeds voice-note.mjs, whose note rides to chat-brain as host.voiceNote.
  const recentReplies = [];
  const ringReply = (reply) => { if (typeof reply === 'string' && reply) { recentReplies.push(reply); if (recentReplies.length > VOICE_NOTE_RING) recentReplies.shift(); } };
  const liveReplies = new Map(); // turnId -> createLiveReply (step 8b's talk.tts consumes it; 60 s TTL)
  const dispose = () => liveReplies.clear();
  // Step 8b: talk.tts takes the live reply exactly once (main.js:1328-1329: get, then delete).
  const takeLiveReply = (turnId) => {
    const live = liveReplies.get(turnId);
    if (live) liveReplies.delete(turnId);
    return live || null;
  };

  // ---- roles (main.js :1084-1200) ----
  // S1 (CoS 22-10): Gemini may not call the provider before the stored 18+ confirmation, and that includes the
  // metadata paths that reach the provider with the saved key. Electron never reaches this module.
  const geminiAgeBlocked = () => ai.providerId() === 'gemini' && settings().age18Confirmed !== true;
  const ageBlockedReply = () => ({ ok: false, error: 'age_confirm_required', message: 'age_confirm_required', models: [] });
  const noClaude = (listModels) => async () => { const r = await listModels(); return r && r.ok ? { ...r, models: withoutClaude(r.models) } : r; };
  function roleProvider() {
    // Step 12-1 (--settings-shots only): the fixture list, still gated on a saved key so the "no provider yet" shot
    // before the key is saved reads exactly like Electron's.
    if (roleFixture) {
      if (!chatBrain || !chatBrain.hasKey()) return null;
      const f = roleFixture.list();
      if (!f) return null;
      return { label: f.provider, defaultModel: f.defaultModel, listModels: noClaude(async () => ({ ok: true, models: f.models })) };
    }
    if (!chatBrain || !chatBrain.hasKey()) return null;
    const table = chatBrain.provider.models;
    return {
      label: chatBrain.status().provider,
      caps: { webSearch: Boolean(chatBrain.provider.webSearch), effort: Boolean(chatBrain.provider.sendsEffort) },
      defaultModel: chatBrain.defaultModel,
      // S1 covers the model-list path too (a metadata call that carries the saved key). The key TEST stays open.
      listModels: noClaude(() => (geminiAgeBlocked() ? ageBlockedReply() : chatBrain.listModels())),
      ...(chatBrain.legacyOpenRouter ? {} : { roleDefaults: { ...table, do: chatBrain.defaultModel } }),
    };
  }
  async function rolesView() {
    const p = roleProvider();
    if (!p) return { provider: null };
    const list = await p.listModels();
    return { provider: { label: p.label, ...p.caps }, ...resolveRoles(settings().roleModels, p.defaultModel, list && list.ok ? list.models : null, p.roleDefaults), wired: WIRED_ROLES };
  }

  const handlers = {
    // ---- talk (main.js :960-1038) ----
    'talk.status': () => (chatBrain.hasKey() ? chatBrain.status() : cloud.status()),
    // T-31-MAUS P3: the Rust agent loop's one model call (host-only, not in the inventory). Model call only: no tool runs here.
    '__host.modelTurn': (req) => (chatBrain ? chatBrain.modelTurn(req) : { ok: false, error: 'no_key' }),
    // Aborts one in-flight modelTurn by its requestId (the Rust loop on a kill or cancel).
    '__host.modelTurnCancel': (id) => (chatBrain ? chatBrain.cancelModelTurn(id) : { ok: true, aborted: false }),

    'talk.turn': async (p) => {
      if (!chatBrain.hasKey()) {
        // R6c C item 5: an attached image is for the person's own provider only; Zumi's talk server is never sent one.
        if (p && p.images !== undefined && !(Array.isArray(p.images) && p.images.length === 0)) return { ok: false, error: { code: 'no_vision', message: 'no_vision', retryable: false } };
        return cloud.turn(p);
      }
      // S1 (CoS 22-10, owner answer C): Google's terms require Gemini API users to be 18+. A renderer-only check can be
      // bypassed, so a saved Gemini key without the stored confirmation fails closed HERE, before the board read and
      // before any provider fetch. This also covers users who saved a Gemini key before this step. Other providers are
      // untouched, and Electron never reaches this module.
      if (ai.providerId() === 'gemini' && settings().age18Confirmed !== true) {
        return { ok: false, error: { code: 'age_confirm_required', message: 'age_confirm_required', retryable: false } };
      }
      // The live-board digest (and chat-brain's rule that names the owner's board) is owner material: only an owner build has a
      // live board to read. A public or official build sends neither (release 0.3.0 review: "the owner's live task board" was
      // in every stranger's prompt, with an always-unavailable digest). getDigestText never throws.
      const boardDigest = ownerAdmin ? await boardReader.getDigestText() : undefined;
      // The notes block comes from this host only, as turnStream's second argument (chat-brain never reads it from the page's
      // object). A memory read that fails costs this turn its notes, never the reply; the failure is logged (no text).
      let memoryBlock;
      let memoryTool = null; // R6f: the reply model's memory_update tool (memory-chat.mjs), offered only while a saved note is quoted to it
      let forgot = false; // this turn asked to forget a note: its own sentence says the fact, so it is not kept
      const mine = ++turnSeq;
      if (memory) {
        const said = p && typeof p.message === 'string' ? p.message : '';
        try { memoryBlock = memory.recall(said) || undefined; }
        catch (e) { log(`[memory] recall failed: ${(e && e.message) || e}`); }
        // A correction or a "forget" said in plain chat or voice (the same talk.turn) is the reply model's own call, as upstream's memory_update: no
        // cue test, no call in front of the reply, so a turn that corrects nothing costs nothing. A barge-in (a newer talk.turn) drops the call of
        // the turn the person moved on from, so a note never changes after that.
        // R6g: the tool is offered only on the person's own words: a picture, a pasted page or file (long, several lines, markup) never reaches a write.
        const pictured = p && p.images !== undefined && !(Array.isArray(p.images) && p.images.length === 0);
        if (memoryBlock && memoryBlock.includes(NOTES_HEAD) && !pictured && ownWords(said)) {
          const turn = newMemoryTurn(said); // shared by every call of this turn: one write at most
          memoryTool = {
            tool: MEMORY_TOOL,
            apply: async (args) => {
              if (mine !== turnSeq) { log('[memory] chat call dropped: the person moved on'); return { result: 'Nothing was changed. Carry on with the reply without mentioning it.' }; }
              const r = applyMemoryCall(memory, args, turn, log);
              if (r.forgot) forgot = true;
              return r;
            },
          };
        }
      }
      // Nothing worn -> '' -> chat-brain adds nothing and the prompt is byte-identical (scripts/check-voice-wire.mjs). A note-building failure
      // costs this turn its hint, never the reply; the failure is logged (no text).
      let voiceNote = '';
      // The per-message language note (3.2) rides in the same note, only while the soul's reply language is `auto`; a fixed language wins.
      try { voiceNote = voiceNoteOf(recentReplies, p && typeof p.message === 'string' ? p.message : '', { langAuto: soulPrefs({ soul: typeof getSoul === 'function' ? getSoul() : null }).replyLang === 'auto' }); }
      catch (e) { log(`[voice-note] skipped: ${(e && e.message) || e}`); }
      let { head, live } = await chatBrain.turnStream({ ...(p && typeof p === 'object' ? p : {}), boardDigest }, { memoryBlock, memoryTool, voiceNote });

      // R6c C: a finished reply is kept with the sentence, on this device, while Memory is on (addTurn says no when it is off). Only the
      // text is kept. A failure costs this turn its place in the list, never the reply; the failure is logged (no text).
      const sentence = p && typeof p.message === 'string' ? p.message : '';
      const keepId = p && typeof p.turnId === 'string' && p.turnId ? p.turnId : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const keepTurn = (reply) => {
        ringReply(reply); // the ring is the session's own replies for the hint; it does not depend on Memory being on
        if (!memory || typeof memory.addTurn !== 'function' || forgot) return;
        try { memory.addTurn(keepId, sentence, reply); } catch (e) { log(`[memory] could not keep the turn: ${(e && e.message) || e}`); }
      };
      const key = keyForScrub();
      const clean = keyRedactor(key);
      // 429 / 402 wording, ported verbatim from main.js:977-981.
      if (head && head.error && head.error.code === 'quota') head = { ...head, error: { ...head.error, provider: ai.provider().label, free: ai.providerId() === 'gemini' || ai.providerId() === 'groq' } };
      if (head && head.error && head.error.code === 'credit') head = { ...head, error: { ...head.error, provider: ai.provider().label } };
      if (head && head.error && typeof head.error.message === 'string') head = { ...head, error: { ...head.error, message: clean(head.error.message) } };
      if (head && typeof head.reply === 'string') head = { ...head, reply: clean(head.reply) };
      const turnId = p && typeof p.turnId === 'string' ? p.turnId : null;
      if (live && turnId) {
        liveReplies.set(turnId, live);
        setTimeout(() => liveReplies.delete(turnId), LIVE_REPLY_TTL_MS).unref();
        live.onText((text) => emit('talk:replyMore', { turnId, text: clean(text) }));
        live.final.then((fin) => {
          aiCore.rememberCited(fin.sources);
          if (fin.ok && typeof onReplyOk === 'function') { try { onReplyOk(); } catch (e) { log(`[talk] onReplyOk failed: ${(e && e.message) || e}`); } }
          if (fin.ok) keepTurn(clean(fin.reply));
          emit('talk:replyDone', {
            turnId, ok: fin.ok, reply: clean(fin.reply),
            error: fin.error ? clean(fin.error) : null,
            sources: fin.sources || [],
          });
        });
        live.checked.then((c) => { if (c) emit('talk:checkDone', { turnId, verdict: c.verdict, text: clean(c.text) }); });
      }
      if (!live && head && head.ok === true && typeof head.reply === 'string') keepTurn(head.reply); // the non-streamed reply
      return head;
    },

    'talk.gesture': (p) => cloud.gesture(p),
    // T-31-ROOM motion P5b: the agent's [move: compose: ...] and the chat's /move compose: ... both reach this through the renderer's motion
    // route; the answer is validated there and gated in the room before anything moves
    'talk.composeMotion': (brief) => motionComposer.compose(brief),
    'talk.brainInfo': () => {
      if (!chatBrain.hasKey()) return null;
      const st = chatBrain.status();
      return { provider: st.provider, model: st.model };
    },

    // ---- keys (main.js :1015-1072) ----
    'brainKey.save': async (raw, confirm) => (await brainKey()).save(raw, { confirmUnreachable: confirm === true }),
    // S1 deliberately leaves the key test UNGUARDED: the user saves a Gemini key BEFORE the 18+ confirm exists (the
    // card's Save is the first write), and this call only validates the key against the provider's key route -- it is
    // not a chat or model-list turn. Gating it would make a fresh key unsaveable.
    'brainKey.test': async () => (await brainKey()).test(),
    'brainKey.cliLoginStatus': () => cliView(),
    // on: his click. A login that cannot be read leaves the choice as it was; the card says so from active:false.
    'brainKey.cliLoginSet': (on) => {
      if (!ownerAdmin || ai.providerId() !== 'opencode-go') return { active: false, source: 'key-file' };
      if (on !== true) saveSettings({ goCliLogin: false });
      else if (cliRead()) saveSettings({ goCliLogin: true });
      else return { active: false, source: 'key-file' };
      return cliView();
    },
    'ai.testKey': async (raw) => (await brainKey()).testKey(raw),

    // ---- roles (main.js :1169-1205) ----
    'roles.get': () => rolesView(),
    'roles.set': async (role, choice) => {
      if (!roleProvider()) return { ok: false, error: 'no_provider' };
      if (!Object.prototype.hasOwnProperty.call(WIRED_ROLES, role)) return { ok: false, error: 'not_available' };
      const r = setRoleChoice(settings().roleModels, role, choice);
      if (!r.ok) return r;
      saveSettings({ roleModels: r.next });
      return { ok: true, ...(await rolesView()) };
    },
    'roles.reset': async (role) => {
      const r = resetRoleChoice(settings().roleModels, role);
      if (!r.ok) return r;
      saveSettings({ roleModels: r.next });
      return { ok: true, ...(await rolesView()) };
    },
    'roles.setOn': async (role, on) => {
      if (!roleProvider()) return { ok: false, error: 'no_provider' };
      if (typeof on !== 'boolean') return { ok: false, error: 'bad_choice' };
      const r = setRoleOn(settings().roleModels, role, on);
      if (!r.ok) return r;
      saveSettings({ roleModels: r.next });
      return { ok: true, ...(await rolesView()) };
    },
    'roles.models': async () => {
      const p = roleProvider();
      return p ? p.listModels() : { ok: false, error: 'no_provider', models: [] };
    },
  };

  // ai.setMode / ai.setProvider call this (Electron's rebuildChatBrain): the next turn reads the new key/model.
  function rebuild() { chatBrain = buildChatBrain(); }

  /**
   * HOST ONLY (T-31-MOBILE M4 pairing, GATE-BRIDGE-OPUS F3): the ONE brain key the phone uses, the selected provider's,
   * for the pairing bundle. null when no key is saved, or for Gemini without the stored 18+ confirmation (S1: the phone
   * must not get a chat this app would refuse). Never an rpc.
   */
  function phoneAi() {
    if (!chatBrain.hasKey()) return null;
    if (ai.providerId() === 'gemini' && settings().age18Confirmed !== true) return null;
    const key = keyForScrub();
    if (!key) return null;
    const st = chatBrain.status();
    return { provider: ai.providerId(), key, model: st.model || null };
  }
  /** HOST ONLY: the PC's client-name list for the pairing bundle, or null if it cannot be trusted (phone-extras.mjs). */
  const phoneRedact = () => readRedactStrict(redactFile);
  // Barge-in (T-31-ROOM-live-b P1 item 3): cut the streamed LLM request of an abandoned turn. The registry is module-level in
  // chat-brain, so this also reaches a turn started before a rebuild(). false = no such live turn.
  const abortTurn = (turnId) => chatBrain.abortTurn(turnId);
  return { handlers, rebuild, dispose, keyPresence, phoneAi, phoneRedact, get chatBrain() { return chatBrain; }, boardReader, cloud, takeLiveReply, abortTurn };
}
