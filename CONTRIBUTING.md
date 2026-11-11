# Contributing to Zumi

Thanks for your interest in Zumi. The app is about halfway to where we want it, and we would like to build the rest together with the people who use it.

## Ways to help now

- **Report bugs.** Open an issue with the [bug report](https://github.com/Zumia-Space/zumi/issues/new?template=bug-report.yml) template. Include your Zumi version (Settings > App), your Windows version and the steps that lead to the problem.
- **Test on a Mac.** The macOS build has not been tested on a real Mac yet. Open a [macOS test report](https://github.com/Zumia-Space/zumi/issues/new?template=macos-test-report.yml).
- **Suggest features and discuss ideas** in an issue or on [Discord](https://discord.gg/5jyJ3UJ5zF).
- **Build from source** and tell us what you would change: see "Build from source" in the [README](README.md#build-from-source).

## Before you send code

- Outside contributions need a signed Contributor License Agreement first: see [CLA.md](CLA.md). The CLA is a draft pending lawyer review, so code pull requests cannot be merged yet.
- Until then, please open an issue that describes the change you have in mind, so we can agree on it before the CLA is ready.
- Issues and bug reports are welcome now.

## What this repository holds

- The app code (Electron and `tauri/`) is licensed under AGPL-3.0-only; see `LICENSE`. The Tauri app in `tauri/` is the official build; the Electron shell in `src/main/` is the earlier one, kept frozen while the Tauri sidecar reuses its modules.
- The Zumi name and logo, and the Zumi assets (the default avatar model, the rooms and their plates), are NOT part of the open-source code. They ship only in the official installer; see `ASSETS-LICENSE.md` there. A build from this source is the public flavour and starts without them and asks you to open your own `.vrm` file.

## Checks

`npm run check:release -- --dry` is the set that passes from a clean clone, and `npm run check:ui-lang` and `npm run check:contributing` are examples of what it holds. Many other checks need the default avatar, rooms or local test models, which are not in this repository. Every `scripts/check-*.mjs` must be registered in `package.json` (`npm run check:checks-registered`).

## Contact

- Community: [Discord](https://discord.gg/5jyJ3UJ5zF)
- Open-source questions: oss@zumia.space
