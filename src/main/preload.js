'use strict';
// Narrow bridge: the renderer never gets Node or raw ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

const cleanSources = (list) => (Array.isArray(list) ? list.filter((s) => s && typeof s.url === 'string').slice(0, 5).map((s) => ({ url: s.url, title: typeof s.title === 'string' ? s.title : '' })) : []);
const on = (channel, cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Brain's three read-only board calls (T-31 3a-3): main passes this argument only in a next-UI build, and registers the handlers only then.
const NEXT_UI = process.argv.includes('--zumi-next-ui=1');

contextBridge.exposeInMainWorld('zumi', {
  info: () => ipcRenderer.invoke('app:info'),
  // Auto-update (src/main/updater.mjs). State: { phase: off|idle|downloading|error|ready, version, percent,
  // ready: { version, notes } | null } (notes: plain text in the UI language). install() = Restart now;
  // later(version) = not again this session, installs on the next quit. The page never names a URL or a file.
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    onState: (cb) => on('update:state', (p) => { if (p && typeof p.phase === 'string') cb(p); }),
    install: () => ipcRenderer.invoke('update:install'),
    later: (version) => ipcRenderer.invoke('update:later', version),
    check: () => ipcRenderer.invoke('update:check'),
  },
  // Models: { models: [{ id, label, source, url, ... }], selected: id | null, bundledCount }
  listModels: () => ipcRenderer.invoke('models:list'),
  selectModel: (id) => ipcRenderer.invoke('models:select', id),
  openModelFile: () => ipcRenderer.invoke('models:open-file'), // native VRM-file dialog; null when cancelled
  restoreDefaultModel: () => ipcRenderer.invoke('models:restore-default'), // no arguments: main owns the default file + sha256 (T-31 0.2.8)
  listClips: () => ipcRenderer.invoke('clips:list'),
  // Rooms (T-31 R3): { rooms: [{id, source, label, author, license, hasManifest, url, warnings, stats}], selected }
  rooms: {
    list: () => ipcRenderer.invoke('rooms:list'),
    select: (id) => ipcRenderer.invoke('rooms:select', id),
    openFile: () => ipcRenderer.invoke('rooms:open-file'), // native .glb-file dialog; null when cancelled, {error} when refused
    delete: (id) => ipcRenderer.invoke('rooms:delete', id),
    // room standard v2 (T-31 camera modes): dev-only registration-tool save. { pos:[x,y,z], target:[x,y,z], fov }.
    v2: { saveView: (id, view, camera) => ipcRenderer.invoke('rooms:v2:save-view', id, view, camera) },
  },
  // Video rooms (T-31 room picker): { selected: 'current' | <id>, geometry, rooms: [{id, label, status, url, framing}] }.
  scenes: {
    list: () => ipcRenderer.invoke('scenes:list'),
    select: (id) => ipcRenderer.invoke('scenes:select', id),
  },
  // 3D chair (T-31 chair3d): { selected: 'painted' | <id>, noChairPlateUrl, hideOccluders, chairs: [{id, label, url, seat, reclineDeg, look}] }.
  chairs: {
    list: () => ipcRenderer.invoke('chairs:list'),
    select: (id) => ipcRenderer.invoke('chairs:select', id),
  },
  // Talk-camera HUD (T-31 hud-react): prefs { style: 'off'|'a'|'b' }, default off. onFeed gets main's
  // 'hud:feed' messages; answer(offerId, yes) is the only way an acceptance file is opened (main holds the file/URL).
  // Voice is the talk scheduler's now (T-31 talk-mode), not a HUD pref. onReaction hands main each host reaction.
  hud: {
    getPrefs: () => ipcRenderer.invoke('hud:get-prefs'),
    setPrefs: (p) => ipcRenderer.invoke('hud:set-prefs', p),
    ready: () => ipcRenderer.invoke('hud:ready'),
    answer: (id, yes) => ipcRenderer.invoke('hud:answer', String(id), yes === true),
    // Inline board-ask answer (T-31 0.2.3 batch C): the owner picks an option (choice), approves/rejects (verdict)
    // or types a reply (text) on a HUD ask card. `payload` is { id, rev, choice?|verdict?|text? }; main fixes the
    // op (ask.answer), gates owner-build + live + unlocked and holds the credential. -> { ok, reason? }.
    answerAsk: (payload) => ipcRenderer.invoke('hud:answer-ask', payload),
    onFeed: (cb) => on('hud:feed', cb),
  },
  // UI language: 'en' | 'vi' | 'zh', persisted per user by main (settings.json uiLang). Default 'en'.
  ui: {
    getLang: (fallback) => ipcRenderer.invoke('ui:get-lang', fallback), // fallback: the OS-locale language, used only while none is saved
    setLang: (lang) => ipcRenderer.invoke('ui:set-lang', lang),
    // Developer mode: one persisted boolean (settings.json developerMode; the old `devTools` key is ignored). Off by
    // default; an unpackaged dev run shows the dev controls regardless (app:info.packaged).
    getDevTools: () => ipcRenderer.invoke('ui:get-dev-tools'),
    setDevTools: (on) => ipcRenderer.invoke('ui:set-dev-tools', on),
    // "Send client names to the AI" (T-31 board-aware privacy, CoS 07-10): one persisted boolean (settings.json
    // sendClientNamesToAi). Off by default — the board digest then masks every name on the owner's redact list.
    getSendClientNames: () => ipcRenderer.invoke('ui:get-send-client-names'),
    setSendClientNames: (on) => ipcRenderer.invoke('ui:set-send-client-names', on),
    // Look-tuning panel (T-31 camera modes): a user override file in userData, never the shipped room files.
    getLookTuning: () => ipcRenderer.invoke('ui:get-look-tuning'),
    setLookTuning: (overrides) => ipcRenderer.invoke('ui:set-look-tuning', overrides),
  },
  // Starts the local board server on first call: { url, origin, dataDir } or { error }
  openBoard: () => ipcRenderer.invoke('board:open'),
  // GestureCommand entry point (for a future LLM / devtools): goes renderer -> main -> renderer over
  // the `gesture:play` IPC channel so every source uses the same path. Resolves to the validator verdict.
  playGesture: (command) => ipcRenderer.invoke('gesture:play', command),
  // Registered once by the app: runs a command in the player and returns a JSON-safe result.
  onGesture: (handler) => on('gesture:play', async ({ reqId, command }) => {
    let result;
    try { result = await handler(command); } catch (e) { result = { ok: false, errors: [String(e && e.message || e)] }; }
    ipcRenderer.send('gesture:result', reqId, JSON.parse(JSON.stringify(result || null)));
  }),
  // Talk: one narrow call per operation (main validates every payload and holds the device token; this page never sees it).
  talk: {
    status: () => ipcRenderer.invoke('talk:status'),
    turn: (p) => ipcRenderer.invoke('talk:turn', p),
    // T-31 voice round 6: a streamed turn() resolves at the reply's first clause ({ streaming: true }); the text so
    // far keeps arriving here (plain text, the whole reply so far each time), then once as the final reply
    // ({ ok, reply, error }). Filtered by turnId; each returns an unsubscribe function.
    onReplyMore: (turnId, cb) => on('talk:replyMore', (p) => { if (p && p.turnId === turnId && typeof p.text === 'string') cb(p.text); }),
    // `sources`: a Look up reply's cited pages [{ url, title }] (plain text; empty on every other turn).
    onReplyDone: (turnId, cb) => on('talk:replyDone', (p) => { if (p && p.turnId === turnId) cb({ ok: p.ok === true, reply: typeof p.reply === 'string' ? p.reply : '', error: p.error || null, sources: cleanSources(p.sources) }); }),
    // Models by role: the Check role's verdict on a streamed reply, after it was spoken: { verdict: 'ok'|'fix', text }.
    // Arrives only when Check ran. Plain text, shown under the reply, never spoken.
    onCheckDone: (turnId, cb) => on('talk:checkDone', (p) => { if (p && p.turnId === turnId && (p.verdict === 'ok' || p.verdict === 'fix')) cb({ verdict: p.verdict, text: typeof p.text === 'string' ? p.text : '' }); }),
    // Sources row link: opens in the OS browser, and only a URL main saw a Look up reply cite. -> true | false
    openSource: (url) => ipcRenderer.invoke('talk:openSource', url),
    // Settings-panel line only: { provider, model } | null. Never a key.
    brainInfo: () => ipcRenderer.invoke('talk:brainInfo'),
    // Settings-panel line only: { mode: 'cloud'|'kokoro'|'windows'|'off', voice: string|null }. Never a key.
    voiceInfo: () => ipcRenderer.invoke('talk:voiceInfo'),
    // Settings-panel line only: the BYO voice providers for the Voice card, [{ id, langs, paid, needsKey, hasKey }]
    // (T-31 talk-mode, PLAN 10.3). No secrets: only hasKey crosses back.
    voiceProviders: () => ipcRenderer.invoke('talk:voiceProviders'),
    gesture: (p) => ipcRenderer.invoke('talk:gesture', p),
    tts: (p) => ipcRenderer.invoke('talk:tts', p),
    // T-31 voice P1 item 2: sentence 2+ of an EN/Kokoro reply, pushed after `tts()` already resolved with
    // sentence 1. Filters by turnId itself so a caller only ever sees chunks for the turn it asked about;
    // returns an unsubscribe function.
    onTtsMore: (turnId, cb) => on('talk:ttsMore', (p) => { if (p && p.turnId === turnId) cb(p.audio); }),
    ttsAbandon: (turnId) => ipcRenderer.invoke('talk:ttsAbandon', { turnId }),
    // Settings-panel progress indicator for the one-time Kokoro model download: { phase, loaded, total }.
    onKokoroProgress: (cb) => on('talk:kokoroProgress', cb),
    // { state: idle|downloading|loading|ready|error|off, phase, loaded, total, error } -- the local voice prefetch.
    voiceState: () => ipcRenderer.invoke('talk:voiceState'),
    // T-31 talk-mode (PLAN 10.3): a provider key goes in through these; only a boolean / hasKey ever comes back, and
    // the key is never read back to the renderer. `testVoice` speaks one short line through the chosen provider.
    setProviderKey: (id, raw) => ipcRenderer.invoke('talk:setProviderKey', id, raw),
    clearProviderKey: (id) => ipcRenderer.invoke('talk:clearProviderKey', id),
    testVoice: (p) => ipcRenderer.invoke('talk:testVoice', p),
    getVoiceEnabled: () => ipcRenderer.invoke('talk:getVoiceEnabled'),
    setVoiceEnabled: (on_) => ipcRenderer.invoke('talk:setVoiceEnabled', on_),
    // Settings > Voice "Soft sound while thinking": boolean, default false.
    getThinkSound: () => ipcRenderer.invoke('talk:getThinkSound'),
    setThinkSound: (on_) => ipcRenderer.invoke('talk:setThinkSound', on_),
    // Settings > Workflow "Read the reply aloud when the mic is off" (T-31 settings P1): boolean, default true.
    getSpeakTypedWhenMicOff: () => ipcRenderer.invoke('talk:getSpeakTypedWhenMicOff'),
    setSpeakTypedWhenMicOff: (on_) => ipcRenderer.invoke('talk:setSpeakTypedWhenMicOff', on_),
    // Settings > Voice: { speed: 0.75-1.5, volume: 0-1 } (settings.json voiceSpeed / voiceVolume); set takes a partial.
    getVoicePrefs: () => ipcRenderer.invoke('talk:getVoicePrefs'),
    setVoicePrefs: (p) => ipcRenderer.invoke('talk:setVoicePrefs', p),
    // T-31 talk-mode (PLAN 1): "how much Zumi talks" (level / voice language / quiet hours). get reads the normalised
    // prefs, set takes a partial patch; both validated in main. No secrets.
    getTalkPrefs: () => ipcRenderer.invoke('talk:getTalkPrefs'),
    setTalkPrefs: (p) => ipcRenderer.invoke('talk:setTalkPrefs', p),
    // T-31 talk-mode (PLAN 2, 5.2): Zumi's own lines. onSay hands the renderer each line the scheduler issued
    // ({ sayId, kind, text, show, voice, lang, mood }); sayAck answers it ('busy' re-holds a P1 ask); sayEvent names ONE of
    // poke/pat/look (main refuses anything else); mute(untilMs|null)/unmute persist the stage mute; openGuide names a
    // provider guide (main owns the URL table). None of these carries a key or a URL.
    onSay: (cb) => on('speech:say', (line) => { if (line && typeof line.sayId === 'string') cb(line); }),
    sayReady: () => ipcRenderer.invoke('talk:sayReady'),
    sayAck: (sayId, spoken, reason) => ipcRenderer.invoke('talk:sayAck', { sayId, spoken, reason }),
    sayEvent: (name) => ipcRenderer.invoke('talk:sayEvent', name),
    sayStatus: () => ipcRenderer.invoke('talk:sayStatus'),
    mute: (untilMs) => ipcRenderer.invoke('talk:mute', untilMs == null ? null : untilMs),
    unmute: () => ipcRenderer.invoke('talk:unmute'),
    openGuide: (id) => ipcRenderer.invoke('talk:openGuide', id),
    log: (rec) => ipcRenderer.invoke('talk:log', rec),
  },
  // Jev fast-reflex: one call, one narrow shape back. Never probabilities, never a key.
  reflexJev: {
    classify: (text) => ipcRenderer.invoke('reflexjev:classify', text),
  },
  gcache: {
    load: () => ipcRenderer.invoke('gcache:load'),
    save: (text) => ipcRenderer.invoke('gcache:save', text),
  },
  // Owner token-usage summary (T-31 owner-admin + usage): read-only, { today, rows: [{date, model, calls, ok, in,
  // out, total, estCostUsd, priced}] } for today + the last 30 days. Never the prompt/reply text, never a key.
  usage: {
    summary: () => ipcRenderer.invoke('usage:summary'),
  },
  // T-31 alpha.12 (PLAN-ZUMI-WATCH v2, agent-core.mjs). Soul: get -> {soul, onboarded, canUndo, history, templates,
  // defaults, limits, preview}; save(input) -> {ok, soul} | {ok:false, error, field}; undo -> {ok, soul} | {ok:false}.
  soul: {
    get: () => ipcRenderer.invoke('soul:get'),
    save: (input) => ipcRenderer.invoke('soul:save', input),
    undo: () => ipcRenderer.invoke('soul:undo'),
  },
  // Rhythm core: get -> rhythm.get() + watchLevel; pause(on) / reset() -> the same view.
  rhythm: {
    get: () => ipcRenderer.invoke('rhythm:get'),
    pause: (on) => ipcRenderer.invoke('rhythm:pause', on),
    reset: () => ipcRenderer.invoke('rhythm:reset'),
  },
  // The read-only board watcher's on/off ('on' | 'off'); returns the rhythm view with the new watchLevel.
  watch: {
    setLevel: (level) => ipcRenderer.invoke('watch:set-level', level),
  },
  // Settings > AI brain > "Your own key" (T-31 settings-a2, KEY-HANDLING.md). The key goes IN once (save); what comes
  // back is only { provider, saved, last4, checked, encryption } + { ok, check: works|rejected|unreachable, error }.
  brainKey: {
    status: () => ipcRenderer.invoke('brainKey:status'),
    // save(raw, confirm): an UNREACHABLE key test does not store the key unless confirm === true (the explicit
    // "Lưu dù chưa thử được" button). T-31 fix round item 1.
    save: (raw, confirm) => ipcRenderer.invoke('brainKey:save', raw, confirm),
    clear: () => ipcRenderer.invoke('brainKey:clear'),
    test: () => ipcRenderer.invoke('brainKey:test'),
  },
  // T-31 BYOK: the chat provider picker + key helpers, kept OUT of brainKey so that existing flow is untouched.
  // provider -> { id, label, mode } | null (mode: 'free' | 'byok'); setProvider(id) -> { ok, id, label }; testKey(raw)
  // -> { ok, check } or { ok:false, error }; openKeyPage() opens the active provider's key page in the OS browser
  // (main owns the URL); setMode(mode) -> { ok, mode } persists the two-choice header choice.
  ai: {
    provider: () => ipcRenderer.invoke('ai:provider'),
    setProvider: (id) => ipcRenderer.invoke('ai:set-provider', id),
    testKey: (raw) => ipcRenderer.invoke('ai:test-key', raw),
    openKeyPage: () => ipcRenderer.invoke('ai:open-key-page'),
    setMode: (mode) => ipcRenderer.invoke('ai:set-mode', mode),
  },
  // Settings probe run only (scripts/check-settings-normal-launch.mjs): the handler exists only under --settings-probe.
  probe: { finish: (report) => ipcRenderer.invoke('probe:finish', report) },
  // Settings > Models by role (T-31 board-roles): plan/do/check/lookup, each { model, effort } from the user's own
  // provider. get/set/reset/setOn -> { provider: {label}|null, defaults, roles: {role:{model,effort,by,on}},
  // sameCheckModel, wired }; models -> { ok, models: [{id, name, reasoning}] }. Never a key. setOn: Plan / Check /
  // Look up on or off (Do has no switch).
  roles: {
    get: () => ipcRenderer.invoke('roles:get'),
    set: (role, choice) => ipcRenderer.invoke('roles:set', role, choice),
    setOn: (role, on_) => ipcRenderer.invoke('roles:setOn', role, on_),
    reset: (role) => ipcRenderer.invoke('roles:reset', role),
    models: () => ipcRenderer.invoke('roles:models'),
  },
  // Live board (T-31 L1): narrow, one call per operation, like `talk` above. Main never hands this page a secret, a
  // PIN, or anything derived from a PIN — see the L1 UI contract for the exact field list.
  board: {
    status: () => ipcRenderer.invoke('board:status'),
    setSecrets: (p) => ipcRenderer.invoke('board:setSecrets', p),
    setSecretsOs: (p) => ipcRenderer.invoke('board:setSecretsOs', p),
    unlock: (pin) => ipcRenderer.invoke('board:unlock', pin),
    lock: () => ipcRenderer.invoke('board:lock'),
    setMode: (mode) => ipcRenderer.invoke('board:setMode', mode),
    liveOpen: () => ipcRenderer.invoke('board:live-open'),
    // "Require PIN for Board" (Settings toggle): disablePin/enablePin re-seal an ALREADY-configured install;
    // setPinRequired only flips the fresh-setup preference (refused once configured, see main.js).
    disablePin: (pin) => ipcRenderer.invoke('board:disablePin', pin),
    enablePin: (newPin) => ipcRenderer.invoke('board:enablePin', newPin),
    setPinRequired: (on) => ipcRenderer.invoke('board:setPinRequired', on),
    signOut: (pin) => ipcRenderer.invoke('board:signOut', pin),
    ...(NEXT_UI ? {
      state: () => ipcRenderer.invoke('board:state'),
      media: (id, opts) => ipcRenderer.invoke('board:media', String(id), { w: opts && opts.w }),   // no coercion of w: the host validates strictly
      openRef: (ref) => ipcRenderer.invoke('board:open-ref', { kind: ref && ref.kind, target: ref && ref.target }),
    } : {}),
  },
  // Fires when the host changes the active model on its own: the renderer re-lists models and hot-swaps.
  onModelChanged: (cb) => on('model:changed', cb),
  // `reflex:event` is the wiring point for future backend/board pushes: { type: 'board-message', ... }
  onReflexEvent: (cb) => on('reflex:event', cb),
  onWindowFocus: (cb) => on('window:focus', cb),
  onWindowVisible: (cb) => on('window:visible', cb), // minimize/hide -> false, restore/show -> true (video rooms pause)
  // demo run (P9, test-only; the handlers exist only when the app was started with --demo-script)
  demo: {
    info: () => ipcRenderer.invoke('demo:info'),
    log: (msg) => ipcRenderer.send('demo:log', msg),
    capture: (name) => ipcRenderer.invoke('demo:capture', name),
    finish: (report) => ipcRenderer.invoke('demo:finish', report),
  },
  selftest: {
    capture: (name, opts) => ipcRenderer.invoke('selftest:capture', name, opts),
    emitBoard: () => ipcRenderer.invoke('selftest:emit-board'),
    boardLog: () => ipcRenderer.invoke('selftest:board-log'),
    clipboardImage: () => ipcRenderer.invoke('selftest:clipboard-image'),
    log: (msg) => ipcRenderer.send('selftest:log', msg),
    finish: (report) => ipcRenderer.invoke('selftest:finish', report),
    // Room fixtures (test-only; the handlers exist only under --selftest): generates good + 6 bad room files once,
    // then opens one by name through the real import path (importRoomFile).
    roomFixtures: () => ipcRenderer.invoke('selftest:room-fixtures'),
    roomOpen: (name) => ipcRenderer.invoke('selftest:room-open', name),
  },
  // QC screenshot runs (the handlers exist only when the app was started with --room-shots, --board-stress or
  // --settings-shots). badRoom is room-shots only.
  shots: {
    capture: (name) => ipcRenderer.invoke('shots:capture', name),
    log: (msg) => ipcRenderer.send('shots:log', msg),
    finish: (report) => ipcRenderer.invoke('shots:finish', report),
    badRoom: () => ipcRenderer.invoke('shots:bad-room'),
    rolesProvider: (mode) => ipcRenderer.invoke('shots:roles-provider', mode), // --settings-shots only: 'on'|'one'|'off'
    resize: (w, h) => ipcRenderer.invoke('shots:resize', w, h), // --settings-shots only
    voiceState: (state) => ipcRenderer.invoke('shots:voice-state', state), // --settings-shots only
    seedUsage: () => ipcRenderer.invoke('shots:seed-usage'), // --settings-shots only
  },
});
