import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Circle, FolderOpen, Monitor, RefreshCw, Trash2 } from 'lucide-react'
import type { AppInfo, DisplayInfo, Language, ProjectSummary } from '@shared/types'
import { useStore } from '../store'
import { useRecorder } from '../recording/useRecorder'
import { formatDuration } from '../util/format'
import { changeLanguage, useI18n, useT } from '../i18n'
import { Logo } from '../components/Logo'

export function Home(): JSX.Element {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const openProject = useStore((s) => s.openProject)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const recorder = useRecorder((project) => {
    openProject(project)
  })

  const refreshDisplays = useCallback(async () => {
    const [list, settings] = await Promise.all([window.zc.displays.list(), window.zc.app.getSettings()])
    setDisplays(list)
    setSelectedDisplay((current) => {
      if (current !== null && list.some((d) => d.id === current)) return current
      const remembered = list.find((d) => d.id === settings.lastDisplayId)
      return (remembered ?? list.find((d) => d.primary) ?? list[0])?.id ?? null
    })
  }, [])

  const refreshProjects = useCallback(async () => {
    setProjects(await window.zc.projects.list())
  }, [])

  useEffect(() => {
    void refreshDisplays()
    void refreshProjects()
    void window.zc.app.info().then(setInfo)
  }, [refreshDisplays, refreshProjects])

  useEffect(() => {
    if (recorder.phase === 'idle') void refreshProjects()
  }, [recorder.phase, refreshProjects])

  const open = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      openProject(await window.zc.projects.load(id))
    } catch (err) {
      alert(t('home.openFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (p: ProjectSummary): Promise<void> => {
    if (!confirm(t('home.deleteConfirm', { name: p.name }))) return
    await window.zc.projects.remove(p.id)
    await refreshProjects()
  }

  const recording = recorder.phase !== 'idle' && recorder.phase !== 'error'

  return (
    <div className="home">
      <header className="home-header">
        <div className="brand">
          <Logo size={44} />
          <div>
            <h1>ZoomCut</h1>
            <p>{t('home.tagline')}</p>
          </div>
        </div>
        <div className="home-meta">
          <label className="lang-select">
            <span>{t('common.language')}</span>
            <select value={lang} onChange={(e) => void changeLanguage(e.target.value as Language)}>
              <option value="en">{t('common.lang.en')}</option>
              <option value="ru">{t('common.lang.ru')}</option>
            </select>
          </label>
          {info && (
            <>
              <span>v{info.version}</span>
              <span title={info.recordingsDir}>{t('home.recordingsDir', { dir: info.recordingsDir })}</span>
              {!info.ffmpegPath && <span className="warn">{t('home.ffmpegMissing')}</span>}
            </>
          )}
        </div>
      </header>

      <div className="home-main">
        <section className="card">
          <div className="card-head">
            <h2>
              <Monitor size={18} /> {t('home.newRecording')}
            </h2>
            <button className="btn btn-ghost" onClick={() => void refreshDisplays()} title={t('home.refreshDisplays')}>
              <RefreshCw size={15} />
            </button>
          </div>

          <div className="display-grid">
            {displays.map((d) => (
              <button
                key={d.id}
                className={'display-card' + (d.id === selectedDisplay ? ' selected' : '')}
                onClick={() => setSelectedDisplay(d.id)}
                disabled={recording}
              >
                {d.thumbnail ? <img src={d.thumbnail} alt="" /> : <div className="display-placeholder" />}
                <div className="display-name">
                  {d.name}
                  {d.primary ? ` · ${t('home.primary')}` : ''}
                  <span className="muted">
                    {' '}
                    {Math.round(d.bounds.width * d.scaleFactor)}×{Math.round(d.bounds.height * d.scaleFactor)}
                  </span>
                </div>
              </button>
            ))}
            {displays.length === 0 && <p className="muted">{t('home.noDisplays')}</p>}
          </div>

          <div className="record-actions">
            <button
              className="btn btn-record"
              disabled={recording || selectedDisplay === null}
              onClick={() => selectedDisplay !== null && void recorder.start(selectedDisplay)}
            >
              <Circle size={16} fill="currentColor" />
              {t('home.start')}
            </button>
            <p className="muted">{t('home.hint', { shortcut: 'Ctrl+Alt+R' })}</p>
          </div>

          {recorder.phase === 'error' && (
            <div className="error-box">
              <strong>{t('home.failed')}</strong> {recorder.error}
              <button className="btn btn-ghost" onClick={recorder.reset}>
                {t('home.dismiss')}
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <FolderOpen size={18} /> {t('home.recent')}
            </h2>
          </div>
          {projects.length === 0 && <p className="muted">{t('home.nothingYet')}</p>}
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id} className="project-row">
                <button className="project-open" onClick={() => void open(p.id)} disabled={busy !== null}>
                  <span className="project-name">{p.name}</span>
                  <span className="muted">
                    {formatDuration(p.durationMs)} · {p.width}×{p.height} · {new Date(p.createdAt).toLocaleString()}
                  </span>
                </button>
                <button className="btn btn-ghost" title={t('home.showFolder')} onClick={() => void window.zc.projects.reveal(p.id)}>
                  <FolderOpen size={15} />
                </button>
                <button className="btn btn-ghost danger" title={t('common.delete')} onClick={() => void remove(p)}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {recording && (
        <div className="overlay">
          <div className="overlay-card">
            {recorder.phase === 'starting' && <p>{t('home.preparing')}</p>}
            {recorder.phase === 'countdown' && <p>{t('home.countdown')}</p>}
            {recorder.phase === 'recording' && (
              <>
                <p>{t('home.recording')}</p>
                <button className="btn" onClick={recorder.stop}>
                  {t('home.stop')}
                </button>
              </>
            )}
            {recorder.phase === 'processing' && (
              <>
                <p>
                  {recorder.progress?.phase === 'transcode'
                    ? t('home.transcoding', { percent: Math.round(recorder.progress.percent) })
                    : t('home.finishing')}
                </p>
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${recorder.progress?.percent ?? 0}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
