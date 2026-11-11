# Zumi

Zumi is a desktop companion: an animated 3D character who lives in a room on your PC. You type to her, she answers through an AI provider you choose with your own key, and she reacts with gestures and a voice.

> **Zumi is about halfway there.** The app works today, and roughly half of what we plan is built. The rest is still ahead, and we would like to build it with you. Try it, tell us what breaks, and join the community on **[Discord](https://discord.gg/5jyJ3UJ5zF)**.

**Official build: the Tauri app.** Windows first. Mac and Linux come later. The supported download is the Windows installer. A macOS build exists but has not been tested yet (see [macOS](#macos-untested-testers-wanted)).

- Website: [zumia.space](https://zumia.space)
- Download: [latest release](https://github.com/Zumia-Space/zumi/releases/latest)
- Community: [Discord](https://discord.gg/5jyJ3UJ5zF)
- Bugs and ideas: [GitHub Issues](https://github.com/Zumia-Space/zumi/issues)

## What Zumi does today

- **A 3D character on your desktop.** Zumi is a VRM model rendered with three.js. She idles, gestures in reaction to what you type and moves her mouth while she speaks. You can load your own `.vrm` model from the top bar.
- **Rooms and camera views.** She sits in a room, with talk, work and room views. The official installer ships the Zumi avatar and its rooms; you can also open a room file of your own.
- **Chat with your own AI key.** You bring a key and your messages go straight from your PC to that provider. Built-in presets cover Google Gemini, Groq, OpenRouter and Cloudflare Workers AI, which all have free tiers, plus Mistral as an advanced option. Keys are stored encrypted on your PC (Windows DPAPI).
- **A personality you can set.** In **Settings > Agent & Soul** you choose her name, how she addresses you, her style and the reply language.
- **Memory notes.** Notes you write are kept in a local SQLite file and quoted to your AI provider when they matter. Conversations themselves are not stored. You can list, search, delete and export notes.
- **Voice.** Free Windows voices out of the box. Cloud voices (Gemini, ElevenLabs) with your own key. A local Kokoro-82M voice pack is listed in the Marketplace and marked "Coming soon" until it is published.
- **Marketplace.** Free packs made by Zumia; each pack is pinned by its sha256 and size before it installs.
- **Usage view.** **Settings > AI & Usage** shows calls, tokens and estimated cost for today, the last 7 days and the last 30 days.
- **Three interface languages.** English, Vietnamese and Chinese.
- **Self-update.** The Windows build checks for a new version at startup, every 6 hours and from the About button. It downloads the update from GitHub Releases, verifies its signature, then asks you to restart now or later ("Later" installs it on your next normal quit).

## What is not there yet

Zumi is a preview, and parts of it are experimental. Expect rough edges, and expect things to change between versions.

| Area | State |
|---|---|
| Windows 10/11 (x64) | Supported, official installer |
| macOS | Built, untested, testers wanted |
| Linux | Not started |
| Kokoro voice pack | Listed, "Coming soon" |
| Marketplace skills, plugins, agent packs | Not there yet |
| Code signing | The Windows installer is not Authenticode-signed yet, so SmartScreen warns (updates are still signature-checked) |

## Install on Windows

1. Download `Zumi_<version>_x64-setup.exe` from the [latest release](https://github.com/Zumia-Space/zumi/releases/latest).
2. Optional: check the file. Compare its SHA-256 with the line in `SHA256SUMS.txt` from the same release:
   ```powershell
   Get-FileHash -Algorithm SHA256 .\Zumi_<version>_x64-setup.exe
   ```
3. Run it. Because the installer is not code-signed yet, Windows SmartScreen may say "Windows protected your PC": choose **More info**, then **Run anyway**. The first launch of the app may show the same screen; do the same.
4. On first start, if your PC has no Node.js 22 or newer, Zumi asks to download about 35 MB from nodejs.org. The download is checked against its published checksum and installed for your Windows account only. Without it Zumi cannot run.

To uninstall, use Windows Settings > Apps. Your settings, notes and the downloaded Node.js stay on the PC unless you tick the option to delete them.

## Add a key

Zumi needs a key to reply. Until you add one she only reacts with gestures.

1. Open **Settings > AI & Usage**.
2. Pick a provider and follow the steps shown to get a free key.
3. Paste the key and press **Save**, then **Test key**.

The provider's own terms and limits apply to your chat.

## macOS (untested, testers wanted)

The Tauri app has been built for macOS (unsigned `.dmg`, Apple silicon and Intel) in automated runs, but nobody on the team has a Mac to try it on. We do not know yet whether it is ready, so it is not a supported download and it is not on the website.

If you have a Mac and want to help:

1. Open a [macOS test report](https://github.com/Zumia-Space/zumi/issues/new?template=macos-test-report.yml). We will point you to the current test build.
2. Install it, try the basics (start, chat with a key, voice, settings) and fill in the report.

Once testers confirm it works, the macOS build goes on the website.

## Join us

Zumi is open source and still being shaped. Come and say hello in the **[Zumi Discord](https://discord.gg/5jyJ3UJ5zF)**: it is where we talk about what to build next. The fastest ways to help right now:

- **Use it and report what breaks.** Open a [bug report](https://github.com/Zumia-Space/zumi/issues/new?template=bug-report.yml). Your Zumi version, Windows version and the steps you took help most.
- **Test on a Mac.** See [macOS](#macos-untested-testers-wanted).
- **Share ideas and talk to us** on [Discord](https://discord.gg/5jyJ3UJ5zF) or in an issue.
- **Build it from source**, read the code and tell us what you would change.

Code pull requests need a signed Contributor License Agreement, and that agreement is still being written, so we cannot merge outside code yet. Until then, please start with an issue that describes the change. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Build from source

You need Windows 10 or 11, Node.js 22 or newer, and a Rust toolchain.

```powershell
git clone https://github.com/Zumia-Space/zumi.git
cd zumi
npm ci
powershell -ExecutionPolicy Bypass -File tauri\build.ps1 -Flavour public
```

The installer lands under `tauri\src-tauri\target\release\bundle\nsis\`. A build from this repository does not contain the Zumi avatar or rooms (see [Licence](#licence)): open your own VRM model from the top bar.

To run the checks that pass from a clean clone:

```powershell
npm run check:release -- --dry
```

### Repository layout

| Path | What it holds |
|---|---|
| `tauri/src-tauri/` | The Rust host of the official app (Tauri 2): window, key vault, updater, network guard |
| `tauri/sidecar/` | The Node sidecar the host runs: chat, voice, memory notes, Marketplace, settings |
| `src/renderer/` | The interface: 3D stage (three.js, three-vrm), settings, Marketplace, chat |
| `src/main/` | Shared modules the sidecar imports, and the earlier desktop shell, which is frozen |
| `scripts/` | Build helpers and `check-*` scripts |
| `docs/` | Release process, security notes, Marketplace package standard |
| `release-notes/` | User-facing notes for each version |

## Licence

The code is under [AGPL-3.0-only](LICENSE). The Zumi name and logo, the default avatar and the rooms are not open source and not in this repository; their terms come with the official installer. Third-party notices are in [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Contact

- Community: [Discord](https://discord.gg/5jyJ3UJ5zF)
- Bugs and ideas: [GitHub Issues](https://github.com/Zumia-Space/zumi/issues)
- Open-source questions: oss@zumia.space
