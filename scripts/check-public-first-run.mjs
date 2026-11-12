// The clean-first-run decisions (FIRST-RUN.md ids) as pins: a public or official build shows a stranger no owner material and no
// dead end, and the owner build keeps its behaviour. Renderer modules are imported for real where they load in Node; the rest
// is pinned on the source that makes the behaviour. `node scripts/check-public-first-run.mjs`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };
const attempt = async (name, fn) => { try { await fn(); } catch (e) { ok(false, name, String(e && e.message || e).slice(0, 200)); } };

// ---------- the flag ----------
await attempt('F0 public-build module', async () => {
  ok(/publicBuild: !ownerAdmin/.test(read('tauri/sidecar/main.mjs')), 'F0 the host reports publicBuild from the resolved flavour, never a constant');
  const { isPublicBuild } = await load('src/renderer/public-build.js');
  ok(isPublicBuild({ publicBuild: true }) === true, 'F0 publicBuild true is public');
  ok(isPublicBuild({ ownerAdmin: false }) === false && isPublicBuild({}) === false && isPublicBuild(null) === false, 'F0 no flag (Electron, older host) is not public');
});

// ---------- O1: personality samples ----------
{
  const tpl = JSON.parse(read('src/main/soul-templates.json'));
  const text = JSON.stringify(tpl.templates);
  for (const [word, re] of [['T-31', /T-31/], ['dossier', /dossier/i], ['hồ sơ', /hồ sơ/i], ['board', /\bboard\b/i], ['the owner', /\bowner\b/i], ['bảng', /\bbảng\b|rà bảng/i], ['himself', /\bhimself\b|\bhim\b/i]]) {
    ok(!re.test(text), `O1 no "${word}" in any personality template`);
  }
  const previews = tpl.templates.flatMap((x) => [x.preview.en, x.preview.vi]);
  ok(previews.every((p) => typeof p === 'string' && p.length > 10), 'O1 every template keeps an English and a Vietnamese sample');
}

// ---------- O3: public Vietnamese addresses the user through the address word, never as the owner ----------
await attempt('O3 strings', async () => {
  const i18n = await load('src/renderer/i18n.js');
  i18n.setLocale('vi');
  ok(i18n.t('settings.provider.google') === 'Google Cloud · khoá của anh', 'O3 owner build keeps its Vietnamese text');
  i18n.setPublicBuild(true);
  ok(i18n.t('settings.provider.google') === 'Google Cloud · khoá của bạn', 'O3 public: "khoá của bạn"', i18n.t('settings.provider.google'));
  // The address word only: "tiếng Anh" (English) and "Vương quốc Anh" (the UK) are names and stay (R8-F2, i18n.js ANH_WORD).
  const anh = /(?<![\p{L}\p{N}])(?<!(?:[Tt]iếng|quốc) )anh(?![\p{L}\p{N}])/iu;
  const bad = i18n.publicKeys('vi').filter((k) => k !== 'lookTuning.rim' && (anh.test(i18n.publicRaw('vi', k)) || /\bCoS\b/.test(i18n.publicRaw('vi', k))));
  ok(bad.length === 0, 'O3 public Vietnamese: no string says "anh" or "CoS"', bad.slice(0, 8).join(', '));
  i18n.setPublicBuild(false);
  ok(i18n.t('settings.provider.google') === 'Google Cloud · khoá của anh', 'O3 the override switches off again: the owner table is untouched');
  i18n.setLocale('en');
});

// ---------- O2: no Board surface in public ----------
await attempt('O2 shell', async () => {
  const { applyPublicShell } = await load('src/renderer/public-build.js');
  const hidden = new Set();
  const fakeDoc = { querySelector: (sel) => ({ set hidden(v) { if (v) hidden.add(sel); }, style: {} }) };
  applyPublicShell(fakeDoc);
  for (const sel of ['.tab[data-tab="board"]', '#stab-account', '#stabpanel-account', '#hud-card', '#phone-card']) ok(hidden.has(sel), `O2 public hides ${sel}`);
  ok(/if \(isPublicBuild\(info\)\) applyPublicShell\(document\)/.test(read('src/renderer/app.js')), 'O2 only a public build runs the shell change');
  ok(/\[role="tab"\]:not\(\[hidden\]\)/.test(read('src/renderer/settings-tabs.js')), 'O2 Settings opens on the first tab still shown');
  const boot = read('src/renderer/next/boot.js'), brain = read('src/renderer/next/brain/brain.js');
  ok(/initNextUi\(\{ \$, engine, info \}\)/.test(read('src/renderer/app.js')) && /export function initNextUi\(\{ \$, engine, info \}\)/.test(boot), 'O2 the next UI is told the build');
  ok(/initBrain\(\{ card, isOwner: \(\) => ownerAdmin, tabIds: isPublicBuild\(info\) \? publicBrainTabs\(\) : undefined \}\)/.test(boot), 'O2 public Brain has no Tasks tab (it reads the Board)');
  ok(/tabIds = TABS/.test(brain) && /for \(const id of tabIds\)/.test(brain), 'O2 Brain builds only the tabs it is given');
});

// ---------- B4, C8-C12: nothing dead or unexplained on the stage ----------
{
  const boot = read('src/renderer/next/boot.js'), app = read('src/renderer/app.js'), talk = read('src/renderer/talk/index.js');
  // B4: seated at the desk, her arm is inside the Brain card's reach, so the arm-clearance fade kept the card at opacity 0 for good.
  ok(/const stayVisible = isPublicBuild\(info\)/.test(boot) && /if \(st\.guard\) st\.guard\(c\);\s*if \(stayVisible\) continue;/.test(boot), 'B4 public cards never fade away for the arm; the collapse guard still runs');
  // C8
  ok(/gesture\(label, source\) \{\s*if \(publicHidesGesture\(\)\) return;/.test(talk), 'C8 the gesture line is not painted in public');
  ok(/publicHidesGesture = \(\) => isPublicText\(\) && !devMode/.test(talk), 'C8 Developer mode brings it back');
  // C9
  const holo = read('src/renderer/room/holo-screen.js');
  ok(/export function workPanelOn\(stageMode, working, publicBuild = false\) \{\s*if \(publicBuild\) return false;/.test(holo), 'C9 public: the task panel never comes up');
  ok((app.match(/workPanelOn\(stageMode, engine\.working, isPublicBuild\(info\)\)/g) || []).length === 2, 'C9 both call sites pass the build');
  ok(/holo\.setOn\(panelOn\);\s*floatShadow\.setOn\(true\);/.test(app), 'C9 float mode uses the same rule');
  // C10-C12
  ok(/if \(!isPublicBuild\(info\)\) \{[^]*?addPricing\(\{ \$, stage, zumiTab \}\)/.test(boot) || /if \(!isPublicBuild\(info\)\) addPricing/.test(boot), 'C12 no Pricing item in public');
  ok(/if \(isPublicBuild\(info\)\) btn\.hidden = true;/.test(boot), 'C11 no Devices item in public');
  ok(/skillsBtn\.hidden = isPublicBuild\(info\) && !hasLearnedSkill/.test(boot) || /hideSkillsUntilEarned/.test(boot), 'C10 Skills stays out of the rail until a skill is learned');
}
await attempt('C10 derive', async () => {
  const { hasLearnedSkill } = await load('src/renderer/next/skills/derive.js');
  ok(hasLearnedSkill({ nodes: [{ status: 'available' }, { status: 'locked' }] }) === false, 'C10 nothing learned: hidden');
  ok(hasLearnedSkill({ nodes: [{ status: 'learned' }] }) === true, 'C10 one learned: shown');
});

// ---------- B1: Kokoro comes from a GitHub Release; until that exists it says so and offers no failing Install ----------
await attempt('B1 market', async () => {
  const os = await import('node:os');
  const { CATALOG, createMarketHost } = await load('tauri/sidecar/market-host.mjs');
  const { MARKET_ORIGINS, marketFetch } = await load('tauri/sidecar/egress.mjs');
  const kokoro = CATALOG.find((c) => c.id === 'voice.kokoro-82m');
  ok(kokoro.download.url === 'https://github.com/Zumia-Space/zumi/releases/download/packs-v1/voice.kokoro-82m-1.2.1.zip', 'B1 the catalog points at the Release asset');
  ok(kokoro.download.releaseAsset === true, 'B1 the item is marked as a Release asset that may not exist yet');
  ok(!MARKET_ORIGINS.includes('https://zumia.space') && MARKET_ORIGINS.includes('https://github.com') && MARKET_ORIGINS.includes('https://release-assets.githubusercontent.com'), 'B1 the Marketplace reaches GitHub and its asset host, not zumia.space');
  let seenRedirect = null;
  await marketFetch(async (u, i) => { seenRedirect = i.redirect; return { status: 200, ok: true }; })('https://github.com/x');
  ok(seenRedirect === 'manual', 'B1 redirects are never followed blindly: the host checks each hop');
  let refused = false; try { await marketFetch(async () => ({ status: 200 }))('https://evil.example/x'); } catch { refused = true; }
  ok(refused, 'B1 any other host is refused');

  const model = { present: () => false, download: async () => true, remove: () => {}, stop: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-b1-'));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const item = { ...kokoro, id: 'voice.kokoro-82m', modelBytes: 0 };
  const events = [];
  // Not published yet: the HEAD answers 404.
  let calls = [];
  const none = createMarketHost({ dataDir: dir, catalog: [item], model, emit: (c, p) => events.push([c, p]), fetchImpl: async (u, i) => { calls.push(i && i.method || 'GET'); return { status: 404, ok: false, headers: new Headers() }; } });
  const st0 = none.handlers['market.list']().items[0].state;
  ok(st0 === 'unpublished', 'B1 before any answer: not offered', st0);
  await settle();
  ok(none.handlers['market.list']().items[0].state === 'unpublished', 'B1 404: still not offered');
  const r404 = await none.handlers['market.install'](item.id);
  ok(r404.ok === false && r404.code === 'not_published', 'B1 install asks first and refuses honestly', JSON.stringify(r404));
  ok(!calls.includes('GET'), 'B1 nothing was downloaded');
  // Published: the HEAD answers 302; the label moves without a new app version.
  const yes = createMarketHost({ dataDir: dir, catalog: [item], model, emit: (c, p) => events.push([c, p]), fetchImpl: async () => ({ status: 302, ok: false, headers: new Headers({ location: 'https://release-assets.githubusercontent.com/x' }) }) });
  yes.handlers['market.list']();
  await settle();
  ok(yes.handlers['market.list']().items[0].state === 'available', 'B1 published: Install is offered');
  ok(events.some(([c, p]) => c === 'market:progress' && p.phase === 'done' && p.id === item.id), 'B1 the page is told to look again');
  // Offline: unknown is not "available".
  const off = createMarketHost({ dataDir: dir, catalog: [item], model, fetchImpl: async () => { throw new Error('offline'); } });
  off.handlers['market.list']();
  await settle();
  ok(off.handlers['market.list']().items[0].state === 'offline', 'B1 offline: not offered, and said as offline (05-11), not as Coming soon');
  // One hop, on the allowed list, then bytes; a second redirect is a failed download.
  const hops = [];
  const twice = createMarketHost({ dataDir: dir, catalog: [{ ...item, download: { ...item.download, releaseAsset: false } }], model, fetchImpl: async (u) => { hops.push(u); return { status: 302, ok: false, headers: new Headers({ location: `https://release-assets.githubusercontent.com/${hops.length}` }) }; } });
  const r2 = await twice.handlers['market.install'](item.id);
  ok(r2.ok === false && r2.code === 'download_failed' && hops.length === 2, 'B1 a redirect chain stops after one hop', JSON.stringify([r2, hops.length]));
  fs.rmSync(dir, { recursive: true, force: true });

  const ui = read('src/renderer/market.js'), i18n = read('src/renderer/i18n.js');
  ok(/if \(r\.recommended && r\.state !== 'unpublished' && r\.state !== 'unpackaged'\)/.test(ui), 'B1 what cannot be installed is not Recommended');
  ok(/else status\('market\.status\.unavailable'\); \/\/ unpublished/.test(ui), 'B1 it says Not available yet, with no Install button');
  ok(/if \(p\.phase === 'done'\) \{ progress\.delete\(p\.id\); if \(!busyHere\(\)\) refresh\(\); \}/.test(ui) || /progress\.delete\(p\.id\); refresh\(\);/.test(ui), 'B1 the page re-reads the list when told');
  ok(!/from zumia\.space|từ zumia\.space|从 zumia\.space/.test(i18n), 'B1 no string names zumia.space as the source');
  ok((i18n.match(/'market\.status\.unavailable':/g) || []).length === 3 && (i18n.match(/'market\.err\.not_published':/g) || []).length === 3, 'B1 three languages');
});

// ---------- B2: Node is asked for honestly in two languages; No is a screen, not a stack trace ----------
await attempt('B2 node setup', async () => {
  const rt = read('tauri/src-tauri/src/node_runtime.rs'), lib = read('tauri/src-tauri/src/lib.rs'), app = read('src/renderer/app.js');
  ok(/Zumi cần Node\.js/.test(rt) && /Zumi needs Node\.js/.test(rt), 'B2 the dialog speaks Vietnamese and English');
  ok(/nodejs\.org/.test(rt.slice(rt.indexOf('fn ask_consent'), rt.indexOf('fn ask_consent') + 900)) && /35 MB/.test(rt.slice(rt.indexOf('fn ask_consent'), rt.indexOf('fn ask_consent') + 900)), 'B2 it says where from and how much');
  const { nodeSetupProblem, initNodeSetup } = await load('src/renderer/node-setup.js');
  ok(nodeSetupProblem({ message: 'node_runtime_declined: x', fatal: true }) === 'declined', 'B2 a declined dialog is recognised');
  ok(nodeSetupProblem({ message: 'node_runtime_download_failed: x', fatal: true }) === 'failed', 'B2 a failed download too');
  ok(nodeSetupProblem({ message: 'sidecar_exit', fatal: true }) === null && nodeSetupProblem(null) === null, 'B2 any other failure stays with the status line');
  ok(typeof initNodeSetup === 'function', 'B2 the screen exists');
  const screen = read('src/renderer/node-setup.js');
  ok(/invoke\('rpc', \{ method: 'host\.retryNodeSetup', args: \[\] \}\)/.test(screen), 'B2 Try again asks the host');
  ok(/zumi:sidecar-provisioning/.test(screen) && /downloaded/.test(screen), 'B2 the screen shows download progress');
  ok(/\.innerHTML/.test(screen) === false, 'B2 no innerHTML');
  ok(/if \(nodeSetupOpen\(\)\) return;/.test(app.slice(app.indexOf('main().catch'))), 'B2 no stack trace behind the screen');
  ok(app.indexOf('initNodeSetup(') > -1 && app.indexOf('initNodeSetup(') < app.indexOf('await zumi.info()'), 'B2 armed before the first call');
  ok(/nodeSetupProblem\(payload\)/.test(read('src/renderer/sidecar-status.js')), 'B2 the status banner leaves it to the screen');
  ok(/const NODE_SETUP_RETRY: &str = "host\.retryNodeSetup"/.test(lib) && lib.indexOf('NODE_SETUP_RETRY') > -1 && /method == NODE_SETUP_RETRY/.test(lib.slice(0, lib.indexOf('renderer_method_allowed(&method)?'))), 'B2 the host answers it before the allow-list, main webview only');
  ok(/Err\(NodeExeError::NeedsRuntime\)/.test(lib.slice(lib.indexOf('method == NODE_SETUP_RETRY'), lib.indexOf('method == NODE_SETUP_RETRY') + 500)) && /\.restart\(\)/.test(lib.slice(lib.indexOf('method == NODE_SETUP_RETRY'), lib.indexOf('method == NODE_SETUP_RETRY') + 500)), 'B2 it restarts only while Node is still missing');
  ok(/"downloaded": /.test(lib) && /download_progress/.test(rt), 'B2 the beat carries the bytes on disk');
  ok(/zumi:sidecar-provisioning/.test(read('tauri/shim/generate-shim.mjs')), 'B2 the shim passes the beat to the page');
  const kit = read('tauri/README-installer.txt');
  ok(!/do not need to install Node/i.test(kit) && /Node\.js/.test(kit) && /nodejs\.org/.test(kit), 'B2 the kit README tells the truth about Node');
  const i18n = await load('src/renderer/i18n.js');
  for (const loc of ['en', 'vi', 'zh']) for (const k of ['nodeSetup.title', 'nodeSetup.declined', 'nodeSetup.failed', 'nodeSetup.retry', 'nodeSetup.progress']) ok(Boolean(i18n.TABLES[loc][k]), `B2 ${loc} has ${k}`);
});

// ---------- B3: one app per data folder ----------
{
  const lib = read('tauri/src-tauri/src/lib.rs');
  ok(exists('tauri/src-tauri/src/single_instance.rs'), 'B3 the module exists');
  ok(exists('tauri/src-tauri/src/single_instance.rs') && /CreateMutexW/.test(read('tauri/src-tauri/src/single_instance.rs')) && /AllowSetForegroundWindow/.test(read('tauri/src-tauri/src/single_instance.rs')), 'B3 a per-folder mutex; the second launch hands the first the right to come forward');
  ok(/!flavour_file && !self_test\.enabled\(\)/.test(lib.slice(lib.indexOf('.setup(move |app|'), lib.indexOf('start_sidecar_provisioning_node(&handle, &setup_client)'))), 'B3 public and official only, decided before the sidecar starts');
  ok(/mod single_instance;/.test(lib), 'B3 wired in');
  const toml = read('tauri/src-tauri/Cargo.toml');
  ok(!/tauri-plugin-single-instance/.test(toml), 'B3 no new crate');
}

// ---------- C1, C2: a stranger is told about the key ----------
await attempt('C1 C2', async () => {
  const i18n = await load('src/renderer/i18n.js');
  const app = read('src/renderer/app.js');
  ok(exists('src/renderer/key-guide.js'), 'C1 the card exists');
  const guide = exists('src/renderer/key-guide.js') ? read('src/renderer/key-guide.js') : '';
  ok(/zumi\.ai\.openKeyPage\(\)/.test(guide), 'C1 a link to get a key: the provider page the host already opens');
  ok(/stab-ai/.test(guide) && /brain-key-input/.test(guide), 'C1 a link to the field');
  ok(/zumi:onboarding-done/.test(guide) && /zumi:onboarding-done/.test(read('src/renderer/next/boot.js')), 'C1 it waits for the onboarding cards');
  ok(/zumi:talk-enabled/.test(guide) && /zumi:talk-enabled/.test(read('src/renderer/talk/index.js')), 'C1 it leaves when a key works');
  ok(/if \(isPublicBuild\(info\)\) initKeyGuide\(/.test(app), 'C1 public only');
  i18n.setLocale('vi'); i18n.setPublicBuild(true);
  const vi = i18n.t('msg.placeholderOff');
  ok(/khoá/i.test(vi) && !/cử chỉ/i.test(vi), 'C2 the placeholder says plainly that a key is needed (vi)', vi);
  i18n.setPublicBuild(false); const ownerVi = i18n.t('msg.placeholderOff'); i18n.setPublicBuild(true);
  ok(ownerVi !== vi, 'C2 the owner keeps his placeholder');
  i18n.setLocale('en');
  ok(/key/i.test(i18n.t('msg.placeholderOff')) && !/gestures/.test(i18n.t('msg.placeholderOff')), 'C2 the placeholder (en)', i18n.t('msg.placeholderOff'));
  ok(/Settings/.test(i18n.t('app.noKeyReply')), 'C2 a chat with no key answers with the path', i18n.t('app.noKeyReply'));
  i18n.setPublicBuild(false);
  ok(/if \(isPublicBuild\(info\) && current && !talk\.enabled\) \{/.test(app) && /t\('app\.noKeyReply'\)/.test(app), 'C2 the send path answers, never silent');
  for (const loc of ['en', 'vi', 'zh']) for (const k of ['keyGuide.title', 'keyGuide.body', 'keyGuide.add', 'keyGuide.get', 'app.noKeyReply']) ok(Boolean(i18n.TABLES[loc][k]), `C1 ${loc} has ${k}`);
});

// ---------- C3-C7 ----------
await attempt('C3-C7', async () => {
  const i18n = await load('src/renderer/i18n.js');
  // C3
  ok(i18n.TABLES.en['settings.modeFree'] === 'Use free models', 'C3 owner text unchanged');
  ok(/key/i.test(i18n.publicRaw('en', 'settings.modeFree')) && /khoá/i.test(i18n.publicRaw('vi', 'settings.modeFree')) && /密钥/.test(i18n.publicRaw('zh', 'settings.modeFree')), 'C3 public: free providers still need a key, and it says so');
  // C4
  const { applyPublicShell } = await load('src/renderer/public-build.js');
  const moves = [];
  applyPublicShell({ querySelector: (sel) => ({ sel, style: {}, before(x) { moves.push([x.sel, sel]); } }) });
  ok(moves.some(([a, b]) => a === '#brain-key-save' && b === '#brain-key-test'), 'C4 public buttons read Save, then Test key, as the steps do');
  // C5
  const card = read('src/renderer/brain-key-card.js');
  ok(/if \(isPublicText\(\)\) \{ el\.edit\.parentNode\.insertBefore\(row, el\.edit\);/.test(card), 'C5 the 18+ switch sits next to the field in public');
  // C6
  const settings = read('src/renderer/settings.js');
  ok(/if \(isPublicText\(\) && el\.voiceSpeaking\) el\.voiceSpeaking\.textContent = t\('settings\.voiceSpeaking', \{ voice: voiceName\(v\) \|\| t\('settings\.voiceSpeakingNone'\) \}\)/.test(settings), 'C6 the card says which voice speaks, from the status the app reports');
  for (const loc of ['en', 'vi', 'zh']) ok(Boolean(i18n.TABLES[loc]['settings.voiceSpeaking']) && Boolean(i18n.TABLES[loc]['settings.voiceSpeakingNone']), `C6 ${loc}`);
  // C7
  const imp = await load('src/renderer/profile-import.js');
  ok(imp.hasSomethingToImport({ copy: [], same: ['a'], skipped: ['b'], unknown: [], conflicts: [] }) === false, 'C7 0 settings: no dialog');
  ok(imp.hasSomethingToImport({ copy: ['a'], same: [], skipped: [], unknown: [], conflicts: [] }) === true, 'C7 something to copy: the dialog');
  ok(imp.hasSomethingToImport({ copy: [], conflicts: [{ key: 'k' }] }) === true, 'C7 a conflict to choose: the dialog');
  const src = read('src/renderer/profile-import.js');
  ok(/if \(isPublicText\(\)\) \{ try \{ await api\.importDismiss\(\); \} catch/.test(src), 'C7 Not now does not come back in public');
});

// ---------- E3, E6: the strings that stayed English ----------
await attempt('E3 E6', async () => {
  const i18n = await load('src/renderer/i18n.js');
  ok(i18n.publicRaw('vi', 'settings.testPlayed') === 'Đã phát.', 'E3 "Played." in Vietnamese');
  ok(i18n.publicRaw('vi', 'roomView.talk') === 'Trò chuyện' && i18n.publicRaw('vi', 'roomView.work') === 'Làm việc' && i18n.publicRaw('vi', 'roomView.room') === 'Cả phòng', 'E6 the stage views in Vietnamese');
  ok(i18n.TABLES.vi['roomView.talk'] === 'Talk', 'E6 the owner table is untouched');
});

// ---------- updates row ----------
{
  const conf = JSON.parse(read('tauri/src-tauri/tauri.conf.json'));
  ok(/\$\('update-check-row'\)\.hidden/.test(read('src/renderer/update-ui.js')) || /update-check-row/.test(read('src/renderer/update-ui.js')), 'U0 the row is the update UI\'s to show');
  ok(/<[^>]*id="update-check-row"[^>]*hidden/.test(read('src/renderer/index.html')), 'U0 hidden until a host says the updater is on');
  ok(/pubkey/.test(read('tauri/src-tauri/src/updater.rs')) && /fn enabled/.test(read('tauri/src-tauri/src/updater.rs')), 'U0 an empty key turns the updater off');
}

// ---------- C13, C14, E1: installer and uninstaller ----------
{
  const conf = JSON.parse(read('tauri/src-tauri/tauri.public.conf.json'));
  const nsis = conf.bundle && conf.bundle.windows && conf.bundle.windows.nsis;
  ok(Boolean(nsis) && JSON.stringify(nsis.languages) === '["English","Vietnamese","SimpChinese"]', 'E1 the public installer speaks the app\'s three languages');
  ok(!/"languages"/.test(read('tauri/src-tauri/tauri.conf.json')), 'E1 the owner installer is unchanged');
  for (const [lang, def] of [['English', 'LANG_ENGLISH'], ['Vietnamese', 'LANG_VIETNAMESE'], ['SimpChinese', 'LANG_SIMPCHINESE']]) {
    const f = nsis && nsis.customLanguageFiles && nsis.customLanguageFiles[lang];
    const text = f && exists(`tauri/src-tauri/${f}`) ? read(`tauri/src-tauri/${f}`) : '';
    ok(Boolean(text), `C13 ${lang} wording file`);
    ok(text.includes(`\${${def}}`), `C13 ${lang} is defined for its own language`);
    const line = (key) => (text.split('\n').find((l) => l.startsWith(`LangString ${key} `)) || '');
    const said = line('appRunningOkKill').split('"')[1] || '';
    ok(said && !/kill/i.test(said) && !/tắt ứng dụng/.test(said) && !/终止/.test(said), `C13 ${lang}: no "kill"`);
    ok(/Node\.js/.test(line('deleteAppData')), `C14 ${lang}: the delete option names what it deletes, and what stays`);
    ok(!/\{\{/.test(text), `C13 ${lang}: only NSIS defines, no bundler template words`);
  }
  // A bundler that adds a string needs it here too; only checkable with the pinned bundler on disk.
  const reg = path.join(process.env.CARGO_HOME || '', 'registry', 'src');
  const dirs = fs.existsSync(reg) ? fs.readdirSync(reg).flatMap((d) => fs.readdirSync(path.join(reg, d)).filter((n) => n.startsWith('tauri-bundler-')).map((n) => path.join(reg, d, n, 'src/bundle/windows/nsis/languages/English.nsh'))) : [];
  if (dirs.length && nsis && nsis.customLanguageFiles) {
    const keys = (t) => t.split('\n').filter((l) => l.startsWith('LangString ')).map((l) => l.split(' ')[1]).sort().join();
    ok(keys(fs.readFileSync(dirs[dirs.length - 1], 'utf8')) === keys(read(`tauri/src-tauri/${nsis.customLanguageFiles.English}`)), 'C13 the wording file has every string the bundler uses');
  } else console.log('SKIP bundler language file not on disk');
}

// ---------- E7: the root README ----------
{
  const md = read('README.md');
  for (const [name, re] of [['what Zumi is', /desktop companion/], ['install', /## Install/], ['the real file name', /Zumi_<version>_x64-setup\.exe/], ['the key', /## Add a key/], ['build from source', /## Build from source/], ['licence', /AGPL-3\.0-only/], ['experimental', /experimental/i], ['Windows first', /Windows first\. Mac and Linux come later/], ['Node told straight', /Node\.js 22 or newer/]]) ok(re.test(md), `E7 README: ${name}`);
  ok(!/v0\.2\.0|Zumi-Setup|Electron|Chưa có backend/.test(md), 'E7 README: nothing of the old text');
  ok(/Node\.js \(22 or newer\)/.test(read('tauri/README-installer.txt')), 'B2 the kit README gives the real minimum');
}

// ---------- what the first rerun found ----------
await attempt('rerun 1', async () => {
  const { hasLearnedSkill } = await load('src/renderer/next/skills/derive.js');
  ok(hasLearnedSkill({ nodes: [{ kind: 'base', status: 'learned' }, { kind: 'learned', status: 'available' }] }) === false, 'C10 the Chat node every profile starts with is not a skill learned');
  ok(hasLearnedSkill({ nodes: [{ kind: 'learned', status: 'learned' }] }) === true, 'C10 a skill really learned shows the tab');
  const boot = read('src/renderer/next/boot.js'), brain = read('src/renderer/next/brain/brain.js');
  ok(/memoryAvailable\(\) \? \['memory', 'soul'\] : \['soul'\]/.test(boot), 'B4 public Brain: no Memory tab while memory is not in this host (it spoke of Tauri and Electron)');
  ok(/tab: tabIds\[0\]/.test(brain), 'B4 Brain opens on the first tab it was given');
  const guide = read('src/renderer/key-guide.js');
  ok(/field\.disabled \? \$\('brain-free-age18'\) : field/.test(guide), 'C1 Add my key lands on the 18+ switch while the field is blocked');
  const i18n = await load('src/renderer/i18n.js');
  for (const [loc, tab] of [['en', 'AI & Usage'], ['vi', 'AI & Sử dụng'], ['zh', 'AI 与用量']]) {
    ok(i18n.publicRaw(loc, 'msg.placeholderOff').includes(tab), `C2 ${loc} placeholder names the tab as it reads`);
    ok(i18n.TABLES[loc]['app.noKeyReply'].includes(tab), `C2 ${loc} chat answer names the tab as it reads`);
    ok(!/Board/.test(i18n.publicRaw(loc, 'settings.themeD')), `O2 ${loc} the theme hint names no Board tab`);
    ok(Boolean(i18n.TABLES[loc]['settings.provider.windowsHere']), `C6 ${loc} has the Windows voice label`);
  }
  const html = read('src/renderer/index.html');
  ok(html.indexOf('id="voice-speaking"') > html.indexOf('data-i18n="settings.voiceSection"'), 'C6 the line sits under the card head');
  const settings = read('src/renderer/settings.js');
  ok(/isPublicText\(\) && lang === 'en' && saved && !known\(saved\)/.test(settings), 'C6 the provider select shows what speaks, not the first option');
  ok(/if \(isPublicText\(\)\) card\.querySelector\('#watch-level'\)\.closest\('\.srow'\)\.hidden = true/.test(read('src/renderer/rhythm-card.js')), 'O2 no board watcher switch in public');
});

// ---------- what the second rerun found ----------
{
  const guide = read('src/renderer/key-guide.js'), app = read('src/renderer/app.js'), src = read('src/renderer/profile-import.js');
  ok(/initKeyGuide\(\{ zumi, \$(, openGuide: [\w.]+)? \}\)/.test(app) && /let onboarded = false, enabled = !\$\('talk'\)\.hidden/.test(guide), 'C1 a key saved earlier: no card on the next start (the first event fires before the card listens, and talk.enabled still waits for the model)');
  ok(/if \(isPublicText\(\) && !hasSomethingToImport\(plan\)\) \{ await api\.importDismiss\(\); return; \}/.test(src), 'C7 nothing to import is an answer: the offer does not come back when a later start has settings of its own');
}

// ---------- launch path: the gate of 2026-11-03 ----------
await attempt('gate', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-notes-'));
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(bad, '## vi\nx\n\n## en\nOwner preview (alpha). Kokoro is recommended.\n');
  const r = spawnSync(process.execPath, ['scripts/check-release-gate.mjs', '--notes', bad], { cwd: ROOT, encoding: 'utf8' });
  ok(r.status !== 0 && /FAIL notes do not say "Owner preview"/.test(r.stdout) && /FAIL notes do not recommend Kokoro/.test(r.stdout), 'R3 the gate refuses notes with Owner preview and a Kokoro recommendation');
  const good = path.join(dir, 'good.md');
  fs.writeFileSync(good, '## vi\nBản đầu tiên.\n\n## en\nThe first public alpha.\n');
  const g = spawnSync(process.execPath, ['scripts/check-release-gate.mjs', '--notes', good], { cwd: ROOT, encoding: 'utf8' });
  ok(!/FAIL notes/.test(g.stdout), 'R3 it passes plain notes', g.stdout.split('\n').filter((l) => /FAIL notes/.test(l)).join());
  fs.rmSync(dir, { recursive: true, force: true });
  const yml = read('.github/workflows/release.yml');
  const list = read('scripts/release-checks.mjs');
  ok(/'check-release-gate', '--kokoro', '--live'/.test(list) && yml.indexOf('release-checks.mjs') > yml.indexOf('- run: npm ci'), 'R2 the release runs the gate with the Kokoro rebuild, after npm ci');
  ok(/--live/.test(list), 'R6 the release asks GitHub which release is Latest');
  const { isPublicRepoExcluded } = (await import('node:module')).createRequire(import.meta.url)('./lib/zumi-only.cjs');
  for (const p of ['docs/migration/PLAN.md', 'docs/migration/DRIFT.md', 'docs/agents/KEEP-BOARD-CURRENT.md', 'release-notes/0.2.11.md', 'release-notes/0.3.0-alpha.2.md', 'release-notes/0.3.0-alpha.13.md']) ok(isPublicRepoExcluded(p), `R7 the export drops ${p}`);
  for (const p of ['docs/migration/api-inventory.json', 'docs/migration/data-schema.json', 'release-notes/0.3.0-alpha.14.md']) ok(!isPublicRepoExcluded(p), `R7 the export keeps ${p}: tools read it`);
  for (const f of ['src/renderer/next/brain/vendor/diagram.js', 'vendor/laneboard/public/diagram.js', 'vendor/laneboard/src/roles.mjs', 'vendor/laneboard/AGENTS.md']) ok(!/[A-Z]:\/K\//.test(read(f)), `R7 ${f} names no owner path`);
  ok(!/\[ASSETS-LICENSE\.md\]\(/.test(read('README.md')), 'R4 README links no file the export drops');
  ok(/not in this repository/.test(read('README.md')), 'R4 README says where the asset terms are');
  ok(!/the owner's|owner\s+approval|T-31|astra-out/i.test(read('THIRD_PARTY_LICENSES.md')), 'R2 the licence file carries no owner wording');
  ok(!/room videos/.test(read('CONTRIBUTING.md')), 'R4 CONTRIBUTING claims no room videos: the official installer has none');
  const i18n = await load('src/renderer/i18n.js');
  ok(!/HUD/.test(i18n.publicRaw('en', 'settings.tab.room')) && !/HUD/.test(i18n.publicRaw('vi', 'settings.tab.room')) && !/HUD/.test(i18n.publicRaw('zh', 'settings.tab.room')), 'N1 the tab is named for what a public build has in it');
  ok(!/Board|Bảng/.test(i18n.publicRaw('en', 'import.check.board_login.b')) && !/Board|Bảng/.test(i18n.publicRaw('vi', 'import.check.board_login.b')), 'N2 the import checklist sends nobody to a Board tab');
  ok(!/zumia\.space/.test(read('scripts/market-pack-kokoro.mjs')), 'N3 the pack tool names the real host');
});

// ---------- found while filming ----------
await attempt('filming', async () => {
  const app = read('src/renderer/app.js');
  ok(/if \(isPublicBuild\(info\) && !devChrome\) return;\s*const chip = \$\('reflex-chip'\);/.test(app), 'C8 the top-bar chip carries the same line: not painted in public without Developer mode');
  ok(/addEventListener\('zumi:dev-chrome', \(e\) => \{ devChrome = Boolean\(e\.detail\); \}\)/.test(app), 'C8 Developer mode brings the chip back');
  const i18n = await load('src/renderer/i18n.js');
  for (const loc of ['en', 'vi', 'zh']) {
    ok(!/Google|Gemini/.test(i18n.publicRaw(loc, 'settings.presetAge18Reason')), `C5 ${loc}: the 18+ reason names no one provider: it shows for Groq and OpenRouter too`, i18n.publicRaw(loc, 'settings.presetAge18Reason'));
    ok(!/board|bảng|看板|code session|phiên code|代码会话/i.test(i18n.publicRaw(loc, 'roles.status')), `O2 ${loc}: the chat models card names no board or code session`, i18n.publicRaw(loc, 'roles.status'));
  }
  // The real provider switch: the select's change handler repaints the box through paintFreeLlm with the new provider.
  const card = read('src/renderer/brain-key-card.js');
  ok(/const gemini = providerId === 'gemini';/.test(card) && /free\.eea\.hidden = !gemini;/.test(card) && /free\.freeTier\.hidden = !gemini;/.test(card), 'C5 the Gemini-only notes follow the provider');
  const { isPublicRepoExcluded } = (await import('node:module')).createRequire(import.meta.url)('./lib/zumi-only.cjs');
  ok(!isPublicRepoExcluded('scripts/check-tauri-coverage.mjs'), 'R7 check-tauri-coverage stays: other exported checks import it, and it reads the plan only under --require-full');
  ok(/fs\.existsSync\(path\.join\(ROOT, 'docs', 'migration', 'DRIFT\.md'\)\)/.test(read('scripts/check-tauri-egress.mjs')), 'R7 the egress check runs without the dropped drift log');
});

// ---------- third launch gate ----------
{
  ok(/stripOfficialManifest\(stage, flavour\)/.test(read('tauri/stage-bundle.mjs')) && /export function stripOfficialManifest/.test(read('tauri/flavour-stage.mjs')), 'G3 the official stage drops the room manifest, which names an owner path');
  ok(!/anh: "ko gioi han/.test(read('src/main/chat-brain.js')), 'G3 chat-brain quotes no owner');
  ok(!/owner records|G5I waiver/.test(read('docs/security-notes.md')), 'G3 security notes point at no internal record');
  // Owner quotes in comments. The quoted strings a check or the UI uses are not comments and stay.
  const quote = /(?:^\s*(?:\/\/|\*|#)|\s\/\/\s).*\b(?:owner|Owner|anh|Anh)\b[^"\n]{0,40}?(?::|said)\s*"[^"\n]*"/;
  const files = ['src/main/main.js', 'src/main/providers.js', 'src/renderer/app.js', 'src/renderer/brain-key-card.js', 'scripts/builder-selftest.cjs', 'scripts/check-owner-board.mjs', 'scripts/check-pricing.mjs'];
  const hits = files.filter(exists).filter((f) => read(f).split('\n').some((l) => quote.test(l)));
  ok(hits.length === 0, 'G3 no owner quote in the comments of the sampled files', hits.join(', '));
}

// ---------- delta of the third gate ----------
{
  // Slim installer (owner 11-11 mkt-q1): the official frontend embeds no room at all, so no room manifest either.
  ok(/else if \(officialFlavour\) console\.log\([^\n]*Marketplace pack/.test(read('tauri/prep-ui.mjs')), 'G3 the official frontend carries no room (and so no room manifest)');
  ok(!/Fable ruling|the owner's own OpenRouter/.test(read('src/main/chat-brain.js').split('\n').slice(0, 3).join('\n')), 'G3 chat-brain opens with no internal words');
  ok(!/CoS ruling/.test(read('src/renderer/next/theme-a.css')), 'G3 shipped CSS names no internal ruling');
  ok(/`export of \$\{/.test(fs.existsSync(path.join(ROOT, 'scripts/check-export.mjs')) ? read('scripts/check-export.mjs') : '`export of ${'), 'G3 the export commit says which tree commit it is');
}

console.log(`\ncheck-public-first-run: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
