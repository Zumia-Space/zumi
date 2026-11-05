// Minimal CDP client (Node 22+ global WebSocket). Reviewer scratch tool, spare PC only.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitTarget(port, pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = list.find((x) => x.type === 'page' && pred(x));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(40);
  }
  return null;
}
export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) (handlers.get(msg.method) || []).forEach((h) => { try { h(msg.params); } catch {} });
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      on: (method, h) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(h); },
      eval: async function (expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || 'exception')); return r.result.value; },
      close: () => ws.close(),
    });
  });
}
