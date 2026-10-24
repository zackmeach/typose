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
# Real input moves the real mouse (e2e/chrome.e2e.ts runs it only on CI, or with TYPOSE_REAL_INPUT=1). Before each
# press, in this process, the cursor must be at the point and the window under it must be this one; the move and the
# press then go in as one SendInput, so nothing comes between them. A press is always released, and the cursor is put
# back where it was.
param([string]$op, [long]$hwnd, [string]$points)
Add-Type @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  const uint MOVE = 0x1, DOWN = 0x2, UP = 0x4, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;

  // An absolute move is in 0..65535 across the virtual desktop (every monitor), rounded up so it maps back to (x, y).
  static INPUT Mouse(uint flags, int x, int y) {
    INPUT i = new INPUT();
    i.mi.dwFlags = flags;
    if ((flags & MOVE) != 0) {
      i.mi.dwFlags |= ABSOLUTE | VIRTUALDESK;
      i.mi.dx = (int)Math.Ceiling((x - GetSystemMetrics(76)) * 65536.0 / GetSystemMetrics(78));
      i.mi.dy = (int)Math.Ceiling((y - GetSystemMetrics(77)) * 65536.0 / GetSystemMetrics(79));
    }
    return i;
  }
  static void Send(params INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("SendInput took " + sent + " of " + inputs.Length + " inputs");
  }
  // Presses the left button at (x, y), only if the cursor is there and the window under it is hwnd.
  public static void Press(IntPtr hwnd, int x, int y) {
    SetCursorPos(x, y);
    Thread.Sleep(50);
    POINT at;
    GetCursorPos(out at);
    if (at.X != x || at.Y != y) throw new Exception("not pressed: the cursor is at " + at.X + "," + at.Y + ", not " + x + "," + y);
    if (GetAncestor(WindowFromPoint(at), 2) != hwnd) throw new Exception("not pressed: another window is under " + x + "," + y);
    Send(Mouse(MOVE, x, y), Mouse(DOWN, 0, 0));
  }
  public static void MoveTo(int x, int y) { Send(Mouse(MOVE, x, y)); }
  public static void Release() { Send(Mouse(UP, 0, 0)); }
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
if ($op -ne 'drag' -and $op -ne 'dblclick') { throw "unknown op $op" }
$was = New-Object W+POINT
[void][W]::GetCursorPos([ref]$was)
$pressed = $false
try {
  if ($op -eq 'drag') {
    [W]::Press([IntPtr]$hwnd, $pts[0][0], $pts[0][1])
    $pressed = $true
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) {
      Start-Sleep -Milliseconds 15
      [W]::MoveTo([int]($pts[0][0] + ($pts[1][0] - $pts[0][0]) * $i / $steps), [int]($pts[0][1] + ($pts[1][1] - $pts[0][1]) * $i / $steps))
    }
    Start-Sleep -Milliseconds 100
    [W]::Release()
    $pressed = $false
  } else {
    foreach ($i in 1, 2) {
      [W]::Press([IntPtr]$hwnd, $pts[0][0], $pts[0][1])
      $pressed = $true
      Start-Sleep -Milliseconds 20
      [W]::Release()
      $pressed = $false
    }
  }
  Start-Sleep -Milliseconds 300
} finally {
  if ($pressed) { [W]::Release() }
  [void][W]::SetCursorPos($was.X, $was.Y)
}
'{}'
