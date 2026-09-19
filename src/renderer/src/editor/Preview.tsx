import type React from 'react'
import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, SkipBack } from 'lucide-react'
import type { CropRect, Project, WindowRect } from '@shared/types'
import { useProject, useStore } from '../store'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, layoutText, outputSize, textIsActive, TRANSPARENT_BACKGROUND, type OutputSize } from '../engine/compose'
import { keepSegments, lastKeptTime, outputDuration, srcToOut, type Segment } from '../engine/timeline'
import { uniqueWindows, windowToCrop } from '../engine/windows'
import { formatTimecode } from '../util/format'
import { clamp } from '../util/format'
import { useT } from '../i18n'

interface Props {
  followPath: FollowPath | null
}

interface Size {
  w: number
  h: number
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/** Project variant used while editing the crop or picking a zoom target: full source, no frame. */
function rawProject(project: Project): Project {
  return { ...project, crop: { x: 0, y: 0, w: 1, h: 1 }, frame: { ...project.frame, padding: 0, cornerRadius: 0 } }
}

interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

function segmentIndexAt(segments: Segment[], t: number): number {
  return segments.findIndex((s) => t >= s.start && t < s.end)
}

function nextSegmentIndex(segments: Segment[], t: number): number {
  return segments.findIndex((s) => s.start > t - 1)
}

/**
 * Preview player. Two <video> elements share the source: while one plays a kept
 * segment, the other is already seeked to the start of the next one, so jumping over
 * a removed piece is a swap instead of a seek and playback does not stall.
 */
export function Preview({ followPath }: Props): JSX.Element {
  const t = useT()
  const project = useProject()
  const mode = useStore((s) => s.mode)
  const playing = useStore((s) => s.playing)
  const seekSeq = useStore((s) => s.seekSeq)
  const selection = useStore((s) => s.selection)
  const playheadMs = useStore((s) => s.playheadMs)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const togglePlay = useStore((s) => s.togglePlay)
  const playFromStart = useStore((s) => s.playFromStart)
  const updateText = useStore((s) => s.updateText)
  const updateZoom = useStore((s) => s.updateZoom)
  const setCrop = useStore((s) => s.setCrop)
  const checkpoint = useStore((s) => s.checkpoint)
  const setMode = useStore((s) => s.setMode)

  const [viewportRef, viewport] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const activeRef = useRef<0 | 1>(0)
  const standby = useRef<{ segIndex: number; ready: boolean }>({ segIndex: -1, ready: false })
  const [readyCount, setReadyCount] = useState(0)
  const ready = readyCount >= 2
  const [pickRect, setPickRect] = useState<PxRect | null>(null)
  const [hoverWindow, setHoverWindow] = useState<number | null>(null)

  const activeVideo = useCallback((): HTMLVideoElement | null => (activeRef.current === 0 ? videoARef.current : videoBRef.current), [])
  const standbyVideo = useCallback((): HTMLVideoElement | null => (activeRef.current === 0 ? videoBRef.current : videoARef.current), [])

  const editRaw = mode !== 'normal'
  const viewProject = useMemo(() => (editRaw ? rawProject(project) : project), [editRaw, project])
  const size: OutputSize = useMemo(
    () => outputSize(viewProject, 1, { maxW: Math.max(64, viewport.w - 24), maxH: Math.max(64, viewport.h - 24) }),
    [viewProject, viewport.w, viewport.h]
  )
  const segments = useMemo(() => keepSegments(project.recording.durationMs, project.cuts), [project.recording.durationMs, project.cuts])
  const outDur = outputDuration(segments)
  const transparent = project.frame.background === TRANSPARENT_BACKGROUND && !editRaw
  const windows = useMemo(() => uniqueWindows(project.windows), [project.windows])

  // keep the latest values in refs for the render loop
  const latest = useRef({ project: viewProject, size, followPath, playing, segments, editRaw })
  latest.current = { project: viewProject, size, followPath, playing, segments, editRaw }

  const prepareStandby = useCallback(
    (segIndex: number) => {
      const s = standbyVideo()
      const segs = latest.current.segments
      if (!s) return
      if (segIndex < 0 || segIndex >= segs.length) {
        standby.current = { segIndex: -1, ready: false }
        return
      }
      if (standby.current.segIndex === segIndex) return
      standby.current = { segIndex, ready: false }
      s.pause()
      const onSeeked = (): void => {
        if (standby.current.segIndex === segIndex) standby.current.ready = true
      }
      s.addEventListener('seeked', onSeeked, { once: true })
      s.currentTime = segs[segIndex].start / 1000
    },
    [standbyVideo]
  )

  // load the source video into both players
  useEffect(() => {
    const videos = [videoARef.current, videoBRef.current]
    setReadyCount(0)
    standby.current = { segIndex: -1, ready: false }
    const offs: Array<() => void> = []
    for (const video of videos) {
      if (!video) continue
      video.src = window.zc.media.url(project.recording.videoPath)
      const onMeta = (): void => setReadyCount((n) => n + 1)
      video.addEventListener('loadedmetadata', onMeta)
      video.load()
      offs.push(() => video.removeEventListener('loadedmetadata', onMeta))
    }
    return () => offs.forEach((off) => off())
  }, [project.recording.videoPath])

  // explicit seeks from the store
  useEffect(() => {
    const video = activeVideo()
    if (!video || !ready) return
    const tSec = useStore.getState().playheadMs / 1000
    if (Math.abs(video.currentTime - tSec) > 0.001) video.currentTime = tSec
    standby.current = { segIndex: -1, ready: false }
  }, [seekSeq, ready, activeVideo])

  // play / pause
  useEffect(() => {
    const video = activeVideo()
    if (!video || !ready) return
    if (playing) {
      const segs = latest.current.segments
      const head = useStore.getState().playheadMs
      let idx = segmentIndexAt(segs, head)
      let target = head
      if (idx === -1) {
        idx = nextSegmentIndex(segs, head)
        if (idx === -1) {
          setPlaying(false)
          return
        }
        target = segs[idx].start
      }
      if (Math.abs(video.currentTime * 1000 - target) > 30) video.currentTime = target / 1000
      void video.play().catch(() => setPlaying(false))
      prepareStandby(idx + 1)
    } else {
      videoARef.current?.pause()
      videoBRef.current?.pause()
    }
  }, [playing, ready, setPlaying, activeVideo, prepareStandby])

  // render loop
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const canvas = canvasRef.current
      const active = activeVideo()
      if (!active || !canvas || !ready) return
      const { project: p, size: sz, followPath: fp, playing: isPlaying, segments: segs, editRaw: raw } = latest.current
      if (canvas.width !== sz.outW || canvas.height !== sz.outH) {
        canvas.width = sz.outW
        canvas.height = sz.outH
      }
      let tm = useStore.getState().playheadMs
      if (isPlaying) {
        if (active.seeking) return
        const vt = active.currentTime * 1000
        const idx = segmentIndexAt(segs, vt)
        if (idx === -1) {
          const nextIdx = nextSegmentIndex(segs, vt)
          if (nextIdx === -1 || active.ended) {
            active.pause()
            useStore.getState().setPlaying(false)
            useStore.getState().setPlayhead(lastKeptTime(segs), true)
            return
          }
          const other = standbyVideo()
          if (other && standby.current.segIndex === nextIdx && standby.current.ready && !other.seeking) {
            // seamless jump: the standby player already shows the next segment's first frame
            active.pause()
            void other.play().catch(() => undefined)
            activeRef.current = activeRef.current === 0 ? 1 : 0
            standby.current = { segIndex: -1, ready: false }
            prepareStandby(nextIdx + 1)
          } else {
            active.currentTime = segs[nextIdx].start / 1000
          }
          return
        }
        if (idx + 1 < segs.length && standby.current.segIndex !== idx + 1) prepareStandby(idx + 1)
        if (active.paused) void active.play().catch(() => undefined)
        tm = vt
        useStore.getState().setPlayhead(tm)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      composeFrame(ctx, active, p.recording.width, p.recording.height, p, tm, sz, fp, {
        disableZoom: raw,
        disableFrame: raw,
        disableTexts: raw,
        disableCursor: raw
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready, activeVideo, standbyVideo, prepareStandby])

  // ---- overlays ----
  const selectedText = selection?.kind === 'text' ? project.texts.find((x) => x.id === selection.id) : undefined
  const selectedZoom = selection?.kind === 'zoom' ? project.zooms.find((z) => z.id === selection.id) : undefined
  const textBox = useMemo(() => {
    if (!selectedText || editRaw || !textIsActive(selectedText, playheadMs)) return null
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return null
    return layoutText(ctx, selectedText, size.outW, size.outH)
  }, [selectedText, editRaw, playheadMs, size.outW, size.outH])

  const startTextDrag = (e: React.PointerEvent): void => {
    if (!selectedText) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    checkpoint()
    const startX = e.clientX
    const startY = e.clientY
    const origin = { x: selectedText.x, y: selectedText.y }
    const move = (ev: PointerEvent): void => {
      updateText(
        selectedText.id,
        {
          x: clamp(origin.x + (ev.clientX - startX) / size.outW, 0, 1),
          y: clamp(origin.y + (ev.clientY - startY) / size.outH, 0, 1)
        },
        false
      )
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // the source crop in stage pixels (the stage shows the full source in pick / crop modes)
  const cropPx: PxRect = useMemo(
    () => ({ x: project.crop.x * size.outW, y: project.crop.y * size.outH, w: project.crop.w * size.outW, h: project.crop.h * size.outH }),
    [project.crop, size.outW, size.outH]
  )

  /**
   * Pick mode: a click sets the focus point, dragging draws a rectangle that keeps the
   * crop's proportions, stays inside the crop and never asks for more than 5× zoom.
   */
  const startPick = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (mode !== 'pickTarget' || !selectedZoom) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const aspect = cropPx.w / cropPx.h
    const minW = cropPx.w / 5
    const maxW = cropPx.w / 1.2
    const p0 = {
      x: clamp(e.clientX - rect.left, cropPx.x, cropPx.x + cropPx.w),
      y: clamp(e.clientY - rect.top, cropPx.y, cropPx.y + cropPx.h)
    }
    const rectFrom = (px: number, py: number): PxRect => {
      const dx = px - p0.x
      const dy = py - p0.y
      const sx = dx >= 0 ? 1 : -1
      const sy = dy >= 0 ? 1 : -1
      const availW = sx > 0 ? cropPx.x + cropPx.w - p0.x : p0.x - cropPx.x
      const availH = sy > 0 ? cropPx.y + cropPx.h - p0.y : p0.y - cropPx.y
      let w = Math.max(Math.abs(dx), Math.abs(dy) * aspect)
      w = Math.min(w, maxW, availW, availH * aspect)
      const h = w / aspect
      return { x: sx > 0 ? p0.x : p0.x - w, y: sy > 0 ? p0.y : p0.y - h, w, h }
    }
    const enforceMin = (r: PxRect): PxRect => {
      if (r.w >= minW) return r
      const w = minW
      const h = minW / aspect
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      return {
        x: clamp(cx - w / 2, cropPx.x, cropPx.x + cropPx.w - w),
        y: clamp(cy - h / 2, cropPx.y, cropPx.y + cropPx.h - h),
        w,
        h
      }
    }
    setPickRect(null)
    const move = (ev: PointerEvent): void => {
      const r = rectFrom(ev.clientX - rect.left, ev.clientY - rect.top)
      setPickRect(r.w < 6 ? null : enforceMin(r))
    }
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setPickRect(null)
      const r = rectFrom(ev.clientX - rect.left, ev.clientY - rect.top)
      if (r.w < 6) {
        updateZoom(selectedZoom.id, { mode: 'fixed', target: { x: p0.x / rect.width, y: p0.y / rect.height } })
      } else {
        const fr = enforceMin(r)
        updateZoom(selectedZoom.id, {
          mode: 'fixed',
          target: { x: (fr.x + fr.w / 2) / rect.width, y: (fr.y + fr.h / 2) / rect.height },
          scale: clamp(Math.round((cropPx.w / fr.w) * 10) / 10, 1.2, 5)
        })
      }
      setMode('normal')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const cropToWindow = (w: WindowRect): void => {
    checkpoint()
    setCrop(windowToCrop(w), false)
  }

  const showCropShade = mode === 'crop' || mode === 'pickTarget'

  return (
    <div className="preview">
      <div className="preview-viewport" ref={viewportRef}>
        <div className={'preview-stage' + (transparent ? ' checker' : '')} style={{ width: size.outW, height: size.outH }}>
          <canvas
            ref={canvasRef}
            className={'preview-canvas' + (mode === 'pickTarget' ? ' picking' : '')}
            width={size.outW}
            height={size.outH}
            onPointerDown={startPick}
          />
          {!ready && <div className="preview-loading">{t('preview.loading')}</div>}

          {textBox && (
            <div
              className="text-box"
              style={{ left: textBox.x, top: textBox.y, width: textBox.w, height: textBox.h }}
              onPointerDown={startTextDrag}
              title={t('preview.dragToMove')}
            />
          )}

          {showCropShade && <CropShade crop={cropPx} stage={size} />}

          {mode === 'pickTarget' && selectedZoom && !pickRect && (
            <div className="target-marker" style={{ left: selectedZoom.target.x * size.outW, top: selectedZoom.target.y * size.outH }} />
          )}
          {pickRect && <div className="pick-rect" style={{ left: pickRect.x, top: pickRect.y, width: pickRect.w, height: pickRect.h }} />}

          {mode === 'crop' &&
            windows.map((w, i) => (
              <div
                key={i}
                className={'win-outline' + (hoverWindow === i ? ' hover' : '')}
                style={{ left: w.x * size.outW, top: w.y * size.outH, width: w.w * size.outW, height: w.h * size.outH }}
                title={w.title}
                onPointerEnter={() => setHoverWindow(i)}
                onPointerLeave={() => setHoverWindow((cur) => (cur === i ? null : cur))}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  cropToWindow(w)
                }}
              >
                <span>{w.title}</span>
              </div>
            ))}

          {mode === 'crop' && <CropEditor crop={project.crop} size={size} onChange={(c, commit) => setCrop(c, commit)} onBegin={checkpoint} />}
        </div>
      </div>

      <div className="preview-controls">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setPlaying(false)
            setPlayhead(segments[0]?.start ?? 0, true)
          }}
          title={t('preview.goStart')}
        >
          <SkipBack size={16} />
        </button>
        <button className="btn btn-ghost" onClick={playFromStart} disabled={mode !== 'normal'} title={t('preview.playFromStart')}>
          <RotateCcw size={16} />
        </button>
        <button className="btn btn-ghost" onClick={togglePlay} disabled={mode !== 'normal'} title={t('preview.playPause')}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="timecode">{formatTimecode(srcToOut(playheadMs, segments))}</span>
        <span className="muted">/ {formatTimecode(outDur)}</span>
        <span className="muted small source-time">{t('preview.sourceTime', { time: formatTimecode(playheadMs) })}</span>
        {mode === 'pickTarget' && <span className="hint">{t('preview.pickHint')}</span>}
        {mode === 'crop' && (
          <span className="hint">
            {windows.length > 0 ? t('preview.cropWindowHint') + ' ' : ''}
            {t('preview.cropHint')}{' '}
            <button className="link" onClick={() => setMode('normal')}>
              {t('common.done')}
            </button>
          </span>
        )}
      </div>
      <video ref={videoARef} className="hidden-video" muted playsInline preload="auto" crossOrigin="anonymous" />
      <video ref={videoBRef} className="hidden-video" muted playsInline preload="auto" crossOrigin="anonymous" />
    </div>
  )
}

/** Darkens everything outside the source crop. */
function CropShade({ crop, stage }: { crop: PxRect; stage: OutputSize }): JSX.Element {
  const W = stage.outW
  const H = stage.outH
  return (
    <>
      <div className="crop-shade" style={{ left: 0, top: 0, width: W, height: crop.y }} />
      <div className="crop-shade" style={{ left: 0, top: crop.y + crop.h, width: W, height: Math.max(0, H - crop.y - crop.h) }} />
      <div className="crop-shade" style={{ left: 0, top: crop.y, width: crop.x, height: crop.h }} />
      <div className="crop-shade" style={{ left: crop.x + crop.w, top: crop.y, width: Math.max(0, W - crop.x - crop.w), height: crop.h }} />
    </>
  )
}

interface CropEditorProps {
  crop: CropRect
  size: OutputSize
  onChange: (crop: CropRect, commit: boolean) => void
  onBegin: () => void
}

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

function CropEditor({ crop, size, onChange, onBegin }: CropEditorProps): JSX.Element {
  const W = size.outW
  const H = size.outH
  const MIN = 0.05

  const start = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    onBegin()
    const sx = e.clientX
    const sy = e.clientY
    const o = { ...crop }
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - sx) / W
      const dy = (ev.clientY - sy) / H
      let { x, y, w, h } = o
      if (handle === 'move') {
        x = clamp(o.x + dx, 0, 1 - o.w)
        y = clamp(o.y + dy, 0, 1 - o.h)
      } else {
        if (handle.includes('w')) {
          const nx = clamp(o.x + dx, 0, o.x + o.w - MIN)
          w = o.w + (o.x - nx)
          x = nx
        }
        if (handle.includes('e')) w = clamp(o.w + dx, MIN, 1 - o.x)
        if (handle.includes('n')) {
          const ny = clamp(o.y + dy, 0, o.y + o.h - MIN)
          h = o.h + (o.y - ny)
          y = ny
        }
        if (handle.includes('s')) h = clamp(o.h + dy, MIN, 1 - o.y)
      }
      onChange({ x, y, w, h }, false)
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const left = crop.x * W
  const top = crop.y * H
  const width = crop.w * W
  const height = crop.h * H
  const handles: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  return (
    <div className="crop-rect" style={{ left, top, width, height }} onPointerDown={start('move')}>
      {handles.map((h) => (
        <div key={h} className={`crop-handle crop-${h}`} onPointerDown={start(h)} />
      ))}
    </div>
  )
}
