# Spare-PC-only input helper (OPUS Alt check). One command per call, prints ONE compact JSON line.
# Real input via SendInput (same path as a physical keyboard/mouse). Refuses unless ZUMI_ELECTRON_HOST=box.
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [int]$TargetPid = 0, [string]$ProcessName = '',
  [int]$X = 0, [int]$Y = 0, [int]$Vk = 0, [string]$Text = '', [string]$Out = '', [int]$HoldMs = 80, [int]$GapMs = 60
)
if ($env:ZUMI_ELECTRON_HOST -ne 'box') { Write-Host '{"ok":false,"reason":"REFUSED not box"}'; exit 1 }
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class IN {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] a, int size);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public static List<IntPtr> Tops(uint pid) { var r = new List<IntPtr>(); EnumWindows(delegate (IntPtr h, IntPtr l) { uint o; GetWindowThreadProcessId(h, out o); if (o == pid && IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<string> Menus() { var r = new List<string>(); EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsWindowVisible(h) && Cls(h) == "#32768") { uint o; GetWindowThreadProcessId(h, out o); RECT q; GetWindowRect(h, out q); r.Add(o + ":" + q.L + "," + q.T + "," + q.R + "," + q.B); } return true; }, IntPtr.Zero); return r; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Ttl(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  static INPUT K(ushort vk, bool up, bool ext) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0); i.u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u); return i; }
  public static void Key(ushort vk, bool up, bool ext) { var a = new INPUT[] { K(vk, up, ext) }; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
}
'@
function J($o) { ($o | ConvertTo-Json -Compress -Depth 5) }
function Fg() { $h = [IN]::GetForegroundWindow(); $p = [uint32]0; [void][IN]::GetWindowThreadProcessId($h, [ref]$p); @{ hwnd = [int64]$h; pid = $p; cls = [IN]::Cls($h); title = [IN]::Ttl($h) } }
function MainWin([int]$p) { $best = [IntPtr]::Zero; $ba = 0; foreach ($h in [IN]::Tops([uint32]$p)) { $r = New-Object IN+RECT; [void][IN]::GetWindowRect($h, [ref]$r); $a = ($r.R - $r.L) * ($r.B - $r.T); if ($a -gt $ba -and ($r.R - $r.L) -ge 200) { $ba = $a; $best = $h } }; $best }
$VK_MENU = 0x12; $VK_TAB = 0x09; $VK_ESCAPE = 0x1B

switch ($Cmd) {
  'fg' { J (Fg) }
  'rect' { $h = MainWin $TargetPid; if ($h -eq [IntPtr]::Zero) { J @{ ok = $false; reason = 'no window' } } else { $r = New-Object IN+RECT; [void][IN]::GetWindowRect($h, [ref]$r); J @{ ok = $true; hwnd = [int64]$h; cls = [IN]::Cls($h); L = $r.L; T = $r.T; R = $r.R; B = $r.B } } }
  'place' { $h = MainWin $TargetPid; [void][IN]::ShowWindow($h, 1); [void][IN]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 1000, 700, 0x0040); J @{ ok = $true } }
  'click' { [void][IN]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 80; [IN]::Mouse(0x0002); Start-Sleep -Milliseconds 60; [IN]::Mouse(0x0004); Start-Sleep -Milliseconds 120; J (Fg) }
  'alt-tap' { [IN]::Key($VK_MENU, $false, $false); Start-Sleep -Milliseconds $HoldMs; [IN]::Key($VK_MENU, $true, $false); J @{ ok = $true } }
  'alt-key' { [IN]::Key($VK_MENU, $false, $false); Start-Sleep -Milliseconds 120; [IN]::Key([uint16]$Vk, $false, $false); Start-Sleep -Milliseconds 80; [IN]::Key([uint16]$Vk, $true, $false); Start-Sleep -Milliseconds 120; [IN]::Key($VK_MENU, $true, $false); J @{ ok = $true } }
  'menus' { J @{ ok = $true; menus = @([IN]::Menus()) } }
  'esc' { [IN]::Key($VK_ESCAPE, $false, $false); Start-Sleep -Milliseconds 50; [IN]::Key($VK_ESCAPE, $true, $false); J @{ ok = $true } }
  'alt-tab' { [IN]::Key($VK_MENU, $false, $false); Start-Sleep -Milliseconds 120; [IN]::Key($VK_TAB, $false, $false); Start-Sleep -Milliseconds 60; [IN]::Key($VK_TAB, $true, $false); Start-Sleep -Milliseconds 400; [IN]::Key($VK_MENU, $true, $false); Start-Sleep -Milliseconds 700; J (Fg) }
  'type' {
    foreach ($c in $Text.ToCharArray()) {
      $s = [IN]::VkKeyScan($c); $vk = [uint16]($s -band 0xFF); $shift = (($s -shr 8) -band 1) -eq 1
      if ($shift) { [IN]::Key(0x10, $false, $false) }
      [IN]::Key($vk, $false, $false); Start-Sleep -Milliseconds 25; [IN]::Key($vk, $true, $false)
      if ($shift) { [IN]::Key(0x10, $true, $false) }
      Start-Sleep -Milliseconds $GapMs
    }
    J @{ ok = $true; typed = $Text.Length }
  }
  'shot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $g.Dispose()
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); J @{ ok = $true; out = $Out; w = $b.Width; h = $b.Height }
  }
  'burst' {
    # N screen grabs every GapMs; md5 of the stage region and of the composer-input region, so a stalled renderer shows as identical hashes.
    $md5 = [System.Security.Cryptography.MD5]::Create(); $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $res = @()
    $regs = @{ stage = @(190, 120, 900, 540); input = @(210, 680, 860, 36) }
    $t0 = Get-Date
    for ($i = 0; $i -lt $X; $i++) {
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $g.Dispose()
      $row = @{ t = [int]((Get-Date) - $t0).TotalMilliseconds }
      foreach ($k in $regs.Keys) { $r = $regs[$k]; $rect = New-Object System.Drawing.Rectangle $r[0], $r[1], $r[2], $r[3]; $c = $bmp.Clone($rect, $bmp.PixelFormat); $ms = New-Object IO.MemoryStream; $c.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $row[$k] = ([BitConverter]::ToString($md5.ComputeHash($ms.ToArray())).Replace('-', '').Substring(0, 8)); $c.Dispose(); $ms.Dispose() }
      $bmp.Dispose(); $res += $row
      Start-Sleep -Milliseconds $GapMs
    }
    J @{ ok = $true; frames = $res }
  }
  default { J @{ ok = $false; reason = "unknown cmd $Cmd" } }
}
