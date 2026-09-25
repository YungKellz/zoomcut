import type { AudioExportPlan, Composition, CompositionItem, Project } from '@shared/types'
import { buildFollowPath, type FollowPath } from '../engine/cursor'
import { outputSize, type OutputSize } from '../engine/compose'
import { keepSegments, outputDuration, type Segment } from '../engine/timeline'
import { buildAudioPlan } from '../export/audioPlan'

/** A composition item resolved against its (current) project. */
export interface CompositionEntry {
  item: CompositionItem
  project: Project
  segments: Segment[]
  /** output duration of the recording after its cuts */
  outMs: number
  followPath: FollowPath | null
}

export function makeEntry(item: CompositionItem, project: Project): CompositionEntry {
  const segments = keepSegments(project.recording.durationMs, project.cuts)
  const { followSmoothing, followDeadZone, offsetMs } = project.cursor
  const followPath = project.cursorData.samples.length
    ? buildFollowPath(project.cursorData.samples, { followSmoothing, followDeadZone, offsetMs }, project.recording.durationMs)
    : null
  return { item, project, segments, outMs: outputDuration(segments), followPath }
}

export interface CompositionSpan {
  entry: CompositionEntry
  /** composition output time (ms) where this recording starts */
  outOffset: number
}

export interface CompositionLayout {
  spans: CompositionSpan[]
  totalMs: number
}

/** Places the recordings one after another; a recording that is cut out entirely is skipped. */
export function compositionLayout(entries: CompositionEntry[]): CompositionLayout {
  const spans: CompositionSpan[] = []
  let at = 0
  for (const entry of entries) {
    if (entry.outMs <= 0) continue
    spans.push({ entry, outOffset: at })
    at += entry.outMs
  }
  return { spans, totalMs: at }
}

/** Which span plays at composition time `tOut`, and the time inside that recording's output. */
export function locate(layout: CompositionLayout, tOut: number): { index: number; localOut: number } | null {
  const { spans } = layout
  if (spans.length === 0) return null
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if (tOut < s.outOffset + s.entry.outMs) return { index: i, localOut: Math.max(0, tOut - s.outOffset) }
  }
  const last = spans[spans.length - 1]
  return { index: spans.length - 1, localOut: last.entry.outMs }
}

export function evenPx(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** Output frame at 100 %: the chosen size, or the first recording's own output size. */
export function compositionFrame(composition: Pick<Composition, 'size'>, entries: CompositionEntry[]): { width: number; height: number } {
  if (composition.size) return { width: evenPx(composition.size.width), height: evenPx(composition.size.height) }
  const first = entries[0]
  if (!first) return { width: 1920, height: 1080 }
  const size = outputSize(first.project, 1)
  return { width: size.outW, height: size.outH }
}

/** Output scale at which the project's frame fits inside `maxW` × `maxH` (up or down). */
export function fitScale(project: Project, maxW: number, maxH: number): number {
  const base = outputSize(project, 1)
  return Math.min(maxW / base.outW, maxH / base.outH)
}

/** The project's output geometry scaled (up or down) to fit inside `maxW` × `maxH`. */
export function fitOutputSize(project: Project, maxW: number, maxH: number): OutputSize {
  return outputSize(project, fitScale(project, maxW, maxH), { maxW, maxH })
}

export function centerBox(w: number, h: number, frameW: number, frameH: number): { x: number; y: number } {
  return { x: Math.round((frameW - w) / 2), y: Math.round((frameH - h) / 2) }
}

/** Every recording's own audio plan, shifted to where the recording starts in the composition. */
export function compositionAudioPlan(layout: CompositionLayout): AudioExportPlan | null {
  const tracks: AudioExportPlan['tracks'] = []
  for (const { entry, outOffset } of layout.spans) {
    const plan = buildAudioPlan(entry.project, entry.segments)
    if (!plan) continue
    for (const track of plan.tracks) {
      tracks.push({ ...track, pieces: track.pieces.map((p) => ({ ...p, outAt: p.outAt + outOffset })) })
    }
  }
  if (tracks.length === 0) return null
  return { tracks, outDurationMs: layout.totalMs }
}
