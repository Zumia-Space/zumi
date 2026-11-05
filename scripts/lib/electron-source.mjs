// Test helper (T-31 Tauri parity step 3): run the ORIGINAL Electron handler code from src/main/main.js in a vm with
// injected dependencies, so a sidecar reply can be compared with what Electron's own code returns. Nothing from
// Electron is loaded; the text is cut out of the file by balanced braces / parens.
import vm from 'node:vm';

const BS = String.fromCharCode(92); // a backslash, built so no escaping layer can eat it

// Index just past the bracket that closes the one opening at `open`. Skips // and /* */ comments and quoted strings.
function matchClose(src, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === BS) i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  throw new Error('unbalanced source');
}

/** Source text of `function name(...) {...}` or `async function name(...) {...}`. */
export function functionSource(src, name) {
  const m = new RegExp(`^(async )?function ${name}[(]`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  return src.slice(m.index, matchClose(src, open));
}

/** Source text of the `ipcMain.handle('<channel>', ...)` statement. */
export function handlerSource(src, channel) {
  const at = src.indexOf(`ipcMain.handle('${channel}'`);
  if (at < 0) throw new Error(`handler ${channel} not found`);
  const open = src.indexOf('(', at);
  return src.slice(at, matchClose(src, open));
}

/** Source text of a top-level `const name = ...;` statement (ends at the first top-level `;`). */
export function constSource(src, name) {
  const m = new RegExp(`^const ${name} = `, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  const stack = [];
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'" || c === '`') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === BS) i++; continue; }
    if ('{(['.includes(c)) stack.push(c);
    else if ('})]'.includes(c)) stack.pop();
    else if (c === ';' && !stack.length) return src.slice(m.index, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}

/**
 * Evaluate source snippets in one sandbox. `scope` is the injected globals (fs, path, loadSettings, ...).
 * Returns { ipc, ctx }: ipc maps channel -> handler registered through the fake ipcMain; ctx exposes the
 * evaluated top-level functions.
 */
export function evaluate(snippets, scope) {
  const ipc = {};
  const ctx = vm.createContext({ ...scope, ipcMain: { handle: (ch, fn) => { ipc[ch] = fn; } }, console });
  vm.runInContext(snippets.join('\n'), ctx);
  return { ipc, ctx };
}
