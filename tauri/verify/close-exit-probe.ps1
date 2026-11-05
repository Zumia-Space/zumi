# Launch a Zumi build on a private, non-interactive Windows desktop so nothing appears on the owner's screen.
# Opens the board guest over CDP, posts WM_CLOSE to the app's visible top-level windows, and measures the process tree.
# Only ever closes the PID it started.
param([string]$Exe,[string]$Data=(Join-Path $env:TEMP 'zumi-exit-probe-data'),[int]$Settle=25,[int]$Watch=60,[string]$Log='',[int]$Port=9377,[switch]$Guest,[ValidateSet('main','helper','both','mainThenHelper','minimized')][string]$Target='both')
$src = @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic; using System.Text;
public static class HD {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SI { public int cb; public string r; public string desk; public string title; public int x,y,w,h,cx,cy,attr,flags; public short show,r2; public IntPtr r3,i,o,e; }
 [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hP,hT; public int pid,tid; }
 [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktopW(string n,IntPtr d,IntPtr dm,int f,uint a,IntPtr s);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcessW(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inh,uint fl,IntPtr env,string cwd,ref SI si,out PI pi);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32")] public static extern bool EnumDesktopWindows(IntPtr d,EnumProc e,IntPtr l);
 [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h,out int pid);
 [DllImport("user32")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 public struct RECT { public int l,t,r,b; }
 public static string Desc(long v){ var h=new IntPtr(v); var c=new StringBuilder(128); var t=new StringBuilder(128); GetClassNameW(h,c,128); GetWindowTextW(h,t,128); RECT r; GetWindowRect(h,out r); return v+" class="+c+" title="+t+" size="+(r.r-r.l)+"x"+(r.b-r.t); }
 [DllImport("user32")] public static extern bool PostMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static List<long> Windows(IntPtr d,int pid,bool visibleOnly){ var r=new List<long>(); EnumDesktopWindows(d,(h,l)=>{int p; GetWindowThreadProcessId(h,out p); if(p==pid&&(!visibleOnly||IsWindowVisible(h))) r.Add(h.ToInt64()); return true;},IntPtr.Zero); return r; }
}
'@
Add-Type -TypeDefinition $src
$lines = New-Object System.Collections.ArrayList
function say($s){ [void]$lines.Add($s); Write-Output $s }
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$deskName = "zumi-probe-$PID"
$desk = [HD]::CreateDesktopW($deskName,[IntPtr]::Zero,[IntPtr]::Zero,0,0x10000000,[IntPtr]::Zero)
if($desk -eq [IntPtr]::Zero){ throw "CreateDesktop failed" }
if($Guest){ $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port" }
$si = New-Object HD+SI; $si.cb=[Runtime.InteropServices.Marshal]::SizeOf($si); $si.desk=$deskName
$pi0 = New-Object HD+PI
$cmd = New-Object Text.StringBuilder("`"$Exe`" --data-dir $Data")
if(-not [HD]::CreateProcessW($Exe,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$false,0,[IntPtr]::Zero,(Split-Path $Exe),[ref]$si,[ref]$pi0)){ throw "CreateProcess failed" }
$procId=$pi0.pid; $p=Get-Process -Id $procId
say "pid=$procId desktop=$deskName exe=$Exe sha=$((Get-FileHash $Exe -Algorithm SHA256).Hash.Substring(0,16)) guest=$Guest"
try {
Start-Sleep -Seconds $Settle
if($Guest){ say (node $PSScriptRoot/close-exit-open-guest.mjs $Port | Out-String) }
function kids($id){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | Select-Object ProcessId,Name }
$k = kids $procId
say ("children: " + (($k | ForEach-Object { "$($_.Name):$($_.ProcessId)" }) -join ' '))
$nodeId = ($k | Where-Object Name -eq 'node.exe' | Select-Object -First 1).ProcessId
$w=[HD]::Windows($desk,$procId,$true); foreach($h in $w){ say ("window " + [HD]::Desc($h)) }
$mainW = @($w | Where-Object { [HD]::Desc($_) -match 'title=Zumi' }); $helperW = @($w | Where-Object { [HD]::Desc($_) -notmatch 'title=Zumi' })
$post = switch($Target){ 'main' {$mainW} 'helper' {$helperW} 'minimized' {@()} default {$mainW + $helperW} }
foreach($h in $post){ [void][HD]::PostMessageW([IntPtr]$h,0x10,[IntPtr]::Zero,[IntPtr]::Zero) }
say "WM_CLOSE posted to target=$Target ($($post.Count) windows)"
if($Target -eq 'minimized'){
  [void][HD]::ShowWindow([IntPtr]($mainW[0]),6); Start-Sleep -Seconds 2
  $w2=[HD]::Windows($desk,$procId,$true); say ("z-order after minimise (what MainWindowHandle takes first): " + (($w2 | ForEach-Object { [HD]::Desc($_) }) -join ' || '))
  for($n=1;$n -le 2;$n++){ $w3=[HD]::Windows($desk,$procId,$true); if($w3.Count){ say ("close call $n -> " + [HD]::Desc($w3[0])); [void][HD]::PostMessageW([IntPtr]$w3[0],0x10,[IntPtr]::Zero,[IntPtr]::Zero); Start-Sleep -Seconds 3 } }
}
$exitAt=$null
for($i=0;$i -lt $Watch;$i++){
  Start-Sleep -Seconds 1
  $p.Refresh(); $alive=-not $p.HasExited
  $nodeAlive = if($nodeId){ [bool](Get-Process -Id $nodeId -ErrorAction SilentlyContinue) } else {$false}
  $vis = if($alive){ [HD]::Windows($desk,$procId,$true).Count } else {0}
  if($i -lt 6 -or $i % 10 -eq 0 -or -not $alive){ say ("t+{0,3}s exe={1} visibleWindows={2} node={3} webviewChildren={4}" -f ($i+1),$alive,$vis,$nodeAlive,(kids $procId | Where-Object Name -eq 'msedgewebview2.exe' | Measure-Object).Count) }
  if(-not $alive -and -not $nodeAlive){ $exitAt=$i+1; break }
}
if($exitAt){ say "RESULT exited ${exitAt}s after close, exit code $($p.ExitCode)" } else {
  say "RESULT STILL ALIVE after ${Watch}s"
  $p.Threads | Group-Object ThreadState,WaitReason | ForEach-Object { say ("threads {0} x{1}" -f $_.Name,$_.Count) }
}
} finally {
  $p.Refresh(); if(-not $p.HasExited){ say "stopping my own pid $procId"; Stop-Process -Id $procId -Force }
  if($Log){ $lines | Set-Content -Encoding UTF8 $Log }
}
