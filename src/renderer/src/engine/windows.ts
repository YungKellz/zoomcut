import type { CropRect, WindowRect, WindowSnapshot } from '@shared/types'

/** Unique windows across snapshots (same title and roughly the same rectangle count once). */
export function uniqueWindows(snapshots: WindowSnapshot[]): WindowRect[] {
  const seen = new Set<string>()
  const out: WindowRect[] = []
  for (const snap of snapshots) {
    for (const w of snap.windows) {
      const key = `${w.title}|${w.x.toFixed(2)}|${w.y.toFixed(2)}|${w.w.toFixed(2)}|${w.h.toFixed(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(w)
    }
  }
  return out
}

export function windowToCrop(w: WindowRect): CropRect {
  const x = Math.max(0, Math.min(1, w.x))
  const y = Math.max(0, Math.min(1, w.y))
  return { x, y, w: Math.max(0.05, Math.min(1 - x, w.w)), h: Math.max(0.05, Math.min(1 - y, w.h)) }
}
