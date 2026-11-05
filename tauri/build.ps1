<#
.SYNOPSIS
  T-31 P1a — build the Zumi Tauri PREVIEW shell (Windows NSIS installer).

.DESCRIPTION
  Reversible scaffolding for the Electron -> Tauri migration: this builds the preview app only
  (productName "Zumi Preview", identifier space.zumia.preview; a public build is "Zumi", space.zumia.zumi, tauri.public.conf.json). It does NOT touch the shipped
  Electron app, and it never launches anything.

  Steps: bundle the renderer (esbuild) -> assemble tauri\ui\ (prep-ui.mjs, which injects the generated
  window.zumi shim) -> stage the bundle resources (step 7-1) -> ensure cargo-tauri -> cargo tauri build. Nothing is
  installed on C: CARGO_HOME is pointed at a D: folder in this worktree and the Tauri bundler cache (NSIS/WiX) is
  redirected off C: via LOCALAPPDATA. The existing Rust toolchain (rustup, on C:) is reused, never modified.

  Bundle resources (parity 7-1): tauri\stage-bundle.mjs stages the sidecar, src/main, the voice modules and zumi-vault.exe
  (beside the main exe). NO node.exe is bundled (node-bundle option (c)): at runtime the host uses a compatible system
  Node (>= 22) or, after the user consents, downloads the pinned Node from nodejs.org, verifies its sha256 and installs it
  per user (tauri\src-tauri\src\node_runtime.rs). After a build, check it with:
    node tauri\verify\check-bundle.mjs --dir tauri\src-tauri\target\release

  Installer (parity 7-2): NSIS per-user (installMode currentUser) with the WebView2 download bootstrapper, and the
  Electron render-loop flags mapped to WebView2 additionalBrowserArgs in tauri.conf.json. The last lines print the
  installer size and the unpacked app.

  SIGNING HOOK (step 7 condition, UNSIGNED for T1): when a certificate exists, set
  bundle.windows.certificateThumbprint in tauri.conf.json and sign the MAIN exe AND zumi-vault.exe in the SAME step
  with the SAME certificate; check-bundle.mjs asserts the pair exists side by side.

  A fast sanity build with no installer and no bundle resources:
    powershell -ExecutionPolicy Bypass -File tauri\build.ps1 -NoBundle -SkipNpm -Flavour owner
  A pure compile check (what the P1a gate runs) is just:
    cargo build --manifest-path tauri\src-tauri\Cargo.toml

.PARAMETER NoBundle
  Compile the app only (cargo tauri build --no-bundle); skip the installer. Much faster.

.PARAMETER SkipNpm
  Assume node_modules is already installed; skip `npm ci`.

.PARAMETER SkipBundleResources
  Reuse the already-staged src-tauri\bundle tree instead of re-staging it (and skip the zumi-vault release build). The
  staged tree is gitignored; it contains the sidecar, src/main, the voice modules and zumi-vault.exe.

.PARAMETER Flavour
  Build flavour (step 6-pre, GATE-6pre item 2): owner (default) | public | official | selftest. official = what users download: public code plus the default model and Night City, no room videos, no flavour.json (it updates itself). It needs ZUMI_DEFAULT_VRM_PATH and the room files, so it builds from the private tree, not the source export. A public build (no avatar, no room; open-core
  ADR 2026-10-28) must pass -Flavour public explicitly (CoS decision 28-10, fix round 1 B2). `owner` and `selftest` write
  flavour.json beside the built exe (the values of scripts/builder-selftest.cjs extraMetadata); `public` writes NO file and
  deletes a stale one. The file is for anh's PCs and the spare PC only: a signed release bundle must contain none (step 7 gate).

.PARAMETER AllowUnchangedExe
  By default the build FAILS when the exe it is about to copy is older than the build start (cargo did not produce it, so it is
  stale). Cargo leaves an up-to-date exe untouched, so a deliberate no-op rebuild needs this switch.

.PARAMETER MeasureStub
  Stage the measurement-only stub chat provider (tauri\sidecar\measure-stub.mjs) so the demo run can time first answers
  offline. NEVER for a public build: combined with -Flavour public the build is refused. The bundle you get
  carries the stub marker and is for the spare PC only; a public bundle must not (check-tauri-measure-stub). It builds with
  --no-bundle (NO installer) and yields only target\unpacked; -SkipBundleResources and -NoBundle are refused with it.

.PARAMETER UseDefaultLocalAppData
  Do NOT redirect LOCALAPPDATA; let the Tauri bundler cache NSIS/WiX under %LOCALAPPDATA%\tauri on C:.
#>
[CmdletBinding()]
param(
  [switch]$NoBundle,
  [switch]$SkipNpm,
  [switch]$SkipBundleResources,
  [ValidateSet('public', 'official', 'owner', 'selftest')][string]$Flavour = 'owner',
  [switch]$UseDefaultLocalAppData,
  [switch]$AllowUnchangedExe,
  [switch]$MeasureStub
)

$ErrorActionPreference = 'Stop'
if ($MeasureStub -and $Flavour -in 'public', 'official') { throw '-MeasureStub stages a test-only provider: it needs -Flavour owner or selftest, never a public build' }
if ($MeasureStub -and $SkipBundleResources) { throw '-MeasureStub always re-stages: -SkipBundleResources would reuse a stage of unknown content' }
if ($MeasureStub -and $NoBundle) { throw '-MeasureStub needs the staged bundle (it is the measurement build): drop -NoBundle' }
# A stub build is an UNPACKED measurement build only: it never makes an NSIS/MSI installer (every installer runs as the public flavour).
$noInstaller = $NoBundle -or $MeasureStub
# Two products: the public build has its own name and identifier (tauri.public.conf.json); owner and self-test keep the preview's.
$mainExeName = if ($Flavour -in 'public', 'official') { 'Zumi.exe' } else { 'ZumiPreview.exe' }
$tauriDir = $PSScriptRoot
$repo = Split-Path $tauriDir -Parent

Write-Host "== T-31 Tauri preview build (P1a) ==" -ForegroundColor Cyan
Write-Host "repo:  $repo"
Write-Host "tauri: $tauriDir"

# --- keep cargo's cache + cargo-tauri install off C: -------------------------------------------
$env:CARGO_HOME = Join-Path $repo '.cargo-home'
New-Item -ItemType Directory -Force -Path $env:CARGO_HOME | Out-Null
$env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
Write-Host "CARGO_HOME=$env:CARGO_HOME (RUSTUP_HOME stays the existing toolchain: $(if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { 'default' }))"

# --- 1. renderer bundle + tauri/ui -------------------------------------------------------------
Push-Location $repo
try {
  if (-not $SkipNpm -and -not (Test-Path (Join-Path $repo 'node_modules'))) {
    Write-Host "-- npm ci" -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
  } else {
    Write-Host "-- node_modules present, skipping npm ci" -ForegroundColor DarkGray
  }
  Write-Host "-- npm run build:renderer" -ForegroundColor Cyan
  npm run build:renderer
  if ($LASTEXITCODE -ne 0) { throw "build:renderer failed ($LASTEXITCODE)" }

  Write-Host "-- prep-ui (assemble tauri/ui + inject shim)" -ForegroundColor Cyan
  node (Join-Path $tauriDir 'prep-ui.mjs') --flavour $Flavour
  if ($LASTEXITCODE -ne 0) { throw "prep-ui failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

# --- 2. cargo-tauri ----------------------------------------------------------------------------
$cargoTauri = $null
try { $null = & cargo tauri --version 2>$null; if ($LASTEXITCODE -eq 0) { $cargoTauri = 'cargo tauri' } } catch {}
if (-not $cargoTauri) {
  Write-Host "-- installing cargo-tauri into $env:CARGO_HOME\bin" -ForegroundColor Cyan
  cargo install tauri-cli --version '=2.12.4' --locked
  if ($LASTEXITCODE -ne 0) { throw "cargo install tauri-cli failed ($LASTEXITCODE)" }
  $cargoTauri = 'cargo tauri'
}
Write-Host "-- $(& cargo tauri --version)"

# --- 3. icons (generated once from buildres/icon.png) ------------------------------------------
$iconsDir = Join-Path $tauriDir 'src-tauri\icons'
if (-not (Test-Path (Join-Path $iconsDir 'icon.ico'))) {
  Write-Host "-- generating icons from buildres\icon.png" -ForegroundColor Cyan
  Push-Location $tauriDir
  try { cargo tauri icon (Join-Path $repo 'buildres\icon.png') } finally { Pop-Location }
}

# --- 3b. bundle resources (parity 7-1) ---------------------------------------------------------
# No node.exe is staged (option (c)): the host finds or downloads Node at runtime. zumi-vault.exe is built first so it can
# sit beside the main exe (step 5 gate condition 2).
if ($NoBundle) {
  Write-Host "-- -NoBundle: bundle resources not staged (a debug exe can use ZUMI_NODE or a system Node)" -ForegroundColor DarkGray
} elseif ($SkipBundleResources) {
  Write-Host "-- -SkipBundleResources: reusing src-tauri\bundle" -ForegroundColor DarkGray
} else {
  Write-Host "-- cargo build --release --bin zumi-vault" -ForegroundColor Cyan
  & cargo build --release --manifest-path (Join-Path $tauriDir 'src-tauri\Cargo.toml') --bin zumi-vault
  if ($LASTEXITCODE -ne 0) { throw "zumi-vault build failed ($LASTEXITCODE)" }
  Write-Host "-- stage-bundle (sidecar + src/main + voice-modules + zumi-vault.exe)" -ForegroundColor Cyan
  $stageArgs = @()
  if ($MeasureStub) { $stageArgs += '--measure-stub' }
  $stageArgs += '--flavour', $Flavour
  node (Join-Path $tauriDir 'stage-bundle.mjs') @stageArgs
  if ($LASTEXITCODE -ne 0) { throw "stage-bundle failed ($LASTEXITCODE)" }
}

# The stage is what the installer packs (tauri.conf.json bundles bundle/). A non-stub build must prove it holds no stub, a reused
# stage (-SkipBundleResources, possibly left by an earlier -MeasureStub build) included, BEFORE any installer is made.
if (-not $NoBundle -and -not $MeasureStub) {
  $stagedDir = Join-Path $tauriDir 'src-tauri\bundle'
  Write-Host "-- check-bundle --dir $stagedDir (no stub in the stage)" -ForegroundColor Cyan
  node (Join-Path $tauriDir 'verify\check-bundle.mjs') --dir $stagedDir --flavour $Flavour
  if ($LASTEXITCODE -ne 0) { throw "check-bundle failed ($LASTEXITCODE) on the stage: it holds the measure stub or is incomplete; re-stage without -SkipBundleResources" }
  # Third-party licence gate over frontendDist + the stage (flavour public = HARD FAIL on any UNVERIFIED asset, owner/selftest = warn).
  Write-Host "-- check-tauri-third-party --flavour $Flavour" -ForegroundColor Cyan
  node (Join-Path $repo 'scripts/check-tauri-third-party.mjs') --flavour $Flavour
  if ($LASTEXITCODE -ne 0) { throw "check-tauri-third-party failed ($LASTEXITCODE) for the $Flavour flavour: an unlisted, uncredited or (public) unverified asset ships" }
}

# --- 4. build ----------------------------------------------------------------------------------
$buildStart = Get-Date
Push-Location $tauriDir
try {
  if (-not $UseDefaultLocalAppData) {
    $env:LOCALAPPDATA = Join-Path $repo '.tauri-cache'
    New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null
    Write-Host "LOCALAPPDATA redirected to $env:LOCALAPPDATA (bundler cache off C:)"
  }
  # Step 7-5: package.json, the resolved tauri.conf.json version and Cargo.toml must agree BEFORE anything is built.
  Write-Host "-- check-tauri-version (package.json == tauri.conf.json == Cargo.toml)" -ForegroundColor Cyan
  node (Join-Path $repo 'scripts\check-tauri-version.mjs')
  if ($LASTEXITCODE -ne 0) { throw "check-tauri-version failed ($LASTEXITCODE): fix the version mismatch before building" }
  $buildArgs = @('build')
  if ($noInstaller) { $buildArgs += '--no-bundle' }
  if ($Flavour -in 'public', 'official') { $buildArgs += '--config', (Join-Path $tauriDir 'src-tauri\tauri.public.conf.json') }
  Write-Host "-- cargo tauri $($buildArgs -join ' ')" -ForegroundColor Cyan
  & cargo tauri @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

# Cargo builds into CARGO_TARGET_DIR when set (box/scratch builds), else src-tauri\target. A hard-coded target\release shipped a
# STALE exe into target\unpacked whenever CARGO_TARGET_DIR was set (N3 proof b4b8a58).
$cargoTarget = if (-not $env:CARGO_TARGET_DIR) {
  Join-Path $tauriDir 'src-tauri\target'
} elseif ([System.IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
  $env:CARGO_TARGET_DIR
} else {
  Join-Path $tauriDir $env:CARGO_TARGET_DIR   # cargo ran with cwd = $tauriDir
}
$release = Join-Path $cargoTarget 'release'
$builtExe = Join-Path $release $mainExeName
if (-not (Test-Path $builtExe)) { throw "built exe missing: $builtExe (CARGO_TARGET_DIR=$env:CARGO_TARGET_DIR)" }
$builtExeTime = (Get-Item $builtExe).LastWriteTime
if (-not $AllowUnchangedExe -and $builtExeTime -lt $buildStart) {
  throw "stale exe: $builtExe is dated $builtExeTime, older than the build start $buildStart. Cargo did not produce it; refusing to ship it (-AllowUnchangedExe for a deliberate no-op rebuild)."
}
Write-Host "built exe: $builtExe ($builtExeTime)"
# Flavour file beside the built exe (public = no file; a stale one is removed). This writes only the LOOSE copy in $release.
# The NSIS installer is packed from the staged resources (src-tauri\bundle), and a non-public stage already holds its own
# flavour.json (flavour-stage.mjs), so an owner/selftest installer DOES carry flavour.json (+ the room videos). A public
# installer carries neither. stage-preview-kit.ps1 therefore reads the installer payload, never trusts a folder or a file name.
node (Join-Path $tauriDir 'write-flavour.mjs') --flavour $Flavour --out $release
if ($LASTEXITCODE -ne 0) { throw "write-flavour failed ($LASTEXITCODE)" }

# An UNPACKED app dir (target\unpacked): the same files an install gets (main exe + staged resources + zumi-vault.exe
# beside the exe). Tauri's NSIS bundle leaves no unpacked directory on Windows, and the spare-PC probes drive the built
# app from here. check-bundle.mjs asserts this directory; its size is the installed size.
$staged = Join-Path $tauriDir 'src-tauri\bundle'
$unpacked = Join-Path $tauriDir 'src-tauri\target\unpacked'
if (-not $NoBundle) {
  if (-not (Test-Path $staged)) {
    throw "bundle resources are missing ($staged): stage them (omit -NoBundle) before building a bundle"
  }
  if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
  New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
  Copy-Item -Recurse -Force (Join-Path $staged '*') $unpacked
  Copy-Item -Force $builtExe $unpacked
  if (Test-Path (Join-Path $release 'flavour.json')) { Copy-Item -Force (Join-Path $release 'flavour.json') $unpacked }

  # Step 7-7: the bundle check is a HARD gate, including when -SkipBundleResources reused a staged tree. A bundle that
  # fails it must not be handed to a probe or shipped.
  Write-Host "-- check-bundle --dir $unpacked (hard gate)" -ForegroundColor Cyan
  $bundleCheckArgs = @('--flavour', $Flavour)
  if ($MeasureStub) { $bundleCheckArgs += '--allow-measure-stub' }
  node (Join-Path $tauriDir 'verify\check-bundle.mjs') --dir $unpacked @bundleCheckArgs
  if ($LASTEXITCODE -ne 0) { throw "check-bundle failed ($LASTEXITCODE): the built bundle is incomplete" }

  # Step 7-5, after the build: the NSIS artifact's file name must carry the same version (a stub build has no installer).
  if (-not $MeasureStub) {
    node (Join-Path $repo 'scripts\check-tauri-version.mjs') --installer-dir (Join-Path $release 'bundle\nsis')
    if ($LASTEXITCODE -ne 0) { throw "check-tauri-version --installer-dir failed ($LASTEXITCODE): the installer name does not match package.json" }

    # CoS rule (26-10): a kit is verified against the EXTRACTED installer payload, not the build tree. 7z extracts the fresh
    # installer, the payload gate FAILs on any entry packed twice (r4: zumi-vault.exe x2), then check-bundle runs on the extracted dir.
    # No 7-Zip on the box = a hard stop (exit 2), never a silent pass.
    $freshSetup = @(Get-ChildItem (Join-Path $release 'bundle\nsis') -Filter '*-setup.exe' | Where-Object { $_.LastWriteTime -ge $buildStart })
    if ($freshSetup.Count -ne 1) { throw "expected exactly one fresh installer in bundle\nsis for the payload check, found $($freshSetup.Count)" }
    $payloadDir = Join-Path $cargoTarget 'installer-payload'
    if (Test-Path $payloadDir) { Remove-Item -Recurse -Force $payloadDir }
    Write-Host "-- check-tauri-installer-payload ($($freshSetup[0].Name) -> $payloadDir)" -ForegroundColor Cyan
    node (Join-Path $repo 'scripts\check-tauri-installer-payload.mjs') --installer $freshSetup[0].FullName --out $payloadDir
    if ($LASTEXITCODE -ne 0) { throw "check-tauri-installer-payload failed ($LASTEXITCODE): the installer packs an entry twice, cannot be extracted, or 7-Zip is missing" }
    Write-Host "-- check-bundle --dir $payloadDir (the extracted installer payload)" -ForegroundColor Cyan
    node (Join-Path $tauriDir 'verify\check-bundle.mjs') --dir $payloadDir --flavour $Flavour
    if ($LASTEXITCODE -ne 0) { throw "check-bundle failed ($LASTEXITCODE) on the EXTRACTED installer payload: what the installer ships is incomplete" }
  }

  # P3-A: a non-public installer carries flavour.json + the room videos. It is the SAME product ("Zumi Preview", identifier
  # space.zumia.preview, per-user, directory page) so it installs over anh's preview in place. Its file is RENAMED (not
  # copied) to <product>_<version>_x64-<flavour>-installer.exe: exactly one installer file exists per build, and only a
  # public build keeps the *-setup.exe name that stage-preview-kit.ps1 globs, so the owner payload never sits under it.
  if ($Flavour -notin 'public', 'official' -and -not $MeasureStub) {
    $pub = @(Get-ChildItem (Join-Path $release 'bundle\nsis') -Filter '*-setup.exe' | Where-Object { $_.LastWriteTime -ge $buildStart })
    if ($pub.Count -ne 1) { throw "expected exactly one fresh installer in bundle\nsis, found $($pub.Count)" }
    $ownerName = $pub[0].Name -replace '-setup\.exe$', "-$Flavour-installer.exe"
    if ($ownerName -eq $pub[0].Name) { throw "cannot derive the $Flavour installer name from $($pub[0].Name)" }
    Move-Item -Force $pub[0].FullName (Join-Path $pub[0].DirectoryName $ownerName)
    Write-Host "$Flavour installer (not for the public kit): $(Join-Path $pub[0].DirectoryName $ownerName)"
  }
}

Write-Host "`n== done ==" -ForegroundColor Green
Write-Host "app exe:     $builtExe"
if (-not $noInstaller) {
  $installers = @(Get-ChildItem (Join-Path $release 'bundle') -Recurse -Include *.exe -ErrorAction SilentlyContinue)
  if ($installers.Count -eq 0) {
    Write-Host "installer size: (none: cargo tauri build did not produce an NSIS installer)"
  } else {
    $installers | ForEach-Object { Write-Host "installer size: $([math]::Round($_.Length/1MB,1)) MB  $($_.FullName)" }
  }
}
if (-not $NoBundle) {
  Write-Host "unpacked app: $unpacked"
  Write-Host "bundle check: node tauri\verify\check-bundle.mjs --dir `"$unpacked`""
}
