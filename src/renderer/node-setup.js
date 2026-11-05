// First start with no Node.js: the host asks, downloads and unpacks before any sidecar exists (src-tauri/src/node_runtime.rs), so this page has
// no settings yet and picks its language from the system. A No, or a failed download, is a screen with Try again, never a stack trace.
import { TABLES } from './i18n.js';

const MB = 1024 * 1024;

/** 'declined' | 'failed' from a sidecar:error payload, or null when Node is not the problem. */
export function nodeSetupProblem(payload) {
  const message = payload && typeof payload.message === 'string' ? payload.message : '';
  if (!message.startsWith('node_runtime_')) return null;
  return message.startsWith('node_runtime_declined') ? 'declined' : 'failed';
}

let open = false;
export function nodeSetupOpen() { return open; }

/** Tauri only: Electron has no sidecar, so no event ever comes. */
export function initNodeSetup({ win = globalThis.window, doc = globalThis.document } = {}) {
  if (!win || !win.__TAURI__ || !doc) return;
  const lang = String((win.navigator && win.navigator.language) || 'en').slice(0, 2);
  const text = (key, vars = {}) => (TABLES[lang] || TABLES.en)[key].replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  let box = null, line = null, button = null;
  const screen = () => {
    if (box) return;
    box = doc.createElement('div'); box.id = 'node-setup'; box.className = 'empty-model'; box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--background)';
    const card = doc.createElement('div'); card.className = 'card';
    const h = doc.createElement('h2'); h.textContent = text('nodeSetup.title');
    line = doc.createElement('p'); line.className = 'muted'; line.setAttribute('aria-live', 'polite');
    button = doc.createElement('button'); button.className = 'primary'; button.type = 'button'; button.textContent = text('nodeSetup.retry'); button.hidden = true;
    button.addEventListener('click', () => { button.disabled = true; win.__TAURI__.core.invoke('rpc', { method: 'host.retryNodeSetup', args: [] }).catch(() => { button.disabled = false; }); });
    card.append(h, line, button); box.appendChild(card); doc.body.appendChild(box);
  };
  win.addEventListener('zumi:sidecar-provisioning', (e) => {
    const downloaded = e && e.detail && e.detail.downloaded;
    if (typeof downloaded !== 'number' || (button && !button.hidden)) return;
    screen();
    line.textContent = text('nodeSetup.progress', { done: Math.round(downloaded / MB) });
  });
  win.addEventListener('zumi:sidecar-error', (e) => {
    const problem = nodeSetupProblem(e && e.detail);
    if (!problem) return;
    open = true;
    screen();
    line.textContent = text(problem === 'declined' ? 'nodeSetup.declined' : 'nodeSetup.failed');
    button.hidden = false;
  });
  win.addEventListener('zumi:sidecar-ready', () => { if (box) box.remove(); box = null; open = false; });
}
