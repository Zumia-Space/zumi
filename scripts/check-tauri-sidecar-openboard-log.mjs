// T-31 BH-11e follow-up: the openBoard failure line in the app log (stderr) carries the error CODE only.
// Added as its own file because check-brain-host BH-11e forbids editing an existing check script.
//
//   node scripts/check-tauri-sidecar-openboard-log.mjs   (exit 1 on any failure)
//
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };

// openBoard's catch writes one stderr line. The message it returns can carry the user's home path (a missing import) or
// a snippet of the board file (a corrupt projection), and stderr lands in the app log users attach to bug reports.
// Each case spawns the real sidecar, asks openBoard once, and reads the real stderr. Scratch stays under the gitignored
// .tauri-check-tmp (off C:). The "missing module" tree reuses this tree's src/ and node_modules through junctions and
// carries its own copy of tauri/sidecar (repoRoot derives from that file) and of vendor/laneboard minus src/board.mjs.
async function openBoardOnce(treeRoot, dataDirArg) {
  const child = spawn(process.execPath, [path.join(treeRoot, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDirArg, '--no-voice-prefetch'], { cwd: treeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const rl = readline.createInterface({ input: child.stdout });
  let answer = null;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 60000);
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'ready') child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'openBoard', params: [] })}\n`);
      else if (m.id === 1) { answer = m.result ?? m.error ?? m; clearTimeout(timer); resolve(); }
    });
  });
  child.stdin.end();
  await new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill(); r(); }, 5000); });
  return { answer, stderrLine: stderr.split(/\r?\n/).find((l) => l.includes('openBoard failed')) || null };
}
const leaks = (line, needles) => needles.filter((n) => line.toLowerCase().includes(n.toLowerCase()));
const ERR_TMP = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(ERR_TMP, { recursive: true });

// 4a. a corrupt board projection: the error text quotes the first characters of the file and its path.
{
  const dir = fs.mkdtempSync(path.join(ERR_TMP, 'openboard-corrupt-'));
  const snippet = 'SNIPQX7K';
  fs.mkdirSync(path.join(dir, 'board-data', 'laneboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board-data', 'laneboard', 'state.json'), `${snippet} is not json`);
  const r = await openBoardOnce(ROOT, dir);
  const returned = r.answer && r.answer.error ? String(r.answer.error) : '';
  ok(returned.includes(snippet) && returned.includes(path.basename(dir)), 'openBoard corrupt-board: the caller still gets the full message (precondition: it carries the snippet and the path)', returned.slice(0, 200));
  ok(r.stderrLine !== null, 'openBoard corrupt-board: one "openBoard failed" line reaches stderr');
  ok(r.stderrLine !== null && leaks(r.stderrLine, [snippet, path.basename(dir)]).length === 0, 'openBoard corrupt-board: the stderr line carries neither the board data snippet nor the path', r.stderrLine);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4b. a missing module: ERR_MODULE_NOT_FOUND names the absolute path of the module.
{
  const tree = fs.mkdtempSync(path.join(ERR_TMP, 'openboard-missing-'));
  const data = path.join(tree, 'data');
  fs.mkdirSync(data);
  fs.cpSync(path.join(ROOT, 'tauri', 'sidecar'), path.join(tree, 'tauri', 'sidecar'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vendor', 'laneboard'), path.join(tree, 'vendor', 'laneboard'), { recursive: true });
  fs.rmSync(path.join(tree, 'vendor', 'laneboard', 'src', 'board.mjs'));
  fs.symlinkSync(path.join(ROOT, 'src'), path.join(tree, 'src'), 'junction');
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(tree, 'node_modules'), 'junction');
  const r = await openBoardOnce(tree, data);
  const returned = r.answer && r.answer.error ? String(r.answer.error) : '';
  ok(/board\.mjs/.test(returned) && returned.includes(path.basename(tree)), 'openBoard missing-module: the caller still gets the full message (precondition: it names the module path)', returned.slice(0, 200));
  ok(r.stderrLine !== null && /ERR_MODULE_NOT_FOUND/.test(r.stderrLine), 'openBoard missing-module: the stderr line still names the error code', r.stderrLine);
  ok(r.stderrLine !== null && leaks(r.stderrLine, [path.basename(tree), 'board.mjs', 'laneboard']).length === 0, 'openBoard missing-module: the stderr line carries no module path', r.stderrLine);
  fs.unlinkSync(path.join(tree, 'src')); // junctions first: a recursive remove must never reach the real src/ or node_modules
  fs.unlinkSync(path.join(tree, 'node_modules'));
  fs.rmSync(tree, { recursive: true, force: true });
}
ok(fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json')) || fs.readdirSync(path.join(ROOT, 'node_modules')).length > 0, 'the scratch cleanup left the real node_modules in place');

console.log(`\n${fail ?'FAIL' : 'PASS'} check-tauri-sidecar-openboard-log — ${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
