# Security notes (Zumi Tauri preview)

## Known limitation: build flavour is read from `flavour.json` (accepted for the preview)

- The preview installs per user (no admin rights, under the user's profile).
- The build flavour (public vs owner) is read at start-up from `flavour.json` placed next to the executable.
- A program running as the same Windows user can edit that file and switch a public install to the owner flavour.
- Accepted for the preview: same-user malware can already read the user's whole profile (settings, vault files, tokens), so the flavour switch adds little.
- Planned fix: embed the flavour in the binary at build time and stop reading `flavour.json`. Tracked under T-31-TAURI.

Opus re-review conditions (GATE-P3B-SECURITY.md, "Same-user flavour.json tamper"):
- (a) Named known limitation: this section and `release-notes/0.2.10-preview.3.md`.
- (b) The signed public bundle carries no `flavour.json`; enforced by `tauri/verify/check-bundle.mjs` (PARITY-PLAN step 7). No code change in this batch.
- (c) The sidecar logs the resolved flavour at start and the reason whenever a file is ignored (`tauri/sidecar/flavour.mjs`). No code change in this batch.

## Board live view in every flavour

The board live view opens in every flavour. In the public flavour, file chips are refused with `not_owner_build`, the same as Electron 0.2.9.

## Accepted residual: G5(i), same-origin iframe `window.open` on the board guest

- Residual: script in a same-origin, non-sandboxed subframe of the board guest can reach `window.open` for the guest. The new-window handler does not tell a subframe from the top frame.
- Accepted (Opus 5.5 review, 2026-10-25): a frame check would not be a boundary. A same-origin subframe can already drive the top frame (`top.open(...)`, a synthetic click on a chip in `top.document`, `top.location`), and no subframe can run script that the top frame cannot.
- Why no injection path exists: the guest CSP (`GUEST_HTML_CSP`, `src/main/board-bridge.mjs`) is `default-src 'self'; script-src 'self'; ...; frame-ancestors 'none'`, so cross-origin, `data:` and `blob:` frames are blocked, and `srcdoc`/`about:blank` frames inherit the CSP. `'self'` serves only the vendored static files and magic-byte-checked media. The board Markdown escapes all text and links only http(s) and mailto.
- The opener check, the owner flavour, `OPEN_ROOTS` and `OPEN_EXT` still apply to every open.
- Correction to the earlier record: WebView2 does expose the source frame (`ICoreWebView2NewWindowRequestedEventArgs3::OriginalSourceFrameInfo`, `ICoreWebView2FrameInfo2::FrameKind`). The claim "no frame info" was wrong for WebView2. The check is not enforced because it is not a boundary here.
