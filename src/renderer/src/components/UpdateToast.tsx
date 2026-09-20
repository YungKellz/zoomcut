import type { JSX } from 'react'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useT } from '../i18n'
import { useUpdateState } from '../hooks/useUpdateState'

/** Bottom-right card shown once a new version has been downloaded: restart now or later. */
export function UpdateToast(): JSX.Element | null {
  const t = useT()
  const update = useUpdateState()
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (update.status !== 'downloaded' || !update.version || dismissed === update.version) return null
  const version = update.version
  return (
    <div className="update-toast" role="status">
      <RefreshCw size={18} className="update-toast-icon" />
      <div className="update-toast-text">
        <strong>{t('update.readyTitle', { version })}</strong>
        <span className="muted">{t('update.readyHint')}</span>
      </div>
      <div className="update-toast-actions">
        <button className="btn btn-primary btn-small" onClick={() => void window.zc.update.install().catch(() => undefined)}>
          {t('update.restart')}
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => setDismissed(version)}>
          {t('update.later')}
        </button>
      </div>
    </div>
  )
}
