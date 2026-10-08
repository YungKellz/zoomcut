import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { FileImage, FileVideo } from 'lucide-react'
import { useT } from '../i18n'
import type { VideoIntake } from './useVideoIntake'

interface Props {
  intake: VideoIntake
  /** a recording or a scenario capture is running */
  disabled: boolean
}

/**
 * The MP4 → GIF block on the home screen: a drop zone plus a file picker. The drop itself is
 * handled by the Home root (any file dropped anywhere on the window counts); the card only
 * lights up while a file is being dragged over the window.
 */
export function GifConverterCard({ intake, disabled }: Props): JSX.Element {
  const t = useT()
  const errorRef = useRef<HTMLDivElement>(null)

  // the card can sit below the fold of its column: bring a fresh error into view
  useEffect(() => {
    if (intake.error) errorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [intake.error])

  return (
    <section className={'card converter-card' + (intake.dragging ? ' drop-active' : '')}>
      <div className="card-head">
        <h2>
          <FileImage size={18} /> {t('converter.button')}
        </h2>
      </div>
      <div className="converter-drop">
        <FileVideo size={26} className="converter-drop-icon" />
        <div className="converter-drop-text">
          <p className="converter-drop-title">{intake.busy ? t('converter.probing') : t('converter.dropTitle')}</p>
          <p className="muted small">{t('converter.help')}</p>
        </div>
        <button className="btn converter-choose" onClick={() => void intake.choose()} disabled={disabled || intake.busy} title={t('converter.buttonTitle')}>
          {t('converter.chooseFile')}
        </button>
      </div>
      {intake.error && (
        <div ref={errorRef} className="error-box converter-error" role="alert">
          <span>{intake.error}</span>
          <button className="btn btn-ghost" onClick={intake.clearError}>
            {t('home.dismiss')}
          </button>
        </div>
      )}
    </section>
  )
}
