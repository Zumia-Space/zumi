# Tauri P1c focus kit (tauri/verify) (spare PC only, ZUMI_ELECTRON_HOST=box)

Default (use these):
- `win-helper-noalt.ps1` : same commands as win-helper.ps1 (class-selected main window, >= 200x200), foreground via AttachThreadInput, NO synthetic ALT key; adds read-only `-Cmd fg-info`.
- `focus-drive-v3.mjs` : focus-events driver. Every CDP eval has a timeout (a hung page gives INCONCLUSIVE, not a deadlock); the real foreground is read after each step; "switch away" keeps the helper form open across "switch back"; "restore" starts from a non-Zumi foreground (a helper form is held open across the restore) so restore -> focused always has an activation change. Usage: `node focus-drive-v3.mjs --exe <zumi.exe> --tree <tree> --out <dir> [--reps 3] [--helper <ps1>]`.

Deprecated (kept for history, do not use on an unlocked session): `win-helper.ps1` (ALT trick: on a focused Zumi a bare ALT puts the window in system-menu mode and the WebView stops answering CDP; the old driver has no eval timeout and hangs) and the r5 `focus-drive.mjs` (mis-judges "switch back").
Evidence: probe-r5/PROBE-REPORT.md, "Focus (unlocked)". Re-run on the box at e5bbfac after the v3 restore change: see `probe-r5/ALT-CHECK.md`, "restore v3".

## Alt check (fix: a lone Alt no longer swallows the next key)
Spare PC, real input (SendInput), Zumi Tauri build, click into the chat input first.
1. Type `abc`, tap Alt (press+release), type `xyz` -> the input reads `abcxyz` (before the fix: `abcyz`). CDP `Runtime.evaluate` answers right after the Alt tap (before: stalls until the next key/click).
2. Tap Alt, then Esc, then `ee` -> Esc is not eaten, `ee` lands.
3. Alt+F4 on Zumi closes the window.
4. Alt+Space opens the window's system menu (Restore/Move/Size/Close).
5. Alt+Tab away and back -> typing continues.
6. Alt+Space, Esc, type `xyz` -> `xyz` lands (before the fix: the page stalls and the first key is lost; fix: `refocus_page_after(WM_EXITMENULOOP)` calls `Webview::set_focus`). Not yet run on the box.
Automated: `node tauri/verify/alt-check.mjs --exe <ZumiPreview.exe> --tree <tree> --out <dir>` (real SendInput through `input-helper.ps1`, run as an interactive scheduled task) covers items 1-5 and writes `alt-result.json` plus a screenshot per step. First run at e5bbfac: all PASS (see `ALT-CHECK.md`, "Alt check (e5bbfac)").
Evidence of the defect: the P1c probe r5 ALT-CHECK notes. Fix: window_shell.rs `swallow_syscommand` (SC_KEYMENU with lParam 0 returns 0 in the main-window subclass).
