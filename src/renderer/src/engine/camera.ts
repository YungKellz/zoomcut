import type { CropRect, Project, ZoomPart, ZoomSegment } from '@shared/types'
import { followAt, type FollowPath, type Point } from './cursor'

/** Camera state in crop-normalized coordinates: (cx, cy) is the center of the visible area. */
export interface Camera {
  cx: number
  cy: number
  scale: number
}

export interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

export const IDENTITY_CAMERA: Camera = { cx: 0.5, cy: 0.5, scale: 1 }

export function easeInOutCubic(p: number): number {
  const t = Math.max(0, Math.min(1, p))
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function findZoom(zooms: ZoomSegment[], t: number): ZoomSegment | undefined {
  return zooms.find((z) => t >= z.start && t < z.end)
}

/** 0 → 1 → 0 envelope of a zoom segment with eased in/out transitions. */
export function zoomProgress(z: ZoomSegment, t: number): number {
  const len = Math.max(1, z.end - z.start)
  const easeIn = Math.min(z.easeInMs, len / 2)
  const easeOut = Math.min(z.easeOutMs, len / 2)
  if (t < z.start + easeIn) return easeInOutCubic(easeIn > 0 ? (t - z.start) / easeIn : 1)
  if (t > z.end - easeOut) return easeInOutCubic(easeOut > 0 ? (z.end - t) / easeOut : 1)
  return 1
}

export function toCropSpace(p: Point, crop: CropRect): Point {
  return {
    x: Math.max(0, Math.min(1, (p.x - crop.x) / Math.max(1e-6, crop.w))),
    y: Math.max(0, Math.min(1, (p.y - crop.y) / Math.max(1e-6, crop.h)))
  }
}

export function fromCropSpace(p: Point, crop: CropRect): Point {
  return { x: crop.x + p.x * crop.w, y: crop.y + p.y * crop.h }
}

export function clampCamera(cam: Camera): Camera {
  if (cam.scale <= 1) return { cx: 0.5, cy: 0.5, scale: 1 }
  const half = 0.5 / cam.scale
  return {
    cx: Math.max(half, Math.min(1 - half, cam.cx)),
    cy: Math.max(half, Math.min(1 - half, cam.cy)),
    scale: cam.scale
  }
}

// ---- zoom parts: several areas inside one fixed-area zoom ----

/** Every area of a zoom lasts at least this long. */
export const ZOOM_PART_MIN_MS = 300
/** The glide from one area to the next starts at the boundary and takes this long (less for a short area). */
export const ZOOM_PART_TRANSITION_MS = 600

/** One stretch of a zoom with its own target and scale: area 0 is the zoom itself, the rest are its parts. */
export interface ZoomArea {
  index: number
  /** null for area 0 */
  id: string | null
  start: number
  end: number
  target: { x: number; y: number }
  scale: number
}

/** Parts only count in fixed mode; follow mode keeps them stored but ignores them. */
function activeParts(z: ZoomSegment): ZoomPart[] {
  return z.mode === 'fixed' && z.parts ? z.parts : []
}

/** Drops the `parts` key (an empty list and a missing one mean the same, the missing one is canonical). */
function withoutParts(z: ZoomSegment): ZoomSegment {
  const { parts: _dropped, ...rest } = z
  return rest
}

function withParts(z: ZoomSegment, parts: ZoomPart[]): ZoomSegment {
  return parts.length > 0 ? { ...z, parts } : withoutParts(z)
}

/** The areas of a zoom in time order; follow mode or no parts gives the single area 0. */
export function zoomAreas(z: ZoomSegment): ZoomArea[] {
  const parts = activeParts(z)
  const areas: ZoomArea[] = [
    { index: 0, id: null, start: z.start, end: parts.length > 0 ? parts[0].start : z.end, target: z.target, scale: z.scale }
  ]
  parts.forEach((part, i) => {
    areas.push({ index: i + 1, id: part.id, start: part.start, end: i + 1 < parts.length ? parts[i + 1].start : z.end, target: part.target, scale: part.scale })
  })
  return areas
}

/** Index of the area playing at source time `tSrc` (before the zoom: 0, after it: the last one). */
export function zoomAreaIndexAt(z: ZoomSegment, tSrc: number): number {
  let index = 0
  for (const part of activeParts(z)) {
    if (tSrc >= part.start) index++
    else break
  }
  return index
}

/** How long the glide into an area takes: the usual time, but never more than half of that area. */
function glideMs(area: ZoomArea): number {
  return Math.min(ZOOM_PART_TRANSITION_MS, Math.max(0, area.end - area.start) / 2)
}

/**
 * A moment inside area `index` after its ease-in (area 0) or glide (the rest) has settled, so the
 * frame found there shows the area itself. Where the editor parks the playhead for picking an area.
 */
export function zoomAreaFocusMs(z: ZoomSegment, index: number): number {
  const areas = zoomAreas(z)
  const area = areas[Math.max(0, Math.min(areas.length - 1, index))]
  const settle = area.index === 0 ? Math.min(z.easeInMs, (area.end - area.start) / 2) : glideMs(area)
  return Math.max(area.start, Math.min(Math.max(area.start, area.end - 1), area.start + settle + 50))
}

function isFinitePart(p: ZoomPart): boolean {
  return Number.isFinite(p.start) && Number.isFinite(p.scale) && Number.isFinite(p.target?.x) && Number.isFinite(p.target?.y)
}

/**
 * Sorts the parts, keeps every area at least ZOOM_PART_MIN_MS long (a boundary is pushed back from
 * its predecessor) and drops the parts that no longer fit before the zoom's end. Returns the same
 * object when nothing had to change; follow mode is left alone.
 */
export function normalizeZoomParts(z: ZoomSegment): ZoomSegment {
  const parts = z.parts
  if (!parts || z.mode !== 'fixed') return z
  const sorted = parts.filter(isFinitePart).sort((a, b) => a.start - b.start)
  const kept: ZoomPart[] = []
  let prev = z.start
  for (const part of sorted) {
    const start = Math.max(part.start, prev + ZOOM_PART_MIN_MS)
    // this boundary and every later one would leave less than the minimum before the end
    if (z.end - start < ZOOM_PART_MIN_MS) break
    kept.push(start === part.start ? part : { ...part, start })
    prev = start
  }
  if (kept.length === parts.length && kept.every((p, i) => p === parts[i])) return z
  return withParts(z, kept)
}

/**
 * Starts a new part at `at`. It copies the area playing there, so nothing changes on screen until
 * a new area is picked. Null when `at` is closer than the minimum to the zoom's edges or to another
 * boundary, or the zoom is not in fixed mode. `index` is the new part's area index (>= 1).
 */
export function insertZoomPart(z: ZoomSegment, at: number, id: string): { zoom: ZoomSegment; index: number } | null {
  if (z.mode !== 'fixed' || !Number.isFinite(at)) return null
  if (at - z.start < ZOOM_PART_MIN_MS || z.end - at < ZOOM_PART_MIN_MS) return null
  const parts = z.parts ?? []
  if (parts.some((p) => Math.abs(p.start - at) < ZOOM_PART_MIN_MS)) return null
  const here = zoomAreas(z)[zoomAreaIndexAt(z, at)]
  const part: ZoomPart = { id, start: at, target: { ...here.target }, scale: here.scale }
  const next = [...parts, part].sort((a, b) => a.start - b.start)
  return { zoom: { ...z, parts: next }, index: next.indexOf(part) + 1 }
}

/** Removes area `index` (>= 1); the previous area then lasts until the next boundary. */
export function removeZoomPart(z: ZoomSegment, index: number): ZoomSegment {
  const parts = z.parts
  if (!parts || index < 1 || index > parts.length) return z
  return withParts(z, parts.filter((_, i) => i !== index - 1))
}

/** Moves every boundary by `delta` ms, for when the whole zoom was dragged along the timeline. */
export function shiftZoomParts(z: ZoomSegment, delta: number): ZoomSegment {
  if (!z.parts || z.parts.length === 0 || !Number.isFinite(delta) || delta === 0) return z
  return { ...z, parts: z.parts.map((p) => ({ ...p, start: p.start + delta })) }
}

export interface ZoomAreaPatch {
  start?: number
  target?: { x: number; y: number }
  scale?: number
}

/**
 * Edits area `index`: target and scale of area 0 are the zoom's own; a part may also move its
 * boundary, which stays ZOOM_PART_MIN_MS away from its neighbours and the zoom's edges.
 */
export function patchZoomArea(z: ZoomSegment, index: number, patch: ZoomAreaPatch): ZoomSegment {
  if (index <= 0) {
    const target = patch.target ?? z.target
    const scale = patch.scale ?? z.scale
    return target === z.target && scale === z.scale ? z : { ...z, target, scale }
  }
  const parts = z.parts
  const part = parts?.[index - 1]
  if (!parts || !part) return z
  let start = part.start
  if (patch.start !== undefined && Number.isFinite(patch.start)) {
    const lo = (index >= 2 ? parts[index - 2].start : z.start) + ZOOM_PART_MIN_MS
    const hi = (index < parts.length ? parts[index].start : z.end) - ZOOM_PART_MIN_MS
    start = Math.max(lo, Math.min(hi, patch.start))
  }
  const target = patch.target ?? part.target
  const scale = patch.scale ?? part.scale
  if (start === part.start && target === part.target && scale === part.scale) return z
  return { ...z, parts: parts.map((p, i) => (i === index - 1 ? { ...p, start, target, scale } : p)) }
}

/**
 * Where a fixed zoom aims at `t`, before its own ease in/out: the current area, or part-way from
 * the previous one while the camera glides (target linearly, scale geometrically so the zoom
 * speed feels even).
 */
function areaPoseAt(z: ZoomSegment, t: number): { target: { x: number; y: number }; scale: number } {
  const areas = zoomAreas(z)
  const cur = areas[zoomAreaIndexAt(z, t)]
  if (cur.index === 0) return { target: cur.target, scale: cur.scale }
  const prev = areas[cur.index - 1]
  const glide = glideMs(cur)
  const f = glide > 0 ? easeInOutCubic((t - cur.start) / glide) : 1
  if (f >= 1) return { target: cur.target, scale: cur.scale }
  const lerp = (a: number, b: number): number => a + (b - a) * f
  return {
    target: { x: lerp(prev.target.x, cur.target.x), y: lerp(prev.target.y, cur.target.y) },
    scale: Math.exp(lerp(Math.log(Math.max(1, prev.scale)), Math.log(Math.max(1, cur.scale))))
  }
}

export function cameraAt(project: Project, tSrc: number, followPath: FollowPath | null): Camera {
  const found = findZoom(project.zooms, tSrc)
  if (!found) return IDENTITY_CAMERA
  // stored parts come from disk: a hand-edited file must not feed NaN into the canvas
  const z = found.parts ? normalizeZoomParts(found) : found
  const pose = activeParts(z).length > 0 ? areaPoseAt(z, tSrc) : { target: z.target, scale: z.scale }
  if (pose.scale <= 1.001) return IDENTITY_CAMERA
  const p = zoomProgress(z, tSrc)
  const scale = 1 + (pose.scale - 1) * p
  const sourceTarget: Point =
    z.mode === 'fixed' || !followPath ? pose.target : followAt(followPath, tSrc)
  const target = toCropSpace(sourceTarget, project.crop)
  return clampCamera({
    cx: 0.5 + (target.x - 0.5) * p,
    cy: 0.5 + (target.y - 0.5) * p,
    scale
  })
}

export function viewportOf(cam: Camera): Viewport {
  const w = 1 / cam.scale
  const h = 1 / cam.scale
  return { x: cam.cx - w / 2, y: cam.cy - h / 2, w, h }
}

/** Keeps zoom segments sorted and non-overlapping after one of them changed. */
export function resolveZoomOverlaps(zooms: ZoomSegment[], changedId: string, durationMs: number): ZoomSegment[] {
  const sorted = [...zooms].sort((a, b) => a.start - b.start)
  const idx = sorted.findIndex((z) => z.id === changedId)
  if (idx === -1) return sorted
  const z = { ...sorted[idx] }
  const prev = sorted[idx - 1]
  const next = sorted[idx + 1]
  // the room between the neighbours; the segment never leaves it
  const lo = prev ? prev.end : 0
  const hi = next ? next.start : durationMs
  const minLength = 200
  z.start = Math.max(lo, Math.min(hi, z.start))
  z.end = Math.max(lo, Math.min(hi, z.end))
  if (z.end - z.start < minLength) {
    z.end = Math.min(hi, z.start + minLength)
    if (z.end - z.start < minLength) z.start = Math.max(lo, z.end - minLength)
  }
  // a shorter zoom may no longer have room for all its parts
  sorted[idx] = normalizeZoomParts(z)
  return sorted.filter((s) => s.end - s.start >= 50)
}
