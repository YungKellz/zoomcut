import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { screen, type Display } from 'electron'
import type { WindowRect } from '@shared/types'
import { boxArea, isVisibleEnough, OVERLAY_TITLES, uncoveredArea, type Box } from '@shared/windows'

/**
 * Lists the top-level windows that really paint on screen, topmost first (EnumWindows order), with
 * their DWM frame bounds in physical pixels. Runs in PowerShell with a tiny C# helper, so no native
 * module is needed.
 *
 * Every window that paints is printed (`o`), untitled ones too (the taskbar covers what is below it);
 * titled, non-tool windows are candidates for the Clip tab (`c`). Left out entirely: hidden, minimized
 * and cloaked windows (other virtual desktops, suspended UWP apps), windows excluded from screen capture
 * (WDA_EXCLUDEFROMCAPTURE – not in the recording at all), our own process, click-through windows
 * (WS_EX_TRANSPARENT), (almost) fully transparent layered windows, and overlays spread over a whole
 * monitor (game bars, GPU overlays, the input host: tool / no-activate / see-through windows).
 *
 * Browsers (Chromium family by exe and window class; Firefox family) also get the page rectangle:
 * Chromium's page widget (Chrome_RenderWidgetHostHWND, the largest visible one), else – and always for
 * Firefox, which has no such child window – UI Automation's largest Document, with a 1.5 s budget for
 * all of them, and only for windows mostly on the recorded display and visible enough to be listed.
 * Any failure there only means no page rectangle.
 */
// C# string literals; the titles hold no quotes or backslashes
const OVERLAY_LIST = [...OVERLAY_TITLES].map((title) => `"${title}"`).join(', ')

const PS_SCRIPT = String.raw`
param([int]$OwnPid = 0, [int]$DisplayL = 0, [int]$DisplayT = 0, [int]$DisplayR = 0, [int]$DisplayB = 0)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ZcWin {
  public long Hwnd;
  public bool Candidate, HasPage, NeedsUia;
  public int L, T, R, B, PL, PT, PR, PB;
  public string Exe = "", Title = "";
  public override string ToString() {
    string page = HasPage ? PL + "\t" + PT + "\t" + PR + "\t" + PB : "\t\t\t";
    return (Candidate ? "c" : "o") + "\t" + L + "\t" + T + "\t" + R + "\t" + B + "\t" + Exe + "\t" + page + "\t" + Title;
  }
}
public static class ZcWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT pv, int cb);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int pv, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  const int WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000;
  // exe names without .exe; browser.exe is Yandex Browser (also checked by its Chrome_ window class)
  static readonly HashSet<string> Chromium = new HashSet<string>(new string[] { "chrome", "chromium", "msedge", "brave", "opera", "vivaldi", "browser", "arc", "thorium", "whale" });
  static readonly HashSet<string> Gecko = new HashSet<string>(new string[] { "firefox", "librewolf", "waterfox", "floorp", "zen" });
  // OVERLAY_TITLES of shared/windows.ts: they paint nothing, are never listed and hide nothing
  static readonly HashSet<string> Overlays = new HashSet<string>(new string[] { ${OVERLAY_LIST} });

  public static List<ZcWin> List(int ownPid) {
    // physical pixels for GetWindowRect of child windows too (DWM frame bounds are physical anyway)
    bool aware = false;
    try { aware = SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero; } catch (Exception) { }
    if (!aware) { try { aware = SetProcessDPIAware(); } catch (Exception) { } }
    var res = new List<ZcWin>();
    var exes = new Dictionary<uint, string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      try { Add(h, ownPid, aware, exes, res); } catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return res;
  }

  static void Add(IntPtr h, int ownPid, bool aware, Dictionary<uint, string> exes, List<ZcWin> res) {
    if (!IsWindowVisible(h) || IsIconic(h)) return;
    if (GetAncestor(h, 2) != h) return;
    int cloaked;
    if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return;
    uint affinity;
    if (GetWindowDisplayAffinity(h, out affinity) && affinity == 0x11) return;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (ownPid != 0 && pid == (uint)ownPid) return;
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) return;
    if (r.R - r.L < 2 || r.B - r.T < 2) return;
    int ex = GetWindowLong(h, -20);
    if ((ex & WS_EX_TRANSPARENT) != 0) return;
    bool seeThrough = false;
    if ((ex & WS_EX_LAYERED) != 0) {
      uint key, flags;
      byte alpha;
      // fails for per-pixel alpha (UpdateLayeredWindow); a colour key punches holes
      if (!GetLayeredWindowAttributes(h, out key, out alpha, out flags)) seeThrough = true;
      else if ((flags & 2) != 0 && alpha < 26) return;
      else if ((flags & 2) == 0) seeThrough = true;
    }
    string title = "";
    int len = GetWindowTextLength(h);
    if (len > 0) {
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      title = sb.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ").Trim();
    }
    if (Overlays.Contains(title)) return;
    var cls = new StringBuilder(256);
    GetClassName(h, cls, cls.Capacity);
    string className = cls.ToString();
    bool tool = (ex & WS_EX_TOOLWINDOW) != 0;
    bool overlayLike = tool || (ex & WS_EX_NOACTIVATE) != 0 || className == "Windows.UI.Core.CoreWindow" ||
      (seeThrough && ((ex & WS_EX_TOPMOST) != 0 || title.Length == 0));
    if (overlayLike && CoversMonitor(h, r)) return;
    var w = new ZcWin();
    w.Hwnd = h.ToInt64();
    w.L = r.L; w.T = r.T; w.R = r.R; w.B = r.B;
    w.Title = title;
    w.Candidate = title.Length > 0 && !tool && r.R - r.L >= 60 && r.B - r.T >= 60;
    if (w.Candidate) {
      w.Exe = ExeName(pid, exes);
      string name = w.Exe.EndsWith(".exe") ? w.Exe.Substring(0, w.Exe.Length - 4) : w.Exe;
      bool chromium = Chromium.Contains(name) && className.StartsWith("Chrome_");
      bool gecko = Gecko.Contains(name) && className == "MozillaWindowClass";
      if (chromium && aware) PageFromRenderWidget(h, w);
      if ((chromium || gecko) && aware && !w.HasPage) w.NeedsUia = true;
    }
    res.Add(w);
  }

  static bool CoversMonitor(IntPtr h, RECT r) {
    var mi = new MONITORINFO();
    mi.Size = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    long w = Math.Min(r.R, mi.Monitor.R) - Math.Max(r.L, mi.Monitor.L);
    long hh = Math.Min(r.B, mi.Monitor.B) - Math.Max(r.T, mi.Monitor.T);
    long area = (long)(mi.Monitor.R - mi.Monitor.L) * (mi.Monitor.B - mi.Monitor.T);
    return w > 0 && hh > 0 && area > 0 && w * hh >= area * 9 / 10;
  }

  static string ExeName(uint pid, Dictionary<uint, string> cache) {
    string name;
    if (cache.TryGetValue(pid, out name)) return name;
    name = "";
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p != IntPtr.Zero) {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (QueryFullProcessImageName(p, 0, sb, ref size)) {
        string path = sb.ToString();
        int slash = path.LastIndexOf('\\');
        name = (slash >= 0 ? path.Substring(slash + 1) : path).ToLowerInvariant();
      }
      CloseHandle(p);
    }
    cache[pid] = name;
    return name;
  }

  // the page is the largest render widget; hidden ones (background tabs, a covered window) only as a fallback
  static void PageFromRenderWidget(IntPtr top, ZcWin w) {
    var best = new RECT();
    long bestArea = 0;
    bool bestVisible = false;
    EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
      var cls = new StringBuilder(64);
      GetClassName(c, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_RenderWidgetHostHWND") return true;
      RECT cr;
      if (!GetWindowRect(c, out cr)) return true;
      long area = (long)(cr.R - cr.L) * (cr.B - cr.T);
      bool visible = IsWindowVisible(c);
      if ((visible && !bestVisible) || (visible == bestVisible && area > bestArea)) {
        best = cr;
        bestArea = area;
        bestVisible = visible;
      }
      return true;
    }, IntPtr.Zero);
    if (bestArea > 0) SetPage(w, best.L, best.T, best.R, best.B);
  }

  // UI Automation only for browser windows that will most likely be listed: mostly on the recorded
  // display and visible enough with every window above them as an occluder. A little more generous than
  // selectWindows / isVisibleEnough (shared/windows.ts), which decide in the end. Asking a browser through
  // UIA switches its accessibility engine on for the rest of its session, and the time budget is shared.
  public static void KeepUiaForVisible(List<ZcWin> wins, int dl, int dt, int dr, int db) {
    if (dr - dl < 1 || db - dt < 1) return;
    long display = (long)(dr - dl) * (db - dt);
    var above = new List<int[]>();
    foreach (var w in wins) {
      int l = Math.Max(w.L, dl), t = Math.Max(w.T, dt), r = Math.Min(w.R, dr), b = Math.Min(w.B, db);
      bool on = r - l >= 1 && b - t >= 1;
      if (w.NeedsUia) {
        long full = (long)(w.R - w.L) * (w.B - w.T);
        long area = on ? (long)(r - l) * (b - t) : 0;
        long open = on ? Uncovered(new int[] { l, t, r, b }, above) : 0;
        w.NeedsUia = area * 4 >= full && open * 200 >= display && (open * 5 >= area * 2 || open * 5 >= display);
      }
      if (on) above.Add(new int[] { l, t, r, b });
    }
  }

  // exact area of a (l, t, r, b) not covered by any of cover, by rectangle subtraction
  static long Uncovered(int[] a, List<int[]> cover) {
    var parts = new List<int[]>();
    parts.Add(a);
    foreach (var c in cover) {
      var next = new List<int[]>();
      foreach (var p in parts) {
        int il = Math.Max(p[0], c[0]), it = Math.Max(p[1], c[1]), ir = Math.Min(p[2], c[2]), ib = Math.Min(p[3], c[3]);
        if (ir <= il || ib <= it) { next.Add(p); continue; }
        if (it > p[1]) next.Add(new int[] { p[0], p[1], p[2], it });
        if (p[3] > ib) next.Add(new int[] { p[0], ib, p[2], p[3] });
        if (il > p[0]) next.Add(new int[] { p[0], it, il, ib });
        if (p[2] > ir) next.Add(new int[] { ir, it, p[2], ib });
      }
      parts = next;
      if (parts.Count == 0 || parts.Count > 4000) break;
    }
    if (parts.Count > 4000) return (long)(a[2] - a[0]) * (a[3] - a[1]);
    long sum = 0;
    foreach (var p in parts) sum += (long)(p[2] - p[0]) * (p[3] - p[1]);
    return sum;
  }

  public static void SetPage(ZcWin w, int l, int t, int r, int b) {
    l = Math.Max(l, w.L); t = Math.Max(t, w.T); r = Math.Min(r, w.R); b = Math.Min(b, w.B);
    if (r - l < 40 || b - t < 40) return;
    w.PL = l; w.PT = t; w.PR = r; w.PB = b;
    w.HasPage = true;
  }
}
'@
$wins = [ZcWinEnum]::List($OwnPid)
[ZcWinEnum]::KeepUiaForVisible($wins, $DisplayL, $DisplayT, $DisplayR, $DisplayB)
$pages = @($wins | Where-Object { $_.NeedsUia })
if ($pages.Count -gt 0) {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
public static class ZcPageUia {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  // The largest UI Automation Document of a top-level window (the web page), searched breadth-first
  // without descending into documents; null when there is none or it takes longer than timeoutMs.
  // A browser builds its accessibility tree only once a client asks, so the first search can come
  // back without the page: it is retried until the time is up.
  public static int[] Find(long hwnd, int timeoutMs) {
    int[] result = null;
    int deadline = Environment.TickCount + timeoutMs;
    var thread = new Thread(delegate() {
      try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
      while (true) {
        int[] found = null;
        try { found = Search(new IntPtr(hwnd)); } catch (Exception) { }
        if (found != null || deadline - Environment.TickCount < 400) { result = found; return; }
        Thread.Sleep(200);
      }
    });
    thread.IsBackground = true;
    thread.Start();
    return thread.Join(timeoutMs) ? result : null;
  }
  static int[] Search(IntPtr h) {
    var queue = new Queue<KeyValuePair<AutomationElement, int>>();
    queue.Enqueue(new KeyValuePair<AutomationElement, int>(AutomationElement.FromHandle(h), 0));
    Rect best = Rect.Empty;
    double bestArea = 0;
    int visited = 0;
    while (queue.Count > 0 && visited < 400) {
      var item = queue.Dequeue();
      visited++;
      AutomationElementCollection children;
      try { children = item.Key.FindAll(TreeScope.Children, Condition.TrueCondition); } catch (Exception) { continue; }
      foreach (AutomationElement child in children) {
        try {
          if (child.Current.ControlType == ControlType.Document) {
            Rect r = child.Current.BoundingRectangle;
            if (!r.IsEmpty && r.Width * r.Height > bestArea) { best = r; bestArea = r.Width * r.Height; }
          } else if (item.Value < 12) {
            queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
          }
        } catch (Exception) { }
      }
    }
    if (bestArea <= 0) return null;
    return new int[] { (int)Math.Round(best.Left), (int)Math.Round(best.Top), (int)Math.Round(best.Right), (int)Math.Round(best.Bottom) };
  }
}
'@
    # a fair share of what is left for each window, so one without a page (a Firefox Library window)
    # cannot use up the time of the ones after it
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
    for ($i = 0; $i -lt $pages.Count; $i++) {
      $w = $pages[$i]
      $budget = [int](($deadline - [DateTime]::UtcNow).TotalMilliseconds / ($pages.Count - $i))
      if ($budget -lt 100) { continue }
      $r = [ZcPageUia]::Find($w.Hwnd, $budget)
      if ($null -ne $r) { [ZcWinEnum]::SetPage($w, $r[0], $r[1], $r[2], $r[3]) }
    }
  } catch { }
}
foreach ($w in $wins) { Write-Output $w.ToString() }
`

const OWN_TITLES = new Set(['ZoomCut', 'ZoomCut recorder', 'ZoomCut overlay', 'Program Manager'])

/** One line of the helper's output, in physical screen pixels. */
export interface RawWindow {
  /** a titled app window that can be listed; the others only cover what is below them */
  candidate: boolean
  left: number
  top: number
  right: number
  bottom: number
  /** exe name, lower case; empty for non-candidates */
  app: string
  /** browsers: the page rectangle, inside the window */
  page: { left: number; top: number; right: number; bottom: number } | null
  title: string
}

/** A display's bounds in physical pixels. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

let runs = 0

// PowerShell 5.1 does not run a multi-line script piped into '-Command -', so it goes through a file
// (one per run: the snapshots at the start and the end of a recording, or two app instances, can overlap).
async function runPowerShell(script: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const scriptPath = join(tmpdir(), `zoomcut-winenum-${process.pid}-${++runs}.ps1`)
  await fsp.writeFile(scriptPath, script, 'utf8')
  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('window enumeration timed out'))
      }, timeoutMs)
      proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      proc.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(`powershell exited with ${code}: ${err.slice(-500)}`))
      })
      proc.stdin.end()
    })
  } finally {
    await fsp.rm(scriptPath, { force: true }).catch(() => undefined)
  }
}

export function parse(output: string): RawWindow[] {
  const rows: RawWindow[] = []
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 11 || (parts[0] !== 'c' && parts[0] !== 'o')) continue
    const [l, t, r, b] = parts.slice(1, 5).map((v) => Number(v))
    if ([l, t, r, b].some((v) => !Number.isFinite(v))) continue
    const p = parts.slice(6, 10).map((v) => (v.trim() === '' ? NaN : Number(v)))
    rows.push({
      candidate: parts[0] === 'c',
      left: l,
      top: t,
      right: r,
      bottom: b,
      app: parts[5].trim().toLowerCase(),
      page: p.every((v) => Number.isFinite(v)) ? { left: p[0], top: p[1], right: p[2], bottom: p[3] } : null,
      title: parts.slice(10).join('\t').trim()
    })
  }
  return rows
}

/** `left..bottom` clipped to the display and normalized to it; null when nothing of it is on the display. */
function toDisplay(d: PixelRect, left: number, top: number, right: number, bottom: number): Box | null {
  const l = Math.max(d.x, left)
  const t = Math.max(d.y, top)
  const r = Math.min(d.x + d.w, right)
  const b = Math.min(d.y + d.h, bottom)
  if (r - l < 1 || b - t < 1) return null
  return { x: (l - d.x) / d.w, y: (t - d.y) / d.h, w: (r - l) / d.w, h: (b - t) / d.h }
}

/**
 * The windows to list for display `d`: candidates mostly on this display (at least 40×40 px and 30 % of
 * the window) that were really visible – every window above them that paints, listed or not, counts as
 * an occluder (`isVisibleEnough` in shared/windows.ts has the threshold). Topmost first.
 */
export function selectWindows(raw: RawWindow[], d: PixelRect): WindowRect[] {
  const above: Box[] = []
  const out: WindowRect[] = []
  for (const w of raw) {
    const box = toDisplay(d, w.left, w.top, w.right, w.bottom)
    if (!box) continue // on another display: covers nothing here
    const fullArea = (w.right - w.left) * (w.bottom - w.top)
    const onDisplay = box.w * d.w >= 40 && box.h * d.h >= 40 && boxArea(box) * d.w * d.h >= fullArea * 0.3
    if (OVERLAY_TITLES.has(w.title)) continue // the helper leaves them out as well
    if (w.candidate && w.title && !OWN_TITLES.has(w.title) && onDisplay) {
      const share = uncoveredArea(box, above) / boxArea(box)
      if (isVisibleEnough(box, share)) {
        const rect: WindowRect = { title: w.title, ...box }
        if (w.app) rect.app = w.app
        const content = pageBox(d, box, w.page)
        if (content) rect.content = content
        rect.visible = Math.round(share * 1000) / 1000
        out.push(rect)
      }
    }
    above.push(box)
  }
  return out
}

/** The page rectangle clipped to the window's part on the display; null when it is missing, too small
 * (under 80×60 px or a quarter of the window) or no smaller than the window (a full-screen page). */
function pageBox(d: PixelRect, win: Box, page: RawWindow['page']): Box | null {
  if (!page) return null
  const p = toDisplay(d, page.left, page.top, page.right, page.bottom)
  if (!p) return null
  const x = Math.max(p.x, win.x)
  const y = Math.max(p.y, win.y)
  const w = Math.min(p.x + p.w, win.x + win.w) - x
  const h = Math.min(p.y + p.h, win.y + win.h) - y
  if (w * d.w < 80 || h * d.h < 60 || w * h < boxArea(win) * 0.25) return null
  if ((win.w - w) * d.w + (win.h - h) * d.h < 16) return null
  return { x, y, w, h }
}

/** The helper's arguments: our process (left out) and the display, which only browser windows mostly
 * on it and visible enough are asked for their page through UI Automation (`KeepUiaForVisible`). */
export function helperArgs(ownPid: number, d: PixelRect): string[] {
  const l = Math.round(d.x)
  const t = Math.round(d.y)
  return ['-OwnPid', String(ownPid), '-DisplayL', String(l), '-DisplayT', String(t), '-DisplayR', String(l + Math.round(d.w)), '-DisplayB', String(t + Math.round(d.h))]
}

/** The display's bounds in physical pixels (exact for every display, even with mixed scale factors). */
function physicalBounds(display: Display): PixelRect {
  try {
    const r = screen.dipToScreenRect(null, display.bounds)
    if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height }
  } catch {
    // fall back to scaling the DIP bounds (exact for the primary display)
  }
  const scale = display.scaleFactor || 1
  return { x: display.bounds.x * scale, y: display.bounds.y * scale, w: display.bounds.width * scale, h: display.bounds.height * scale }
}

/**
 * Windows really visible on `display`, normalized to the display's physical bounds, topmost first.
 * Returns an empty list on non-Windows platforms or when enumeration fails.
 */
export async function snapshotWindows(display: Display): Promise<WindowRect[]> {
  if (process.platform !== 'win32') return []
  const d = physicalBounds(display)
  let raw: RawWindow[]
  try {
    raw = parse(await runPowerShell(PS_SCRIPT, helperArgs(process.pid, d)))
  } catch (err) {
    console.warn('[windows] enumeration failed', err)
    return []
  }
  return selectWindows(raw, d)
}
