import type React from 'react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, SkipBack } from 'lucide-react'
import type { AudioClip } from '@shared/types'
import { audioClipPath, isRecordedClip } from '@shared/audio'
import { composeFrame } from '../engine/compose'
import { firstKeptTime, outToSrc, srcToOut, type Segment } from '../engine/timeline'
import { overlayActive, recordedActive } from '../editor/AudioPlayer'
import { useElementSize } from '../hooks/useElementSize'
import { clamp, formatTimecode } from '../util/format'
import { useT } from '../i18n'
import { centerBox, fitOutputSize, locate, type CompositionLayout } from './layout'

interface Props {
  layout: CompositionLayout
  frame: { width: number; height: number }
  background: string
}

const DRIFT_THRESHOLD_S = 0.08

function segmentIndexAt(segments: Segment[], t: number): number {
  return segments.findIndex((s) => t >= s.start && t < s.end)
}

function nextSegmentIndex(segments: Segment[], t: number): number {
  return segments.findIndex((s) => s.start > t - 1)
}

interface AudioSlot {
  key: string
  span: number
  clip: AudioClip
  url: string
}

/**
 * Plays a composition: one hidden <video> per recording, the one under the playhead drives
 * the clock. Each frame is drawn with the recording's own composeFrame (all its edits) into a
 * scratch canvas and fitted into the composition frame. Jumps over cuts are seeks - good
 * enough for a preview; the export walks the frames exactly.
 */
export function CompositionPlayer({ layout, frame, background }: Props): JSX.Element {
  const t = useT()
  const [viewportRef, viewport] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const itemCanvas = useRef<HTMLCanvasElement | null>(null)
  const videos = useRef(new Map<number, HTMLVideoElement>())
  const audios = useRef(new Map<string, HTMLAudioElement>())
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const [playing, setPlayingState] = useState(false)
  const [time, setTime] = useState(0)

  const k = Math.min(1, Math.max(64, viewport.w - 24) / frame.width, Math.max(64, viewport.h - 24) / frame.height)
  const stageW = Math.max(2, Math.round(frame.width * k))
  const stageH = Math.max(2, Math.round(frame.height * k))

  const spansKey = layout.spans.map((s) => s.entry.item.id + ':' + s.entry.project.recording.videoPath).join('|')
  const audioSlots: AudioSlot[] = useMemo(
    () =>
      layout.spans.flatMap((s, span) =>
        s.entry.project.audio.map((clip) => ({
          key: `${s.entry.item.id}:${clip.id}`,
          span,
          clip,
          url: window.zc.media.url(audioClipPath(s.entry.project, clip))
        }))
      ),
    [layout]
  )

  const latest = useRef({ layout, background, stageW, stageH, audioSlots })
  latest.current = { layout, background, stageW, stageH, audioSlots }

  const setPlaying = useCallback((value: boolean) => {
    playingRef.current = value
    setPlayingState(value)
    if (!value) {
      for (const v of videos.current.values()) v.pause()
      for (const a of audios.current.values()) a.pause()
    }
  }, [])

  /** Puts the video of the span under `tOut` on the right frame (and plays it while playing). */
  const seek = useCallback((tOut: number) => {
    const { layout: L } = latest.current
    const tm = clamp(tOut, 0, L.totalMs)
    timeRef.current = tm
    setTime(tm)
    const loc = locate(L, tm)
    if (!loc) return
    const span = L.spans[loc.index]
    for (const [i, v] of videos.current) if (i !== loc.index) v.pause()
    const video = videos.current.get(loc.index)
    if (!video) return
    const tSrc = outToSrc(Math.min(loc.localOut, span.entry.outMs - 1), span.entry.segments)
    video.currentTime = tSrc / 1000
    if (playingRef.current) void video.play().catch(() => undefined)
  }, [])

  const togglePlay = (): void => {
    if (playingRef.current) {
      setPlaying(false)
      return
    }
    if (layout.totalMs <= 0) return
    const from = timeRef.current >= layout.totalMs - 30 ? 0 : timeRef.current
    playingRef.current = true
    setPlayingState(true)
    seek(from)
  }

  // a changed composition (items reordered, a recording edited) restarts from a valid spot
  useEffect(() => {
    setPlaying(false)
    seek(Math.min(timeRef.current, latest.current.layout.totalMs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spansKey, layout.totalMs])

  // render loop
  useEffect(() => {
    let raf = 0
    let lastUi = -1
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const canvas = canvasRef.current
      if (!canvas) return
      const { layout: L, background: bg, stageW: W, stageH: H } = latest.current
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)
      const loc = locate(L, timeRef.current)
      if (!loc) return
      const span = L.spans[loc.index]
      const video = videos.current.get(loc.index)
      if (!video || video.readyState < 2) return
      const segs = span.entry.segments

      if (playingRef.current && !video.seeking) {
        const vt = video.currentTime * 1000
        const idx = segmentIndexAt(segs, vt)
        if (idx === -1 || video.ended) {
          const nextIdx = video.ended ? -1 : nextSegmentIndex(segs, vt)
          if (nextIdx !== -1) {
            video.currentTime = segs[nextIdx].start / 1000
          } else if (loc.index + 1 < L.spans.length) {
            // on to the next recording
            video.pause()
            const next = L.spans[loc.index + 1]
            timeRef.current = next.outOffset
            const nv = videos.current.get(loc.index + 1)
            if (nv) {
              nv.currentTime = firstKeptTime(next.entry.segments) / 1000
              void nv.play().catch(() => undefined)
            }
            return
          } else {
            timeRef.current = L.totalMs
            setTime(L.totalMs)
            setPlaying(false)
            return
          }
        } else {
          timeRef.current = span.outOffset + srcToOut(vt, segs)
          if (video.paused) void video.play().catch(() => undefined)
        }
      }

      const p = span.entry.project
      const size = fitOutputSize(p, W, H)
      if (!itemCanvas.current) itemCanvas.current = document.createElement('canvas')
      const ic = itemCanvas.current
      if (ic.width !== size.outW || ic.height !== size.outH) {
        ic.width = size.outW
        ic.height = size.outH
      }
      const ictx = ic.getContext('2d')
      if (!ictx) return
      composeFrame(ictx, video, p.recording.width, p.recording.height, p, video.currentTime * 1000, size, span.entry.followPath)
      const box = centerBox(size.outW, size.outH, W, H)
      ctx.drawImage(ic, box.x, box.y)

      if (Math.abs(timeRef.current - lastUi) > 40) {
        lastUi = timeRef.current
        setTime(timeRef.current)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [setPlaying])

  // audio: only the clips of the recording under the playhead play, synced like the editor's AudioPlayer
  useEffect(() => {
    const sync = (): void => {
      const { layout: L, audioSlots: slots } = latest.current
      const loc = locate(L, timeRef.current)
      const video = loc ? videos.current.get(loc.index) : undefined
      for (const slot of slots) {
        const el = audios.current.get(slot.key)
        if (!el) continue
        const clip = slot.clip
        const silent = clip.muted || clip.volume <= 0
        el.volume = Math.max(0, Math.min(1, clip.volume))
        if (!playingRef.current || !loc || !video || slot.span !== loc.index || silent) {
          if (!el.paused) el.pause()
          continue
        }
        const entry = L.spans[slot.span].entry
        const playheadMs = video.currentTime * 1000
        const info = isRecordedClip(clip)
          ? recordedActive(clip, playheadMs, entry.segments)
          : overlayActive(clip, playheadMs, entry.segments, entry.outMs)
        if (!info.active) {
          if (!el.paused) el.pause()
          continue
        }
        const fileTimeS = Math.max(0, info.fileTime / 1000)
        if (Math.abs(el.currentTime - fileTimeS) > DRIFT_THRESHOLD_S) el.currentTime = fileTimeS
        if (el.paused) void el.play().catch(() => undefined)
      }
    }
    const timer = window.setInterval(sync, 100)
    return () => window.clearInterval(timer)
  }, [])

  // ---- scrub bar ----
  const barRef = useRef<HTMLDivElement>(null)
  const timeFromEvent = (clientX: number): number => {
    const el = barRef.current
    if (!el || layout.totalMs <= 0) return 0
    const r = el.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1) * layout.totalMs
  }
  const scrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    seek(timeFromEvent(e.clientX))
    const move = (ev: PointerEvent): void => seek(timeFromEvent(ev.clientX))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const current = locate(layout, time)

  return (
    <div className="preview comp-player">
      <div className="preview-viewport" ref={viewportRef}>
        <div className="preview-stage" style={{ width: stageW, height: stageH }}>
          <canvas ref={canvasRef} className="preview-canvas" width={stageW} height={stageH} />
          {layout.spans.length === 0 && <div className="preview-loading">{t('composition.emptyPreview')}</div>}
        </div>
      </div>
      <div className="comp-scrub" ref={barRef} onPointerDown={scrub}>
        {layout.spans.map((s, i) => (
          <div
            key={s.entry.item.id}
            className={'comp-scrub-span' + (current?.index === i ? ' active' : '')}
            style={{ left: `${(s.outOffset / Math.max(1, layout.totalMs)) * 100}%`, width: `${(s.entry.outMs / Math.max(1, layout.totalMs)) * 100}%` }}
            title={s.entry.project.name}
          >
            <span>{s.entry.project.name}</span>
          </div>
        ))}
        <div className="comp-scrub-head" style={{ left: `${(time / Math.max(1, layout.totalMs)) * 100}%` }} />
      </div>
      <div className="preview-controls">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setPlaying(false)
            seek(0)
          }}
          title={t('preview.goStart')}
        >
          <SkipBack size={16} />
        </button>
        <button className="btn btn-ghost" onClick={togglePlay} disabled={layout.totalMs <= 0} title={t('preview.playPause')}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="timecode">{formatTimecode(time)}</span>
        <span className="muted">/ {formatTimecode(layout.totalMs)}</span>
        {current && layout.spans[current.index] && (
          <span className="muted small source-time">
            {t('composition.nowPlaying', { n: current.index + 1, name: layout.spans[current.index].entry.project.name })}
          </span>
        )}
      </div>
      {layout.spans.map((s, i) => (
        <video
          key={s.entry.item.id}
          ref={(el) => {
            if (el) videos.current.set(i, el)
            else videos.current.delete(i)
          }}
          className="hidden-video"
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          src={window.zc.media.url(s.entry.project.recording.videoPath)}
        />
      ))}
      <div className="audio-player">
        {audioSlots.map((slot) => (
          <audio
            key={slot.key}
            ref={(el) => {
              if (el) audios.current.set(slot.key, el)
              else audios.current.delete(slot.key)
            }}
            src={slot.url}
            preload="auto"
            loop={slot.clip.loop}
          />
        ))}
      </div>
    </div>
  )
}
