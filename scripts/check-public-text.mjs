// What a public / official user sees or what their model is told carries no owner material (release 0.3.0 review): no
// owner live board, no owner host, no internal lane / task / process names. Plain Node, no window; the provider is a loopback fake.
//   1. UI text: every key of every locale, as t() resolves it in a public build (setPublicBuild(true)).
//   2. Prompt: the system messages of a real chat-host turn in the public flavour (official = public code), next to the owner
//      flavour, which keeps its live-board digest and its persona text byte for byte. The public persona names "the user" (never
//      "your owner") and has no board / code-session sentence; a soul saved through the soul store (the first-run cards) reaches it.
// A hit fails unless ALLOW names it with a reason; an ALLOW entry that no longer matches fails too (no stale exceptions).
// Out of scope here: comments and identifiers in the shipped source (it is the published AGPL source), and the owner-only
// files the official payload never carries (check-public-payload). Log lines: covered by the installed-app runs (RESULT notes).
//   node scripts/check-public-text.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };

// Owner / internal material. "anh" is the owner's form of address (a whole word, any case); "lane" the owner's agent lanes.
// "Anh" after "tiếng" / "quốc" is English / the UK, not the address (the same exception as i18n.js ANH_WORD, R8-F2).
export const INTERNAL = /\bowner\b|live (task )?board|3kmedia|\bCoS\b|(?<![\p{L}\p{N}])(?<!(?:[Tt]iếng|quốc) )anh(?![\p{L}\p{N}])|dossier|\bT-\d{1,2}\b|\bJ-05\b|Laneboard|\bKei\b|\blanes?\b/iu;

// ---------- 1. UI text ----------
// Keys whose text names owner material but that a public build never shows. Each reason names the gate that hides it.
const BOARD_SURFACES = 'src/renderer/public-build.js BOARD_SURFACES: the Board tab and Settings > Account (live board card) are hidden in a public build';
export const UI_ALLOW = {
  'brain.detail.dossier': 'Brain task detail: a public build has only the Memory and Soul tabs (src/renderer/next/boot.js publicBrainTabs)',
  'brain.reason.not_live': 'Brain task list reason: same, no task tab in a public build (boot.js publicBrainTabs)',
  'board.mode.live': BOARD_SURFACES,
  'settings.liveBoard': BOARD_SURFACES,
  'settings.signOutIo': BOARD_SURFACES,
  'settings.needUnlock': BOARD_SURFACES,
  'settings.pinOffRisk': BOARD_SURFACES,
  'err.not_configured': `${BOARD_SURFACES} (board.setMode / board.unlock errors)`,
  'board.liveConnectFailed': `${BOARD_SURFACES} (Board tab hint)`,
  'board.liveInElectron': `${BOARD_SURFACES} (Board tab hint)`,
  'board.liveWhere': `${BOARD_SURFACES} (Board tab hint)`,
  'roles.boardLink': 'src/renderer/app.js shows #roles-board-link only when info.ownerAdmin',
  'settings.provider.zumia-owner': 'listed only while the owner voice flag (owner-voice.json) is present: src/main/voice-providers / settings.js providerList from main',
  'lookTuning.rim': 'vi "anh sang" is unaccented "ánh sáng" (light), not a form of address: i18n.js NEUTRAL_EXEMPT',
};
{
  const i18n = await import('../src/renderer/i18n.js');
  i18n.setPublicBuild(true);
  const hits = new Map();
  for (const loc of i18n.LOCALES) {
    i18n.setLocale(loc);
    for (const k of i18n.publicKeys(loc)) {
      const v = i18n.t(k);
      if (typeof v === 'string' && INTERNAL.test(v)) hits.set(`${loc} ${k}`, v);
    }
  }
  i18n.setLocale('en');
  const real = [...hits].filter(([lk]) => !(lk.split(' ')[1] in UI_ALLOW));
  ok(hits.size > 0 && real.length === 0, `UI text: no owner material in any public string, en/vi/zh (${hits.size} hits, all allowlisted with a reason)`, real.map(([k, v]) => `${k}: ${v.slice(0, 100)}`).join(' | '));
  const stale = Object.keys(UI_ALLOW).filter((k) => ![...hits.keys()].some((lk) => lk.endsWith(` ${k}`)));
  ok(stale.length === 0, 'UI text: every allowlist entry still matches a string (no stale exception)', stale.join(', '));
  ok(Object.values(UI_ALLOW).every((r) => typeof r === 'string' && r.length > 20), 'UI text: every allowlist entry cites its reason');
  // R8-F2: neutralAddress() made "Tiếng Anh" (English) read "Tiếng Bạn". Language and country names survive, whatever the address word.
  {
    const PROPER = /(?:[Tt]iếng|quốc) Anh(?![\p{L}\p{N}])/u;
    const viKeys = i18n.publicKeys('vi');
    const named = viKeys.filter((k) => typeof i18n.TABLES.vi[k] === 'string' && PROPER.test(i18n.TABLES.vi[k]));
    const lost = named.filter((k) => !PROPER.test(i18n.publicRaw('vi', k)));
    ok(named.length >= 10 && lost.length === 0, `vi public text: every "tiếng Anh" / "Vương quốc Anh" survives the address rewrite (${named.length} strings)`, lost.map((k) => `${k}: ${i18n.publicRaw('vi', k)}`).join(' | '));
    const langs = ['soul.lang.en', 'settings.replyLang.en', 'market.lang.en'];
    const bad = [];
    i18n.setLocale('vi');
    for (const userWord of ['bạn', 'anh', 'chị', 'em', 'cậu']) {
      i18n.setAddress({ selfWord: 'em', userWord });
      for (const k of langs) if (i18n.t(k) !== 'Tiếng Anh') bad.push(`${userWord}: ${k} = ${i18n.t(k)}`);
    }
    i18n.setAddress({ selfWord: 'em', userWord: 'bạn' }); i18n.setLocale('en');
    ok(bad.length === 0, 'vi public UI: the language names read "Tiếng Anh" with every address word (first-run card language pickers)', bad.join(' | '));
    // Every vi string the rewrite touches differs from the source only where "anh" addresses the reader.
    const wrong = viKeys.filter((k) => {
      const src = i18n.TABLES.vi[k], pub = i18n.publicRaw('vi', k);
      if (typeof src !== 'string' || src === pub || !/\{[Uu]ser\}/.test(pub)) return false;
      return pub.replace(/\{user\}/g, 'anh').replace(/\{User\}/g, 'Anh') !== src || /(?:[Tt]iếng|quốc) \{[Uu]ser\}/u.test(pub);
    });
    ok(wrong.length === 0, 'vi public text: every rewritten string changes only the address word (no language or country name)', wrong.map((k) => `${k}: ${i18n.publicRaw('vi', k)}`).join(' | '));
  }
  ok(INTERNAL.test("the owner's live board") && INTERNAL.test('Xin chào anh') && INTERNAL.test('see the T-31 dossier') && !INTERNAL.test('ánh sáng') && !INTERNAL.test('Thanh') && !INTERNAL.test('Tiếng Anh') && !INTERNAL.test('Vương quốc Anh') && INTERNAL.test('Anh ơi'), 'the pattern bites on planted owner text and spares ordinary words');
}

// ---------- 2. the prompt a public chat turn sends ----------
// The owner flavour's persona (soul-prefs.js soulSystemPrompt(null), pinned against alpha.10 by check-soul): sha256 at ec63fe87.
const OWNER_PERSONA_SHA256 = '080e1aa68e95014c877685d5fb981001fca204192bf9948160ba79593cb431c5';
// The owner-only sentence of the companion rule: work on the owner's board belongs to his code sessions.
const BOARD_SESSION = /code sessions?|work on the board/i;
{
  const { startFakeLlm } = await import('./fake-llm-sse.mjs');
  const { guardedFetch, cloudFetch, mirrorFetch, jevFetch, PROVIDER_ORIGINS } = await import('../tauri/sidecar/egress.mjs');
  const { createAiSettings } = await import('../tauri/sidecar/ai-settings.mjs');
  const { createAiCore } = await import('../tauri/sidecar/ai-core.mjs');
  const { createChatHost } = await import('../tauri/sidecar/chat-host.mjs');
  const { createSecretStores } = await import('../tauri/sidecar/secret-stores.mjs');
  const { FLAVOURS } = await import('../tauri/sidecar/flavour.mjs');
  const loopback = require('./fixtures/fetch-to-loopback.cjs');
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const prov = require('../src/main/providers.js');
  const { createSoulStore, soulSystemPrompt, soulPrefs } = require('../src/main/soul-prefs.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-public-text-'));
  const fake = await startFakeLlm({ firstMs: 1, intervalMs: 1, chunkChars: 16, text: 'Hello.', log: () => {} });
  try {
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8') };
    let n = 0;
    const systemFor = async (flavour, soulInput = null) => {
      const dir = path.join(tmpRoot, `chat${++n}`); fs.mkdirSync(dir);
      const file = path.join(dir, 'settings.json');
      const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
      const set = (p) => { const next = { ...get(), ...p }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
      set({ aiProvider: 'openrouter', roleModels: { off: ['plan', 'check', 'lookup'] } });
      // A soul saved the way the first-run cards save it (soul store save), read every turn the way main.mjs wires agent.getSoul.
      const soulStore = soulInput ? createSoulStore({ settings: get, saveSettings: set, dataDir: dir, ownerBuild: flavour.ownerAdmin === true }) : null;
      if (soulStore) { const r = soulStore.save(soulInput); if (!r.ok) throw new Error(`soul save failed: ${r.error}`); }
      const bodies = [];
      const base = async (url, init) => { bodies.push(init && init.body ? JSON.parse(init.body) : null); return fetch(loopback.rewrite(url, new URL(fake.url)), init); };
      let host = null;
      const ai = createAiSettings({ dataDir: dir, settings: get, saveSettings: set, onChange: () => { if (host) host.rebuild(); } });
      ai.pin();
      const secretStores = async () => createSecretStores({ safeStorage, dataDir: dir });
      const aiCore = createAiCore({ ai, secretStores, dataDir: dir, log: () => {}, reflexEgress: false, jevFetch: jevFetch(base, false, () => {}) });
      const p = prov.PROVIDERS.openrouter;
      createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789');
      host = createChatHost({
        dataDir: dir, settings: get, saveSettings: set, ai, secretStores, safeStorage, flavour: { values: flavour }, aiCore, log: () => {}, memory: null,
        emit: () => true, getSoul: soulStore ? () => soulStore.current() : null,
        egress: { provider: guardedFetch(base, PROVIDER_ORIGINS, () => {}), cloud: cloudFetch(base, null, () => {}), mirror: mirrorFetch(base, null, () => {}) },
      });
      host.rebuild();
      await host.handlers['talk.turn']({ turnId: '1'.padStart(32, '0'), message: 'What is waiting for me today?', history: [] });
      const body = bodies[bodies.length - 1];
      return body && Array.isArray(body.messages) ? body.messages.filter((m) => m.role === 'system').map((m) => m.content) : [];
    };
    const pub = await systemFor(FLAVOURS.public);
    const official = await systemFor(FLAVOURS.official);
    const owner = await systemFor(FLAVOURS.owner);
    const leftover = (sys) => sys.filter((s) => INTERNAL.test(s));
    ok(pub.length > 0 && leftover(pub).length === 0, 'prompt (public flavour): no owner material, the persona included (no "your owner")', leftover(pub).map((s) => s.slice(0, 160)).join(' | '));
    ok(official.length > 0 && leftover(official).length === 0, 'prompt (official flavour): the same', leftover(official).map((s) => s.slice(0, 160)).join(' | '));
    ok(!pub.some((s) => /BOARD DIGEST|live task board/i.test(s)), 'prompt (public flavour): no board rule and no board digest at all', pub.map((s) => s.slice(0, 80)).join(' | '));
    ok(![...pub, ...official].some((s) => BOARD_SESSION.test(s)), 'prompt (public + official): no board / code-session sentence', [...pub, ...official].filter((s) => BOARD_SESSION.test(s)).map((s) => s.slice(0, 160)).join(' | '));
    ok(/speaking directly with the user\b/.test(pub[0] || '') && pub[0] === official[0], 'prompt (public + official): the persona speaks with "the user", the same text in both', (pub[0] || '').slice(0, 120));
    ok(owner.some((s) => /live task board/.test(s)) && owner.some((s) => /^BOARD DIGEST/.test(s)), 'prompt (owner flavour): the live-board rule and digest are kept', owner.map((s) => s.slice(0, 80)).join(' | '));
    const sha = (s) => require('node:crypto').createHash('sha256').update(String(s)).digest('hex');
    ok(sha(owner[0]) === OWNER_PERSONA_SHA256 && /your owner/.test(owner[0]) && BOARD_SESSION.test(owner[0]), 'prompt (owner flavour): the persona is byte for byte the ec63fe87 text', sha(owner[0]));
    // The first-run values: her name for the user, the Vietnamese address word and the reply language, saved through the soul store.
    const saved = await systemFor(FLAVOURS.public, { ownerName: 'Lan', userWord: 'chị', replyLang: 'vi' });
    ok(saved[0].includes("The user's name is Lan.") && saved[0].includes('call the user "chị"') && saved[0].includes('Always reply in Vietnamese.') && !INTERNAL.test(saved[0]),
      'prompt (public flavour): the saved name, address word and reply language reach the persona, with no owner word', saved[0].slice(0, 400));
    const savedOwner = await systemFor(FLAVOURS.owner, { ownerName: 'Lan', userWord: 'chị', replyLang: 'vi' });
    ok(savedOwner[0] === soulSystemPrompt(soulPrefs({ soul: { ownerName: 'Lan', userWord: 'chị', replyLang: 'vi', selfWord: 'em' } })) && savedOwner[0].includes('Address your owner as Lan.'),
      'prompt (owner flavour): a saved soul renders the owner text unchanged', savedOwner[0].slice(0, 200));
  } finally {
    await fake.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

console.log(`\ncheck:public-text ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; // not process.exit(): let the fake provider's sockets close first
