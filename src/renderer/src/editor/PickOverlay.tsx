import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { useStore } from '../store'
import { zoomAreas } from '../engine/camera'
import { useT } from '../i18n'

/**
 * While a zoom area is being picked (mode === 'pickTarget') this covers the WHOLE inspector - tabs
 * and panel - with the hint and Apply / Cancel, so nothing else can be switched or edited until the
 * position is committed. Rendered as the last child of the inspector (it positions against it).
 * The timeline and the hotkeys are held back by the store (select / setRange / add* / deleteSelected
 * are ignored while picking); Enter applies and Esc cancels in Editor.tsx.
 */
export function PickOverlay(): JSX.Element | null {
  const t = useT()
  const cardRef = useRef<HTMLDivElement>(null)
  const mode = useStore((s) => s.mode)
  const picking = mode === 'pickTarget'
  const pickArea = useStore((s) => s.pickArea)
  const setMode = useStore((s) => s.setMode)
  const applyPick = useStore((s) => s.applyPick)
  const zoom = useStore((s) => {
    const sel = s.selection
    return picking && sel?.kind === 'zoom' ? s.project?.zooms.find((z) => z.id === sel.id) : undefined
  })

  // the zoom vanished under the pick (undo, a delete from the timeline): leave the mode instead of
  // keeping a rectangle that has nothing to apply to
  useEffect(() => {
    if (picking && !zoom) setMode('normal')
  }, [picking, zoom, setMode])

  // A bare Alt press-and-release would reveal the window's hidden menu bar (autoHideMenuBar), which
  // shifts the whole layout under the pointer. Alt resizes the rectangle from its centre while
  // picking, so its key events are consumed here (capture phase: before anything else sees them).
  useEffect(() => {
    if (!picking) return
    const swallowAlt = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') e.preventDefault()
    }
    window.addEventListener('keydown', swallowAlt, true)
    window.addEventListener('keyup', swallowAlt, true)
    return () => {
      window.removeEventListener('keydown', swallowAlt, true)
      window.removeEventListener('keyup', swallowAlt, true)
    }
  }, [picking])

  const showing = picking && zoom !== undefined
  // keyboard focus moves into the overlay (not onto a button: Space on a focused Apply would apply)
  useEffect(() => {
    if (showing) cardRef.current?.focus()
  }, [showing])

  if (!picking || !zoom) return null
  const multi = zoomAreas(zoom).length > 1
  return (
    <div className="pick-overlay" role="dialog" aria-label={t('zoom.pickingTitle')} data-testid="pick-overlay">
      <div className="pick-overlay-card" ref={cardRef} tabIndex={-1}>
        <h3 className="pick-overlay-title">{t('zoom.pickingTitle')}</h3>
        <p className="pick-overlay-hint">{multi ? t('preview.pickPartHint', { n: pickArea + 1 }) : t('preview.pickHint')}</p>
        <div className="pick-overlay-actions">
          <button className="btn btn-primary" data-action="apply" onClick={applyPick}>
            <Check size={14} /> {t('common.apply')}
          </button>
          <button className="btn" data-action="cancel" onClick={() => setMode('normal')}>
            <X size={14} /> {t('common.cancel')}
          </button>
        </div>
        <p className="muted small pick-overlay-keys">{t('zoom.pickModifiers')}</p>
      </div>
    </div>
  )
}
