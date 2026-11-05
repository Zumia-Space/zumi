// T-31 batch-1 box probe: a dead sidecar must be a RECOVERABLE error the owner can see (PARITY-PLAN "### 13":
// "sidecar kill -> recoverable error in the UI and restart path"). The shim already turns the host's
// sidecar:error into a `zumi:sidecar-error` window event (tauri/shim/zumi-shim.js) and, since this fix, the
// host's sidecar:ready into `zumi:sidecar-ready`; this module is the one place that paints them.
//
// Tauri only: Electron has no sidecar and does not define `window.__TAURI__`, so this builds no DOM there and
// the Electron renderer stays byte-identical (same gate as brain-key-card.js's preset block).
//
// The banner is a status line, not a dialog: the restart is automatic (lib.rs restarts with backoff), calls
// made meanwhile are held by the shim, and the next sidecar:ready clears the message.
import { nodeSetupProblem } from './node-setup.js';

export function initSidecarStatus({ win = globalThis.window, doc = globalThis.document, t = (key) => key } = {}) {
  if (!win || !win.__TAURI__ || !doc) return null;
  const host = (typeof doc.getElementById === 'function' && doc.getElementById('stage')) || doc.body;
  if (!host || typeof doc.createElement !== 'function' || typeof host.appendChild !== 'function') return null;

  const el = doc.createElement('div');
  el.id = 'sidecar-status';
  el.className = 'sidecar-status';
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.hidden = true;
  host.appendChild(el);

  const show = (payload) => {
    if (nodeSetupProblem(payload)) return; // node-setup.js has the whole window for that one
    const fatal = Boolean(payload && payload.fatal === true);
    el.textContent = t(fatal ? 'sidecar.failed' : 'sidecar.restarting');
    el.dataset.state = fatal ? 'fatal' : 'restarting';
    el.hidden = false;
  };
  const clear = () => {
    el.hidden = true;
    el.textContent = '';
    delete el.dataset.state;
  };

  win.addEventListener('zumi:sidecar-error', (e) => show(e && e.detail));
  win.addEventListener('zumi:sidecar-ready', clear);
  return { el, show, clear };
}
