import type { ClickEvent, CutRange, ZoomSegment } from '@shared/types'
import { ZOOM_DEFAULTS } from '@shared/defaults'
import { uid } from './ids'
import { normalizeCuts } from './timeline'

export interface AutoZoomOptions {
  /** clicks closer than this are grouped into one zoom */
  gapMs?: number
  leadMs?: number
  tailMs?: number
  scale?: number
  minLengthMs?: number
}

/**
 * Generates "follow the cursor" zoom segments around clusters of clicks – a one-click
 * way to get the typical demo look. Clicks inside cut ranges are ignored.
 */
export function generateZoomsFromClicks(
  clicks: ClickEvent[],
  durationMs: number,
  cuts: CutRange[],
  opts: AutoZoomOptions = {}
): ZoomSegment[] {
  const gap = opts.gapMs ?? 2200
  const lead = opts.leadMs ?? 700
  const tail = opts.tailMs ?? 1600
  const scale = opts.scale ?? ZOOM_DEFAULTS.scale
  const minLength = opts.minLengthMs ?? 1500
  const removed = normalizeCuts(cuts, durationMs)
  const usable = clicks
    .filter((c) => c.t >= 0 && c.t <= durationMs)
    .filter((c) => !removed.some((r) => c.t >= r.start && c.t < r.end))
    .sort((a, b) => a.t - b.t)

  const clusters: Array<{ first: number; last: number }> = []
  for (const c of usable) {
    const last = clusters[clusters.length - 1]
    if (last && c.t - last.last <= gap) last.last = c.t
    else clusters.push({ first: c.t, last: c.t })
  }

  const zooms: ZoomSegment[] = []
  for (const cl of clusters) {
    const start = Math.max(0, cl.first - lead)
    const end = Math.min(durationMs, Math.max(cl.last + tail, start + minLength))
    const prev = zooms[zooms.length - 1]
    if (prev && start < prev.end + 400) {
      prev.end = Math.max(prev.end, end)
      continue
    }
    zooms.push({ ...ZOOM_DEFAULTS, id: uid('zoom'), start, end, scale, mode: 'follow', target: { x: 0.5, y: 0.5 } })
  }
  return zooms.filter((z) => z.end - z.start >= 300)
}
