# T-31 parity step 4 spare-PC dialog driver (used by probe-step4.mjs; never run on the main PC).
#
# Finds the preview app's common file dialog by its title and either waits for it, types a path + Enter into it,
# or dismisses it with Esc. Refuses unless ZUMI_ELECTRON_HOST=box (the render box), like win-helper.ps1. It changes
# no OS setting; it only sends keystrokes to the dialog window it just brought to the foreground.
#
#   -Action wait    poll up to 15 s for a visible top-level window titled -Title owned by -TargetPid
#   -Action type    wait, foreground it, SendKeys "<-Text>{ENTER}" (the dialog's File name box has focus on open)
#   -Action cancel  wait, foreground it, SendKeys "{ESC}"
# Prints ONE compact JSON line: {"ok":true|false,"why":"..."}.
param(
  [Parameter(Mandatory = $true)][ValidateSet('wait', 'type', 'cancel')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Text = '',
  [int]$TargetPid = 0
)
if ($env:ZUMI_ELECTRON_HOST -ne 'box') {
  Write-Host '{"ok":false,"why":"REFUSED: dialog-pick.ps1 sends keystrokes; it runs only on the render box (ZUMI_ELECTRON_HOST=box)"}'
  exit 1
}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class DlgWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
function Find-Dialog {
  $script:found = [IntPtr]::Zero
  $cb = [DlgWin+EnumProc]{ param($h, $l)
    if ([DlgWin]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][DlgWin]::GetWindowText($h, $sb, 256)
      if ($sb.ToString() -eq $Title) {
        $owner = 0
        [void][DlgWin]::GetWindowThreadProcessId($h, [ref]$owner)
        if ($TargetPid -eq 0 -or $owner -eq $TargetPid) { $script:found = $h; return $false }
      }
    }
    return $true
  }
  [void][DlgWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}
$deadline = (Get-Date).AddSeconds(15)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $h = Find-Dialog
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"why":"dialog not seen within 15 s"}'; exit 0 }
if ($Action -eq 'wait') { Write-Output '{"ok":true,"why":"seen"}'; exit 0 }
[void][DlgWin]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
if ($Action -eq 'cancel') {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
} else {
  $escaped = [regex]::Replace($Text, '([+^%~(){}\[\]])', '{$1}')
  [System.Windows.Forms.SendKeys]::SendWait($escaped + '{ENTER}')
}
Write-Output '{"ok":true,"why":"sent"}'
