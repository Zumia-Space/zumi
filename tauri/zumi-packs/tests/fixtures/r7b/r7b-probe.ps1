# R7b re-gate probe (Opus reviewer, scratch only). Each step writes one line; never stops early.
param([string]$out, [string]$secret = '', [string]$medfile = '', [int]$port = 0, [string]$key = '', [int]$hostpid = 0, [string]$wmi = '', [string]$child = '', [string]$direct = '')
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Q {
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, byte[] info, int len, out int ret);
  public static string Job() {
    var ui = new byte[4]; int r; bool a = QueryInformationJobObject(IntPtr.Zero, 4, ui, 4, out r); int ea = Marshal.GetLastWin32Error();
    var ext = new byte[144]; bool b = QueryInformationJobObject(IntPtr.Zero, 9, ext, 144, out r); int eb = Marshal.GetLastWin32Error();
    return "innermost job: uiRestrictions=" + (a ? "0x" + BitConverter.ToUInt32(ui, 0).ToString("x") : "err" + ea) + " limitFlags=" + (b ? "0x" + BitConverter.ToUInt32(ext, 16).ToString("x") : "err" + eb);
  }
}
"@
$lines = @()
function Add-Line([string]$s) { $script:lines += $s }
try { $inJob = $false; [void][Q]::IsProcessInJob([Q]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob); Add-Line "pid=$PID inJob=$inJob; $([Q]::Job())" } catch { Add-Line "inJob error $_" }
try { $si = New-Object Diagnostics.ProcessStartInfo (Join-Path $env:SystemRoot 'System32\whoami.exe'); $si.Arguments = '/groups'; $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.CreateNoWindow = $true; $wp = [Diagnostics.Process]::Start($si); $txt = $wp.StandardOutput.ReadToEnd(); $wp.WaitForExit(); $lab = ($txt -split "`n" | Where-Object { $_ -match 'Mandatory Label' } | ForEach-Object { ($_.Trim() -split '\s{2,}')[0] }) -join ';'; Add-Line "integrity: $lab" } catch { Add-Line "integrity error $_" }
if ($secret) { try { $t = [IO.File]::ReadAllText($secret); Add-Line "read-outside-roots: OK '$t'" } catch { Add-Line "read-outside-roots: DENIED $($_.Exception.InnerException.Message)" } }
if ($medfile) { try { [IO.File]::WriteAllText($medfile, 'written-by-pack-process'); Add-Line "write-user-file: OK" } catch { Add-Line "write-user-file: DENIED $($_.Exception.InnerException.Message)" } }
if ($port -gt 0) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $s = $c.GetStream(); $b = [Text.Encoding]::ASCII.GetBytes('EXFIL-' + $PID); $s.Write($b, 0, $b.Length); $s.Flush(); $c.Close(); Add-Line "own-socket-connect: OK" } catch { Add-Line "own-socket-connect: DENIED $($_.Exception.InnerException.Message)" } }
if ($key) {
  try {
    Add-Type -AssemblyName System.Security
    $sealed = [IO.File]::ReadAllBytes($key)
    Add-Line "read-audit-key-file: OK $($sealed.Length) bytes"
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, [Text.Encoding]::ASCII.GetBytes('zumi-pack-audit-key/1'), 'CurrentUser')
    Add-Line ("unseal-audit-key: OK " + (($plain | ForEach-Object { $_.ToString('x2') }) -join ''))
  } catch { Add-Line "audit-key: DENIED $($_.Exception.Message)" }
}
# R7d: the open-host-process line was removed. It proved nothing ("Process with an Id of N is not running" at Low as well); gate_r7b_new.rs now asks the compiled attacker (`--open-process`).
if ($wmi) { try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $wmi } -ErrorAction Stop; Add-Line "wmi-create: ReturnValue=$($r.ReturnValue) pid=$($r.ProcessId)" } catch { Add-Line "wmi-create: DENIED $($_.Exception.Message)" } }
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($child) { try { $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-out', "`"$child`"") -PassThru -WindowStyle Hidden; Add-Line "grandchild (Start-Process, ShellExecute) pid=$($p.Id)"; $p.WaitForExit(30000) | Out-Null } catch { Add-Line "grandchild: FAILED $_" } }
if ($direct -eq 'stdout') { try { $si = New-Object Diagnostics.ProcessStartInfo $ps; $si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.RedirectStandardOutput = $true; $si.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -out stdout"; $p = [Diagnostics.Process]::Start($si); $gt = $p.StandardOutput.ReadToEnd(); $p.WaitForExit(30000) | Out-Null; foreach ($l in ($gt -split "`r?`n")) { if ($l) { Add-Line "  grandchild: $l" } } } catch { Add-Line "grandchild direct: FAILED $_" } }
elseif ($direct) { try { $si = New-Object Diagnostics.ProcessStartInfo $ps; $si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -out `"$direct`""; $p = [Diagnostics.Process]::Start($si); Add-Line "grandchild (CreateProcess) pid=$($p.Id)"; $p.WaitForExit(30000) | Out-Null } catch { Add-Line "grandchild direct: FAILED $_" } }
Add-Line 'done'
if ($out -eq 'stdout') { $lines | ForEach-Object { [Console]::Out.WriteLine($_) } } else { Set-Content -Path $out -Value $lines -Encoding UTF8 }