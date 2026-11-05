'use strict';
// Intentional no-op stub (T-31 voice P1, Kokoro packaged-app fix, bug 3 of 3).
//
// @huggingface/transformers's Node build (dist/transformers.node.mjs) has an unconditional, top-level
// `import * as __WEBPACK_EXTERNAL_MODULE_sharp__ from "sharp";` for its OPTIONAL image-reading utilities
// (src/utils/image.js). Loading that file at all -- which kokoro-js's own dist bundle does on every
// `import('kokoro-js')`, regardless of this app's own code -- requires `sharp` to be resolvable, even though
// this app only ever uses Kokoro for CPU TTS and never reads, writes, or processes a single image.
//
// The real `sharp` package pulls in a large native binary per platform/arch; package.json's extraResources
// filter for @huggingface/transformers deliberately excludes it from the packaged voice-modules tree to keep
// that footprint small (see kokoro-tts.js's voiceModulesDir() comment). Without SOME module at this path, the
// static import throws `ERR_MODULE_NOT_FOUND`, which — because ensureFiles()'s own unrelated download bug used
// to crash first (see kokoro-worker.mjs's download()/ensureFiles() history) — was never reached or noticed
// until a real packaged install on a clean machine with no stray global `sharp` to fall back on.
//
// This stub exists ONLY so that import resolves. transformers.js's own feature detection reads
// `sharp.default` to decide whether sharp-backed image loading is available (see image.js: `else if (sharp)`
// after webpack's CJS interop makes that `sharp__WEBPACK_IMPORTED_MODULE_4__["default"]`); exporting `{}` here
// makes that check false, exactly like "no image library installed" -- the same state a device:'cpu',
// images-never-touched Kokoro/TTS session is already in by design. If this app ever actually needs image
// processing through @huggingface/transformers, replace this stub with the real `sharp` dependency instead of
// editing this file.
module.exports = {};
