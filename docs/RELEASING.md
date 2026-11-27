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

## Commit emails

A commit's author, committer and trailer addresses are published with the repo. `scripts/check-commit-emails.mjs` fails on any address that is not a GitHub noreply address, `noreply@anthropic.com` or an address at `zumia.space`, and prints the sha, the field and a masked form (`a***@domain`), never the address. History up to `a8144d4` (public main on 2026-11-27) is exempt: it is kept as it is, by decision. `release-checks.mjs` runs it over the commits since the previous release tag, so a release tag with a bad commit fails before the build. A release workflow checkout that is shallow only shows the tagged commit; give the checkout `fetch-depth: 0` to read the whole range.

Before you push, turn on the hook once per clone: `git config core.hooksPath scripts/hooks`. It runs the check on what the push would publish. Nothing installs it for you. Also set your git `user.email` to your GitHub noreply address (GitHub, Settings, Emails, "Keep my email addresses private" and "Block command line pushes that expose my email"). There is no pull-request workflow in this repo yet, so a PR is not checked server-side: run `npm run check:commit-emails` before you open one.
