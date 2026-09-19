import type { CutRange } from '@shared/types'

export interface Segment {
  start: number
  end: number
}

export const MIN_SEGMENT_MS = 40

/** Clamps, sorts and merges cut ranges. Overlapping/adjacent cuts become one. */
export function normalizeCuts(cuts: CutRange[], durationMs: number): CutRange[] {
  const clamped = cuts
    .map((c) => ({
      ...c,
      start: Math.max(0, Math.min(durationMs, Math.min(c.start, c.end))),
      end: Math.max(0, Math.min(durationMs, Math.max(c.start, c.end)))
    }))
    .filter((c) => c.end - c.start >= 1)
    .sort((a, b) => a.start - b.start)

  const merged: CutRange[] = []
  for (const cut of clamped) {
    const last = merged[merged.length - 1]
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end)
    } else {
      merged.push({ ...cut })
    }
  }
  return merged
}

/** Source-time spans that survive the cuts, in order. */
export function keepSegments(durationMs: number, cuts: CutRange[]): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const cut of normalizeCuts(cuts, durationMs)) {
    if (cut.start - cursor >= MIN_SEGMENT_MS) segments.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (durationMs - cursor >= MIN_SEGMENT_MS) segments.push({ start: cursor, end: durationMs })
  return segments
}

export function outputDuration(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0)
}

/** Maps a source time to output time. Inside a cut, returns the output time of the next kept frame. */
export function srcToOut(tSrc: number, segments: Segment[]): number {
  let out = 0
  for (const s of segments) {
    if (tSrc < s.start) return out
    if (tSrc <= s.end) return out + (tSrc - s.start)
    out += s.end - s.start
  }
  return out
}

/** Maps an output time to the source time it displays. */
export function outToSrc(tOut: number, segments: Segment[]): number {
  if (segments.length === 0) return 0
  let out = 0
  for (const s of segments) {
    const len = s.end - s.start
    if (tOut < out + len) return s.start + (tOut - out)
    out += len
  }
  const last = segments[segments.length - 1]
  return last.end
}

export function segmentAt(tSrc: number, segments: Segment[]): Segment | null {
  for (const s of segments) {
    if (tSrc >= s.start && tSrc < s.end) return s
  }
  return null
}

/**
 * When `tSrc` is inside a cut, returns the start of the next kept segment; `null` when
 * nothing is left to play. Returns `tSrc` itself when it is already inside a kept segment.
 */
export function resolvePlayableTime(tSrc: number, segments: Segment[]): number | null {
  for (const s of segments) {
    if (tSrc < s.start) return s.start
    if (tSrc < s.end) return tSrc
  }
  return null
}

export function lastKeptTime(segments: Segment[]): number {
  return segments.length ? segments[segments.length - 1].end : 0
}

export function firstKeptTime(segments: Segment[]): number {
  return segments.length ? segments[0].start : 0
}

export interface TimedRegion {
  start: number
  end: number
}

/**
 * Applies cuts to timed regions (zooms, texts): regions fully inside a cut are dropped,
 * regions overlapping a cut's edge are shortened, regions spanning a whole cut are kept.
 */
export function clipRegionsToCuts<T extends TimedRegion>(regions: T[], cuts: CutRange[], durationMs: number, minLength = 50): T[] {
  const removed = normalizeCuts(cuts, durationMs)
  const out: T[] = []
  for (const region of regions) {
    let { start, end } = region
    let dropped = false
    for (const cut of removed) {
      if (start >= cut.start && end <= cut.end) {
        dropped = true
        break
      }
      if (cut.start <= start && start < cut.end) start = cut.end
      else if (cut.start < end && end <= cut.end) end = cut.start
    }
    if (dropped || end - start < minLength) continue
    out.push(start === region.start && end === region.end ? region : { ...region, start, end })
  }
  return out
}
