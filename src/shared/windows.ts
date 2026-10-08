/**
 * "Which windows were really visible" – the geometry shared by the recorder's window snapshot (main,
 * with every window that paints on screen as an occluder) and the editor's pass over projects
 * recorded before 0.4.1 (renderer, with only the listed windows as occluders).
 *
 * Boxes are normalized to the recorded display (its area is 1) and lists are topmost first.
 */

/** An axis-aligned rectangle. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

// slivers thinner than this (float noise of normalized coordinates) do not count
const EPS = 1e-9

/**
 * A window is listed only when it was really visible: at least half of its area on the display was
 * not covered by windows above it – then cropping to it shows mostly that window, not the ones in
 * front of it – or the uncovered part is large on its own (a quarter of the display: a maximized
 * window with a smaller one in front is still clearly seen around it). Either way the uncovered part
 * must be at least 1 % of the display (~144×144 px at 1080p); anything smaller is no crop target.
 */
export const MIN_VISIBLE_SHARE = 0.5
export const MIN_LARGE_VISIBLE_AREA = 0.25
export const MIN_VISIBLE_AREA = 0.01

export function boxArea(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h)
}

/** The overlap of two boxes, or null when they do not overlap. */
export function intersectBox(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right - x <= EPS || bottom - y <= EPS) return null
  return { x, y, w: right - x, h: bottom - y }
}

/** The parts of `a` outside `cut`: up to four disjoint boxes (`a` itself when they do not overlap). */
export function subtractBox(a: Box, cut: Box): Box[] {
  const i = intersectBox(a, cut)
  if (!i) return [a]
  const out: Box[] = []
  const right = a.x + a.w
  const bottom = a.y + a.h
  // full-width bands above and below the overlap, then the pieces left and right of it
  if (i.y - a.y > EPS) out.push({ x: a.x, y: a.y, w: a.w, h: i.y - a.y })
  if (bottom - (i.y + i.h) > EPS) out.push({ x: a.x, y: i.y + i.h, w: a.w, h: bottom - (i.y + i.h) })
  if (i.x - a.x > EPS) out.push({ x: a.x, y: i.y, w: i.x - a.x, h: i.h })
  if (right - (i.x + i.w) > EPS) out.push({ x: i.x + i.w, y: i.y, w: right - (i.x + i.w), h: i.h })
  return out
}

/** Area of `a` that none of `cover` overlaps – exact rectangle subtraction, no sampling grid. */
export function uncoveredArea(a: Box, cover: Box[]): number {
  let parts = boxArea(a) > EPS ? [a] : []
  for (const c of cover) {
    if (parts.length === 0) break
    parts = parts.flatMap((p) => subtractBox(p, c))
  }
  return parts.reduce((sum, p) => sum + boxArea(p), 0)
}

/** For a topmost-first list: the share of each box that no box before it covers (0 for empty boxes). */
export function uncoveredShares(boxes: Box[]): number[] {
  return boxes.map((b, i) => {
    const area = boxArea(b)
    return area > EPS ? uncoveredArea(b, boxes.slice(0, i)) / area : 0
  })
}

/** Whether a window (normalized to the display) with this uncovered share counts as visible. */
export function isVisibleEnough(box: Box, share: number): boolean {
  const visibleArea = boxArea(box) * share
  return visibleArea >= MIN_VISIBLE_AREA && (share >= MIN_VISIBLE_SHARE || visibleArea >= MIN_LARGE_VISIBLE_AREA)
}
