import type { AudioClip, AudioExportPiece, AudioExportPlan, AudioExportTrack, Project } from '@shared/types'
import { audioClipPath, isRecordedClip } from '@shared/audio'
import { outputDuration, srcToOut, type Segment } from '../engine/timeline'

/**
 * One piece per kept segment: the file's own [0, durationMs) window mapped onto that
 * segment. When the segment starts before the file's own t=0 (a negative clip.start, or a
 * segment that starts earlier than the recorder did), fileStart clamps up to 0 – but the
 * piece must then start later in output time too (by the same amount), or it would play
 * audio that was never recorded.
 */
function recordedPieces(clip: AudioClip, segments: Segment[]): AudioExportPiece[] {
  const pieces: AudioExportPiece[] = []
  for (const seg of segments) {
    const raw = seg.start - clip.start
    const fileStart = Math.max(0, raw)
    const shift = fileStart - raw
    const fileEnd = Math.max(0, Math.min(clip.durationMs, seg.end - clip.start))
    if (fileEnd <= fileStart) continue
    pieces.push({ fileStart, fileEnd, outAt: srcToOut(seg.start, segments) + shift })
  }
  return pieces
}

/**
 * One piece starting at the clip's own OUTPUT-time start; loop is expressed as
 * fileEnd > durationMs. A negative clip.start (the clip wants to start before the output
 * begins) clamps outAt up to 0 and shifts fileStart forward by the same amount, mirroring
 * recordedPieces – otherwise the truncated lead-in would play at the wrong output time.
 */
function overlayPiece(clip: AudioClip, outDurationMs: number): AudioExportPiece | null {
  const outAt = Math.max(0, clip.start)
  if (outAt >= outDurationMs) return null
  const fileStart = Math.max(0, -clip.start)
  const availableOut = outDurationMs - outAt
  const fileEnd = clip.loop ? fileStart + availableOut : Math.min(clip.durationMs, fileStart + availableOut)
  if (fileEnd <= fileStart) return null
  return { fileStart, fileEnd, outAt }
}

/**
 * Turns the project's audio clips into the ffmpeg-ready plan consumed by finalizeMp4 (see
 * src/main/media/ffmpeg.ts, via src/main/media/audioGraph.ts). Returns null when nothing
 * would actually be audible, so callers can skip the -filter_complex path (and GIF exports
 * can ignore audio entirely).
 */
export function buildAudioPlan(project: Project, segments: Segment[]): AudioExportPlan | null {
  const outDurationMs = outputDuration(segments)
  const tracks: AudioExportTrack[] = []
  for (const clip of project.audio) {
    if (clip.muted || clip.volume <= 0) continue
    const pieces = isRecordedClip(clip) ? recordedPieces(clip, segments) : filterNulls([overlayPiece(clip, outDurationMs)])
    if (pieces.length === 0) continue
    tracks.push({
      path: audioClipPath(project, clip),
      durationMs: clip.durationMs,
      pieces,
      volume: clip.volume,
      fadeInMs: clip.fadeInMs,
      fadeOutMs: clip.fadeOutMs
    })
  }
  if (tracks.length === 0) return null
  return { tracks, outDurationMs }
}

function filterNulls<T>(xs: Array<T | null>): T[] {
  return xs.filter((x): x is T => x !== null)
}
