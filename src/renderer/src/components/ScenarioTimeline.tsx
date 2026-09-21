import type { JSX } from 'react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScenarioAction } from '@shared/types'
import { SCENARIO_MAX_MS } from '@shared/defaults'
import { actionEnd, scenarioEnd } from '@shared/scenario'
import { KIND_ICON } from '../scenario/kindMeta'
import { formatMinSec } from '../scenario/format'
import { useT } from '../i18n'

// Same small "pick the coarsest step whose pixel spacing clears a threshold" pattern as
// editor/Timeline.tsx's TICK_STEPS, just starting at whole seconds - a scenario is edited in
// seconds, not frames, so sub-second ticks would only add clutter here.
const TICK_STEPS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
const TRACK_PAD_PX = 16

interface ScenarioTimelineProps {
  actions: ScenarioAction[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRetime: (id: string, at: number, ripple: boolean) => void
}

/**
 * Ruler + one draggable marker per action, below the action list on the scenario review
 * screen. The track is fit to the current content (scenarioEnd(actions) - the current,
 * possibly-edited end, not the frozen recorded Scenario.durationMs) rather than to the full
 * 10-minute cap, so short scenarios stay editable at a usable pixel-per-ms scale; pxPerMs is
 * never floored, so a long scenario shrinks to fit instead of being clipped by the track's
 * `overflow: hidden` (there is no horizontal scroll here, unlike the main editor timeline).
 */
export function ScenarioTimeline(props: ScenarioTimelineProps): JSX.Element {
  const { actions, selectedId, onSelect, onRetime } = props
  const t = useT()
  const trackRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(800)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    setViewportWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const contentEnd = Math.max(scenarioEnd(actions), 1000)
  // guard only the degenerate case (no real width measured yet) - never clamp the natural fit,
  // or a long scenario would overflow a narrow window with nowhere to scroll to see the rest
  const pxPerMs = Math.max(1, viewportWidth - TRACK_PAD_PX) / contentEnd

  // kept live for the marker drag handlers below: a plain closure captured at pointerdown would
  // go stale mid-drag (dragging a marker past the previous end grows contentEnd, which shrinks
  // pxPerMs on the next render) and misplace every subsequent move by reading a scale that no
  // longer matches the track's actual width
  const pxPerMsRef = useRef(pxPerMs)
  pxPerMsRef.current = pxPerMs

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pxPerMs >= 60) ?? TICK_STEPS[TICK_STEPS.length - 1]
    const out: number[] = []
    for (let tm = 0; tm <= contentEnd; tm += step) out.push(tm)
    return out
  }, [pxPerMs, contentEnd])

  return (
    <div className="scenario-timeline">
      <div className="scenario-timeline-hint muted">{t('scenario.timelineHint')}</div>
      <div className="scenario-timeline-track" ref={trackRef}>
        {ticks.map((tm) => (
          <div key={tm} className="scenario-timeline-tick" style={{ left: tm * pxPerMs }}>
            <span>{formatMinSec(tm)}</span>
          </div>
        ))}
        {actions.map((a) => (
          <ScenarioMarker
            key={a.id}
            action={a}
            pxPerMs={pxPerMs}
            pxPerMsRef={pxPerMsRef}
            selected={a.id === selectedId}
            onSelect={onSelect}
            onRetime={onRetime}
          />
        ))}
      </div>
    </div>
  )
}

interface MarkerProps {
  action: ScenarioAction
  pxPerMs: number
  pxPerMsRef: React.RefObject<number>
  selected: boolean
  onSelect: (id: string) => void
  onRetime: (id: string, at: number, ripple: boolean) => void
}

function ScenarioMarker(props: MarkerProps): JSX.Element {
  const { action, pxPerMs, pxPerMsRef, selected, onSelect, onRetime } = props
  const Icon = KIND_ICON[action.kind]
  const over = actionEnd(action) > SCENARIO_MAX_MS

  const down = (e: React.PointerEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    const el = e.currentTarget
    const track = el.closest('.scenario-timeline-track')
    if (!track) return
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let moved = false

    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return
      moved = true
      const rect = track.getBoundingClientRect()
      // read the LATEST scale, not the one captured when the drag began (see pxPerMsRef above)
      const at = (ev.clientX - rect.left) / pxPerMsRef.current
      onRetime(action.id, at, ev.shiftKey)
    }
    // pointerup ends a normal drag; pointercancel/lostpointercapture cover the OS taking the
    // gesture away mid-drag (e.g. a window switch) - all three must stop the drag the same way,
    // or `move` keeps retiming the action from a pointer nothing is updating any more
    const end = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
      if (!moved && ev.type === 'pointerup') onSelect(action.id)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end, { once: true })
    el.addEventListener('pointercancel', end, { once: true })
    el.addEventListener('lostpointercapture', end, { once: true })
  }

  return (
    <button
      type="button"
      className={'scenario-marker' + (selected ? ' selected' : '') + (over ? ' over' : '')}
      data-id={action.id}
      style={{ left: action.at * pxPerMs }}
      onPointerDown={down}
      title={formatMinSec(action.at)}
    >
      <Icon size={12} />
    </button>
  )
}
