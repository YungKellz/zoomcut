import type { JSX } from 'react'
import { RELEASES_URL } from '@shared/defaults'
import { useT } from '../i18n'
import { useUpdateState } from '../hooks/useUpdateState'

/**
 * One line under the version on the home screen: a manual "Check for updates", the
 * progress of a download, "restart to update", or the hint for the portable build.
 * Hidden in dev and test runs.
 */
export function UpdateStatus(): JSX.Element | null {
  const t = useT()
  const u = useUpdateState()
  if (u.reason === 'dev' || u.reason === 'test') return null

  const check = (): void => void window.zc.update.check().catch(() => undefined)
  const install = (): void => void window.zc.update.install().catch(() => undefined)
  const link = (label: string, onClick: () => void): JSX.Element => (
    <button className="link" onClick={onClick}>
      {label}
    </button>
  )

  let body: JSX.Element
  if (u.reason === 'portable') {
    body = (
      <>
        <span>{t('update.portable')}</span>
        {link(t('update.releases'), () => void window.zc.app.openExternal(RELEASES_URL))}
      </>
    )
  } else {
    switch (u.status) {
      case 'checking':
        body = <span>{t('update.checking')}</span>
        break
      case 'available':
      case 'downloading':
        body = <span>{t('update.downloading', { version: u.version ?? '', percent: u.percent })}</span>
        break
      case 'downloaded':
        body = (
          <>
            <span>{t('update.ready', { version: u.version ?? '' })}</span>
            {link(t('update.restart'), install)}
          </>
        )
        break
      case 'upToDate':
        body = (
          <>
            <span>{t('update.upToDate')}</span>
            {link(t('update.checkAgain'), check)}
          </>
        )
        break
      case 'error':
        body = (
          <>
            <span className="warn" title={u.message ?? undefined}>
              {t('update.failed')}
            </span>
            {link(t('update.retry'), check)}
          </>
        )
        break
      default:
        body = link(t('update.check'), check)
    }
  }
  return (
    <span className="update-status" data-status={u.reason ?? u.status}>
      {body}
    </span>
  )
}
