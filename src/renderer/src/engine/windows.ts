import type { CropRect, WindowRect, WindowSnapshot } from '@shared/types'
import { coversDisplay, isVisibleEnough, OVERLAY_TITLES, uncoveredShares } from '@shared/windows'

/**
 * Windows of one snapshot that were really visible. Snapshots since 0.4.1 come filtered by the recorder
 * (every window on screen counted as an occluder; their windows carry `visible`); older ones list every
 * window, topmost first, so the ones hidden behind the windows listed above them are dropped here.
 *
 * An old snapshot cannot tell an invisible full-screen overlay from a full-screen app, and it listed
 * overlays that had a title: known overlays are dropped, and the topmost window covering the whole
 * display hides nothing – the windows below it stay listed as 0.4.0 listed them (still filtered among
 * themselves) rather than all vanishing behind what may have been an overlay.
 */
export function visibleWindows(snap: WindowSnapshot): WindowRect[] {
  if (snap.windows.some((w) => w.visible !== undefined)) return snap.windows
  const windows = snap.windows.filter((w) => !OVERLAY_TITLES.has(w.title))
  const fullScreen = windows.findIndex((w) => coversDisplay(w))
  const shares = uncoveredShares(windows, (i) => i !== fullScreen)
  return windows.filter((w, i) => isVisibleEnough(w, shares[i]))
}

/**
 * Whether the crop is the whole frame or the crop of one of these windows (or a browser's page). Only
 * then a click inside the crop rectangle picks a window: a crop adjusted by hand is never replaced by
 * a plain click.
 */
export function cropFromWindows(crop: CropRect, windows: WindowRect[]): boolean {
  if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) return true
  return windows.some((w) => {
    const page = pageToCrop(w)
    return sameCrop(crop, windowToCrop(w)) || (page !== null && sameCrop(crop, page))
  })
}

function windowKey(w: WindowRect): string {
  return `${w.title}|${w.x.toFixed(2)}|${w.y.toFixed(2)}|${w.w.toFixed(2)}|${w.h.toFixed(2)}`
}

/**
 * Unique visible windows across snapshots (same title and roughly the same rectangle count once),
 * front to back: a window first seen in a later snapshot goes in front of every listed window that
 * snapshot had below it. A page rectangle missing at the first sighting is taken from a later one.
 */
export function uniqueWindows(snapshots: WindowSnapshot[]): WindowRect[] {
  const out: WindowRect[] = []
  const keys: string[] = []
  for (const snap of snapshots) {
    const windows = visibleWindows(snap)
    const snapKeys = windows.map(windowKey)
    windows.forEach((w, i) => {
      const seen = keys.indexOf(snapKeys[i])
      if (seen >= 0) {
        if (!out[seen].content && w.content) out[seen] = { ...out[seen], content: w.content }
        return
      }
      const below = snapKeys.slice(i + 1).map((k) => keys.indexOf(k)).filter((at) => at >= 0)
      const at = below.length > 0 ? Math.min(...below) : out.length
      out.splice(at, 0, w)
      keys.splice(at, 0, snapKeys[i])
    })
  }
  return out
}

function rectToCrop(r: { x: number; y: number; w: number; h: number }): CropRect {
  const x = Math.max(0, Math.min(1, r.x))
  const y = Math.max(0, Math.min(1, r.y))
  return { x, y, w: Math.max(0.05, Math.min(1 - x, r.w)), h: Math.max(0.05, Math.min(1 - y, r.h)) }
}

export function windowToCrop(w: WindowRect): CropRect {
  return rectToCrop(w)
}

/** The crop to a browser window's page (without the tab strip and the address bar); null for other windows. */
export function pageToCrop(w: WindowRect): CropRect | null {
  return w.content ? rectToCrop(w.content) : null
}

/** Whether two crops are the same up to rounding (marks the window a crop came from). */
export function sameCrop(a: CropRect, b: CropRect, eps = 0.002): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps
}

/** What a click at (x, y), normalized to the source, picks: the frontmost window there, and whether its page. */
export function windowAt(windows: WindowRect[], x: number, y: number): { index: number; page: boolean } | null {
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  const index = windows.findIndex(inside)
  if (index < 0) return null
  const content = windows[index].content
  return { index, page: content !== undefined && inside(content) }
}
