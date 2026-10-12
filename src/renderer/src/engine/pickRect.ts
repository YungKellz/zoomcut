import { clamp } from '../util/format'

/**
 * Geometry of the rectangle that picks a zoom area, in crop-normalized coordinates (0..1 over the
 * cropped frame): a square in those units, `size` = 1 / zoom scale, centred on (cx, cy).
 */
export interface PickGeometry {
  cx: number
  cy: number
  size: number
}

export type PickCorner = 'nw' | 'ne' | 'sw' | 'se'

/** The Shift magnet reaches this far from a centre line, in px of the preview stage ... */
export const PICK_SNAP_PX = 10
/** ... but never more than this share of the frame (a tiny preview would snap over half of it). */
export const PICK_SNAP_MAX = 0.025

/** Magnet reach along one axis, normalized, for a stage that is `stagePx` px long on that axis. */
export function pickSnapThreshold(stagePx: number): number {
  return Math.min(PICK_SNAP_MAX, PICK_SNAP_PX / Math.max(1, stagePx))
}

/** Keeps the rectangle inside the frame by moving its centre. */
export function clampPickCenter(r: PickGeometry): PickGeometry {
  return { ...r, cx: clamp(r.cx, r.size / 2, 1 - r.size / 2), cy: clamp(r.cy, r.size / 2, 1 - r.size / 2) }
}

export interface PickSnap {
  rect: PickGeometry
  /** the centre sits on the frame's vertical centre line */
  x: boolean
  /** the centre sits on the frame's horizontal centre line */
  y: boolean
}

/**
 * The Shift magnet: pulls the rectangle's centre onto the frame's vertical (x = 0.5) and horizontal
 * (y = 0.5) centre lines when it is within `thrX` / `thrY` of them. Each axis snaps on its own.
 * The centre line is always reachable: a rectangle never exceeds PICK_MAX_SIZE < 1.
 */
export function snapPickCenter(r: PickGeometry, thrX: number, thrY: number): PickSnap {
  const x = Math.abs(r.cx - 0.5) <= thrX
  const y = Math.abs(r.cy - 0.5) <= thrY
  if (!x && !y) return { rect: r, x, y }
  return { rect: { ...r, cx: x ? 0.5 : r.cx, cy: y ? 0.5 : r.cy }, x, y }
}

/**
 * Resizes the rectangle by dragging one of its corners to `pointer` (crop-normalized, may be
 * outside the frame). By default the opposite corner stays where it is; with `fromCenter` (Alt) the
 * centre stays and the rectangle grows or shrinks in every direction. Either way the size stays
 * within [min, max] and the rectangle inside the frame. `start` is the rectangle when the drag began.
 */
export function resizePickRect(
  start: PickGeometry,
  corner: PickCorner,
  pointer: { x: number; y: number },
  min: number,
  max: number,
  fromCenter = false
): PickGeometry {
  const sxDir = corner.includes('w') ? -1 : 1
  const syDir = corner.includes('n') ? -1 : 1
  if (fromCenter) {
    // the rectangle reaches (cx +- size / 2): as far as the nearest frame edge from the fixed centre
    const room = 2 * Math.min(start.cx, 1 - start.cx, start.cy, 1 - start.cy)
    const wanted = 2 * Math.max((pointer.x - start.cx) * sxDir, (pointer.y - start.cy) * syDir)
    return { cx: start.cx, cy: start.cy, size: clamp(wanted, min, Math.max(min, Math.min(max, room))) }
  }
  const half = start.size / 2
  const ax = corner.includes('w') ? start.cx + half : start.cx - half
  const ay = corner.includes('n') ? start.cy + half : start.cy - half
  const avail = Math.min(sxDir > 0 ? 1 - ax : ax, syDir > 0 ? 1 - ay : ay)
  const wanted = Math.max((pointer.x - ax) * sxDir, (pointer.y - ay) * syDir)
  const size = clamp(wanted, min, Math.min(max, avail))
  return { cx: ax + (sxDir * size) / 2, cy: ay + (syDir * size) / 2, size }
}
