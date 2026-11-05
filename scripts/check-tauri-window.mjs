// T-31 P1c4 main-window check. Plain Node, no Electron, no window, no network.
//
// The main webview guard and the Electron shell parity are Rust + config; this check pins the parts a
// compile cannot (the spare-PC probe measures the rest):
//   - tauri.conf.json main window == Electron's createWindow (src/main/main.js:625-648), built in `setup`
//     (create:false), http scheme (useHttpsScheme unset: the guard's allow set is `http://*.localhost`),
//     and a CSP whose connect-src names no ws:/wss:/wildcard/remote host (gate P1c4 G4: CSP is main's ws
//     closure for the preview);
//   - lib.rs guards main before the sidecar serves anything (it starts in parallel, held by guard_pending; fail-closed = started then killed, exit 1), denies new windows,
//     answers main's requests only through the parity-4b asset route (never the guest 403), and never opens
//     the OS browser for main's own links;
//   - the guard installs ONLY the request filter (gate G6): no NavigationStarting hook on main;
//   - window:focus / window:visible go to the main webview with emit_to(MAIN_LABEL, ...).
//
//   node scripts/check-tauri-window.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const SRC = path.join(ROOT, 'tauri', 'src-tauri', 'src');
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8'));
// Line comments removed so a comment that names a forbidden call is not read as code. Only a `//` that
// starts a line or follows whitespace counts, so the `//` inside "http://..." strings survives.
const code = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
const lib = code('lib.rs');
const guard = code('guest_guard.rs');
const shell = code('window_shell.rs');

// The text of `fn <name>` from its signature to its matching closing brace.
const fnBody = (src, name) => {
  const start = src.search(new RegExp(`\\bfn ${name}\\b`));
  if (start < 0) return '';
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
};
const before = (text, a, b) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};

// ---- predicates under test (each is also driven by a mutated text below, so a weakened predicate fails here) ----
const SIDECAR_FLAGS_STMT = 'cmd.creation_flags(sidecar_creation_flags(cfg!(debug_assertions)));';
// The exact statement, and the only creation_flags( in the text (no OR-ed CREATE_NO_WINDOW, no second call).
const callSiteOk = (spawnFnText) => spawnFnText.includes(SIDECAR_FLAGS_STMT) && (spawnFnText.match(/\.creation_flags\(/g) || []).length === 1;
const CP_IMPORT = /['"](?:node:)?child_process['"]/;
const CP_CALL = /\b(?:childProcess\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/g;
const importsChildProcess = (t) => CP_IMPORT.test(t);
const bareSpawns = (t) => {
  const out = [];
  for (const m of t.matchAll(CP_CALL)) {
    // vault-adapter builds its options in spawnOptions() (windowsHide: true, pinned by check-tauri-vault).
    if (!/windowsHide:\s*true|spawnOptions\(/.test(t.slice(m.index, m.index + 600))) out.push(m.index);
  }
  return out;
};

// ---- window config == Electron's createWindow (src/main/main.js:625-648, MIN_WINDOW at :625) ----
const main = (CONF.app.windows || []).find((w) => w.label === 'main') || {};
ok(main.create === false, 'main window is create:false (built in setup so it can carry its hooks)');
ok(main.width === 1280 && main.height === 800, 'content size 1280x800 (main.js:628-629)', `${main.width}x${main.height}`);
ok(main.minWidth === 900 && main.minHeight === 600, 'minimum 900x600 (main.js:625 MIN_WINDOW)', `${main.minWidth}x${main.minHeight}`);
ok(main.visible === false, 'hidden until the page has loaded (main.js:637 show:false)');
ok(main.center === true, 'centred (BrowserWindow default)');
ok(main.backgroundColor === '#0e1016', 'background #0e1016, no white flash (main.js:634)', String(main.backgroundColor));
ok(main.resizable === true, 'resizable');

// ---- render-loop parity (step 7-2) + SmartScreen ON (step 7 gate ruling (a)) ----
// Electron sets backgroundThrottling:false + autoplayPolicy:'no-user-gesture-required' (main.js:614-615) and appends
// disable-renderer-backgrounding / disable-background-timer-throttling / disable-features CalculateNativeWinOcclusion
// (main.js:204-206). WebView2 gets them as browser args instead. additionalBrowserArgs REPLACES Tauri's defaults, which
// disable msWebOOUI, msPdfOOUI AND SmartScreen: the string must name the first two only, so SmartScreen stays ON (both
// for main and for the guests, whose own args are pinned in check-tauri-guest.mjs).
const EXPECTED_BROWSER_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required';
ok(main.additionalBrowserArgs === EXPECTED_BROWSER_ARGS, 'additionalBrowserArgs is the exact render-loop string with SmartScreen ON', String(main.additionalBrowserArgs));
const browserArgs = String(main.additionalBrowserArgs || '').split(/\s+/).filter(Boolean);
ok(browserArgs.includes('--disable-renderer-backgrounding'), 'WebView2 keeps rendering: --disable-renderer-backgrounding (main.js:614 backgroundThrottling:false)');
ok(browserArgs.includes('--disable-background-timer-throttling'), 'WebView2 timers are not throttled: --disable-background-timer-throttling');
ok(browserArgs.includes('--autoplay-policy=no-user-gesture-required'), 'audio may start without a gesture: --autoplay-policy=no-user-gesture-required (main.js:615)');
const disabledFeatures = (browserArgs.find((a) => a.startsWith('--disable-features=')) || '').split('=')[1]?.split(',') || [];
ok(disabledFeatures.includes('CalculateNativeWinOcclusion'), 'occlusion is off: --disable-features=…,CalculateNativeWinOcclusion (main.js:206)');
ok(!disabledFeatures.includes('msSmartScreenProtection'), 'SmartScreen is NOT disabled (msSmartScreenProtection is absent)', disabledFeatures.join(','));
ok(['msWebOOUI', 'msPdfOOUI'].every((f) => disabledFeatures.includes(f)), 'msWebOOUI and msPdfOOUI stay disabled', disabledFeatures.join(','));

// ---- packaging (step 7-2): NSIS per-user + WebView2 bootstrapper ----
const bundleConf = CONF.bundle || {};
const winConf = bundleConf.windows || {};
ok(bundleConf.active === true && (bundleConf.targets || []).includes('nsis'), 'the bundle builds an NSIS installer');
ok(winConf.nsis && winConf.nsis.installMode === 'currentUser', 'NSIS installs per user (no admin prompt)', JSON.stringify(winConf.nsis));
ok(winConf.webviewInstallMode && winConf.webviewInstallMode.type === 'downloadBootstrapper', 'WebView2 bootstrapper runs when the runtime is missing', JSON.stringify(winConf.webviewInstallMode));

// ---- gate condition 2: http scheme + CSP closure ----
const confText = JSON.stringify(CONF);
ok(!/useHttpsScheme/i.test(confText), 'useHttpsScheme is unset anywhere in tauri.conf.json (the guard allows http://tauri.localhost only)');
const csp = String((CONF.app.security || {}).csp || '');
const connect = (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src ')) || '').split(/\s+/).slice(1);
ok(connect.length > 0, 'the CSP has a connect-src directive', csp);
const allowedConnect = new Set(["'self'", 'blob:', 'data:', 'ipc:', 'http://ipc.localhost']);
const strayConnect = connect.filter((s) => !allowedConnect.has(s));
ok(strayConnect.length === 0, 'connect-src names only self/blob:/data:/ipc:/http://ipc.localhost', strayConnect.join(' '));
ok(!connect.some((s) => /^wss?:/.test(s) || s.includes('*')), 'connect-src has no ws:/wss:/wildcard source (main ws closure, gate G4)');
ok(!/(^|\s)(\*|https?:\/\/(?!ipc\.localhost)\S+|wss?:\S*)(\s|;|$)/.test(csp), 'no directive of the CSP names a remote origin or wildcard', csp);

// ---- lib.rs: build + guard main before the sidecar, fail closed ----
const setup = fnBody(lib, 'run');
const builder = fnBody(lib, 'open_guarded_main');
ok(builder.length > 0, 'lib.rs has open_guarded_main');
// The sidecar is spawned via start_sidecar_provisioning_node (Node is resolved off the main thread first, 15f10a8).
// Perf (T-31): the sidecar now starts BEFORE the WebView2 build so they overlap (~250 ms off warm first frame). The
// guarantee that used to come from ordering is now explicit. Invariant (CoS R1 25-10): no sidecar-originated effect
// reaches a webview or the OS shell before the main guard is up. guard_pending is raised before the spawn and lowered only
// after open_guarded_main succeeded; while it is set the one predicate Rpc::serving() is false, and the three sidecar
// paths (webview rpc `call`, sidecar -> host requests, push events) all go through it. NOT "never started": fail-closed
// now means the sidecar STARTED (its own start-up work ran) and is then killed, its queued effects dropped, before exit.
ok(!setup.includes('spawn_sidecar(') && /spawn_sidecar\(/.test(fnBody(lib, 'start_sidecar_provisioning_node')), 'setup starts the sidecar only through start_sidecar_provisioning_node');
ok(before(setup, 'guard_pending.store(true', 'start_sidecar_provisioning_node(') && before(setup, 'start_sidecar_provisioning_node(', 'open_guarded_main('),
  'setup raises guard_pending, then starts the sidecar, then builds main (sidecar and WebView2 creation overlap)');
ok(before(setup, 'open_guarded_main(', 'guard_pending.store(false'), 'guard_pending is lowered only after open_guarded_main returned Ok');
ok(/fn serving_with\(&self, pending: &Pending\) -> bool \{\s*pending\.ready && !self\.0\.guard_pending\.load\(Ordering::SeqCst\)\s*\}/.test(lib),
  'one predicate: serving = handshake passed AND main guard up');
const callBody = fnBody(lib, 'call');
ok(before(callBody, 'serving_with(&pending)', 'waiters.insert') && /serving_with\(&pending\) \{[^}]*sidecar_not_ready/.test(callBody),
  'Rpc::call (webview -> sidecar) refuses with sidecar_not_ready while not serving, before anything is queued or written');
ok(/\bif !rpc\.serving\(\) \{\s*rpc\.respond\(&id, Err\("sidecar_not_ready"\.to_string\(\)\)\);\s*return;\s*\}[\s\S]*run\(method/.test(fnBody(lib, 'answer_sidecar_request')),
  'sidecar -> host requests are answered sidecar_not_ready, and never run, while not serving');
ok(/answer_sidecar_request\(rpc, msg, \|method, args\|/.test(fnBody(lib, 'handle_sidecar_request')), 'handle_sidecar_request runs every request through that gate');
ok(/\bif rpc\.serving\(\) \{\s*forward\(params\);/.test(fnBody(lib, 'route_event')) && /route_event\(rpc, /.test(fnBody(lib, 'handle_message')) && !/events::forward\(app, msg/.test(fnBody(lib, 'handle_message')),
  'sidecar push events reach events::forward only through route_event (dropped while not serving)');
ok(/guard_pending\.store\(true, Ordering::SeqCst\);\s*shutdown_sidecar\(rpc\);/.test(fnBody(lib, 'fail_guard_closed')), 'a guard failure keeps guard_pending raised and kills the sidecar');
ok(/guard: main FAILED[\s\S]*?fail_guard_closed\(&early_rpc\);\s*handle\.exit\(1\)/.test(setup), 'a guard failure kills the early sidecar and drops its queued effects before exiting');
ok(/WebviewWindowBuilder::from_config\(/.test(builder), 'main is built from its tauri.conf.json entry (WebviewWindowBuilder::from_config)');
ok(before(builder, 'with_webview(', 'try_recv('), 'the guard result is read with try_recv right after with_webview (inline-install self-check)');
ok(/install_main_guard/.test(builder), 'open_guarded_main installs the main guard');
ok(/\.on_navigation\(\s*guest_guard::main_nav_allowed\s*\)/.test(builder), 'main has the navigation lock (on_navigation(main_nav_allowed))');
ok(/\.on_new_window\(/.test(builder) && /NewWindowResponse::Deny/.test(builder) && !/NewWindowResponse::Create/.test(builder), 'main denies every new window');
// Parity 4b-1: main now DOES install a request handler — the asset route for imported/external files (and only the
// four fixed shapes; every other path is left to Tauri). It must never be the guest 403, which would block the app
// itself, and the test-only avatar stays a feature-gated first step.
ok(/\.on_web_resource_request\(/.test(builder), 'main installs its request handler (the 4b asset route)');
ok(/asset_route::serve\(/.test(builder), 'main answers through asset_route::serve (parity 4b asset route)');
ok(!/deny_app_asset/.test(builder), 'main never answers its own requests with the guest 403');
ok(/test_model::serve\(/.test(builder) && builder.indexOf('test_model::serve') < builder.indexOf('asset_route::serve'), 'the --model / ZUMI_TEST_MODEL avatar is served first, in every build (Electron parity)');
ok(/\.data_directory\(dir\)/.test(builder) && /webview_data_dir\(&self_test\)/.test(builder),
  'a self-test launch moves the main WebView2 profile into <runDir>/webview (gate 12 finding 6)');
ok(/fn webview_data_dir[\s\S]*?self_test\.run_dir\(\)\.or\(self_test\.user_data_dir\(\)\)\.map\(\|base\| base\.join\("webview"\)\)/.test(lib),
  'webview_data_dir is None for a normal launch without --data-dir (the real EBWebView profile is unchanged); --data-dir moves it to <dir>/webview');
ok(!/request_external_open|decideExternalUrl|shell_ops|ShellExecute/.test(builder), 'main never reaches the external-link path (gate G6: silent deny)');
ok(/main_guard_not_inline/.test(builder), 'a missing inline guard result is a failure');
ok(/source_kinds == "all"/.test(builder), 'only source-kinds=all passes (document-only exits, gate G3)');
ok(/shell\.disarm\(\)/.test(builder), 'a failed guard spends the show-once flag (never shows an unguarded main)');
ok(/eprintln!\("guard: main FAILED \{reason\}"\);\s*fail_guard_closed\(&early_rpc\);\s*handle\.exit\(1\);\s*return Ok\(\(\)\);/.test(setup), 'a guard failure prints "guard: main FAILED <reason>", kills the sidecar and drops its queued effects, exits 1 and returns');
ok(/eprintln!\("guard: main source-kinds=\{source_kinds\}"\)/.test(builder), 'success prints "guard: main source-kinds=<kinds>"');
ok(/mod window_shell;/.test(lib) && /window_shell::attach\(/.test(builder), 'window_shell is declared and attached to main');
ok(/page_shell\.on_page_finished\(/.test(builder) && /PageLoadEvent::Finished/.test(builder), 'main shows when the page has finished loading');

// ---- guest_guard.rs: one shared install, filter only on main ----
const filter = fnBody(guard, 'install_request_filter');
const mainGuard = fnBody(guard, 'install_main_guard'); // the first definition is the cfg(windows) one
const guestGuard = fnBody(guard, 'install_guard_inner');
ok(filter.length > 0 && /AddWebResourceRequestedFilterWithRequestSourceKinds/.test(filter), 'install_request_filter holds the filter registration');
ok(/let blocks = move \|uri: &str\| \{\s*crate::guest_requests::record\(uri\);\s*guard_blocks\(uri\)\s*\};/.test(guestGuard) && /install_request_filter\(&core, &environment, blocks, None, "guest_guard"\)/.test(guestGuard), 'guests call install_request_filter with the one guest rule (guard_blocks; the wardrobe ipc exception is gone)');
ok(!/allow_ipc_host|is_wardrobe_label|guest_guard_blocks/.test(guard), 'guest_guard.rs keeps no wardrobe ipc.localhost exception');
ok(/install_request_filter\(&core, &platform\.environment\(\), main_guard_blocks, Some\("main"\), "main_guard"\)/.test(mainGuard), 'main calls install_request_filter with main_guard_blocks and the first-request self-check');
ok(!/add_NavigationStarting|add_NavigationCompleted|request_external_open|GuestRegistry/.test(mainGuard + filter), 'main installs ONLY the request filter: no NavigationStarting/Completed hook, no external open (gate G6)');
ok(/guard: \{tag\} first=/.test(filter) && /COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT/.test(filter), 'the first request logs its ResourceContext as "guard: main first=<document|other>" (gate condition 1)');
ok(/\{failure_prefix\}_filter/.test(filter) && /\{failure_prefix\}_request_handler/.test(filter) && !/guest_guard_/.test(filter + mainGuard), 'main failure reasons carry main_guard_*, never guest_guard_*');
ok(!/\buri\b[^;\n]*eprintln|eprintln![^;]*\buri\b/.test(filter), 'the filter never prints a request URI');
ok(/fn request_verdict\(uri: Option<&str>, blocks: &dyn Fn\(&str\) -> bool\)/.test(guard), 'request_verdict takes the rule as a parameter (guest rule or main rule)');
ok(!/MAIN_APP_HOSTS/.test(fnBody(guard, 'guard_blocks')), 'the guest rule (guard_blocks) does not know the app hosts');

// ---- window events: pushed to the main webview ----
ok(/emit_to\(MAIN_LABEL, "window:focus"/.test(shell), 'window:focus is emitted to the main webview');
ok(/emit_to\(MAIN_LABEL, "window:visible"/.test(shell), 'window:visible is emitted to the main webview');
ok(/WindowEvent::Focused\(/.test(shell) && /WindowEvent::Resized\(/.test(shell), 'minimise/restore come from Resized (tao has no Minimized event); Focused re-reads visibility');
ok(/WM_ACTIVATE/.test(shell) && /SetWindowSubclass\(/.test(shell) && /fn activation_from_wparam\(/.test(shell), "window:focus on Windows follows WM_ACTIVATE (activation, as Electron focus/blur), not Tauri's webview-synthesised Focused (probe-p1c4)");
ok(/#\[cfg\(not\(windows\)\)\]\s*self\.emit_focus\(window, \*focused\)/.test(shell), 'the Windows build never emits focus from WindowEvent::Focused');
ok(/fn changed\(/.test(shell), 'both events go through the change filter (no repeated value is emitted)');
ok(/fn sync_visible\(/.test(shell) && (shell.match(/self\.sync_visible\(window\)/g) || []).length >= 2, 'a hide (Focused loss) and a resize both re-read the real visibility, so a hide reports window:visible false');


// ---- no child of the host may start a conhost.exe (CREATE_NO_WINDOW, 0x08000000) ----
// Every non-test `Command::new` in src-tauri/src must either be the sidecar spawn (flags from sidecar_creation_flags,
// set on THAT command before its `.spawn(`) or go through node_runtime's spawn_in_job()/output_in_job() (no console window AND
// placed in the kill-on-close job, so a host exit leaves no provisioning child running). A new spawn that does
// neither fails here. Only `#[cfg(test)]` items are removed from the scan (an item = attributes, then `mod x;` or a
// braced block); the rest of the file after a test item is still scanned.
const CHAR_LIT = /^'(\\[^']*|[^\\'])'/; // a Rust char literal ('{', '\n'); a lifetime has no closing quote
const stripTestItems = (raw) => {
  const noComments = raw.replace(/(^|\s)\/\/.*$/gm, '$1');
  // index just past the item that starts at `i` (skips attributes, then `...;` or a balanced `{...}`)
  const skipBlock = (s, open) => {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { // string literal (raw strings are not used around braces in this crate; escapes handled)
        for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      } else if (c === "'" && CHAR_LIT.test(s.slice(i))) {
        i += s.slice(i).match(CHAR_LIT)[0].length - 1;
      } else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i + 1;
    }
    return s.length;
  };
  let out = '';
  let pos = 0;
  const re = /#\[cfg\(test\)\]/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    if (m.index < pos) continue;
    out += noComments.slice(pos, m.index);
    let i = m.index + m[0].length;
    for (;;) { // further attributes on the same item
      const a = noComments.slice(i).match(/^\s*#\[[^\]]*\]/);
      if (!a) break;
      i += a[0].length;
    }
    const semi = noComments.indexOf(';', i);
    const brace = noComments.indexOf('{', i);
    pos = semi >= 0 && (brace < 0 || semi < brace) ? semi + 1 : skipBlock(noComments, brace);
    re.lastIndex = pos;
  }
  return out + noComments.slice(pos);
};
{
  const spawnSites = [];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.rs'))) {
    const prod = stripTestItems(fs.readFileSync(path.join(SRC, f), 'utf8'));
    for (const m of prod.matchAll(/Command::new\(/g)) spawnSites.push({ f, at: m.index, prod });
  }
  ok(spawnSites.length > 0, 'found the host child-process spawn sites');
  const unsafe = spawnSites.filter(({ f, at, prod }) => {
    if (f === 'lib.rs') {
      const spawnAt = prod.indexOf('.spawn(', at);
      return spawnAt < 0 || !callSiteOk(prod.slice(at, spawnAt));
    }
    if (f === 'node_runtime.rs') return !/(spawn_in_job|output_in_job)\(&mut cmd\)/.test(prod.slice(at, at + 1500));
    return true;
  });
  ok(unsafe.length === 0, 'every host child spawn hides its console (CREATE_NO_WINDOW)', unsafe.map((u) => u.f).join(','));
  {
    const nr = stripTestItems(fs.readFileSync(path.join(SRC, 'node_runtime.rs'), 'utf8'));
    const withoutHelper = nr.replace(fnBody(nr, 'spawn_in_job'), '');
    ok(!/\.spawn\(|\.output\(/.test(withoutHelper), 'node_runtime starts no child except through spawn_in_job (no bare .spawn()/.output())');
    ok(/no_window\(cmd\)\.spawn\(\)\?;\s*crate::assign_to_job\(child\.id\(\)\);/.test(fnBody(nr, 'spawn_in_job')), 'spawn_in_job places the child in the kill-on-close job');
  }
  ok(spawnSites.some((s) => s.f === 'lib.rs'), 'the lib.rs sidecar spawn is inside the scanned (non-test) text');
  const flagsFn = fnBody(lib, 'sidecar_creation_flags');
  ok(/const DETACHED_PROCESS: u32 = 0x0000_0008;/.test(lib) && /if debug \{ 0 \} else \{ DETACHED_PROCESS \}/.test(flagsFn) && !/CREATE_NO_WINDOW/.test(flagsFn),
    'a release sidecar spawn is DETACHED_PROCESS (no console, so no conhost.exe); only a debug build keeps the console');
  const spawnFn = fnBody(lib, 'spawn_sidecar_at');
  ok(/Stdio::piped\(\)/.test(spawnFn) && /assign_to_job\(/.test(spawnFn) && callSiteOk(spawnFn),
    'the detached sidecar keeps its stdio pipes and its kill-on-close job membership');
}
// ---- the predicates themselves: the reviewer's mutations must be caught (W2, W4, W5) ----
{
  const good = 'cmd.creation_flags(sidecar_creation_flags(cfg!(debug_assertions)));';
  ok(callSiteOk(good), 'predicate: the real call-site statement passes');
  ok(!callSiteOk('cmd.creation_flags(sidecar_creation_flags(cfg!(debug_assertions)) | 0x0800_0000);'), 'predicate: CREATE_NO_WINDOW OR-ed in at the call site fails (W2)');
  ok(!callSiteOk(good + ' cmd.creation_flags(0x0800_0000);'), 'predicate: a second creation_flags in the spawn fn fails');
  ok(importsChildProcess(`import { spawn } from 'child_process';`) && importsChildProcess(`const cp = require("child_process");`) && importsChildProcess(`import cp from 'node:child_process';`), 'predicate: bare and node: child_process imports are both found (W4)');
  ok(bareSpawns(`import { exec } from 'child_process';
exec('x');`).length === 1, 'predicate: a bare exec() without windowsHide is caught (W5)');
  ok(bareSpawns(`fork('a.js');`).length === 1 && bareSpawns(`execSync('x');`).length === 1 && bareSpawns(`cp.spawn('x', [], { windowsHide: true });`).length === 0, 'predicate: fork/execSync caught, windowsHide: true accepted');
}
// ---- a detached node has no console to inherit: every node-side child_process spawn must hide its own ----
{
  const listJs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : listJs(path.join(d, e.name))) : /\.(mjs|js)$/.test(e.name) && e.name !== 'main.js' ? [path.join(d, e.name)] : []));
  const dirs = [['tauri', 'sidecar'], ['src', 'main']].map((d) => path.join(ROOT, ...d));
  const users = dirs.flatMap(listJs).filter((f) => importsChildProcess(fs.readFileSync(f, 'utf8')));
  // floor 3 since 0.3.0-alpha.11 (wardrobe-bridge.mjs and wardrobe-gate.mjs, two spawners, were removed)
  ok(users.length >= 3, 'found the node files that import child_process', String(users.length));
  const bare = [];
  for (const f of users) {
    const t = fs.readFileSync(f, 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const at of bareSpawns(t)) bare.push(path.basename(f) + '@' + at);
  }
  ok(bare.length === 0, 'every sidecar-side child_process spawn carries windowsHide: true', bare.join(','));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
