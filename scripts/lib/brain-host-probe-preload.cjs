'use strict';
// Preload of the PROBE window in scripts/electron-brain-host.cjs only: it hands the page a raw ipcRenderer.invoke, which the app's own
// preload never does. The probe page is not the app's main window, so it also shows that the Brain handlers refuse every other sender.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  invoke: async (channel, ...args) => {
    try { return { ok: true, value: await ipcRenderer.invoke(channel, ...args) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },
});
