# Contributing to Zumi

Thanks for your interest in Zumi.

## Before you send code

- Outside contributions need a signed Contributor License Agreement first: see [CLA.md](CLA.md). The CLA is a draft pending lawyer review, so code pull requests cannot be merged yet.
- Issues and bug reports are welcome now.

## What this repository holds

- The app code (Electron and `tauri/`) is licensed under AGPL-3.0-only; see `LICENSE`.
- The Zumi name and logo, and the Zumi assets (the default avatar model, the rooms and their plates), are NOT part of the open-source code. They ship only in the official installer; see `ASSETS-LICENSE.md` there. A build from this source is the public flavour and starts without them and asks you to open your own `.vrm` file.

## Checks

`npm run check:release -- --dry` is the set that passes from a clean clone, and `npm run check:ui-lang` and `npm run check:contributing` are examples of what it holds. Many other checks need the default avatar, rooms or local test models, which are not in this repository. Every `scripts/check-*.mjs` must be registered in `package.json` (`npm run check:checks-registered`).

## Contact

oss@zumia.space
