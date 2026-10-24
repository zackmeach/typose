# Windows input to the window $hwnd at physical screen points ("x,y;x,y"). Run by e2e/win32.ts.
#   hittest:  sends WM_NCHITTEST for each point, the question Windows asks the window before every mouse event, and
#             prints the answers: HTCLIENT (1) is the page's, HTCAPTION (2) drags and double-click maximizes, and
#             HTMAXBUTTON (9) is what brings up Snap Layouts. Nothing moves.
#   dblclick-message: a double click at the first point as Windows delivers one to the window's frame: the hit test,
#             then WM_NCLBUTTONDBLCLK with its answer, queued as input is. The cursor doesn't move.
#   reach:    whether real input at the first point would reach this window, which must be the one under it
#             (WindowFromPoint). If not, says what is there instead: the lock screen, say.
#   drag:     real input: presses the left button at the first point, moves to the second and releases.
#   dblclick: real input: double-clicks the left button at the first point.
# Real input moves the cursor, so it's put back where it was.
param([string]$op, [long]$hwnd, [string]$points)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
[void][W]::SetThreadDpiAwarenessContext([IntPtr]-4) # per-monitor aware: points are physical pixels
$pts = @($points.Split(';') | ForEach-Object { $xy = $_.Split(','); , @([int]$xy[0], [int]$xy[1]) })
$lparam = { param($p) [IntPtr](($p[1] -band 0xFFFF) -shl 16 -bor ($p[0] -band 0xFFFF)) }
$hitTest = { param($p) [int][W]::SendMessageW([IntPtr]$hwnd, 0x84, [IntPtr]::Zero, (& $lparam $p)) } # WM_NCHITTEST
if ($op -eq 'hittest') {
  ConvertTo-Json -Compress -InputObject @($pts | ForEach-Object { & $hitTest $_ })
  exit
}
if ($op -eq 'dblclick-message') {
  [void][W]::PostMessageW([IntPtr]$hwnd, 0xA3, [IntPtr](& $hitTest $pts[0]), (& $lparam $pts[0])) # WM_NCLBUTTONDBLCLK
  '{}'
  exit
}
if ($op -eq 'reach') {
  $p = New-Object W+POINT
  $p.X = $pts[0][0]
  $p.Y = $pts[0][1]
  $under = [W]::GetAncestor([W]::WindowFromPoint($p), 2) # GA_ROOT
  $class = New-Object System.Text.StringBuilder 256
  [void][W]::GetClassNameW($under, $class, 256)
  $procId = 0
  [void][W]::GetWindowThreadProcessId($under, [ref]$procId)
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  ConvertTo-Json -Compress -InputObject ([ordered]@{ reached = ($under -eq [IntPtr]$hwnd); under = "$class ($name)" })
  exit
}
$DOWN = 2
$UP = 4
$was = New-Object W+POINT
[void][W]::GetCursorPos([ref]$was)
try {
  [void][W]::SetCursorPos($pts[0][0], $pts[0][1])
  Start-Sleep -Milliseconds 100
  if ($op -eq 'drag') {
    [W]::mouse_event($DOWN, 0, 0, 0, [UIntPtr]::Zero)
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) {
      Start-Sleep -Milliseconds 15
      [void][W]::SetCursorPos($pts[0][0] + ($pts[1][0] - $pts[0][0]) * $i / $steps, $pts[0][1] + ($pts[1][1] - $pts[0][1]) * $i / $steps)
    }
    Start-Sleep -Milliseconds 100
    [W]::mouse_event($UP, 0, 0, 0, [UIntPtr]::Zero)
  } elseif ($op -eq 'dblclick') {
    foreach ($i in 1, 2) {
      [W]::mouse_event($DOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [W]::mouse_event($UP, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
  } else { throw "unknown op $op" }
  Start-Sleep -Milliseconds 300
} finally {
  [void][W]::SetCursorPos($was.X, $was.Y)
}
'{}'
