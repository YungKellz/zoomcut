import type { CropRect, Project, ZoomSegment } from '@shared/types'
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

export function cameraAt(project: Project, tSrc: number, followPath: FollowPath | null): Camera {
  const z = findZoom(project.zooms, tSrc)
  if (!z || z.scale <= 1.001) return IDENTITY_CAMERA
  const p = zoomProgress(z, tSrc)
  const scale = 1 + (z.scale - 1) * p
  const sourceTarget: Point =
    z.mode === 'fixed' || !followPath ? z.target : followAt(followPath, tSrc)
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
  z.start = Math.max(0, prev ? Math.max(prev.end, z.start) : z.start)
  z.end = Math.min(durationMs, next ? Math.min(next.start, z.end) : z.end)
  if (z.end - z.start < 200) {
    z.end = Math.min(durationMs, z.start + 200)
  }
  sorted[idx] = z
  return sorted.filter((s) => s.end - s.start >= 50)
}
