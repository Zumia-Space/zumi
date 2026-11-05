# T-31 P1c4 spare-PC window helper (OPUS runs this on the spare PC through run-guard-probe.ps1 and
# drive-guard-probe.mjs; never on the main PC).
#
# One command per call; prints ONE compact JSON line on stdout. It needs user32 (Add-Type), moves the
# foreground, clicks and posts WM_CLOSE, so like the probe runner it refuses unless ZUMI_ELECTRON_HOST=box.
# It changes no OS setting, no registry key, no firewall rule and no scheduled task, and it never prints
# a URL or a window title.
#
# v2 (probe-p1c4 fix round): "the app's main window" is the process's top-level window of class `Tauri Window`,
# or else the largest one; tao's `Tao Thread Event Target` (16x16, WS_VISIBLE, layered/transparent/toolwindow,
# visible ~120 ms after launch) is never a candidate. Every action asserts the chosen window is at least
# 200x200 (normal-placement size, so a minimised window is measured too) and answers ok=false
# reason=no_window_ge_200x200 instead of acting on the wrong window.
#
#   -Cmd watch       poll from BEFORE the app starts: first visible MAIN window of the app process (>= 200x200),
#                    and the times the stderr lines `guard: main source-kinds=all` / `window: main shown` appear.
#                    `anyVisibleMs` (any visible top-level window, tao's included) is reported for diagnosis only.
#                    Writes -Out (json) when all three are seen or after -TimeoutSec. Writes "<Out>.ready"
#                    once it is polling, so the runner starts the app only after that.
#   -Cmd top-count   number of visible top-level windows of -TargetPid
#   -Cmd minimize    ShowWindow(SW_MINIMIZE) on the app's main window
#   -Cmd restore     ShowWindow(SW_RESTORE) + SetForegroundWindow
#   -Cmd focus-away  show a TopMost helper-owned form, hold it foreground for -HoldMs (reports whether it got there)
#   -Cmd focus-zumi  SetForegroundWindow on the app's main window (reports whether it got there)
#   -Cmd click       left click at client pixel (-X,-Y) of the app's main window
#   -Cmd close       PostMessage(WM_CLOSE) and wait up to -TimeoutSec for the process to exit
#
# A step that could not move the foreground reports ok=false; the driver records it INCONCLUSIVE, not FAIL.

param(
  [Parameter(Mandatory = $true)][ValidateSet('watch', 'top-count', 'minimize', 'restore', 'focus-away', 'focus-zumi', 'click', 'close')][string]$Cmd,
  [int]$TargetPid = 0,
  [string]$ProcessName = '',
  [string]$StderrPath = '',
  [string]$Out = '',
  [int]$TimeoutSec = 90,
  [int]$HoldMs = 1500,
  [int]$X = 0,
  [int]$Y = 0
)

if ($env:ZUMI_ELECTRON_HOST -ne 'box') {
  Write-Host "REFUSED: win-helper.ps1 moves windows and the foreground, which runs only on the render box (ZUMI_ELECTRON_HOST=box). Nothing was done."
  exit 1
}

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ZW {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition; }
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public const string MainClass = "Tauri Window";
  public const int MinSide = 200;

  // Top-level windows owned by a process (WebView2 child windows are children, not top-level).
  public static List<IntPtr> TopLevel(uint pid, bool visibleOnly) {
    var found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && (!visibleOnly || IsWindowVisible(h))) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static List<IntPtr> VisibleTopLevel(uint pid) { return TopLevel(pid, true); }

  public static string ClassOf(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  // Normal-placement size: the real size even while minimised (GetWindowRect reports a ~160x28 icon then).
  public static long Area(IntPtr h) {
    var wp = new WINDOWPLACEMENT();
    wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    if (!GetWindowPlacement(h, ref wp)) return 0;
    long w = wp.rcNormalPosition.Right - wp.rcNormalPosition.Left, hgt = wp.rcNormalPosition.Bottom - wp.rcNormalPosition.Top;
    return (w >= MinSide && hgt >= MinSide) ? w * hgt : 0;
  }

  // The app's main window: class "Tauri Window" if present, else the largest window; zero if none is >= 200x200.
  public static IntPtr MainWindow(uint pid, bool visibleOnly) {
    IntPtr best = IntPtr.Zero; long bestArea = 0; bool bestIsClass = false;
    foreach (var h in TopLevel(pid, visibleOnly)) {
      long a = Area(h);
      if (a == 0) continue;
      bool isClass = ClassOf(h) == MainClass;
      if ((isClass && !bestIsClass) || (isClass == bestIsClass && a > bestArea)) { best = h; bestArea = a; bestIsClass = isClass; }
    }
    return best;
  }

  public static uint ForegroundPid() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }

  // Windows refuses SetForegroundWindow from a background process unless a key event just went through;
  // a bare ALT press/release is the standard, side-effect-free way to lift that lock.
  public static bool Foreground(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    bool ok = SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return ok;
  }
}
'@

function Write-Json($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

# The main window (never tao's 16x16 event target). Zero when no window of the process is >= 200x200.
function Get-MainWindow([int]$ProcessId) { return [ZW]::MainWindow([uint32]$ProcessId, $false) }

switch ($Cmd) {
  'watch' {
    if (-not $Out -or -not $ProcessName -or -not $StderrPath) { throw 'watch needs -Out, -ProcessName and -StderrPath' }
    $pollMs = 20
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $r = [ordered]@{ pollMs = $pollMs; processId = $null; processSeenMs = $null; firstVisibleMs = $null; anyVisibleMs = $null; guardSeenMs = $null; shownSeenMs = $null; timedOut = $false }
    Set-Content -Path "$Out.ready" -Value 'ready' -Encoding ASCII
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSec) {
      if ($null -eq $r.processId) {
        $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) { $r.processId = $p.Id; $r.processSeenMs = $clock.ElapsedMilliseconds }
      }
      if ($null -ne $r.processId -and $null -eq $r.anyVisibleMs) {
        if (([ZW]::VisibleTopLevel([uint32]$r.processId)).Count -gt 0) { $r.anyVisibleMs = $clock.ElapsedMilliseconds }
      }
      if ($null -ne $r.processId -and $null -eq $r.firstVisibleMs) {
        if ([ZW]::MainWindow([uint32]$r.processId, $true) -ne [IntPtr]::Zero) { $r.firstVisibleMs = $clock.ElapsedMilliseconds }
      }
      if (($null -eq $r.guardSeenMs -or $null -eq $r.shownSeenMs) -and (Test-Path $StderrPath)) {
        try {
          $stream = [System.IO.File]::Open($StderrPath, 'Open', 'Read', 'ReadWrite')
          try { $text = (New-Object System.IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
          if ($null -eq $r.guardSeenMs -and $text.Contains('guard: main source-kinds=all')) { $r.guardSeenMs = $clock.ElapsedMilliseconds }
          if ($null -eq $r.shownSeenMs -and $text.Contains('window: main shown')) { $r.shownSeenMs = $clock.ElapsedMilliseconds }
        } catch { <# the app still holds the file: read it on the next poll #> }
      }
      if ($null -ne $r.firstVisibleMs -and $null -ne $r.guardSeenMs -and $null -ne $r.shownSeenMs) { break }
      Start-Sleep -Milliseconds $pollMs
    }
    if ($null -eq $r.firstVisibleMs -or $null -eq $r.guardSeenMs -or $null -eq $r.shownSeenMs) { $r.timedOut = $true }
    Set-Content -Path $Out -Value ($r | ConvertTo-Json -Compress) -Encoding UTF8
  }
  'top-count' {
    Write-Json @{ ok = $true; count = ([ZW]::VisibleTopLevel([uint32]$TargetPid)).Count; mainCount = @([ZW]::VisibleTopLevel([uint32]$TargetPid) | Where-Object { [ZW]::Area($_) -gt 0 }).Count }
  }
  'minimize' {
    $h = Get-MainWindow $TargetPid
    if ($h -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; reason = 'no_window_ge_200x200' }; break }
    [void][ZW]::ShowWindow($h, 6) # SW_MINIMIZE
    Start-Sleep -Milliseconds 300
    Write-Json @{ ok = [ZW]::IsIconic($h) }
  }
  'restore' {
    $h = Get-MainWindow $TargetPid
    if ($h -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; reason = 'no_window_ge_200x200' }; break }
    [void][ZW]::ShowWindow($h, 9) # SW_RESTORE
    [void][ZW]::Foreground($h)
    Start-Sleep -Milliseconds 300
    Write-Json @{ ok = (-not [ZW]::IsIconic($h)) }
  }
  'focus-away' {
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object System.Windows.Forms.Form
    $form.TopMost = $true
    $form.Width = 240
    $form.Height = 120
    $form.StartPosition = 'CenterScreen'
    $form.Text = 'zumi probe focus helper'
    $form.Show()
    [void][ZW]::Foreground($form.Handle)
    $until = [DateTime]::UtcNow.AddMilliseconds($HoldMs)
    while ([DateTime]::UtcNow -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
    $fg = [ZW]::ForegroundPid()
    $form.Close()
    $form.Dispose()
    Write-Json @{ ok = ($fg -eq [uint32]$PID); foregroundIsHelper = ($fg -eq [uint32]$PID) }
  }
  'focus-zumi' {
    $h = Get-MainWindow $TargetPid
    if ($h -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; reason = 'no_window_ge_200x200' }; break }
    [void][ZW]::Foreground($h)
    Start-Sleep -Milliseconds 400
    Write-Json @{ ok = ([ZW]::ForegroundPid() -eq [uint32]$TargetPid) }
  }
  'click' {
    $h = Get-MainWindow $TargetPid
    if ($h -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; reason = 'no_window_ge_200x200' }; break }
    $p = New-Object 'ZW+POINT'
    $p.X = $X
    $p.Y = $Y
    [void][ZW]::ClientToScreen($h, [ref]$p)
    [void][ZW]::SetCursorPos($p.X, $p.Y)
    [ZW]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) # LEFTDOWN
    [ZW]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) # LEFTUP
    Start-Sleep -Milliseconds 300
    Write-Json @{ ok = $true }
  }
  'close' {
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) { Write-Json @{ ok = $false; reason = 'no_process' }; break }
    $h = Get-MainWindow $TargetPid
    if ($h -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; reason = 'no_window_ge_200x200' }; break }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    [void][ZW]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
    $exited = $proc.WaitForExit($TimeoutSec * 1000)
    Write-Json @{ ok = $true; exited = $exited; ms = $clock.ElapsedMilliseconds }
  }
}
