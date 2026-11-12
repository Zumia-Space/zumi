// A minimal Chrome DevTools Protocol client for test runs of the built app (pack canary / room preview probes).
// WebView2 is started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=0 by the run script only; each
// browser process (main, and one per guest profile) then writes <its user data folder>/DevToolsActivePort. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every DevToolsActivePort under `root`, as { port, dir }. */
export function findPorts(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'DevToolsActivePort') {
        const port = Number(fs.readFileSync(p, 'utf8').split(/\r?\n/)[0]);
        if (port) out.push({ port, dir: d });
      } else if (e.isDirectory() && !/^(Cache|Code Cache|GPUCache|Service Worker|IndexedDB|Local Storage|blob_storage)$/.test(e.name)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/** Wait until some port under `root` has a page target whose url matches `re`. */
export async function waitTarget(root, re, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const { port } of findPorts(root)) {
      try {
        const t = (await targets(port)).find((x) => x.type === 'page' && re.test(x.url));
        if (t) return { port, target: t };
      } catch { /* a stale port file */ }
    }
    await sleep(500);
  }
  throw new Error(`no page target matching ${re} within ${timeoutMs} ms`);
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws connect failed')); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression, { awaitPromise = true, timeoutMs = 120000 } = {}) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
      sleep(timeoutMs).then(() => { throw new Error(`evaluate timed out: ${expression.slice(0, 60)}`); }),
    ]);
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`);
    return r.result.value;
  };
  return { send, evaluate, on: (fn) => listeners.add(fn), close: () => ws.close() };
}
