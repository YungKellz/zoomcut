import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { AudioClip } from '@shared/types'
import { audioClipPath, isRecordedClip } from '@shared/audio'
import { useProject, useStore } from '../store'
import { keepSegments, outputDuration, segmentAt, srcToOut, type Segment } from '../engine/timeline'

const SYNC_INTERVAL_MS = 100
const DRIFT_THRESHOLD_S = 0.08

interface ActiveInfo {
  active: boolean
  /** ms into the clip's own file */
  fileTime: number
}

/** Recorded clips (system/mic) follow SOURCE time, like the video itself: cut pieces silence them too. */
function recordedActive(clip: AudioClip, playheadMs: number, segments: Segment[]): ActiveInfo {
  const fileTime = playheadMs - clip.start
  const insideKeptSegment = segmentAt(playheadMs, segments) !== null
  return { active: insideKeptSegment && fileTime >= 0 && fileTime < clip.durationMs, fileTime }
}

/** Overlay clips (voiceover/music/file, added in A2) follow OUTPUT time; cuts do not move them. */
function overlayActive(clip: AudioClip, playheadMs: number, segments: Segment[], outDurationMs: number): ActiveInfo {
  const outT = srcToOut(playheadMs, segments)
  const raw = outT - clip.start
  const looped = clip.loop && clip.durationMs > 0
  const fileTime = looped ? ((raw % clip.durationMs) + clip.durationMs) % clip.durationMs : raw
  const active = raw >= 0 && (clip.loop || raw < clip.durationMs) && outT < outDurationMs
  return { active, fileTime }
}

/**
 * Mounted next to <Preview>: one hidden <audio> element per project audio clip, kept in
 * sync with the preview's video clock on a 100 ms interval (and on every explicit seek /
 * play-pause change). currentTime is only nudged when it drifts more than 80 ms from where
 * it should be – resyncing every tick would make playback stutter.
 */
export function AudioPlayer(): JSX.Element {
  const project = useProject()
  const playing = useStore((s) => s.playing)
  const seekSeq = useStore((s) => s.seekSeq)
  const audioMuted = useStore((s) => s.audioMuted)
  const elements = useRef(new Map<string, HTMLAudioElement>())

  const sync = (): void => {
    const p = useStore.getState().project
    if (!p) return
    const isPlaying = useStore.getState().playing
    const globalMuted = useStore.getState().audioMuted
    const playheadMs = useStore.getState().playheadMs
    const segments = keepSegments(p.recording.durationMs, p.cuts)
    const outDurationMs = outputDuration(segments)
    for (const clip of p.audio) {
      const el = elements.current.get(clip.id)
      if (!el) continue
      const info = isRecordedClip(clip)
        ? recordedActive(clip, playheadMs, segments)
        : overlayActive(clip, playheadMs, segments, outDurationMs)
      const silent = globalMuted || clip.muted || clip.volume <= 0
      el.volume = Math.max(0, Math.min(1, clip.volume))
      el.muted = silent
      if (!info.active || !isPlaying || silent) {
        if (!el.paused) el.pause()
        continue
      }
      const fileTimeS = Math.max(0, info.fileTime / 1000)
      if (Math.abs(el.currentTime - fileTimeS) > DRIFT_THRESHOLD_S) el.currentTime = fileTimeS
      if (el.paused) void el.play().catch(() => undefined)
    }
  }

  // 100 ms poll, matching the sync rule in DESIGN.md
  useEffect(() => {
    sync()
    const timer = window.setInterval(sync, SYNC_INTERVAL_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // and immediately on the events that matter, so playback/seeks do not wait for the next poll
  useEffect(() => {
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekSeq, playing, audioMuted, project.audio])

  return (
    <div className="audio-player">
      {project.audio.map((clip) => (
        <audio
          key={clip.id}
          ref={(el) => {
            if (el) elements.current.set(clip.id, el)
            else elements.current.delete(clip.id)
          }}
          src={window.zc.media.url(audioClipPath(project, clip))}
          preload="auto"
        />
      ))}
    </div>
  )
}
