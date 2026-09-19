import { spawn } from 'node:child_process'
import type { Display } from 'electron'
import type { WindowRect } from '@shared/types'

/**
 * Lists visible top-level windows with their DWM frame bounds (physical pixels).
 * Runs in PowerShell with a tiny C# helper, so no native module is needed.
 */
const PS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ZcWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT pv, int cb);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int pv, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if (GetAncestor(h, 2) != h) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      RECT r;
      if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) return true;
      if (r.R - r.L < 60 || r.B - r.T < 60) return true;
      string title = sb.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
      res.Add(r.L + "\t" + r.T + "\t" + r.R + "\t" + r.B + "\t" + title);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
[ZcWinEnum]::List() | ForEach-Object { Write-Output $_ }
`

const OWN_TITLES = new Set(['ZoomCut', 'ZoomCut recorder', 'Program Manager'])

interface RawWindow {
  left: number
  top: number
  right: number
  bottom: number
  title: string
}

function runPowerShell(script: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
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
    proc.stdin.on('error', () => undefined)
    proc.stdin.end(script)
  })
}

function parse(output: string): RawWindow[] {
  const rows: RawWindow[] = []
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [l, t, r, b] = parts.slice(0, 4).map((v) => Number(v))
    if ([l, t, r, b].some((v) => !Number.isFinite(v))) continue
    rows.push({ left: l, top: t, right: r, bottom: b, title: parts.slice(4).join('\t').trim() })
  }
  return rows
}

/**
 * Windows on `display`, normalized to the display's physical bounds, topmost first.
 * Returns an empty list on non-Windows platforms or when enumeration fails.
 */
export async function snapshotWindows(display: Display): Promise<WindowRect[]> {
  if (process.platform !== 'win32') return []
  let raw: RawWindow[]
  try {
    raw = parse(await runPowerShell(PS_SCRIPT))
  } catch (err) {
    console.warn('[windows] enumeration failed', err)
    return []
  }
  const scale = display.scaleFactor || 1
  const dx = display.bounds.x * scale
  const dy = display.bounds.y * scale
  const dw = display.bounds.width * scale
  const dh = display.bounds.height * scale
  const out: WindowRect[] = []
  for (const w of raw) {
    if (OWN_TITLES.has(w.title)) continue
    const left = Math.max(dx, w.left)
    const top = Math.max(dy, w.top)
    const right = Math.min(dx + dw, w.right)
    const bottom = Math.min(dy + dh, w.bottom)
    if (right - left < 40 || bottom - top < 40) continue
    const visibleArea = (right - left) * (bottom - top)
    const fullArea = (w.right - w.left) * (w.bottom - w.top)
    if (visibleArea < fullArea * 0.3) continue
    out.push({
      title: w.title,
      x: (left - dx) / dw,
      y: (top - dy) / dh,
      w: (right - left) / dw,
      h: (bottom - top) / dh
    })
  }
  return out
}
