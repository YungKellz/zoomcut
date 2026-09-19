import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Square, X } from 'lucide-react'
import type { RecorderBarState } from '@shared/types'
import { useT } from '../i18n'

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** UI of the small floating window shown while recording. */
export function RecorderBar(): JSX.Element {
  const t = useT()
  const [state, setState] = useState<RecorderBarState>({ phase: 'idle', startedAt: null, countdownEndsAt: null })
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void window.zc.bar.requestState().then(setState)
    const off = window.zc.bar.onState(setState)
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [])

  let label: string
  let dotClass = 'bar-dot'
  if (state.phase === 'countdown') {
    const left = Math.max(0, Math.ceil(((state.countdownEndsAt ?? now) - now) / 1000))
    label = left > 0 ? t('bar.startingIn', { n: left }) : t('bar.starting')
    dotClass += ' bar-dot-warm'
  } else if (state.phase === 'recording') {
    label = `REC ${formatElapsed(now - (state.startedAt ?? now))}`
    dotClass += ' bar-dot-live'
  } else if (state.phase === 'processing') {
    label = t('bar.stopping')
  } else {
    label = t('bar.ready')
  }

  return (
    <div className="bar">
      <div className="bar-drag">
        <span className={dotClass} />
        <span className="bar-label">{label}</span>
      </div>
      <button className="bar-btn bar-stop" title={t('bar.stopTitle')} onClick={() => void window.zc.bar.stop()} disabled={state.phase === 'processing'}>
        <Square size={14} fill="currentColor" />
        <span>{t('bar.stop')}</span>
      </button>
      <button className="bar-btn bar-cancel" title={t('bar.discard')} onClick={() => void window.zc.bar.cancel()}>
        <X size={16} />
      </button>
    </div>
  )
}
