# Drives the top-level windows of one process by script (Win32 only, no input events): the board-visibility probe uses it to
# minimise, restore, move off/on screen and cover the app's window with a topmost occluder, without a GUI click.
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-drive.ps1 -ProcessId <pid> -Action <minimize|restore|offscreen|onscreen|front|topmost|rect>
#   ... -Action tree: every child window under the main window (class, visible, owning process image, size), the native view of each
#     webview: wry's WRY_WEBVIEW container and the WebView2 browser HWND inside it, which WebView2 hides when the controller's IsVisible is false
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-drive.ps1 -Action occlude [-Seconds <n>]   (a topmost borderless form over
#     the whole virtual screen; prints "occluding" once shown and stays until killed or -Seconds pass)
# Only the process's VISIBLE top-level windows with a title are touched (the app's main window); the result is printed as one JSON line.
param([int]$ProcessId = 0, [Parameter(Mandatory)][string]$Action, [int]$Seconds = 600)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class WinDrive {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  // One line per descendant: depth (by parent chain), class, visible, owning pid, width x height.
  public static List<string> Tree(IntPtr top) {
    var list = new List<string>();
    EnumChildWindows(top, (h, p) => {
      int depth = 0; for (IntPtr q = GetParent(h); q != IntPtr.Zero && q != top && depth < 16; q = GetParent(q)) depth++;
      var c = new StringBuilder(128); GetClassName(h, c, 128); uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
      list.Add(depth + "|" + c + "|" + (IsWindowVisible(h) ? "visible" : "hidden") + "|" + pid + "|" + (r.R - r.L) + "x" + (r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return list;
  }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
  // WM_SYSCOMMAND SC_MONITORPOWER to every top-level window: 2 = display off, -1 = display on (what the power manager does on idle/input).
  public static bool MonitorPower(int state) { return PostMessage(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(state)); }
  public static List<IntPtr> Windows(uint want) {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want) return true;
      var b = new StringBuilder(256); GetWindowText(h, b, 256);
      if (b.Length > 0 && (IsWindowVisible(h) || IsIconic(h))) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
if ($Action -eq 'occlude') {
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'None'; $form.TopMost = $true; $form.ShowInTaskbar = $false; $form.StartPosition = 'Manual'
  $form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $form.Bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.Width, $vs.Height)
  $form.Add_Shown({ [Console]::Out.WriteLine('occluding'); [Console]::Out.Flush() })
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = $Seconds * 1000; $timer.Add_Tick({ $form.Close() }); $timer.Start()
  [System.Windows.Forms.Application]::Run($form)
  exit 0
}
if ($Action -eq 'displayoff') { ConvertTo-Json -Compress -InputObject @{ action = $Action; posted = [WinDrive]::MonitorPower(2) }; exit 0 }
if ($Action -eq 'displayon') {
  $posted = [WinDrive]::MonitorPower(-1)
  [void][WinDrive]::SetThreadExecutionState(0x00000002 -bor 0x00000001)   # ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED, one-shot (no ES_CONTINUOUS)
  ConvertTo-Json -Compress -InputObject @{ action = $Action; posted = $posted }; exit 0
}
if ($ProcessId -le 0) { throw '-ProcessId is required for this action' }
$wins = [WinDrive]::Windows([uint32]$ProcessId)
$out = @()
foreach ($h in $wins) {
  switch ($Action) {
    'minimize'  { [void][WinDrive]::ShowWindow($h, 6) }   # SW_MINIMIZE
    'restore'   { [void][WinDrive]::ShowWindow($h, 9) }   # SW_RESTORE
    'offscreen' { [void][WinDrive]::SetWindowPos($h, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) }
    'onscreen'  { [void][WinDrive]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, 1280, 800, 0x0004 -bor 0x0010) }
    'front'     { [void][WinDrive]::ShowWindow($h, 9); [void][WinDrive]::SetForegroundWindow($h) }
    'topmost'   { [void][WinDrive]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) }   # HWND_TOPMOST, NOSIZE|NOMOVE|NOACTIVATE
    'rect'      { }
    'tree'      { }
    default     { throw "unknown action $Action" }
  }
  $r = New-Object WinDrive+RECT; [void][WinDrive]::GetWindowRect($h, [ref]$r)
  $row = @{ hwnd = $h.ToInt64(); visible = [WinDrive]::IsWindowVisible($h); iconic = [WinDrive]::IsIconic($h); rect = @($r.L, $r.T, $r.R, $r.B) }
  if ($Action -eq 'tree') { $row.tree = @([WinDrive]::Tree($h)) }
  $out += $row
}
ConvertTo-Json -Compress -InputObject @{ action = $Action; windows = $out } -Depth 4
