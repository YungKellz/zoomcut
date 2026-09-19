import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Scissors, Type, ZoomIn } from 'lucide-react'
import type { CutRange, TextOverlay } from '@shared/types'
import { useProject, useStore } from '../store'
import { keepSegments, normalizeCuts, outToSrc, outputDuration, srcToOut, type Segment } from '../engine/timeline'
import { clamp, formatTimecode } from '../util/format'
import { useT } from '../i18n'

const TICK_STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]
const END_PAD_PX = 56

/** A draggable / resizable block. All times are output-time milliseconds. */
interface RegionProps {
  start: number
  end: number
  pxPerMs: number
  maxEnd: number
  className: string
  label: string
  selected: boolean
  minLength?: number
  onSelect: () => void
  onBegin: () => void
  onChange: (start: number, end: number) => void
}

function Region(props: RegionProps): JSX.Element {
  const { start, end, pxPerMs, maxEnd, className, label, selected, minLength = 150, onSelect, onBegin, onChange } = props

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
        const s = clamp(o.start + dMs, 0, Math.max(0, maxEnd - len))
        onChange(s, s + len)
      } else if (kind === 'l') {
        onChange(clamp(o.start + dMs, 0, o.end - minLength), o.end)
      } else {
        onChange(o.start, clamp(o.end + dMs, o.start + minLength, maxEnd))
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

/** Finds the cut that sits right before a kept segment (its seam on the timeline). */
function cutBeforeSegment(cuts: CutRange[], segment: Segment): CutRange | undefined {
  return cuts.find((c) => Math.abs(c.end - segment.start) < 1) ?? cuts.find((c) => c.end <= segment.start && c.start < segment.start)
}

/**
 * The timeline shows OUTPUT time: cut pieces are gone and only a thin seam marks
 * where they were. The store keeps everything in source time, so positions are
 * mapped with srcToOut / outToSrc at the edges.
 */
export function Timeline(): JSX.Element {
  const t = useT()
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

  const segments = useMemo(() => keepSegments(duration, project.cuts), [duration, project.cuts])
  const cuts = useMemo(() => normalizeCuts(project.cuts, duration), [project.cuts, duration])
  const outDur = outputDuration(segments)
  const toOut = (src: number): number => srcToOut(src, segments)
  const toSrc = (out: number): number => outToSrc(out, segments)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(800)
  const contentWidth = Math.max(outDur * pxPerMs + END_PAD_PX, 10)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    setViewportWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fit = (): void => setPxPerMs((viewportWidth - END_PAD_PX - 8) / Math.max(1000, outDur))

  // initial fit
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || viewportWidth < 50) return
    fitted.current = true
    setPxPerMs((viewportWidth - END_PAD_PX - 8) / Math.max(1000, outDur))
  }, [viewportWidth, outDur, setPxPerMs])

  // keep the playhead visible while playing
  const playheadOut = toOut(playheadMs)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const px = playheadOut * pxPerMs
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, px - 80)
    }
  }, [playheadOut, playing, pxPerMs])

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pxPerMs >= 70) ?? 60000
    const out: number[] = []
    for (let tm = 0; tm <= outDur; tm += step) out.push(tm)
    return { step, out }
  }, [pxPerMs, outDur])

  const textLanes = useMemo(() => assignLanes(project.texts), [project.texts])
  const laneCount = Math.max(1, ...Array.from(textLanes.values()).map((l) => l + 1))

  const clickMarks = useMemo(() => {
    const offset = project.cursor.offsetMs
    return project.cursorData.clicks
      .map((c) => c.t - offset)
      .filter((tm) => segments.some((s) => tm >= s.start && tm < s.end))
      .map((tm) => ({ src: tm, out: srcToOut(tm, segments) }))
  }, [project.cursorData.clicks, project.cursor.offsetMs, segments])

  const outFromEvent = (e: { clientX: number }, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect()
    return clamp((e.clientX - rect.left) / pxPerMs, 0, outDur)
  }

  const seekTo = (outMs: number): void => {
    setPlaying(false)
    setPlayhead(toSrc(outMs), true)
  }

  const scrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    seekTo(outFromEvent(e, el))
    const move = (ev: PointerEvent): void => setPlayhead(toSrc(outFromEvent(ev, el)), true)
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const selectRange = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.seam')) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startOut = outFromEvent(e, el)
    let moved = false
    const move = (ev: PointerEvent): void => {
      const cur = outFromEvent(ev, el)
      if (!moved && Math.abs(cur - startOut) * pxPerMs < 4) return
      moved = true
      setRange({ start: toSrc(Math.min(startOut, cur)), end: toSrc(Math.max(startOut, cur)) })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (!moved) {
        setRange(null)
        select(null)
        seekTo(startOut)
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  /** Click on the empty part of the zoom / text tracks: move the playhead there. */
  const emptyTrackClick = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.region')) return
    select(null)
    seekTo(outFromEvent(e, e.currentTarget))
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

  const rangeOut = range ? { start: toOut(range.start), end: toOut(range.end) } : null

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button className="btn btn-small" disabled={!range} onClick={() => range && addCut(range.start, range.end)} title={t('timeline.cutSelectionTitle')}>
          <Scissors size={14} /> {t('timeline.cutSelection')}
        </button>
        <button className="btn btn-small" onClick={() => addZoom()} title={t('timeline.zoomTitle')}>
          <ZoomIn size={14} /> {t('timeline.zoom')}
        </button>
        <button className="btn btn-small" onClick={() => addText()} title={t('timeline.textTitle')}>
          <Type size={14} /> {t('timeline.text')}
        </button>
        <span className="muted timeline-hint">{t('timeline.hint')}</span>
        <div className="timeline-zoom">
          <button className="btn btn-ghost btn-small" onClick={fit} title={t('timeline.fit')}>
            <Maximize2 size={14} />
          </button>
          <input
            type="range"
            min={0.005}
            max={1}
            step={0.005}
            value={pxPerMs}
            onChange={(e) => setPxPerMs(Number(e.target.value))}
            title={t('timeline.zoomSlider')}
          />
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="track-label ruler-label">{t('timeline.trackTime')}</div>
          <div className="track-label video-label">{t('timeline.trackVideo')}</div>
          <div className="track-label zoom-label">{t('timeline.trackZoom')}</div>
          <div className="track-label text-label" style={{ height: 30 * laneCount }}>
            {t('timeline.trackText')}
          </div>
        </div>

        <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
          <div className="timeline-content" style={{ width: contentWidth }}>
            <div className="ruler" onPointerDown={scrub}>
              {ticks.out.map((tm) => (
                <div key={tm} className="tick" style={{ left: tm * pxPerMs }}>
                  <span className="tick-label">{formatTimecode(tm).slice(0, ticks.step >= 1000 ? 5 : 8)}</span>
                </div>
              ))}
            </div>

            <div className="track track-video" onPointerDown={selectRange}>
              {segments.map((seg, i) => {
                const left = toOut(seg.start) * pxPerMs
                const width = (seg.end - seg.start) * pxPerMs
                const cut = i > 0 ? cutBeforeSegment(cuts, seg) : undefined
                return (
                  <div key={seg.start} className="clip" style={{ left, width }}>
                    {cut && (
                      <div
                        className={'seam' + (selection?.kind === 'cut' && selection.id === cut.id ? ' selected' : '')}
                        title={t('timeline.seam', { from: formatTimecode(cut.start), to: formatTimecode(cut.end) })}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          select({ kind: 'cut', id: cut.id })
                        }}
                      />
                    )}
                  </div>
                )
              })}
              {clickMarks.map((m, i) => (
                <div key={i} className="click-mark" style={{ left: m.out * pxPerMs }} title={t('timeline.click', { time: formatTimecode(m.out) })} />
              ))}
              {rangeOut && (
                <div
                  className="range-sel"
                  style={{ left: rangeOut.start * pxPerMs, width: Math.max(2, (rangeOut.end - rangeOut.start) * pxPerMs) }}
                />
              )}
            </div>

            <div
              className="track track-zoom"
              onPointerDown={emptyTrackClick}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('.region')) return
                addZoom(toSrc(outFromEvent(e, e.currentTarget)))
              }}
            >
              {project.zooms.map((z) => (
                <Region
                  key={z.id}
                  start={toOut(z.start)}
                  end={toOut(z.end)}
                  pxPerMs={pxPerMs}
                  maxEnd={outDur}
                  className="zoom"
                  label={`${z.scale.toFixed(1)}× ${z.mode === 'follow' ? t('timeline.follow') : t('timeline.fixed')}`}
                  selected={selection?.kind === 'zoom' && selection.id === z.id}
                  onSelect={() => select({ kind: 'zoom', id: z.id })}
                  onBegin={checkpoint}
                  onChange={(s, e) => updateZoom(z.id, { start: toSrc(s), end: toSrc(e) }, false)}
                />
              ))}
            </div>

            <div
              className="track track-text"
              style={{ height: 30 * laneCount }}
              onPointerDown={emptyTrackClick}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('.region')) return
                addText(toSrc(outFromEvent(e, e.currentTarget)))
              }}
            >
              {project.texts.map((tx) => (
                <div key={tx.id} className="lane" style={{ top: (textLanes.get(tx.id) ?? 0) * 30 }}>
                  <Region
                    start={toOut(tx.start)}
                    end={toOut(tx.end)}
                    pxPerMs={pxPerMs}
                    maxEnd={outDur}
                    className="text"
                    label={tx.text.split('\n')[0] || t('timeline.text')}
                    selected={selection?.kind === 'text' && selection.id === tx.id}
                    onSelect={() => select({ kind: 'text', id: tx.id })}
                    onBegin={checkpoint}
                    onChange={(s, e) => updateText(tx.id, { start: toSrc(s), end: toSrc(e) }, false)}
                  />
                </div>
              ))}
            </div>

            <div className="timeline-end" style={{ left: outDur * pxPerMs }}>
              <span>{t('timeline.end')} · {formatTimecode(outDur)}</span>
            </div>
            <div className="playhead" style={{ left: playheadOut * pxPerMs }} />
          </div>
        </div>
      </div>
    </div>
  )
}
