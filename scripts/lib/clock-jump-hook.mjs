// TEST ONLY (scripts/check-tauri-board-bridge-heal2.mjs): loaded into the REAL sidecar with `node --import`, never shipped.
// When the harness writes a number of milliseconds to ZUMI_TEST_CLOCK_JUMP_FILE, Date.now() jumps forward by that much
// for the rest of the run (a wall-clock jump such as a resume from sleep or an NTP step). The file is then deleted and
// <file>.done is written.
import fs from 'node:fs';

const FILE = process.env.ZUMI_TEST_CLOCK_JUMP_FILE;
if (FILE) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const timer = setInterval(() => {
    let ms;
    try { ms = Number(fs.readFileSync(FILE, 'utf8').trim()); } catch { return; }
    fs.rmSync(FILE, { force: true });
    if (Number.isFinite(ms)) offset += ms;
    fs.writeFileSync(`${FILE}.done`, String(offset));
  }, 100);
  timer.unref();
}
