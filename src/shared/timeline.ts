/**
 * The source-time ↔ output-time basics of the edit model, pure and shared: the renderer's timeline
 * (renderer/engine/timeline.ts re-exports all of this) and the agent's project view (agentProject.ts)
 * must agree on how long a project is once its cuts are applied, so the rule lives in one place.
 * All times are source milliseconds; cuts are removed ranges.
 */
import type { CutRange } from './types'

export interface Segment {
  start: number
  end: number
}

/** a kept piece shorter than this is dropped (see keepSegments) */
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
