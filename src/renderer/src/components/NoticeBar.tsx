import type { JSX } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'

/**
 * Small dismissible top-center bar for a transient notice (e.g. "system audio could not be
 * captured"). Lives in the store (not component state) so it survives Home unmounting when
 * a recording finishes and the editor opens.
 */
export function NoticeBar(): JSX.Element | null {
  const t = useT()
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  if (!notice) return null
  return (
    <div className="notice-bar" role="status">
      <span>{notice}</span>
      <button className="btn btn-ghost" onClick={() => setNotice(null)} title={t('home.dismiss')}>
        <X size={14} />
      </button>
    </div>
  )
}
