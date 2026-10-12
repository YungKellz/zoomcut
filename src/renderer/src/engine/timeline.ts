import type { CutRange } from '@shared/types'
import { normalizeCuts, outputDuration, type Segment } from '@shared/timeline'

// The cuts → kept segments rule (Segment, MIN_SEGMENT_MS, normalizeCuts, keepSegments, outputDuration) is shared with
// the agent's project view, so it lives in shared/timeline.ts; everything here keeps importing it from this module.
export * from '@shared/timeline'

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

/**
 * Where playback starts when Play is pressed with the playhead at `tSrc`: the next kept frame,
 * or the first kept frame when nothing is left to play (the end was reached) - Play at the end
 * starts over, like in any other player. Less than a millisecond of footage counts as the end.
 */
export function playStartTime(tSrc: number, segments: Segment[]): number {
  const t = resolvePlayableTime(tSrc, segments)
  if (t === null || lastKeptTime(segments) - t < 1) return firstKeptTime(segments)
  return t
}

/**
 * `tSrc` moved by `frames` frames of `frameMs` along the OUTPUT timeline, so removed pieces are
 * jumped over; the result stays inside the kept range (the start of the output .. its end).
 *
 * Two positions are not on a frame of their own, and a step starts from the frame they show:
 * - the end of the output shows the last frame (see displayTime), which starts a frame earlier, so
 *   the first step back from the end already shows the frame before it;
 * - a playhead inside a removed piece sits where the first frame after the piece begins, so a step
 *   forward lands on that frame rather than on the one behind it.
 */
export function stepFrames(tSrc: number, frames: number, frameMs: number, segments: Segment[]): number {
  const total = outputDuration(segments)
  const last = segments[segments.length - 1]
  let from = srcToOut(tSrc, segments)
  if (frameMs > 0) {
    // a position that is a whole number of frames from the start of the output is exactly that: the
    // microsecond rounding below would otherwise add up over many steps (60 steps at 30 fps stop at 1999.99998)
    const k = Math.round(from / frameMs)
    if (Math.abs(from - k * frameMs) < 1e-3) from = k * frameMs
  }
  if (last && tSrc >= last.end) from = Math.max(0, total - frameMs)
  else if (frames > 0 && segmentAt(tSrc, segments) === null) from -= frameMs
  // float noise must not decide on which side of a cut the step ends
  const out = Math.round((from + frames * frameMs) * 1e6) / 1e6
  // the sub-microsecond drift that rounding leaves behind over many steps must not stop a step short of the end
  return outToSrc(out > total - 1e-3 ? total : Math.max(0, out), segments)
}

/** A hair past the instant: see displayTime. */
const SEEK_BIAS_MS = 0.05

/**
 * Source time the player is asked to show for a playhead at `tSrc`. A video shows the frame that
 * starts at or before the time it is asked for, so the time lands 50 µs past the playhead: a
 * frame step that float noise left a few nanoseconds short of the next frame would otherwise show
 * the previous frame. The end of the output is the end of its last frame, not a frame of its own
 * (the source there is a removed piece, or nothing at all), so it shows the last frame that is
 * really part of the output.
 */
export function displayTime(tSrc: number, frameMs: number, segments: Segment[]): number {
  const last = segments[segments.length - 1]
  if (!last || tSrc < last.end) return tSrc + SEEK_BIAS_MS
  return Math.max(last.start, last.end - frameMs / 2)
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
