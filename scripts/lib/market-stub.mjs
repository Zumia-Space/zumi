// The window.zumi bridge for the Marketplace page checks (check:market-ui, check:market-e2e): the page boots on it, and window.__market
// (exposed by the check) answers market.* from a real market host.
// `update: null` keeps the updater pill (which reads a stub as "repair needed") off the shots.
export const MARKET_STUB = `(() => {
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
  const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
  const info = { version: 'check', packaged: true, disabledViews: [], ownerAdmin: true, boardPartition: 'b', boardLivePartition: 'bl', demo: false, selftest: false, minWidth: 600, minHeight: 400 };
  const models = { models: [{ id: 'zumi-default', label: 'Zumi default', source: 'bundled', isDefault: true }, { id: 'other', label: 'Second model', source: 'bundled' }, { id: 'user', label: 'Model from this PC', source: 'user' }], selected: 'zumi-default', bundledCount: 2 };
  const sceneList = { selected: 'current', geometry: null, rooms: [{ id: 'cozy-study', label: 'Cozy study' }, { id: 'zen-garden', label: 'Zen garden room' }] };
  window.__picked = [];
  const progress = new Set();
  window.__marketProgress = (p) => { for (const cb of progress) cb(p); };
  window.zumi = withFallback({ info: async () => info, listModels: async () => models, selectModel: async (id) => { window.__picked.push(['model', id]); models.selected = id; return models; }, listClips: async () => [],
    update: null,
    rooms: withFallback({ list: async () => ({ rooms: [], selected: null }) }),
    scenes: withFallback({ list: async () => sceneList, select: async (id) => { window.__picked.push(['room', id]); sceneList.selected = id; return sceneList; } }),
    chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }),
    ui: withFallback({ getLang: async () => window.__uiLang, setLang: async () => {}, getDevTools: async () => false }),
    board: withFallback({ status: async () => ({ configured: false, mode: 'local' }), state: async () => ({ ok: false, reason: 'unconfigured' }) }),
    hud: withFallback({ getPrefs: async () => ({ style: 'a', voiceMuted: false }), setPrefs: async (p) => p, ready: async () => true, onFeed: () => () => {} }),
    market: { list: () => window.__market('list'), install: (id) => window.__market('install', id), remove: (id) => window.__market('remove', id), onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); } } });
  HTMLElement.prototype.loadURL = function () { return Promise.resolve(); };
})();`;
