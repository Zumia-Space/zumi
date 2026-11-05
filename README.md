# Zumi

Zumi is a desktop companion: an animated 3D character in a room on your PC. You type to her, she answers through an AI provider you choose and reacts with gestures and a voice.

**Status: alpha.** Windows first. Mac and Linux come later.

## Install

1. Download `Zumi_<version>_x64-setup.exe` from [Releases](https://github.com/Zumia-Space/zumi/releases).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen may warn you: choose **More info**, then **Run anyway**.
3. On first start, if your PC has no Node.js 22 or newer, Zumi asks to download about 35 MB from nodejs.org. It is checked against its published checksum and installed for your Windows account only. Without it Zumi cannot run.

Zumi updates itself once a signed release exists. To uninstall, use Windows Settings > Apps. Your settings, chats and the downloaded Node.js stay on the PC unless you tick the option to delete them.

## Add a key

Zumi needs an AI key to reply. Until you add one she only reacts with gestures.

1. Open **Settings > AI**.
2. Pick a provider. Gemini, Groq, OpenRouter, Cloudflare and Mistral have free tiers, and each asks for your own key.
3. Follow the steps shown, paste the key, press **Save**.

The key is stored encrypted on your PC. Chat goes straight from your PC to the provider, and the provider's terms and limits apply.

## What works, and what is experimental

| Works today | Experimental or not there yet |
|---|---|
| The character, rooms and views | Everything may change between alpha versions |
| Chat with your own key | The Kokoro voice pack: listed in the Marketplace, marked Coming soon until it is published |
| Windows voices | Mac and Linux builds |
| Marketplace list with sha256-pinned packs | Other Marketplace categories (skills, plugins, agent packs) |

## Build from source

You need Windows 10 or 11, Node.js 22+, and a Rust toolchain.

```powershell
git clone https://github.com/Zumia-Space/zumi.git
cd zumi
npm ci
powershell -ExecutionPolicy Bypass -File tauri\build.ps1 -Flavour public
```

The installer lands under `tauri\src-tauri\target\release\bundle\nsis\`. A build from this repository does not contain the Zumi avatar or rooms (see below): open your own VRM model from the top bar.

## Licence

The code is under [AGPL-3.0-only](LICENSE). The Zumi name and logo, the default avatar and the rooms are not open source and not in this repository; their terms come with the official installer. Third-party notices are in [NOTICE](NOTICE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and bug reports are welcome. Contact: oss@zumia.space
