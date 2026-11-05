# Zumi Marketplace package standards

Owner, 02-11: "có nhưng phải có chuẩn riêng cho từng loại asset , model , phòng , skill , voice , soul , ...". The code is `tauri/sidecar/market-standard.mjs`: the app runs it on every download, `node scripts/market-validate.mjs <file.zip>` runs it by hand, and a later upload path calls the same function. `check:market-pack` proves each rule refuses a bad package.

Today the Marketplace lists free items packaged by Zumia only. There is no upload, no paid item and no broker.

## Every package

A zip with `zumi-pack.json` at its root:

```json
{ "format": "zumi-pack/1", "id": "<kind>.<name>", "kind": "voice|room|model|skill|soul|plugin|agent",
  "version": "1.0.0", "name": { "en": "Up to 60 characters" }, "author": { "name": "..." },
  "licence": { "spdx": "Apache-2.0", "file": "LICENSE.txt" },
  "files": [{ "path": "...", "sha256": "...", "bytes": 123 }] }
```

- `files` lists every file except the manifest. An unlisted, absent, wrong-sized or wrong-hash file is refused.
- Licence: `Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `CC0-1.0`, `CC-BY-4.0` or `LicenseRef-Zumia`, with its text in the package.
- Refused always: paths that leave the folder, links, encryption, zip64, reserved Windows names, two names differing only by case, a file larger than it declares, text that looks like a key.
- Voice and plugin packages run code, so only Zumia may publish them. All others hold data only.

## voice

Limit 1.5 GB. Runs code. `platforms` is required, for example `["win-x64"]`.

```json
"voice": { "engine": "kokoro|server", "langs": ["en", "vi"] }
```

- `kokoro`: must hold `voice-modules/node_modules/kokoro-js/dist/kokoro.js`, `@huggingface/transformers/dist/transformers.node.mjs` under the same folder, and the platform's `onnxruntime_binding.node`.
- `server`: also `"command"` (a file in the package) and `"speechPath"` (the local route). No app code runs this engine yet.

## room

Limit 25 MB, the app's room cap. Data only. A room is a background plate and a looping video. There is no 3D type.

```json
"room": { "plate": "plate.png", "video": "room.mp4", "seconds": 8, "framing": { "scale": 1.1, "offsetX": 0, "offsetY": 0 } }
```

Measured from the eight shipped rooms (`assets/rooms-video/rooms.json`, ffprobe on all eight):

| Part | Rule |
|---|---|
| Plate | PNG, 1920x1200 |
| Video | mp4, h264, 1920x1080, no audio track. Shipped rooms: 24 fps, 1.5-10.4 MB |
| `seconds` | Loop length, up to 60 |
| `framing` | `scale` 1 to 2, about the talk camera's pivot; `offsetX`, `offsetY` in plate pixels |

The video frame rate is not checked by the validator. Installing a room package is not built yet.

## model

Limit 50 MB; the default model is 9.1 MB. Data only.

```json
"model": { "vrm": "model.vrm" }
```

The file must be binary glTF 2 with a `VRM` or `VRMC_vrm` extension. Installing a model package is not built yet.

## skill

Limit 1 MB. Data only. The app cannot install these yet.

```json
"skill": { "file": "skill.md", "summary": "Up to 200 characters" }
```

The `.md` is at most 20 KB.

## soul

Limit 64 KB. Data only. The app cannot install these yet.

```json
"soul": { "file": "soul.json" }
```

`soul.json` passes the Soul tab's own validation (`soul-prefs.js validateSoul`: field limits, no key-shaped text). It must not set `ownerName`, which belongs to the person installing it.

## plugin

Limit 50 MB. Runs code. The app has no plugin runtime, so nothing installs yet.

```json
"plugin": { "entry": "plugin.mjs", "permissions": { "net": ["https://..."], "settings": ["uiLang"], "hud": false } }
```

`net` holds https origins only. `settings` holds only keys on the shared-settings list (`profile-import.mjs ALLOW_KEYS`).

## agent

Limit 64 KB. Data only. The app cannot install these yet.

```json
"agent": { "items": [{ "id": "voice.kokoro-82m", "version": "1.2.1", "sha256": "..." }], "settings": { "uiLang": "vi" } }
```

An agent pack refers to other packages by id, version and hash, and never embeds them, so each file is reviewed once. It cannot hold another agent pack. `settings` holds only keys on the shared-settings list.
