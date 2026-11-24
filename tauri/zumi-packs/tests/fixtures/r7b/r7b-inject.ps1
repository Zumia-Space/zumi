# R7b re-gate: an OUTSIDE same-user process (no job) tries to answer the consent window with synthetic input and UI Automation.
# It injects ONLY while the input desktop is not one it can open (the private consent desktop is up), so nothing reaches the person's desktop.
param([string]$title, [string]$out, [switch]$inject)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class J {
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public KI k; [FieldOffset(0)] public MI m; }
  [StructLayout(LayoutKind.Sequential)] public struct IN { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint f, bool inh, uint a);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr d);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetUserObjectInformationW(IntPtr h, int i, System.Text.StringBuilder b, int n, out int need);
  public static string InputDesktop() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return "<cannot open: err " + Marshal.GetLastWin32Error() + ">";
    var sb = new System.Text.StringBuilder(256); int need;
    GetUserObjectInformationW(d, 2, sb, 512, out need); CloseDesktop(d); return sb.ToString();
  }
  static IN Key(ushort vk, bool up) { var i = new IN(); i.type = 1; i.u.k.vk = vk; i.u.k.flags = up ? 2u : 0u; return i; }
  static IN Mouse(uint f, int x, int y) { var i = new IN(); i.type = 0; i.u.m.dx = x; i.u.m.dy = y; i.u.m.flags = f; return i; }
  public static string Press() {
    int size = Marshal.SizeOf(typeof(IN));
    var keys = new IN[] { Key(0x59, false), Key(0x59, true), Key(0x12, false), Key(0x59, false), Key(0x59, true), Key(0x12, true) };
    uint a = SendInput((uint)keys.Length, keys, size); int ea = Marshal.GetLastWin32Error();
    var clicks = new IN[] { Mouse(0x8001, 27000, 36000), Mouse(0x0002, 0, 0), Mouse(0x0004, 0, 0), Mouse(0x8001, 32768, 36000), Mouse(0x0002, 0, 0), Mouse(0x0004, 0, 0) };
    uint b = SendInput((uint)clicks.Length, clicks, size); int eb = Marshal.GetLastWin32Error();
    return "keys sent=" + a + " err=" + ea + "; clicks sent=" + b + " err=" + eb;
  }
}
"@
$lines = @()
$lines += "input desktop before: " + [J]::InputDesktop()
try {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $title)
  $found = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $lines += "uia windows named like the consent: $($found.Count)"
} catch { $lines += "uia error $_" }
if ($inject) {
  $d = [J]::InputDesktop()
  if ($d.StartsWith('<cannot open')) { $lines += "inject (input desktop is private): " + [J]::Press() } else { $lines += "NOT injecting: input desktop is '$d' (the person's desktop)" }
}
$lines += 'done'
Set-Content -Path $out -Value $lines -Encoding UTF8
