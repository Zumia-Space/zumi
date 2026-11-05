# T-31 parity 7-3: PATH-scrubbed probe of the built (unpacked) preview.
#
# Runs the unpacked app's BUILT HOST headlessly (ZumiPreview.exe --probe-sidecar-spawn), which spawns the sidecar
# through the real resource_dir() path, then drives the sidecar directly over stdio. Every Node directory is removed
# from PATH, so only the explicitly passed test runtime is in play:
#   - the host spawn proves the packaged path form is usable by Node (a verbatim `\\?\` regression fails with EISDIR);
#   - the sidecar's `info` reports process.execPath under the bundle (no PATH fallback anywhere);
#   - check-kokoro-packaged-env passes with --resources-dir <bundle>, so kokoro-js, @huggingface/transformers and
#     the onnxruntime binary resolve from the bundle.
#
# Headless: no app window is opened (the host probe mode builds the app without its setup hook and exits), and the
# main GUI is never started. Only the sidecar process runs, and it is stopped before this script exits. Nothing on
# the machine is changed outside this script's own process env and a scratch data dir under <repo>\.tauri-check-tmp
# (gitignored).
#
#   powershell -ExecutionPolicy Bypass -File tauri\verify\run-packaged-probe.ps1
#   powershell -ExecutionPolicy Bypass -File tauri\verify\run-packaged-probe.ps1 -Bundle D:\path\to\unpacked
#
# Exit 0 only when every assertion passes.

[CmdletBinding()]
param(
  [string]$Bundle,
  [string]$Node,
  [string]$Seed, # the Kokoro seed folder; empty = packaged-probe.mjs's default (scripts/lib/owner-paths.mjs kokoroSeed)
  [switch]$KeepDataDir
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Bundle) { $Bundle = Join-Path $PSScriptRoot '..\src-tauri\target\unpacked' }

try { $bundleDir = (Resolve-Path -LiteralPath $Bundle).Path }
catch {
  Write-Host "REFUSED: bundle directory not found: $Bundle"
  Write-Host "Build it first: powershell -ExecutionPolicy Bypass -File tauri\build.ps1 -Flavour owner"
  exit 1
}
$bundledNode = Join-Path $bundleDir 'node\node.exe'
# The bundle carries no Node (option (c): provisioned at runtime). -Node / ZUMI_PROBE_NODE / first PATH node (before the scrub) is the TEST runtime.
if (-not $Node) { $Node = $env:ZUMI_PROBE_NODE }
if (-not $Node) { $found = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1; if ($found) { $Node = $found.Source } }
$nodeExe = $Node
$sidecar = Join-Path $bundleDir 'tauri\sidecar\main.mjs'
$hostExe = Join-Path $bundleDir 'ZumiPreview.exe'
$driver = Join-Path $PSScriptRoot 'packaged-probe.mjs'
if (Test-Path -LiteralPath $bundledNode) {
  Write-Host "REFUSED: the bundle still carries node\node.exe: $bundledNode (option (c) ships no Node)"
  exit 1
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  Write-Host "REFUSED: no test Node runtime. Pass -Node <node.exe> or set ZUMI_PROBE_NODE."
  exit 1
}
if (-not (Test-Path -LiteralPath $sidecar)) {
  Write-Host "REFUSED: the bundle has no tauri\sidecar\main.mjs: $sidecar"
  exit 1
}
if (-not (Test-Path -LiteralPath $hostExe)) {
  Write-Host "REFUSED: the bundle has no built host exe: $hostExe (build with tauri\build.ps1 -Flavour owner)"
  exit 1
}

# ---- scrub PATH: drop every directory that holds node.exe (and the usual Node install dir names) ----
$kept = New-Object System.Collections.Generic.List[string]
$dropped = New-Object System.Collections.Generic.List[string]
foreach ($entry in ($env:PATH -split ';')) {
  $e = $entry.Trim().Trim('"')
  if (-not $e) { continue }
  $hasNode = $false
  try { $hasNode = Test-Path -LiteralPath (Join-Path $e 'node.exe') -ErrorAction SilentlyContinue } catch { $hasNode = $false }
  $looksLikeNode = ((Split-Path -Leaf $e) -match '^(node|nodejs|node-v[\d.]+.*|nvm)$')
  if ($hasNode -or $looksLikeNode) { $dropped.Add($e); continue }
  $kept.Add($e)
}
if ($kept.Count -eq 0) {
  # A PATH with nothing on it would break PowerShell helpers the sidecar may start (SAPI). System32 is enough.
  $kept.Add((Join-Path $env:SystemRoot 'System32'))
}
$env:PATH = ($kept -join ';')
# Dev seams are not part of a packaged launch; remove them so nothing below can point at another runtime.
Remove-Item Env:ZUMI_NODE, Env:ZUMI_SIDECAR, Env:ZUMI_BUNDLE_NODE, Env:NODE_PATH, Env:NODE_OPTIONS -ErrorAction SilentlyContinue

Write-Host "[probe] PATH scrubbed: $($kept.Count) entries kept, $($dropped.Count) node dirs dropped"
if ($dropped.Count -gt 0) { Write-Host "        dropped: $($dropped -join '; ')" }

$stillNode = @($kept | Where-Object {
  try { Test-Path -LiteralPath (Join-Path $_ 'node.exe') -ErrorAction SilentlyContinue } catch { $false }
})
if ($stillNode.Count -gt 0) {
  Write-Host "REFUSED: PATH still holds node.exe: $($stillNode -join '; '). Nothing was launched."
  exit 1
}
$whereOut = $null
$whereRc = $null
try {
  # Windows PowerShell 5.1 turns redirected native stderr into an error record under EAP=Stop; a miss is expected here.
  $ErrorActionPreference = 'Continue'
  $whereOut = (& where.exe node 2>&1 | Out-String).Trim()
  $whereRc = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
}
if ($whereRc -eq 0) {
  Write-Host "REFUSED: 'where node' still resolves on the scrubbed PATH: $whereOut. Nothing was launched."
  exit 1
}
Write-Host "[probe] 'where node' finds nothing (scrub verified)"

# ---- run the headless driver with the test runtime ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dataDir = Join-Path $repo (Join-Path '.tauri-check-tmp' "packaged-probe-$stamp")
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "[probe] test node: $nodeExe"
$seedArgs = @(); if ($Seed) { $seedArgs = @('--seed', $Seed) }
& $nodeExe $driver --bundle $bundleDir --node $nodeExe --data-dir $dataDir @seedArgs
$rc = $LASTEXITCODE

if (-not $KeepDataDir) { Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
Write-Host "[probe] rc=$rc"
exit $rc
