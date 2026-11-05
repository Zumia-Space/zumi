// Owner-build board gate (T-31 laneboard-live, coordinator scope-add 07-10).
// The owner's own build (app:info.ownerAdmin, from
// package.json zumiOwnerAdmin) must NEVER mount the bundled/sample local board — every call site that can reach
// openBoard() (the local-board opener) must be gated behind an ownerAdmin check that returns first.
//
// Static source check, not a running-app proof: app.js's renderer (three.js scene, VRM loading, <webview> tags)
// needs real Electron to drive end to end, and this PC's rules forbid launching Electron/Zumi here. This instead
// parses app.js's own function/handler bodies and asserts the gate is textually present and ORDERED correctly
// (the ownerAdmin branch returns before the line that can call openBoard()) at each of the two call sites that
// exist today. A new call site that bypasses the gate — or a reorder that moves openBoard() before the check —
// fails this gate. Pairs with check-ui-lang.mjs (key parity) and check-board-live.mjs (the secrets/bridge logic
// this card drives) for the rest of the behavioural proof.
//   node scripts/check-owner-board.mjs   (or: npm run check:owner-board)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

// Returns the balanced-brace block starting at the first '{' at/after `fromIndex`, or null.
function blockAt(src, fromIndex) {
  const braceStart = src.indexOf('{', fromIndex);
  if (braceStart === -1) return null;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  return start === -1 ? null : blockAt(src, start);
}

// ---------- 1. main.js exposes ownerAdmin on app:info (the renderer's ONLY source of the flag) ----------
ok(/ownerAdmin:\s*OWNER_ADMIN/.test(mainJs), "main.js app:info exposes ownerAdmin");
// 1b. lane routing through the bridge (T-31 role-ui-port): main hands the live board ownerOps = OWNER_ADMIN, and the
// release electron-builder config (package.json "build") never sets zumiOwnerAdmin, so a release build keeps the 403.
ok(/const liveBoardArgs = \{[^}]*\bownerOps:\s*OWNER_ADMIN\b[^}]*\}/.test(mainJs), 'main.js passes ownerOps: OWNER_ADMIN to createLiveBoard');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(!pkg.zumiOwnerAdmin && !(pkg.build && pkg.build.extraMetadata && pkg.build.extraMetadata.zumiOwnerAdmin), 'release build config carries no zumiOwnerAdmin (ownerOps stays false there)');
}

// ---------- 2. call site A: renderBoardTab dispatches to the owner branch before its own openBoard() ----------
const ownerBranch = functionBody(appJs, 'renderOwnerBoardTab');
ok(Boolean(ownerBranch), 'app.js defines renderOwnerBoardTab (the ownerAdmin dispatch branch)');
ok(Boolean(ownerBranch) && !/openBoard\(\)/.test(ownerBranch), 'renderOwnerBoardTab itself never calls openBoard()', ownerBranch);
ok(Boolean(ownerBranch) && /openLiveBoard\(\)/.test(ownerBranch), 'renderOwnerBoardTab calls openLiveBoard() once live+unlocked');

const dispatchBody = functionBody(appJs, 'renderBoardTab');
ok(Boolean(dispatchBody), 'app.js defines renderBoardTab');
{
  const dispatchAt = dispatchBody ? dispatchBody.indexOf('info.ownerAdmin') : -1;
  const returnAt = dispatchBody ? dispatchBody.indexOf('return renderOwnerBoardTab') : -1;
  const openBoardAt = dispatchBody ? dispatchBody.lastIndexOf('openBoard()') : -1;
  ok(dispatchAt > -1 && returnAt > dispatchAt && openBoardAt > -1 && returnAt < openBoardAt,
    'renderBoardTab: the ownerAdmin check RETURNS before its only openBoard() call', { dispatchAt, returnAt, openBoardAt });
}

// ---------- 3. call site B: the Reload button's no-webview path has the same gate, same order ----------
const reloadAt = appJs.indexOf("$('board-reload').addEventListener('click'");
ok(reloadAt > -1, "app.js wires the Reload button's click handler");
const reloadBody = reloadAt > -1 ? blockAt(appJs, reloadAt) : null;
{
  const dispatchAt = reloadBody ? reloadBody.indexOf('info.ownerAdmin') : -1;
  const returnAt = reloadBody ? reloadBody.indexOf('return renderOwnerBoardTab') : -1;
  const openBoardAt = reloadBody ? reloadBody.lastIndexOf('openBoard()') : -1;
  ok(dispatchAt > -1 && returnAt > dispatchAt && openBoardAt > -1 && returnAt < openBoardAt,
    "Reload's no-webview path: the ownerAdmin check RETURNS before its openBoard() call", { dispatchAt, returnAt, openBoardAt });
}

// ---------- 4. no OTHER call site exists (a new one would silently bypass both gates above) ----------
const allCallSites = [...appJs.matchAll(/(?<!zumi\.)(?<!const )openBoard\(\)/g)];
// Exactly 2 real calls (inside renderBoardTab's else-branch and the Reload handler); a `//` anywhere earlier on the
// same line (leading comment OR trailing "// ... openBoard() ..." aside) means this match is prose, not code.
const codeCallSites = allCallSites.filter((m) => {
  const lineStart = appJs.lastIndexOf('\n', m.index) + 1;
  return !appJs.slice(lineStart, m.index).includes('//');
});
ok(codeCallSites.length === 2, `exactly 2 real openBoard() call sites in app.js (both gated above), found ${codeCallSites.length}`);

// ---------- 5. the sign-in card markup exists and starts hidden (never flashes before status arrives) ----------
const signinMatch = /<div id="board-signin"[^>]*>/.exec(indexHtml);
ok(Boolean(signinMatch), 'index.html defines #board-signin');
ok(Boolean(signinMatch) && /\bhidden\b/.test(signinMatch[0]), '#board-signin starts hidden in markup', signinMatch && signinMatch[0]);

console.log(`\ncheck:owner-board ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
