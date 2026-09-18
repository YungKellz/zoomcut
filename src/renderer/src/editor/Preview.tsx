import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, SkipBack } from 'lucide-react'
import type { CropRect, Project } from '@shared/types'
import { useProject, useStore } from '../store'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, layoutText, outputSize, textIsActive, type OutputSize } from '../engine/compose'
import { keepSegments, lastKeptTime, resolvePlayableTime } from '../engine/timeline'
import { formatTimecode } from '../util/format'
import { clamp } from '../util/format'

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

export function Preview({ followPath }: Props): JSX.Element {
  const project = useProject()
  const mode = useStore((s) => s.mode)
  const playing = useStore((s) => s.playing)
  const seekSeq = useStore((s) => s.seekSeq)
  const selection = useStore((s) => s.selection)
  const playheadMs = useStore((s) => s.playheadMs)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const togglePlay = useStore((s) => s.togglePlay)
  const updateText = useStore((s) => s.updateText)
  const updateZoom = useStore((s) => s.updateZoom)
  const setCrop = useStore((s) => s.setCrop)
  const checkpoint = useStore((s) => s.checkpoint)
  const setMode = useStore((s) => s.setMode)

  const [containerRef, container] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)

  const editRaw = mode !== 'normal'
  const viewProject = useMemo(() => (editRaw ? rawProject(project) : project), [editRaw, project])
  const size: OutputSize = useMemo(
    () => outputSize(viewProject, 1, { maxW: Math.max(64, container.w - 24), maxH: Math.max(64, container.h - 24) }),
    [viewProject, container.w, container.h]
  )
  const segments = useMemo(() => keepSegments(project.recording.durationMs, project.cuts), [project.recording.durationMs, project.cuts])

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
    const t = useStore.getState().playheadMs / 1000
    if (Math.abs(video.currentTime - t) > 0.001) video.currentTime = t
  }, [seekSeq, ready])

  // play / pause
  useEffect(() => {
    const video = videoRef.current
    if (!video || !ready) return
    if (playing) {
      const t = resolvePlayableTime(useStore.getState().playheadMs, latest.current.segments)
      if (t === null) {
        setPlaying(false)
        return
      }
      if (Math.abs(video.currentTime * 1000 - t) > 30) video.currentTime = t / 1000
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
      let t = useStore.getState().playheadMs
      if (isPlaying) {
        const vt = video.currentTime * 1000
        const playable = resolvePlayableTime(vt, segs)
        if (playable === null || video.ended) {
          video.pause()
          useStore.getState().setPlaying(false)
          useStore.getState().setPlayhead(lastKeptTime(segs), true)
          return
        }
        if (playable !== vt) {
          video.currentTime = playable / 1000
          return
        }
        t = vt
        useStore.getState().setPlayhead(t)
      }
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      composeFrame(ctx, video, p.recording.width, p.recording.height, p, t, sz, fp, {
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
  const selectedText = selection?.kind === 'text' ? project.texts.find((t) => t.id === selection.id) : undefined
  const selectedZoom = selection?.kind === 'zoom' ? project.zooms.find((z) => z.id === selection.id) : undefined
  const textBox = useMemo(() => {
    if (!selectedText || editRaw || !textIsActive(selectedText, playheadMs)) return null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
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

  const onCanvasClick = (e: React.MouseEvent): void => {
    if (mode !== 'pickTarget' || !selectedZoom) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1)
    updateZoom(selectedZoom.id, { target: { x, y }, mode: 'fixed' })
    setMode('normal')
  }

  return (
    <div className="preview" ref={containerRef}>
      <div className="preview-stage" style={{ width: size.outW, height: size.outH }}>
        <canvas
          ref={canvasRef}
          className={'preview-canvas' + (mode === 'pickTarget' ? ' picking' : '')}
          width={size.outW}
          height={size.outH}
          onClick={onCanvasClick}
        />
        {!ready && <div className="preview-loading">Loading video…</div>}

        {textBox && (
          <div
            className="text-box"
            style={{ left: textBox.x, top: textBox.y, width: textBox.w, height: textBox.h }}
            onPointerDown={startTextDrag}
            title="Drag to move"
          />
        )}

        {mode === 'pickTarget' && selectedZoom && (
          <div
            className="target-marker"
            style={{ left: selectedZoom.target.x * size.outW, top: selectedZoom.target.y * size.outH }}
          />
        )}

        {mode === 'crop' && (
          <CropEditor
            crop={project.crop}
            size={size}
            onChange={(c, commit) => setCrop(c, commit)}
            onBegin={checkpoint}
          />
        )}
      </div>

      <div className="preview-controls">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setPlaying(false)
            setPlayhead(0, true)
          }}
          title="Go to start (Home)"
        >
          <SkipBack size={16} />
        </button>
        <button className="btn btn-ghost" onClick={togglePlay} disabled={mode !== 'normal'} title="Play / pause (Space)">
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="timecode">{formatTimecode(playheadMs)}</span>
        <span className="muted">/ {formatTimecode(project.recording.durationMs)} (source time)</span>
        {mode === 'pickTarget' && <span className="hint">Click on the frame to set the zoom focus point · Esc to cancel</span>}
        {mode === 'crop' && (
          <span className="hint">
            Drag the edges of the crop rectangle ·{' '}
            <button className="link" onClick={() => setMode('normal')}>
              Done
            </button>
          </span>
        )}
      </div>
      <video ref={videoRef} className="hidden-video" muted playsInline preload="auto" />
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
