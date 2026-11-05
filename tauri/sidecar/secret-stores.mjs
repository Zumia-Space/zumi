// T-31 parity step 5: the six key-store modules, built with the vault adapter in place of Electron's safeStorage.
//
// This is the TAURI path only: src/main/main.js (Electron) is untouched and keeps its real safeStorage. The modules are
// the same Electron-free files Electron loads, called with the same options main.js passes, except `safeStorage` and the
// directory, which are fixed here: the PREVIEW data dir, never Electron's userData. Nothing is constructed until a caller
// asks, and step 5 adds no rpc: increments 6 (BYOK/chat), 8 (talk/TTS keys) and 10 (board secrets) call these factories.
import { createRequire } from 'node:module';

import { createLiveBoard } from '../../src/main/board-live.mjs';

const require = createRequire(import.meta.url);
const { createBrainKey } = require('../../src/main/brain-key.js');
const { createChatBrain } = require('../../src/main/chat-brain.js');
const { createReflexJev } = require('../../src/main/reflex-jev.js');
const { createCloud } = require('../../src/main/cloud.js');
const { createLedaTts } = require('../../src/main/leda-tts.js');
const { createGeminiTts } = require('../../src/main/tts-gemini.js');
const { createElevenTts } = require('../../src/main/tts-elevenlabs.js');
const { createHttpTts } = require('../../src/main/tts-http.js');

/**
 * @param {{ safeStorage: object, dataDir: string, log?: (m: string) => void }} o
 * Each factory takes the module's remaining options (provider, fetchImpl, base, publicDir, ...). `safeStorage` and the
 * data directory are applied last, so a caller cannot redirect a key store to another folder or another backend.
 */
export function createSecretStores({ safeStorage, dataDir, log = () => {} }) {
  if (!safeStorage || typeof dataDir !== 'string' || !dataDir) throw new Error('secret_stores_need_safeStorage_and_dataDir');
  return {
    brainKey: (opts = {}) => createBrainKey({ log, ...opts, safeStorage, dir: dataDir }),
    chatBrain: (opts = {}) => createChatBrain({ log, ...opts, safeStorage, dir: dataDir }),
    reflexJev: (opts = {}) => createReflexJev({ log, ...opts, safeStorage, dir: dataDir }),
    cloud: (opts = {}) => createCloud({ log, ...opts, safeStorage, tokenDir: dataDir }),
    liveBoard: (opts = {}) => createLiveBoard({ log, ...opts, safeStorage, secretsDir: dataDir }),
    ledaTts: (opts = {}) => createLedaTts({ log, ...opts, safeStorage, dir: dataDir }),
    // Step 8b: the BYO voice providers. One DPAPI file each (tts-gemini/tts-elevenlabs/tts-http), same option shape
    // main.js passes them; safeStorage and the data dir are applied last so a caller cannot redirect a key store.
    geminiTts: (opts = {}) => createGeminiTts({ log, ...opts, safeStorage, dir: dataDir }),
    elevenTts: (opts = {}) => createElevenTts({ log, ...opts, safeStorage, dir: dataDir }),
    httpTts: (opts = {}) => createHttpTts({ log, ...opts, safeStorage, dir: dataDir }),
  };
}
