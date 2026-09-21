import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, MousePointerClick, Scissors, Type, ZoomIn } from 'lucide-react'
import type { AudioClip, TextOverlay } from '@shared/types'
import { isRecordedClip } from '@shared/audio'
import { useProject, useStore } from '../store'
import { keepSegments, outToSrc, outputDuration, srcToOut } from '../engine/timeline'
import { useThumbnails } from '../hooks/useThumbnails'
import { MUSIC_PRESETS } from '../audio/music'
import { clamp, formatTimecode } from '../util/format'
import { useT, type Translate } from '../i18n'

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
  /** false hides the l/r handles and disables resizing – the block can only be moved (audio overlay clips). */
  resizable?: boolean
  /**
   * Upper bound for `start` while dragging. Defaults to `maxEnd - len` (the region keeps its
   * current length, sliding inside [0, maxEnd]) – correct for a fixed-length region (zoom/text).
   * A non-resizable region whose `end` is re-derived every render from something other than a
   * stored duration (e.g. a looping audio clip, which Timeline always draws touching the output
   * end) needs the caller to pass the real bound explicitly, since `len` at drag-start is not a
   * stable width to preserve there – using the default would clamp to 0 (maxEnd - maxEnd)
   * whenever the region currently spans the full width, making it undraggable.
   */
  moveMax?: number
  onSelect: () => void
  onBegin: () => void
  onChange: (start: number, end: number) => void
}

function Region(props: RegionProps): JSX.Element {
  const { start, end, pxPerMs, maxEnd, className, label, selected, minLength = 150, resizable = true, moveMax, onSelect, onBegin, onChange } = props

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
    const moveUpper = moveMax ?? Math.max(0, maxEnd - len)
    const move = (ev: PointerEvent): void => {
      const dMs = (ev.clientX - sx) / pxPerMs
      if (kind === 'move') {
        const s = clamp(o.start + dMs, 0, moveUpper)
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
      {resizable && <div className="region-handle l" onPointerDown={begin('l')} />}
      <span className="region-label">{label}</span>
      {resizable && <div className="region-handle r" onPointerDown={begin('r')} />}
    </div>
  )
}

/** main stores "System audio" / "Microphone" in English (see RecordingController.finishAudio)
 * and voiceover/music clips store an English name too (see the Audio panel); the timeline
 * always shows the translated kind/preset name for those, and the clip's own name otherwise
 * (a file import, or a music clip whose preset id is no longer a known preset). */
function audioClipLabel(t: Translate, clip: AudioClip): string {
  if (clip.kind === 'system') return t('audio.kind.system')
  if (clip.kind === 'mic') return t('audio.kind.mic')
  if (clip.kind === 'voiceover') return t('audio.kind.voiceover')
  if (clip.kind === 'music' && clip.preset) {
    const preset = MUSIC_PRESETS.find((p) => p.id === clip.preset)
    if (preset) return t(preset.nameKey)
  }
  return clip.name
}

function assignLanes<T extends { id: string; start: number; end: number }>(items: T[]): Map<string, number> {
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

/**
 * The timeline shows OUTPUT time: cut pieces are simply gone. The store keeps
 * everything in source time, so positions are mapped with srcToOut / outToSrc.
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
  const updateAudioClip = useStore((s) => s.updateAudioClip)
  const checkpoint = useStore((s) => s.checkpoint)
  const { stepMs: thumbStep, thumbs } = useThumbnails(project)

  const segments = useMemo(() => keepSegments(duration, project.cuts), [duration, project.cuts])
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

  // recorded clips (system/mic) are drawn spanning the whole output (see DESIGN.md); overlay
  // clips (voiceover/music/file) use their real output-time span, looped ones reaching to the end
  const audioLaneItems = useMemo(
    () =>
      project.audio.map((c) =>
        isRecordedClip(c)
          ? { id: c.id, start: 0, end: outDur }
          : { id: c.id, start: c.start, end: Math.max(c.start, c.loop ? outDur : Math.min(outDur, c.start + c.durationMs)) }
      ),
    [project.audio, outDur]
  )
  const audioLanes = useMemo(() => assignLanes(audioLaneItems), [audioLaneItems])
  const audioLaneCount = Math.max(1, ...Array.from(audioLanes.values()).map((l) => l + 1))

  const clickMarks = useMemo(() => {
    return project.cursorData.clicks
      .map((c) => c.t)
      .filter((tm) => segments.some((s) => tm >= s.start && tm < s.end))
      .map((tm) => ({ src: tm, out: srcToOut(tm, segments) }))
  }, [project.cursorData.clicks, segments])

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

  // Ctrl + wheel zooms the timeline around the mouse. React's onWheel is passive
  // (preventDefault would be ignored), so this is a native non-passive listener.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const current = useStore.getState().pxPerMs
      const rect = el.getBoundingClientRect()
      const mouseMs = (el.scrollLeft + e.clientX - rect.left) / current
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      const next = clamp(current * factor, 0.005, 2)
      useStore.getState().setPxPerMs(next)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, mouseMs * next - (e.clientX - rect.left))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const rangeOut = range ? { start: toOut(range.start), end: toOut(range.end) } : null
  const half = thumbStep / 2

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
          <div className="track-label audio-label" style={{ height: 30 * audioLaneCount }}>
            {t('timeline.trackAudio')}
          </div>
        </div>

        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-content" style={{ width: contentWidth }}>
            <div className="ruler" onPointerDown={scrub}>
              {ticks.out.map((tm) => (
                <div key={tm} className="tick" style={{ left: tm * pxPerMs }}>
                  <span className="tick-label">{formatTimecode(tm).slice(0, ticks.step >= 1000 ? 5 : 8)}</span>
                </div>
              ))}
            </div>

            <div className="track track-video" onPointerDown={selectRange}>
              {segments.map((seg) => {
                const segOut = toOut(seg.start)
                return (
                  <div key={seg.start} className="clip" style={{ left: segOut * pxPerMs, width: (seg.end - seg.start) * pxPerMs }}>
                    {thumbs
                      .filter((th) => th.t + half > seg.start && th.t - half < seg.end)
                      .map((th) => {
                        const s = Math.max(seg.start, th.t - half)
                        const e = Math.min(seg.end, th.t + half)
                        return (
                          <div
                            key={th.t}
                            className="thumb"
                            style={{ left: (s - seg.start) * pxPerMs, width: Math.max(1, (e - s) * pxPerMs), backgroundImage: `url(${th.url})` }}
                          />
                        )
                      })}
                  </div>
                )
              })}
              {clickMarks.map((m, i) => (
                <div key={i} className="click-mark" style={{ left: m.out * pxPerMs }} title={t('timeline.click', { time: formatTimecode(m.out) })}>
                  <MousePointerClick size={11} />
                </div>
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

            <div className="track track-audio" style={{ height: 30 * audioLaneCount }} onPointerDown={emptyTrackClick}>
              {project.audio.map((clip) => {
                const lane = audioLanes.get(clip.id) ?? 0
                const muted = clip.muted || clip.volume <= 0
                const selected = selection?.kind === 'audio' && selection.id === clip.id
                if (isRecordedClip(clip)) {
                  // recorded (system/mic) clips follow the video through cuts, which can split
                  // them into several pieces – too fiddly to draw exactly, so this is a simple
                  // fixed, non-draggable label spanning the whole output (see DESIGN.md)
                  return (
                    <div key={clip.id} className="lane" style={{ top: lane * 30 }}>
                      <div
                        className={'region audio recorded' + (muted ? ' muted' : '') + (selected ? ' selected' : '')}
                        style={{ left: 0, width: Math.max(4, outDur * pxPerMs) }}
                        onClick={() => select({ kind: 'audio', id: clip.id })}
                        title={audioClipLabel(t, clip)}
                      >
                        <span className="region-label">{audioClipLabel(t, clip)}</span>
                      </div>
                    </div>
                  )
                }
                const end = Math.max(clip.start, clip.loop ? outDur : Math.min(outDur, clip.start + clip.durationMs))
                return (
                  <div key={clip.id} className="lane" style={{ top: lane * 30 }}>
                    <Region
                      start={clip.start}
                      end={end}
                      pxPerMs={pxPerMs}
                      maxEnd={outDur}
                      // a looping clip always plays to the end of the output regardless of
                      // where it starts, so its start can range all the way to outDur; a
                      // non-looping clip should not be dragged so far right that most of it
                      // would be truncated by the output end
                      moveMax={clip.loop ? outDur : Math.max(0, outDur - clip.durationMs)}
                      className={'audio' + (muted ? ' muted' : '')}
                      label={audioClipLabel(t, clip)}
                      selected={selected}
                      resizable={false}
                      onSelect={() => select({ kind: 'audio', id: clip.id })}
                      onBegin={checkpoint}
                      onChange={(s) => updateAudioClip(clip.id, { start: Math.round(s) }, false)}
                    />
                  </div>
                )
              })}
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
