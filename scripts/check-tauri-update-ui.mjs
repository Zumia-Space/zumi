// src/renderer/update-ui.js against a fake window.zumi and fake elements (PLAN-UPDATER section 8). Plain Node, opens nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const { pickNotes, initUpdateUi } = await import('../src/renderer/update-ui.js');
const { setLocale, t } = await import('../src/renderer/i18n.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function element() {
  const handlers = {};
  return {
    textContent: '', hidden: false, disabled: false, open: false,
    classList: { toggle() {} },
    addEventListener(name, fn) { handlers[name] = fn; },
    click() { return handlers.click && handlers.click(); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector() { return this.notesHead; },
  };
}
function page(zumi) {
  const els = {};
  const $ = (id) => (els[id] ||= element());
  $('update-dialog').notesHead = element();
  $('update-check-row').hidden = true;
  initUpdateUi({ zumi, $ });
  return els;
}
function fakeZumi(status, checkAnswer) {
  const calls = { check: 0, install: 0, later: [] };
  let listener = null;
  return {
    calls,
    emit: (s) => listener(s),
    update: {
      status: async () => status,
      onState: (cb) => { listener = cb; },
      install: async () => { calls.install++; return false; },
      later: async (v) => { calls.later.push(v); return true; },
      check: async () => { calls.check++; if (checkAnswer instanceof Error) throw checkAnswer; return checkAnswer; },
    },
  };
}

// ---------- notes ----------
const BOTH = '## vi\n• Mới\n\n## en\n• New\n';
ok(pickNotes(BOTH, 'vi') === '• Mới', 'a Vietnamese UI gets the vi section', pickNotes(BOTH, 'vi'));
ok(pickNotes(BOTH, 'en') === '• New', 'an English UI gets the en section');
ok(pickNotes(BOTH, 'zh') === '• New', 'any other UI gets the en section');
ok(pickNotes('## en\n• Only\n', 'vi') === '• Only', 'a missing vi section falls back to en');
ok(pickNotes('Plain text\n', 'vi') === 'Plain text', 'plain notes pass through');
ok(pickNotes(null, 'en') === '', 'no notes is empty text');

// ---------- the About row ----------
setLocale('en');
const off = page(fakeZumi({ phase: 'off' }, { result: 'off' }));
await tick();
ok(off['update-check-row'].hidden === true, 'the row stays hidden when the build has no updater');

for (const [result, key] of [['none', 'update.upToDate'], ['error', 'update.checkFailed'], ['available', 'update.checkFound']]) {
  const zumi = fakeZumi({ phase: 'idle' }, { result });
  const els = page(zumi);
  await tick();
  ok(els['update-check-row'].hidden === false, `the row shows with an updater (${result})`);
  const clicked = els['update-check'].click();
  ok(els['update-check-note'].textContent === t('update.checking') && els['update-check'].disabled, `Checking… while it runs (${result})`);
  await clicked;
  ok(zumi.calls.check === 1 && els['update-check-note'].textContent === t(key) && !els['update-check'].disabled, `${result} shows its own text`, els['update-check-note'].textContent);
}
const thrown = page(fakeZumi({ phase: 'idle' }, new Error('sidecar_gone')));
await tick();
await thrown['update-check'].click();
ok(thrown['update-check-note'].textContent === t('update.checkFailed'), 'a rejected call shows Could not check');
const busy = page(fakeZumi({ phase: 'downloading', percent: 3 }, { result: 'busy' }));
await tick();
await busy['update-check'].click();
ok(busy['update-check-note'].textContent === '', 'busy leaves no result text: the pill shows the download');

// ---------- the offer ----------
setLocale('vi');
const zumi = fakeZumi({ phase: 'idle' }, { result: 'none' });
const els = page(zumi);
await tick();
zumi.emit({ phase: 'downloading', percent: 40 });
ok(els['update-pill'].hidden === false && els['update-pill'].textContent.includes('40'), 'the pill shows percent');
zumi.emit({ phase: 'ready', version: '2.0.0', percent: 100, ready: { version: '2.0.0', notes: BOTH } });
ok(els['update-dialog'].open === true && els['update-pill'].hidden === true, 'ready opens the one dialog and hides the pill');
ok(els['update-notes'].textContent === '• Mới', 'the dialog shows the section for the UI language', els['update-notes'].textContent);
await els['update-later'].click();
ok(els['update-dialog'].open === false && JSON.stringify(zumi.calls.later) === '["2.0.0"]', 'Later closes it and answers with the version');
zumi.emit({ phase: 'error' });
ok(els['update-pill'].classList && els['update-pill'].textContent === t('update.failed'), 'a failed download shows the failure pill');

// ---------- an install that did not finish ----------
{
  const broken = fakeZumi({ phase: 'idle', repair: true }, { result: 'none' });
  const page3 = page(broken);
  await tick();
  ok(page3['update-pill'].hidden === false && page3['update-pill'].textContent === t('update.repair'), 'a mixed install shows the notice', page3['update-pill'].textContent);
  broken.emit({ phase: 'idle', repair: true });
  ok(page3['update-pill'].hidden === false, 'a later state does not hide the notice');
}
setLocale('vi');
ok(t('update.repair') === 'Cài chưa xong, chạy lại bộ cài', 'the Vietnamese wording', t('update.repair'));

// ---------- a second click on Restart now ----------
{
  let finish;
  const installs = { n: 0 };
  const twice = fakeZumi({ phase: 'idle' }, { result: 'none' });
  twice.update.install = () => { installs.n++; return new Promise((resolve) => { finish = resolve; }); };
  const page2 = page(twice);
  await tick();
  twice.emit({ phase: 'ready', version: '2.0.0', percent: 100, ready: { version: '2.0.0', notes: '' } });
  page2['update-pill'].hidden = true;
  page2['update-restart'].click();
  const second = page2['update-restart'].click();
  await second;
  await tick();
  ok(installs.n === 1, 'a second click does not ask again', String(installs.n));
  ok(page2['update-pill'].hidden === true && page2['update-pill'].textContent !== t('update.failed'), 'a second click shows no failed pill while the first runs');
  finish(false);
  await tick();
  ok(page2['update-pill'].hidden === false && page2['update-pill'].textContent === t('update.failed'), 'a real failure still shows the pill');
  page2['update-pill'].hidden = true;
  page2['update-restart'].click();
  ok(installs.n === 2, 'after a real failure the button works again', String(installs.n));
}

// ---------- the text is text ----------
const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'update-ui.js'), 'utf8');
ok(!/innerHTML|insertAdjacentHTML/.test(source), 'notes reach the page through textContent only');
const i18n = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
for (const key of ['update.check', 'update.checkBtn', 'update.checking', 'update.upToDate', 'update.checkFailed', 'update.checkFound', 'update.repair']) {
  ok(i18n.split(`'${key}':`).length === 4, `${key} is in all three language tables`);
}

console.log(`check-tauri-update-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
