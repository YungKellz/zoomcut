import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Rewind, SkipBack } from 'lucide-react'
import type { CropRect, Project } from '@shared/types'
import { useProject, useStore } from '../store'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, layoutText, outputSize, textIsActive, TRANSPARENT_BACKGROUND, type OutputSize } from '../engine/compose'
import { keepSegments, lastKeptTime, outputDuration, resolvePlayableTime, srcToOut } from '../engine/timeline'
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

interface PickRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

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
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [pickRect, setPickRect] = useState<PickRect | null>(null)

  const editRaw = mode !== 'normal'
  const viewProject = useMemo(() => (editRaw ? rawProject(project) : project), [editRaw, project])
  const size: OutputSize = useMemo(
    () => outputSize(viewProject, 1, { maxW: Math.max(64, viewport.w - 24), maxH: Math.max(64, viewport.h - 24) }),
    [viewProject, viewport.w, viewport.h]
  )
  const segments = useMemo(() => keepSegments(project.recording.durationMs, project.cuts), [project.recording.durationMs, project.cuts])
  const outDur = outputDuration(segments)
  const transparent = project.frame.background === TRANSPARENT_BACKGROUND && !editRaw

  // keep the latest values in refs for the render loop
  const latest = useRef({ project: viewProject, size, followPath, playing, segments, editRaw })
  latest.current = { project: viewProject, size, followPath, playing, segments, editRaw }

  // load the source video
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setReady(false)
    video.src = window.zc.media.url(project.recording.videoPath)
    const onMeta = (): void => setReady(true)
    video.addEventListener('loadedmetadata', onMeta)
    video.load()
    return () => video.removeEventListener('loadedmetadata', onMeta)
  }, [project.recording.videoPath])

  // explicit seeks from the store
  useEffect(() => {
    const video = videoRef.current
    if (!video || !ready) return
    const tSec = useStore.getState().playheadMs / 1000
    if (Math.abs(video.currentTime - tSec) > 0.001) video.currentTime = tSec
  }, [seekSeq, ready])

  // play / pause
  useEffect(() => {
    const video = videoRef.current
    if (!video || !ready) return
    if (playing) {
      const playable = resolvePlayableTime(useStore.getState().playheadMs, latest.current.segments)
      if (playable === null) {
        setPlaying(false)
        return
      }
      if (Math.abs(video.currentTime * 1000 - playable) > 30) video.currentTime = playable / 1000
      void video.play().catch(() => setPlaying(false))
    } else {
      video.pause()
    }
  }, [playing, ready, setPlaying])

  // render loop
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || !ready) return
      const { project: p, size: sz, followPath: fp, playing: isPlaying, segments: segs, editRaw: raw } = latest.current
      if (canvas.width !== sz.outW || canvas.height !== sz.outH) {
        canvas.width = sz.outW
        canvas.height = sz.outH
      }
      let tm = useStore.getState().playheadMs
      if (isPlaying) {
        if (video.seeking) return // a jump over a cut is in flight; wait for it
        const vt = video.currentTime * 1000
        const playable = resolvePlayableTime(vt, segs)
        if (playable === null || video.ended) {
          video.pause()
          useStore.getState().setPlaying(false)
          useStore.getState().setPlayhead(lastKeptTime(segs), true)
          return
        }
        if (playable - vt > 1) {
          // inside a removed piece: jump to the next kept segment
          video.currentTime = playable / 1000
          return
        }
        if (video.paused) void video.play().catch(() => undefined)
        tm = vt
        useStore.getState().setPlayhead(tm)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      composeFrame(ctx, video, p.recording.width, p.recording.height, p, tm, sz, fp, {
        disableZoom: raw,
        disableFrame: raw,
        disableTexts: raw,
        disableCursor: raw
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready])

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

  /** Pick mode: a click sets the focus point, dragging a rectangle sets point + zoom level. */
  const startPick = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (mode !== 'pickTarget' || !selectedZoom) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const x0 = clamp(e.clientX - rect.left, 0, rect.width)
    const y0 = clamp(e.clientY - rect.top, 0, rect.height)
    setPickRect({ x0, y0, x1: x0, y1: y0 })
    const move = (ev: PointerEvent): void => {
      setPickRect({ x0, y0, x1: clamp(ev.clientX - rect.left, 0, rect.width), y1: clamp(ev.clientY - rect.top, 0, rect.height) })
    }
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setPickRect(null)
      const x1 = clamp(ev.clientX - rect.left, 0, rect.width)
      const y1 = clamp(ev.clientY - rect.top, 0, rect.height)
      const w = Math.abs(x1 - x0)
      const h = Math.abs(y1 - y0)
      const crop = project.crop
      if (w < 6 || h < 6) {
        updateZoom(selectedZoom.id, { mode: 'fixed', target: { x: x0 / rect.width, y: y0 / rect.height } })
      } else {
        // area → the zoom level that makes the rectangle fill the (cropped) frame
        const rw = w / rect.width / crop.w
        const rh = h / rect.height / crop.h
        const scale = clamp(Math.min(1 / rw, 1 / rh), 1.2, 5)
        updateZoom(selectedZoom.id, {
          mode: 'fixed',
          target: { x: (x0 + x1) / 2 / rect.width, y: (y0 + y1) / 2 / rect.height },
          scale: Math.round(scale * 10) / 10
        })
      }
      setMode('normal')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

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

          {mode === 'pickTarget' && selectedZoom && !pickRect && (
            <div className="target-marker" style={{ left: selectedZoom.target.x * size.outW, top: selectedZoom.target.y * size.outH }} />
          )}
          {pickRect && (
            <div
              className="pick-rect"
              style={{
                left: Math.min(pickRect.x0, pickRect.x1),
                top: Math.min(pickRect.y0, pickRect.y1),
                width: Math.abs(pickRect.x1 - pickRect.x0),
                height: Math.abs(pickRect.y1 - pickRect.y0)
              }}
            />
          )}

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
          <Rewind size={16} />
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
            {t('preview.cropHint')}{' '}
            <button className="link" onClick={() => setMode('normal')}>
              {t('common.done')}
            </button>
          </span>
        )}
      </div>
      <video ref={videoRef} className="hidden-video" muted playsInline preload="auto" crossOrigin="anonymous" />
    </div>
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
    <>
      <div className="crop-shade" style={{ left: 0, top: 0, width: W, height: top }} />
      <div className="crop-shade" style={{ left: 0, top: top + height, width: W, height: H - top - height }} />
      <div className="crop-shade" style={{ left: 0, top, width: left, height }} />
      <div className="crop-shade" style={{ left: left + width, top, width: W - left - width, height }} />
      <div className="crop-rect" style={{ left, top, width, height }} onPointerDown={start('move')}>
        {handles.map((h) => (
          <div key={h} className={`crop-handle crop-${h}`} onPointerDown={start(h)} />
        ))}
      </div>
    </>
  )
}
