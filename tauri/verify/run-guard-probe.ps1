# T-31 P1c1 spare-PC guard-probe runner (OPUS runs this on the spare PC; never on the main PC).
#
# Refuses unless ZUMI_ELECTRON_HOST=box (the render box; same rule as scripts/lib/electron-guard.cjs),
# before it starts anything. On the box's shell, set ZUMI_ELECTRON_HOST=box first; the probe server and
# the preview exe inherit it.
#
# Sets PROCESS-SCOPED env only, starts the preview exe with its output redirected, runs the CDP driver,
# stops the exe by PID, then fails if any node.exe / msedgewebview2.exe survives that belongs to this
# tree or to space.zumia.preview.
#
# It changes no OS setting, no registry key, no firewall rule and no scheduled task.
#
# P1c4: also starts tauri\verify\win-helper.ps1 in `watch` mode BEFORE the exe (so the first moment the main
# window becomes visible is observed, not guessed) and hands the helper to the driver, which runs the main
# webview phase and, last, closes the app with WM_CLOSE and measures the exit.
#
#   powershell -ExecutionPolicy Bypass -File tauri\verify\run-guard-probe.ps1 `
#     -Tree <box-dir>\tree `
#     -Exe  <box-dir>\ZumiPreview.exe `
#     -Out  <box-dir>\out

param(
  [Parameter(Mandatory = $true)][string]$Tree,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$ProbePort = 47931
)

# Host check BEFORE Start-Process and before any listener: this kit starts the preview build and a
# non-loopback listener, so it must refuse off the render box (same rule as scripts/lib/electron-guard.cjs).
if ($env:ZUMI_ELECTRON_HOST -ne 'box') {
  Write-Host "REFUSED: run-guard-probe.ps1 starts the preview build and a non-loopback listener, which run only on the render box (ZUMI_ELECTRON_HOST=box). Nothing was launched."
  exit 1
}

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$env:ZUMI_SIDECAR = Join-Path $Tree 'tauri\sidecar\main.mjs'
# T-31 alpha.12: no wardrobe guest since alpha.11, so the runner starts the probe server itself and names its origin; the
# sidecar admits that one origin on the board partition only on the render box (tauri/sidecar/main.mjs guardProbeOriginOf).
$env:ZUMI_GUARD_PROBE_ORIGIN = "http://127.0.0.1:$ProbePort"
$env:PORT = "$ProbePort"
$probeServer = Start-Process -FilePath 'node' -WindowStyle Hidden -PassThru -ArgumentList @((Join-Path $Tree 'tauri\verify\guard-probe\server\server.mjs'))
Remove-Item Env:PORT
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'

$stdout = Join-Path $Out 'stdout.log'
$stderr = Join-Path $Out 'stderr.log'
$helper = Join-Path $Tree 'tauri\verify\win-helper.ps1'
$watchOut = Join-Path $Out 'watch.json'
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)

# A leftover instance would make the watcher attach to the wrong process and the CDP port clash.
if (Get-Process -Name $exeName -ErrorAction SilentlyContinue) {
  Write-Host "REFUSED: a $exeName process is already running; stop it first. Nothing was launched."
  exit 1
}
Remove-Item -Force -ErrorAction SilentlyContinue $watchOut, "$watchOut.ready", $stderr, $stdout

# Start the watcher first and wait until it is polling, so the app cannot show its window unobserved.
$watcher = Start-Process -FilePath 'powershell' -WindowStyle Hidden -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper, '-Cmd', 'watch',
  '-ProcessName', $exeName, '-StderrPath', $stderr, '-Out', $watchOut, '-TimeoutSec', '120')
$readyBy = (Get-Date).AddSeconds(30)
while (-not (Test-Path "$watchOut.ready") -and (Get-Date) -lt $readyBy) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path "$watchOut.ready")) {
  Write-Host "[run] INSTRUMENT_INVALID: the window watcher never started polling. Nothing was launched."
  if ($watcher -and -not $watcher.HasExited) { Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}

Write-Host "[run] starting $Exe"
$proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Seconds 8  # boot + sidecar handshake before the driver attaches

try {
  $driver = Join-Path $Tree 'tauri\verify\drive-guard-probe.mjs'
  node $driver --cdp 9333 --out $Out --stderr $stderr --pid $proc.Id --helper $helper --watch $watchOut
  $driverExit = $LASTEXITCODE
} finally {
  if ($watcher -and -not $watcher.HasExited) {
    Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue
  }
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  if ($probeServer -and -not $probeServer.HasExited) {
    Stop-Process -Id $probeServer.Id -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Seconds 5

# Orphans: any node.exe / msedgewebview2.exe whose command line still names this tree or the app id.
$orphans = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -or $_.Name -eq 'msedgewebview2.exe') -and $_.CommandLine -and
  ($_.CommandLine -like "*$Tree*" -or $_.CommandLine -like '*space.zumia.preview*')
}
if ($orphans) {
  Write-Host "[run] ORPHANS (FAIL):"
  $orphans | ForEach-Object { Write-Host ("  pid={0} name={1}" -f $_.ProcessId, $_.Name) }
  exit 1
}

Write-Host "[run] no orphans"
if ($driverExit -ne 0) { exit $driverExit }
Write-Host "[run] driver: PASS"
