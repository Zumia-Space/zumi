# R7b M3 attacker (the gate's click.ps1, widened): try to answer a window titled $title with Yes.
#  1. FindWindow on this process's own desktop, then BM_CLICK on IDYES and a posted WM_COMMAND IDYES;
#  2. the same on the window handle $hwnd given on the command line (as if the attacker learned it), when it is not 0;
#  3. list the desktops of this window station; for each one that is not Default/Winlogon/Disconnect: OpenDesktop, and if that works,
#     a new thread SetThreadDesktop + FindWindow + BM_CLICK there.
# Writes one line per attempt to $out, then "done".
param([string]$title, [string]$hwnd, [string]$out)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic; using System.Threading;
public static class P {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindWindowW(string c, string t);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool IsWindow(IntPtr h);
  public delegate bool EnumDeskProc([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool EnumDesktopsW(IntPtr winsta, EnumDeskProc cb, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetThreadDesktop(IntPtr d);
  public static string Click(IntPtr h) {
    if (h == IntPtr.Zero) return "no-window";
    IntPtr yes = GetDlgItem(h, 6);
    int e1 = Marshal.GetLastWin32Error();
    SendMessageW(yes, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    int e2 = Marshal.GetLastWin32Error();
    bool posted = PostMessageW(h, 0x0111, (IntPtr)6, yes);
    int e3 = Marshal.GetLastWin32Error();
    return "window=" + h + " isWindow=" + IsWindow(h) + " yes=" + yes + " errDlg=" + e1 + " errSend=" + e2 + " posted=" + posted + " errPost=" + e3;
  }
  public static List<string> Desktops() {
    var l = new List<string>();
    bool ok = EnumDesktopsW(GetProcessWindowStation(), (n, x) => { l.Add(n); return true; }, IntPtr.Zero);
    if (!ok) l.Add("<enum failed " + Marshal.GetLastWin32Error() + ">");
    return l;
  }
  public static string OnDesktop(string name, string title) {
    IntPtr d = OpenDesktopW(name, 0, false, 0x01FF);
    if (d == IntPtr.Zero) return "open-denied err=" + Marshal.GetLastWin32Error();
    string r = "opened";
    var t = new Thread(() => {
      if (!SetThreadDesktop(d)) { r += " setThreadDesktop-failed err=" + Marshal.GetLastWin32Error(); return; }
      r += " " + Click(FindWindowW("#32770", title));
    });
    t.Start(); t.Join();
    return r;
  }
}
"@
$lines = @()
for ($i = 0; $i -lt 30; $i++) {
  $h = [P]::FindWindowW('#32770', $title)
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
$lines += "own-desktop: " + [P]::Click($h)
if ($hwnd -and $hwnd -ne '0') { $lines += "given-handle: " + [P]::Click([IntPtr][Int64]$hwnd) }
$names = [P]::Desktops()
$lines += "desktops: " + ($names -join ',')
foreach ($n in $names) {
  if ($n -in @('Default', 'Winlogon', 'Disconnect', 'Screen-saver')) { continue }
  $lines += "desktop ${n}: " + [P]::OnDesktop($n, $title)
}
$lines += 'done'
Set-Content -Path $out -Value $lines -Encoding UTF8
