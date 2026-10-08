import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useT } from '../i18n'

/**
 * In-place confirmation: a small popover above (or, without room, below) the button that asked,
 * instead of the native window.confirm() dialog. confirmAt() resolves true on the confirming
 * button or Enter, false on Cancel, Escape, an outside click, a scroll or a resize. A second
 * request while one is open cancels the first one.
 *
 * ConfirmHost renders it and is mounted once by App (main window only).
 */

export interface ConfirmOptions {
  /** label of the confirming button; defaults to common.delete */
  confirmLabel?: string
  /** red confirming button (default true: almost every confirmation here is destructive) */
  danger?: boolean
}

interface ConfirmRequest extends Required<ConfirmOptions> {
  id: number
  message: string
  /** viewport rect of the anchor at request time; null = centered near the top of the window */
  anchor: { left: number; top: number; right: number; bottom: number } | null
  resolve: (ok: boolean) => void
}

interface ConfirmState {
  request: ConfirmRequest | null
}

const useConfirm = create<ConfirmState>(() => ({ request: null }))
let nextId = 1

function finish(ok: boolean): void {
  const req = useConfirm.getState().request
  if (!req) return
  useConfirm.setState({ request: null })
  req.resolve(ok)
}

/** Asks `message` right at `anchor` (normally the clicked button: pass e.currentTarget). */
export function confirmAt(anchor: Element | null | undefined, message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  finish(false)
  const r = anchor?.getBoundingClientRect()
  return new Promise<boolean>((resolve) => {
    useConfirm.setState({
      request: {
        id: nextId++,
        message,
        confirmLabel: opts.confirmLabel ?? '',
        danger: opts.danger ?? true,
        anchor: r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
        resolve
      }
    })
  })
}

/** True while a confirmation is open - screens can use it to ignore their own shortcuts. */
export function isConfirmOpen(): boolean {
  return useConfirm.getState().request !== null
}

const GAP = 10
const MARGIN = 8

export function ConfirmHost(): JSX.Element | null {
  const t = useT()
  const request = useConfirm((s) => s.request)
  const popRef = useRef<HTMLDivElement>(null)
  const yesRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrowX: number; below: boolean } | null>(null)

  // measure, then place above the anchor (below when there is no room), clamped to the window
  useLayoutEffect(() => {
    setPos(null)
    if (!request) return
    const pop = popRef.current
    if (!pop) return
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const a = request.anchor
    if (!a) {
      setPos({ left: Math.max(MARGIN, (vw - w) / 2), top: Math.max(MARGIN, vh * 0.25), arrowX: -1, below: false })
      return
    }
    const cx = (a.left + a.right) / 2
    const below = a.top - GAP - h < MARGIN && a.bottom + GAP + h <= vh - MARGIN
    const top = below ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - h)
    const left = Math.min(Math.max(MARGIN, cx - w / 2), Math.max(MARGIN, vw - MARGIN - w))
    setPos({ left, top, arrowX: Math.min(Math.max(12, cx - left), w - 12), below })
  }, [request])

  useEffect(() => {
    if (!request) return
    yesRef.current?.focus()
    // capture phase + stopPropagation: while it is open no screen shortcut (Delete, Space,
    // Escape clearing a selection...) may fire underneath it
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) finish(false)
    }
    const onScroll = (e: Event): void => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return
      finish(false)
    }
    const onResize = (): void => finish(false)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [request])

  if (!request) return null
  return (
    <div
      ref={popRef}
      key={request.id}
      className={'confirm-pop' + (pos?.below ? ' below' : '') + (pos && pos.arrowX < 0 ? ' no-arrow' : '')}
      role="alertdialog"
      aria-label={request.message}
      style={pos ? { left: pos.left, top: pos.top, ['--arrow-x' as string]: `${pos.arrowX}px` } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <p className="confirm-pop-msg">{request.message}</p>
      <div className="confirm-pop-actions">
        <button className="btn btn-small confirm-no" onClick={() => finish(false)}>
          {t('common.cancel')}
        </button>
        <button ref={yesRef} className={'btn btn-small confirm-yes' + (request.danger ? ' btn-danger' : ' btn-primary')} onClick={() => finish(true)}>
          {request.confirmLabel || t('common.delete')}
        </button>
      </div>
    </div>
  )
}
