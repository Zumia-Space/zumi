'use strict';
// Lazy loader for the local embedding fallback classifier (REPORT.md tier 2: multilingual MiniLM ONNX +
// nearest-centroid, ~420 MB RSS, ~3.4-4.5s one-time load, ~10-16ms/call). NEVER required at startup — only
// main.js's reflex-jev.js calls this, and only the first time Jev is offline/erroring/timed out.
//
// GAP (documented, not patched around): the ONNX runtime + tokenizer packages and the quantised model files
// (onnxruntime-node, @huggingface/tokenizers, assets/reflex-local-model/*) are NOT vendored in this tree. Adding
// them is a heavy dependency (over 50 MB) and this worktree's
// node_modules is a junction to the main checkout, so `npm install` cannot run here anyway. Until that
// dependency is approved and vendored, this loader always rejects and reflex-jev.js's fallback chain is
// simply Jev -> neutral (tier 2 is wired and tested, tier 3 always wins the race until the model lands).
const path = require('node:path');

const LOCAL_MODEL_DIR = path.join(__dirname, '..', '..', 'vendor', 'reflex-local-model');
const LABELS = ['listen', 'nod', 'surprise', 'think', 'happy', 'concern', 'shrug', 'neutral'];

async function loadLocalReflexClassifier() {
  // Mirrors the intent spike's classifier.mjs contract: loadClassifier({modelDir, labels, train})
  // -> { classify(text) -> {label, conf, ...} }. Thrown here on purpose until the dependency is approved.
  let loadClassifier;
  try {
    ({ loadClassifier } = require(path.join(LOCAL_MODEL_DIR, 'classifier.js')));
  } catch {
    throw new Error('local reflex classifier not vendored (onnxruntime-node and the model files are not in this build)');
  }
  const { TRAIN } = require(path.join(LOCAL_MODEL_DIR, 'labels.js'));
  return loadClassifier({ modelDir: LOCAL_MODEL_DIR, labels: LABELS, train: TRAIN });
}

module.exports = { loadLocalReflexClassifier, LOCAL_MODEL_DIR, LABELS };
