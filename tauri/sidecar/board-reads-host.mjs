// T-31 3a-3: Brain's three read-only board calls (board.state / board.media / board.openRef) in the sidecar. src/main/board-reads.mjs runs UNCHANGED
// (the module Electron's main.js builds); this file supplies what Electron supplies around it, and nothing more:
//   - the SAME board reader chat and the HUD already own (one connection, one 60 s cache);
//   - the pinned media transport (egress.mjs bridgeMediaFetch): the live bridge's media route on its current loopback port, nothing else (C10);
//   - decide = board-open.mjs decideOpenRef with this build's ownerAdmin flag (the frozen module, not a copy);
//   - the opener: the owner flavour's host primitive (Rust re-validates before ShellExecuteW); every other flavour has none, so a ref that passed
//     H1 and decide ends as { opened:false, reason:'open_unavailable' } and nothing is opened;
//   - the next-UI gate (C4): without `next-ui.json` beside the host exe this returns null and main.mjs adds no table row, so the three names answer
//     the same "method not found" as any unknown name.
import { createBoardReads } from '../../src/main/board-reads.mjs';
import { decideOpenRef } from '../../src/main/board-open.mjs';
import { bridgeMediaFetch } from './egress.mjs';
import { readNextUiFlag } from './next-ui-flag.mjs';

/**
 * @param {object} o
 * @param {string} o.hostDir
 * @param {boolean} o.ownerAdmin
 * @param {{getState(): Promise<object>}} o.boardReader   chatHost.boardReader
 * @param {{status(): object, bridgePort(): Promise<number|null>, bridgeHeaders(): Promise<object>}} o.liveBoard
 * @param {typeof fetch} o.baseFetch                       the one fetch main.mjs hands to every guard
 * @param {(decision: object) => Promise<void>} o.openHost createHostOpen(ctx.hostCalls.call)
 * @param {(r: {reason: string, origin?: string}) => void} o.logRefusal
 * @param {(line: string) => void} [o.log]
 * @returns {object|null} createBoardReads' { state, media, openRef }, or null when this is not a next-UI bundle
 */
export function createBrainReads({ hostDir, ownerAdmin, boardReader, liveBoard, baseFetch, openHost, logRefusal, log = () => {}, fsImpl }) {
  if (!readNextUiFlag(hostDir, fsImpl)) return null;
  return createBoardReads({
    boardReader,
    liveBoard,
    fetchImpl: bridgeMediaFetch(baseFetch, () => liveBoard.bridgePort(), () => liveBoard.bridgeHeaders()),
    decide: (ref) => decideOpenRef(ref, { ownerAdmin }),
    open: ownerAdmin ? openHost : async () => { throw new Error('open_unavailable'); },
    logRefusal,
    log,
  });
}
