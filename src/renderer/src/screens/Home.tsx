import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Circle, FolderOpen, Mic, Monitor, MousePointerClick, RefreshCw, Trash2, Volume2 } from 'lucide-react'
import type { AppInfo, AudioCaptureOptions, DisplayInfo, Language, ProjectSummary, ScenarioSummary } from '@shared/types'
import { DEFAULT_AUDIO_CAPTURE } from '@shared/defaults'
import { useStore } from '../store'
import { useRecorder } from '../recording/useRecorder'
import { useScenarioCapture } from '../recording/useScenarioCapture'
import { formatDuration } from '../util/format'
import { changeLanguage, useI18n, useT } from '../i18n'
import { Logo } from '../components/Logo'
import { UpdateStatus } from '../components/UpdateStatus'

export function Home(): JSX.Element {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const openProject = useStore((s) => s.openProject)
  const openScenario = useStore((s) => s.openScenario)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [scenarioBusy, setScenarioBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioCaptureOptions>(DEFAULT_AUDIO_CAPTURE)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])

  const recorder = useRecorder((project) => {
    openProject(project)
  })
  const scenario = useScenarioCapture((s) => openScenario(s))
  const recording = recorder.phase !== 'idle' && recorder.phase !== 'error'
  const capturing = scenario.phase !== 'idle' && scenario.phase !== 'error'

  // last used mic / system audio choice becomes the default, like cursor/frame settings
  useEffect(() => {
    void window.zc.app.getSettings().then((s) => {
      if (s.audioDefaults) setAudio(s.audioDefaults)
    })
  }, [])

  const updateAudio = useCallback(
    (patch: Partial<AudioCaptureOptions>): void => {
      // compute the next value and persist it outside the state updater: StrictMode
      // double-invokes updater functions, which would fire setSettings twice
      const next = { ...audio, ...patch }
      setAudio(next)
      void window.zc.app.setSettings({ audioDefaults: next })
    },
    [audio]
  )

  const refreshMicDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      // an empty deviceId (no permission granted yet) is indistinguishable between devices
      // and makes a bad React key / <option> value, so it is not worth listing
      setMicDevices(devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== ''))
    } catch {
      setMicDevices([])
    }
  }, [])

  useEffect(() => {
    void refreshMicDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshMicDevices)
  }, [refreshMicDevices])

  // device labels (and a stable deviceId) only become available once permission was granted
  // at least once; re-enumerate once a recording actually reaches the mic-open attempt
  useEffect(() => {
    if (recorder.phase === 'recording') void refreshMicDevices()
  }, [recorder.phase, refreshMicDevices])

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

  const refreshScenarios = useCallback(async () => {
    setScenarios(await window.zc.scenario.list())
  }, [])

  useEffect(() => {
    void refreshDisplays()
    void refreshProjects()
    void refreshScenarios()
    void window.zc.app.info().then(setInfo)
  }, [refreshDisplays, refreshProjects, refreshScenarios])

  useEffect(() => {
    if (recorder.phase === 'idle') void refreshProjects()
  }, [recorder.phase, refreshProjects])

  // displays come and go (docking, projectors): keep the list fresh while idle - a scenario
  // capture also has to stay excluded, the same as an ordinary recording, or this ends up
  // polling desktopCapturer for every display every 5s on top of the input capture
  useEffect(() => {
    if (recorder.phase !== 'idle' || capturing) return
    const timer = window.setInterval(() => void refreshDisplays(), 5000)
    return () => window.clearInterval(timer)
  }, [recorder.phase, capturing, refreshDisplays])

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

  const openSavedScenario = async (id: string): Promise<void> => {
    setScenarioBusy(id)
    try {
      openScenario(await window.zc.scenario.load(id))
    } catch (err) {
      alert(t('scenario.openFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setScenarioBusy(null)
    }
  }

  const removeScenario = async (s: ScenarioSummary): Promise<void> => {
    if (!confirm(t('scenario.deleteConfirm', { name: s.name }))) return
    try {
      await window.zc.scenario.remove(s.id)
    } catch (err) {
      console.error('failed to delete scenario', err)
    }
    await refreshScenarios()
  }

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
              <UpdateStatus />
              <button className="link folder-link" title={t('home.openRecordingsDir')} onClick={() => void window.zc.app.openPath(info.recordingsDir)}>
                {t('home.recordingsDir', { dir: info.recordingsDir })}
              </button>
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
                disabled={recording || capturing}
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

          <div className="audio-row">
            <label className="field-row audio-check">
              <input type="checkbox" checked={audio.mic} disabled={recording || capturing} onChange={(e) => updateAudio({ mic: e.target.checked })} />
              <Mic size={14} />
              <span>{t('home.audioMic')}</span>
            </label>
            {audio.mic && (
              <select
                className="mic-select"
                value={audio.micDeviceId ?? ''}
                disabled={recording || capturing}
                onChange={(e) => updateAudio({ micDeviceId: e.target.value || null })}
              >
                <option value="">{t('home.audioMicDefault')}</option>
                {micDevices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t('home.audioMicUnnamed', { n: i + 1 })}
                  </option>
                ))}
              </select>
            )}
            <label className="field-row audio-check">
              <input type="checkbox" checked={audio.system} disabled={recording || capturing} onChange={(e) => updateAudio({ system: e.target.checked })} />
              <Volume2 size={14} />
              <span>{t('home.audioSystem')}</span>
            </label>
          </div>

          <div className="record-actions">
            <button
              className="btn btn-record"
              disabled={recording || capturing || selectedDisplay === null}
              onClick={() => selectedDisplay !== null && void recorder.start(selectedDisplay, { audio })}
            >
              <Circle size={16} fill="currentColor" />
              {t('home.start')}
            </button>
            <button
              className="btn btn-scenario"
              disabled={recording || capturing || selectedDisplay === null}
              onClick={() => selectedDisplay !== null && void scenario.start(selectedDisplay)}
            >
              <MousePointerClick size={16} />
              {t('scenario.record')}
            </button>
            <p className="muted">{t('home.hint', { shortcut: 'Ctrl+Alt+R' })}</p>
          </div>
          <p className="muted scenario-hint">{t('scenario.hint')}</p>

          {recorder.phase === 'error' && (
            <div className="error-box">
              <strong>{t('home.failed')}</strong> {recorder.error}
              <button className="btn btn-ghost" onClick={recorder.reset}>
                {t('home.dismiss')}
              </button>
            </div>
          )}
          {scenario.phase === 'error' && (
            <div className="error-box">
              <strong>{t('scenario.failed')}</strong> {scenario.error}
              <button className="btn btn-ghost" onClick={scenario.reset}>
                {t('home.dismiss')}
              </button>
            </div>
          )}
        </section>

        {scenarios.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>
                <MousePointerClick size={18} /> {t('scenario.saved')}
              </h2>
            </div>
            <ul className="scenario-list">
              {scenarios.map((s) => (
                <li key={s.id} className="scenario-row">
                  <button className="scenario-open" onClick={() => void openSavedScenario(s.id)} disabled={scenarioBusy !== null || recording || capturing}>
                    <span className="project-name">{s.name}</span>
                    <span className="muted">{t('scenario.summary', { n: s.actions, duration: formatDuration(s.durationMs) })}</span>
                  </button>
                  <button
                    className="btn btn-ghost danger scenario-delete"
                    title={t('common.delete')}
                    disabled={scenarioBusy !== null || recording || capturing}
                    onClick={() => void removeScenario(s)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

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

      {capturing && (
        <div className="overlay">
          <div className="overlay-card">
            {scenario.phase === 'starting' && <p>{t('scenario.capturePreparing')}</p>}
            {scenario.phase === 'countdown' && <p>{t('scenario.captureCountdown')}</p>}
            {scenario.phase === 'capturing' && <p>{t('scenario.capturingHint')}</p>}
            {scenario.phase === 'saving' && <p>{t('scenario.captureSaving')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
