import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Scissors, Type, ZoomIn } from 'lucide-react'
import type { TextOverlay, ZoomSegment } from '@shared/types'
import { useProject, useStore } from '../store'
import { normalizeCuts } from '../engine/timeline'
import { clamp, formatTimecode } from '../util/format'

const TICK_STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]

interface RegionProps {
  start: number
  end: number
  pxPerMs: number
  duration: number
  className: string
  label: string
  selected: boolean
  minLength?: number
  onSelect: () => void
  onBegin: () => void
  onChange: (start: number, end: number) => void
  onDoubleClick?: () => void
}

function Region(props: RegionProps): JSX.Element {
  const { start, end, pxPerMs, duration, className, label, selected, minLength = 150, onSelect, onBegin, onChange, onDoubleClick } = props

  const begin = (kind: 'move' | 'l' | 'r') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    onBegin()
    const sx = e.clientX
    const o = { start, end }
    const len = end - start
    const move = (ev: PointerEvent): void => {
      const dMs = (ev.clientX - sx) / pxPerMs
      if (kind === 'move') {
        const s = clamp(o.start + dMs, 0, duration - len)
        onChange(s, s + len)
      } else if (kind === 'l') {
        onChange(clamp(o.start + dMs, 0, o.end - minLength), o.end)
      } else {
        onChange(o.start, clamp(o.end + dMs, o.start + minLength, duration))
      }
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`region ${className}${selected ? ' selected' : ''}`}
      style={{ left: start * pxPerMs, width: Math.max(4, (end - start) * pxPerMs) }}
      onPointerDown={begin('move')}
      onDoubleClick={onDoubleClick}
      title={`${formatTimecode(start)} – ${formatTimecode(end)}`}
    >
      <div className="region-handle l" onPointerDown={begin('l')} />
      <span className="region-label">{label}</span>
      <div className="region-handle r" onPointerDown={begin('r')} />
    </div>
  )
}

function assignLanes(items: TextOverlay[]): Map<string, number> {
  const lanes: number[] = []
  const out = new Map<string, number>()
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    let lane = lanes.findIndex((lastEnd) => lastEnd <= item.start)
    if (lane === -1) {
      lane = lanes.length
      lanes.push(0)
    }
    lanes[lane] = item.end
    out.set(item.id, lane)
  }
  return out
}

export function Timeline(): JSX.Element {
  const project = useProject()
  const duration = project.recording.durationMs
  const playheadMs = useStore((s) => s.playheadMs)
  const playing = useStore((s) => s.playing)
  const pxPerMs = useStore((s) => s.pxPerMs)
  const setPxPerMs = useStore((s) => s.setPxPerMs)
  const selection = useStore((s) => s.selection)
  const range = useStore((s) => s.range)
  const setRange = useStore((s) => s.setRange)
  const select = useStore((s) => s.select)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const addCut = useStore((s) => s.addCut)
  const addZoom = useStore((s) => s.addZoom)
  const addText = useStore((s) => s.addText)
  const updateZoom = useStore((s) => s.updateZoom)
  const updateText = useStore((s) => s.updateText)
  const checkpoint = useStore((s) => s.checkpoint)
  const mutate = useStore((s) => s.mutate)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(800)
  const contentWidth = Math.max(duration * pxPerMs, 10)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    setViewportWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // initial fit
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || viewportWidth < 50) return
    fitted.current = true
    setPxPerMs((viewportWidth - 32) / Math.max(1000, duration))
  }, [viewportWidth, duration, setPxPerMs])

  // keep the playhead visible while playing
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const px = playheadMs * pxPerMs
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, px - 80)
    }
  }, [playheadMs, playing, pxPerMs])

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pxPerMs >= 70) ?? 60000
    const out: number[] = []
    for (let t = 0; t <= duration; t += step) out.push(t)
    return { step, out }
  }, [pxPerMs, duration])

  const textLanes = useMemo(() => assignLanes(project.texts), [project.texts])
  const laneCount = Math.max(1, ...Array.from(textLanes.values()).map((l) => l + 1))

  const msFromEvent = (e: { clientX: number }, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect()
    return clamp((e.clientX - rect.left) / pxPerMs, 0, duration)
  }

  const scrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setPlaying(false)
    setPlayhead(msFromEvent(e, el), true)
    const move = (ev: PointerEvent): void => setPlayhead(msFromEvent(ev, el), true)
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const selectRange = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.cut')) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startMs = msFromEvent(e, el)
    let moved = false
    const move = (ev: PointerEvent): void => {
      const cur = msFromEvent(ev, el)
      if (!moved && Math.abs(cur - startMs) * pxPerMs < 4) return
      moved = true
      setRange({ start: Math.min(startMs, cur), end: Math.max(startMs, cur) })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (!moved) {
        setRange(null)
        select(null)
        setPlaying(false)
        setPlayhead(startMs, true)
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mouseMs = (el.scrollLeft + e.clientX - rect.left) / pxPerMs
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
    const next = clamp(pxPerMs * factor, 0.005, 2)
    setPxPerMs(next)
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, mouseMs * next - (e.clientX - rect.left))
    })
  }

  const updateCut = (id: string, start: number, end: number): void => {
    mutate(
      (p) => ({
        ...p,
        cuts: normalizeCuts(p.cuts.map((c) => (c.id === id ? { ...c, start, end } : c)), p.recording.durationMs)
      }),
      false
    )
  }

  const fit = (): void => setPxPerMs((viewportWidth - 32) / Math.max(1000, duration))

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button
          className="btn btn-small"
          disabled={!range}
          onClick={() => range && addCut(range.start, range.end)}
          title="Remove the selected range from the video (C)"
        >
          <Scissors size={14} /> Cut selection
        </button>
        <button className="btn btn-small" onClick={() => addZoom()} title="Add a zoom at the playhead (Z)">
          <ZoomIn size={14} /> Zoom
        </button>
        <button className="btn btn-small" onClick={() => addText()} title="Add text at the playhead (T)">
          <Type size={14} /> Text
        </button>
        <span className="muted timeline-hint">
          Drag on the video track to select a range · I / O set range from the playhead · Delete removes the selection
        </span>
        <div className="timeline-zoom">
          <button className="btn btn-ghost btn-small" onClick={fit} title="Fit timeline">
            <Maximize2 size={14} />
          </button>
          <input
            type="range"
            min={0.005}
            max={1}
            step={0.005}
            value={pxPerMs}
            onChange={(e) => setPxPerMs(Number(e.target.value))}
            title="Timeline zoom (Ctrl + wheel)"
          />
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="track-label ruler-label">time</div>
          <div className="track-label video-label">video</div>
          <div className="track-label zoom-label">zoom</div>
          <div className="track-label text-label" style={{ height: 30 * laneCount }}>
            text
          </div>
        </div>

        <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
          <div className="timeline-content" style={{ width: contentWidth }}>
            <div className="ruler" onPointerDown={scrub}>
              {ticks.out.map((t) => (
                <div key={t} className="tick" style={{ left: t * pxPerMs }}>
                  <span className="tick-label">{formatTimecode(t).slice(0, ticks.step >= 1000 ? 5 : 8)}</span>
                </div>
              ))}
            </div>

            <div className="track track-video" onPointerDown={selectRange}>
              {project.cuts.map((c) => (
                <Region
                  key={c.id}
                  start={c.start}
                  end={c.end}
                  pxPerMs={pxPerMs}
                  duration={duration}
                  className="cut"
                  label="cut"
                  selected={selection?.kind === 'cut' && selection.id === c.id}
                  minLength={40}
                  onSelect={() => select({ kind: 'cut', id: c.id })}
                  onBegin={checkpoint}
                  onChange={(s, e) => updateCut(c.id, s, e)}
                />
              ))}
              {range && (
                <div
                  className="range-sel"
                  style={{ left: range.start * pxPerMs, width: Math.max(2, (range.end - range.start) * pxPerMs) }}
                />
              )}
            </div>

            <div
              className="track track-zoom"
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('.region')) return
                addZoom(msFromEvent(e, e.currentTarget))
              }}
            >
              {project.zooms.map((z: ZoomSegment) => (
                <Region
                  key={z.id}
                  start={z.start}
                  end={z.end}
                  pxPerMs={pxPerMs}
                  duration={duration}
                  className="zoom"
                  label={`${z.scale.toFixed(1)}× ${z.mode === 'follow' ? 'follow' : 'fixed'}`}
                  selected={selection?.kind === 'zoom' && selection.id === z.id}
                  onSelect={() => select({ kind: 'zoom', id: z.id })}
                  onBegin={checkpoint}
                  onChange={(s, e) => updateZoom(z.id, { start: s, end: e }, false)}
                />
              ))}
            </div>

            <div
              className="track track-text"
              style={{ height: 30 * laneCount }}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('.region')) return
                addText(msFromEvent(e, e.currentTarget))
              }}
            >
              {project.texts.map((t) => (
                <div key={t.id} className="lane" style={{ top: (textLanes.get(t.id) ?? 0) * 30 }}>
                  <Region
                    start={t.start}
                    end={t.end}
                    pxPerMs={pxPerMs}
                    duration={duration}
                    className="text"
                    label={t.text.split('\n')[0] || 'text'}
                    selected={selection?.kind === 'text' && selection.id === t.id}
                    onSelect={() => select({ kind: 'text', id: t.id })}
                    onBegin={checkpoint}
                    onChange={(s, e) => updateText(t.id, { start: s, end: e }, false)}
                  />
                </div>
              ))}
            </div>

            <div className="playhead" style={{ left: playheadMs * pxPerMs }} />
          </div>
        </div>
      </div>
    </div>
  )
}
