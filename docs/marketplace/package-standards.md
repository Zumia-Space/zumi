# Zumi Marketplace package standards

Owner, 02-11: "có nhưng phải có chuẩn riêng cho từng loại asset , model , phòng , skill , voice , soul , ...". The code is `tauri/sidecar/market-standard.mjs`: the app runs it on every download, `node scripts/market-validate.mjs <file.zip>` runs it by hand, and a later upload path calls the same function. `check:market-pack` proves each rule refuses a bad package.

Today the Marketplace lists free items packaged by Zumia only. There is no upload, no paid item and no broker.

## Every package

A zip with `zumi-pack.json` at its root:

```json
{ "format": "zumi-pack/1", "id": "<kind>.<name>", "kind": "voice|room|model|skill|soul|plugin|agent|scene",
  "version": "1.0.0", "name": { "en": "Up to 60 characters" }, "author": { "name": "..." },
  "licence": { "spdx": "Apache-2.0", "file": "LICENSE.txt" },
  "files": [{ "path": "...", "sha256": "...", "bytes": 123 }] }
```

- `files` lists every file except the manifest. An unlisted, absent, wrong-sized or wrong-hash file is refused.
- Licence: `Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `CC0-1.0`, `CC-BY-4.0` or `LicenseRef-Zumia`, with its text in the package.
- Refused always: paths that leave the folder, links, encryption, zip64, reserved Windows names, two names differing only by case, a file larger than it declares, text that looks like a key.
- Voice and plugin packages run code, so only Zumia may publish them. All others hold data only.
- Compatibility: a kind section may carry `api` (a whole number, the major version of the host interface it uses); `plugin` and `scene` must. A pack whose `api` this Zumi does not support is refused at install and at load: `pack_needs_newer_host` or `pack_api_retired`. Packs without `api` count as api 1.
- Store: the Marketplace reads a signed index (`index.json` + minisign `index.json.minisig`, store key separate from the updater key). Each version is pinned by sha256 and bytes; the serial never goes down; withdrawn versions stop loading. See ADR `docs/decisions/2026-11-11-pack-system.md`.

## voice

Limit 1.5 GB. Runs code. `platforms` is required, for example `["win-x64"]`.

```json
"voice": { "engine": "kokoro|server", "langs": ["en", "vi"] }
```

- `kokoro`: must hold `voice-modules/node_modules/kokoro-js/dist/kokoro.js`, `@huggingface/transformers/dist/transformers.node.mjs` under the same folder, and the platform's `onnxruntime_binding.node`.
- `server`: also `"command"` (a file in the package) and `"speechPath"` (the local route). No app code runs this engine yet.

## room

Limit 25 MB, the app's room cap. Data only. A room is a background plate and a looping video. A lit 3D room is the `scene` type.

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

The video frame rate is not checked by the validator.

Two more shapes, for the rooms Zumia ships as packs (the slim official installer carries none of them):

- **Video over the default room** (the seven built-in video rooms): `"room": { "over": "default-v2", "video": "<file>.mp4", "seconds": 15.92, "framing": {...} }`. No plate: the video is drawn over the default room's talk plate. The app lists it only when the video is the exact file `assets/rooms-video/rooms.json` pins (size and sha256), so this shape is for Zumia's own rooms.
- **Painted room** (the default room, Night City): `"room": { "layout": "room.json" }`. `room.json` is a room v2 file the app's room checker accepts; every plate it names and its occluder `.glb` must be in the pack. That one `.glb` is the only 3D file a room pack may hold. No video, plate or `over` beside a layout.

Installing: a room pack lands in `<data>/packs/<id>/`. The painted room is copied by its content hash into `<data>/rooms/default-v2/<sha>/` and served from there; a video room is served from its pack folder. Removing the default room's pack removes that copy too.

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

Limit 50 MB. A web app: static files (`.html .js .css`, images, fonts, glTF) shown as a tab in its own locked webview. It talks to the app only through the pack bridge.

```json
"plugin": { "api": 1, "ui": "ui/index.html",
  "tab": { "label": { "en": "Content", "vi": "Nội dung" }, "icon": "ui/icon.svg" },
  "permissions": { "storage": true, "links": { "docs": "https://..." }, "avatar": "read", "net": [] } }
```

- No `.mjs`, `.cjs`, `.wasm` or native file (`plugin_native`): nothing runs outside the webview.
- `net` must be empty: no network in v1. The page may load its own files only.
- `links` maps a short key to an https link; the page asks the app to open a key, never a URL.
- `avatar: "read"` lets the page load the user's current avatar from the app. The pack never carries one.
- Any other permission is refused (`plugin_permission_unknown`).
- `plugin.canary` (`scripts/fixtures/market/plugin.canary`) is the open sample.

## scene

Limit 64 MB. Data only. A lit 3D room the app renders: one binary glTF plus a descriptor of value tables (anchors, views, the five times of day, light and quality tiers).

```json
"scene": { "api": 1, "glb": "scene.glb", "descriptor": "scene.json", "tiers": ["low", "high"], "preview": "preview.jpg",
  "budget": { "triangles": 1500000, "textureMaxPx": 2048 } }
```

- The glb is self-contained: a buffer or image with any `uri` (web, file or data) is refused (`scene_uri`).
- glTF extensions only from the allow-list (`scene_extension`); images png or jpeg only, each no larger than `budget.textureMaxPx` (`scene_texture_size`).
- The triangle count is at most `budget.triangles` (`scene_triangles`); the budget itself is at most 1.5 M triangles and 4096 px (`scene_budget`).
- `scene.json` names the node where Zumi stands: `anchors.zumi_stand.node` (`scene_anchor`).

## agent

Limit 64 KB. Data only. The app cannot install these yet.

```json
"agent": { "items": [{ "id": "voice.kokoro-82m", "version": "1.2.1", "sha256": "..." }], "settings": { "uiLang": "vi" } }
```

An agent pack refers to other packages by id, version and hash, and never embeds them, so each file is reviewed once. It cannot hold another agent pack. `settings` holds only keys on the shared-settings list.
