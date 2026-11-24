# Grandchild: report own job, then run the worker's click probe against the host box.
param([string]$title, [string]$hwnd, [string]$out, [string]$jobout)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Q2 {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, byte[] info, int len, out int ret);
  public static string Job() { var ui = new byte[4]; int r; bool a = QueryInformationJobObject(IntPtr.Zero, 4, ui, 4, out r); return a ? "0x" + BitConverter.ToUInt32(ui, 0).ToString("x") : "err" + Marshal.GetLastWin32Error(); }
}
"@
Set-Content -Path $jobout -Value ("pid=$PID ppid=" + (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId + " uiRestrictions=" + [Q2]::Job()) -Encoding UTF8
& (Join-Path $PSScriptRoot 'click-probe.ps1') -title $title -hwnd $hwnd -out $out