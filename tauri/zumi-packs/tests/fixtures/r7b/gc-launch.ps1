# In-job launcher: starts gc-click.ps1 as a grandchild by Start-Process (ShellExecute) or by CreateProcess.
param([string]$mode, [string]$title, [string]$hwnd, [string]$out, [string]$jobout)
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$a = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\gc-click.ps1`" -title `"$title`" -hwnd $hwnd -out `"$out`" -jobout `"$jobout`""
if ($mode -eq 'shell') { Start-Process -Wait -WindowStyle Hidden -FilePath $ps -ArgumentList $a }
else { $si = New-Object Diagnostics.ProcessStartInfo $ps; $si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.Arguments = $a; $p = [Diagnostics.Process]::Start($si); $p.WaitForExit(60000) | Out-Null }