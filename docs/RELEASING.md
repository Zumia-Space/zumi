# Releasing Zumi

`scripts/check-release-gate.mjs` reads this file and runs in the release workflow.

## App release

Push a `v<version>` tag equal to `package.json`; a rebuild of the same version after a failed run takes `v<version>-r<N>` (N from 2), since a pushed tag is never moved or deleted. The workflow builds, signs and leaves a draft; publishing the draft by hand is what moves GitHub's Latest, which is where the updater looks (`releases/latest/download/latest.json`). The notes are `release-notes/<version>.md`, in plain user wording.

## Voice packs

The Marketplace finds the Kokoro pack as an asset of the `packs-v1` release. Build it from the tree, never from an archive; `--check` fails unless it equals the sha256 and size pinned in `tauri/sidecar/market-host.mjs`.

```powershell
node scripts/market-pack-kokoro.mjs --out voice.kokoro-82m-1.2.1.zip --check
gh release create packs-v1 voice.kokoro-82m-1.2.1.zip --repo Zumia-Space/zumi --title "Voice packs" --notes "Optional voice packs for Zumi. Not an app release." --prerelease --latest=false
```

The app downloads with no account, so the asset must answer an anonymous request: while `Zumia-Space/zumi` is private, GitHub answers 404 and every install shows "Not available yet" (0.3.0, measured 05-11). Two checks: the release workflow runs `node scripts/check-packs-asset.mjs`, which downloads every pinned pack through the GitHub API with the job token (a draft `packs-v1` in a private repo is enough) and fails on a missing asset or a size/sha256 different from the catalog pin. Before publishing an app release, once the repo is public and `packs-v1` is published, run `node scripts/check-packs-public.mjs` by hand: it fails until each catalog URL answers 200 to a request without a token. `npm run check:market-e2e` installs every catalog item from its real zip through the app's own path before you upload it.

`packs-v1` must never become Latest: every install would then look for `latest.json` in it and fail to update. If it ever does, publish the newest app release again with `gh release edit <tag> --repo Zumia-Space/zumi --latest`.
