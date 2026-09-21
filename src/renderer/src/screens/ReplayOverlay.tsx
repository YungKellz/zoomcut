import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { OverlayEffect, ScenarioActionKind } from '@shared/types'
import { truncateCaption } from '../scenario/format'
import { useT } from '../i18n'

interface Effect extends OverlayEffect {
  id: number
}

// How long each effect stays on screen before it prunes itself. Not specified per-kind beyond
// the ripple (600ms) and the typed-text caption (1.5s) in the brief; key/scroll badges get a
// value in between so they are readable without lingering.
const EFFECT_TTL_MS: Record<ScenarioActionKind, number> = {
  click: 600,
  doubleClick: 750,
  rightClick: 600,
  middleClick: 600,
  drag: 600,
  scroll: 900,
  type: 1500,
  key: 900
}

/**
 * Transparent, click-through window shown on top of the display during a scenario replay:
 * a ripple at every click, a fading line from start to end for a drag, a directional arrow for
 * a scroll, a caption bubble for typed text, a keycap badge for shortcuts, and a HUD with the
 * replay progress. Fed by two IPC streams from the main process - overlay:effect (one event per
 * captured action as replay.ps1 reaches it, carrying toX/toY for a drag and deltaY/deltaX for a
 * scroll) and recording:replay-state (for the HUD). Effects are a small array pruned by plain
 * timers (their ids tracked so an early unmount cannot leave one firing into stale state), never
 * a per-frame animation loop.
 */
export function ReplayOverlay(): JSX.Element {
  const t = useT()
  const [effects, setEffects] = useState<Effect[]>([])
  const [hud, setHud] = useState<{ index: number; total: number } | null>(null)
  const nextId = useRef(0)
  const timeoutIds = useRef(new Set<number>())

  useEffect(() => {
    document.documentElement.classList.add('bar-window')
    document.body.classList.add('bar-window')
    const offEffect = window.zc.overlay.onEffect((e) => {
      const id = nextId.current++
      setEffects((prev) => [...prev, { ...e, id }])
      const timeoutId = window.setTimeout(() => {
        timeoutIds.current.delete(timeoutId)
        setEffects((prev) => prev.filter((f) => f.id !== id))
      }, EFFECT_TTL_MS[e.kind] ?? 700)
      timeoutIds.current.add(timeoutId)
    })
    const offState = window.zc.overlay.onReplayState((s) => {
      setHud(
        s.phase === 'preparing' || s.phase === 'ready' || s.phase === 'running'
          ? { index: Math.min(s.index + 1, s.total), total: s.total }
          : null
      )
    })
    return () => {
      offEffect()
      offState()
      for (const id of timeoutIds.current) window.clearTimeout(id)
      timeoutIds.current.clear()
      document.documentElement.classList.remove('bar-window')
      document.body.classList.remove('bar-window')
    }
  }, [])

  return (
    <div className="replay-overlay bar-window">
      {hud && <div className="replay-hud">{t('scenario.overlayHud', { index: hud.index, total: hud.total })}</div>}
      {effects.map((e) => (
        <EffectView key={e.id} effect={e} />
      ))}
    </div>
  )
}

/** Dominant-axis arrow for a scroll's wheel notches (ScenarioScrollAction sign convention: positive deltaY/deltaX = down/right). */
function ScrollArrow({ deltaY, deltaX }: { deltaY?: number; deltaX?: number }): JSX.Element {
  const dy = deltaY ?? 0
  const dx = deltaX ?? 0
  if (Math.abs(dy) >= Math.abs(dx)) {
    const Icon = dy > 0 ? ArrowDown : dy < 0 ? ArrowUp : ArrowUpDown
    return <Icon size={16} />
  }
  const Icon = dx > 0 ? ArrowRight : ArrowLeft
  return <Icon size={16} />
}

function EffectView({ effect }: { effect: Effect }): JSX.Element | null {
  const style = { left: effect.x, top: effect.y }
  switch (effect.kind) {
    case 'click':
      return <span className="replay-ripple left" style={style} />
    case 'doubleClick':
      return (
        <>
          <span className="replay-ripple left" style={style} />
          <span className="replay-ripple left delayed" style={style} />
        </>
      )
    case 'rightClick':
      return <span className="replay-ripple right" style={style} />
    case 'middleClick':
      return <span className="replay-ripple middle" style={style} />
    case 'drag':
      return (
        <>
          <span className="replay-ripple drag" style={style} />
          {effect.toX !== undefined && effect.toY !== undefined && (
            <svg className="replay-drag-line">
              <line x1={effect.x} y1={effect.y} x2={effect.toX} y2={effect.toY} />
            </svg>
          )}
        </>
      )
    case 'scroll':
      return (
        <span className="replay-scroll" style={style}>
          <ScrollArrow deltaY={effect.deltaY} deltaX={effect.deltaX} />
        </span>
      )
    case 'type':
      return (
        <span className="replay-caption" style={style}>
          {truncateCaption(effect.label ?? '', 40)}
        </span>
      )
    case 'key':
      return (
        <span className="replay-key" style={style}>
          {effect.label}
        </span>
      )
    default:
      return null
  }
}
