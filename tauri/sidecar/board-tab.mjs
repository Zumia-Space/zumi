// Zumi 0.3.5-alpha.9.10 (OSS-02 step 2, owner 17-11): the Board tab is off on a new install and is switched on and off from
// the Marketplace card "Laneboard". settings.json `boardTab` (true | false) is the switch. Unset, the tab is on only where a
// board already has data (a local board, a v0.2 board waiting for import, or a signed-in live board), so an update never
// hides a board someone uses; turning the card on once sets `boardTab: true`, which then holds on every start.
// The switch hides or shows the tab only: nothing here reads, moves or deletes <data>/board-data/laneboard.
import fs from 'node:fs';
import path from 'node:path';

import { boardDataRoot } from './adapters.mjs';

export const BOARD_TAB_ID = 'tool.laneboard';

/** True when this profile already has local board data: a non-empty laneboard folder, or a v0.2 board (tasks.json). */
export function hasBoardData(dataDir) {
  const root = boardDataRoot(dataDir);
  const dir = path.join(root, 'laneboard');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) return true;
  return fs.existsSync(path.join(root, 'tasks.json')); // laneboard-host.mjs LEGACY_MARKER: imported on the next open
}

/** Is the Board tab on? The saved switch when there is one; else on only for a profile that already has a board. */
export function boardTabOn({ dataDir, settings, liveConfigured = () => false }) {
  const saved = settings().boardTab;
  if (typeof saved === 'boolean') return saved;
  return hasBoardData(dataDir) || liveConfigured() === true;
}

/**
 * The Marketplace handlers with the Laneboard card added: market.list lists it (state 'on' | 'off'), market.install turns the
 * tab on, market.remove turns it off. Every other id goes to the wrapped market host unchanged.
 * @param {{ 'market.list': Function, 'market.install': Function, 'market.remove': Function }} handlers
 * @param {{ dataDir: string, settings: () => object, saveSettings: (patch: object) => object, liveConfigured?: () => boolean }} o
 */
export function withBoardTab(handlers, { dataDir, settings, saveSettings, liveConfigured = () => false }) {
  const item = () => ({
    id: BOARD_TAB_ID, kind: 'tool', name: 'Laneboard', author: 'Zumia', licence: 'Apache-2.0', needs: ['local-board'],
    state: boardTabOn({ dataDir, settings, liveConfigured }) ? 'on' : 'off',
    source: null, sha256: null, downloadBytes: 0, installedVersion: null, modelReady: null, progress: null,
  });
  const set = (on) => { saveSettings({ boardTab: on }); return { ok: true }; };
  return {
    'market.list': () => {
      const m = handlers['market.list']();
      return { ...m, items: [...(Array.isArray(m.items) ? m.items : []), item()] };
    },
    'market.install': (id) => (id === BOARD_TAB_ID ? set(true) : handlers['market.install'](id)),
    'market.remove': (id) => (id === BOARD_TAB_ID ? set(false) : handlers['market.remove'](id)),
  };
}
