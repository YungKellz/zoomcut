import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Circle, Clapperboard, FileVideo, FolderOpen, Mic, Monitor, MousePointerClick, Plus, RefreshCw, Trash2, Volume2 } from 'lucide-react'
import type { AppInfo, AudioCaptureOptions, CompositionSummary, DisplayInfo, Language, ProjectSummary, ScenarioSummary, VideoFileInfo } from '@shared/types'
import { DEFAULT_AUDIO_CAPTURE } from '@shared/defaults'
import { useStore } from '../store'
import { useBusy } from '../hooks/useBusy'
import { buildHomeItems } from '../home/items'
import { confirmDeleteProject, confirmDeleteScenario } from '../recording/lifecycle'
import { confirmAt } from '../components/ConfirmPopover'
import { useRecorder } from '../recording/useRecorder'
import { useScenarioCapture } from '../recording/useScenarioCapture'
import { formatDuration } from '../util/format'
import { changeLanguage, useI18n, useT } from '../i18n'
import { Logo } from '../components/Logo'
import { UpdateStatus } from '../components/UpdateStatus'
import { GifConverterDialog } from '../converter/GifConverterDialog'
import { GifConverterCard } from '../converter/GifConverterCard'
import { useVideoIntake } from '../converter/useVideoIntake'
import { AgentDialog } from '../agent/AgentDialog'

export function Home(): JSX.Element {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const openProject = useStore((s) => s.openProject)
  const openScenario = useStore((s) => s.openScenario)
  const openComposition = useStore((s) => s.openComposition)
  const [compositions, setCompositions] = useState<CompositionSummary[]>([])
  const [compositionBusy, setCompositionBusy] = useState(false)
  // the video the converter dialog is open for (picked or dropped); null = dialog closed
  const [converterVideo, setConverterVideo] = useState<VideoFileInfo | null>(null)
  const [agentOpen, setAgentOpen] = useState(false)
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
  useBusy('recording', recording)
  useBusy('capture', capturing)
  // a file dropped anywhere on the window (or picked in the converter card) opens the converter
  const intake = useVideoIntake({ enabled: !recording && !capturing && converterVideo === null, onVideo: setConverterVideo })

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

  // fetched together: recordings made from a scenario are grouped under it, so a half-loaded
  // pair would flash them as standalone rows first
  const refreshLibrary = useCallback(async () => {
    const [projectList, scenarioList] = await Promise.all([window.zc.projects.list(), window.zc.scenario.list()])
    setProjects(projectList)
    setScenarios(scenarioList)
  }, [])

  const refreshCompositions = useCallback(async () => {
    setCompositions(await window.zc.compositions.list())
  }, [])

  useEffect(() => {
    void refreshDisplays()
    void refreshCompositions()
    void window.zc.app.info().then(setInfo)
  }, [refreshDisplays, refreshCompositions])

  // on entry, and whenever an attempt ends (finished, discarded, failed): either list may have changed
  useEffect(() => {
    if (recorder.phase === 'idle' && scenario.phase === 'idle') void refreshLibrary()
  }, [recorder.phase, scenario.phase, refreshLibrary])

  // an AI agent deleted a recording or created / deleted a scenario behind the UI's back: both
  // lists are fetched together (see refreshLibrary), so either kind of change reloads them
  useEffect(() => window.zc.agent.onDataChanged(() => void refreshLibrary()), [refreshLibrary])

  // "Record again" and AI agents hand the new attempt over through the store: start it exactly like
  // the button would - when Home opens with it already set, and when it is set while Home is shown.
  // takePendingStart clears it atomically, so a StrictMode re-run of this effect cannot start twice.
  const pendingStart = useStore((s) => s.pendingStart)
  useEffect(() => {
    if (!pendingStart) return
    const pending = useStore.getState().takePendingStart((p) => p.kind !== 'replay')
    if (pending?.kind === 'record') void recorder.start(pending.displayId, { audio: pending.audio ?? undefined })
    else if (pending?.kind === 'capture') void scenario.start(pending.displayId)
    // the hooks' start functions are stable; only a new pending start matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStart])

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

  const remove = async (p: ProjectSummary, anchor: Element): Promise<void> => {
    if (await confirmDeleteProject(p.id, p.name, anchor)) await refreshLibrary()
  }

  const newComposition = async (): Promise<void> => {
    setCompositionBusy(true)
    try {
      openComposition(await window.zc.compositions.create(t('composition.defaultName', { date: new Date().toLocaleString() })))
    } catch (err) {
      alert(t('composition.openFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCompositionBusy(false)
    }
  }

  const openSavedComposition = async (id: string): Promise<void> => {
    setCompositionBusy(true)
    try {
      openComposition(await window.zc.compositions.load(id))
    } catch (err) {
      alert(t('composition.openFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCompositionBusy(false)
    }
  }

  const removeComposition = async (c: CompositionSummary, anchor: Element): Promise<void> => {
    if (!(await confirmAt(anchor, t('composition.deleteConfirm', { name: c.name })))) return
    try {
      await window.zc.compositions.remove(c.id)
    } catch (err) {
      console.error('failed to delete composition', err)
    }
    await refreshCompositions()
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

  // the scenario's recordings stay and move to the top level of the list
  const removeScenario = async (s: ScenarioSummary, anchor: Element): Promise<void> => {
    if (await confirmDeleteScenario(s.id, s.name, anchor)) await refreshLibrary()
  }

  const items = useMemo(() => buildHomeItems(projects, scenarios), [projects, scenarios])

  const projectRow = (p: ProjectSummary): JSX.Element => (
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
      <button className="btn btn-ghost danger" title={t('common.delete')} onClick={(e) => void remove(p, e.currentTarget)}>
        <Trash2 size={15} />
      </button>
    </li>
  )

  return (
    <div className="home" {...intake.dropProps}>
      <header className="home-header">
        <div className="brand">
          <Logo size={44} />
          <div>
            <h1>ZoomCut</h1>
            <p>{t('home.tagline')}</p>
          </div>
        </div>
      </header>

      <div className="home-main">
        <div className="home-col home-col-left">
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
                  {d.thumbnail ? <img src={d.thumbnail} alt="" draggable={false} /> :<div className="display-placeholder" />}
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
              <div className="audio-mic">
                <label className="audio-check">
                  <input type="checkbox" checked={audio.mic} disabled={recording || capturing} onChange={(e) => updateAudio({ mic: e.target.checked })} />
                  <Mic size={15} />
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
              </div>
              <label className="audio-check">
                <input type="checkbox" checked={audio.system} disabled={recording || capturing} onChange={(e) => updateAudio({ system: e.target.checked })} />
                <Volume2 size={15} />
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

          <section className="card">
            <div className="card-head">
              <h2>
                <Clapperboard size={18} /> {t('composition.title')}
              </h2>
              <button className="btn btn-small" onClick={() => void newComposition()} disabled={compositionBusy || recording || capturing}>
                <Plus size={14} /> {t('composition.new')}
              </button>
            </div>
            {compositions.length === 0 && <p className="muted small">{t('composition.homeHint')}</p>}
            <ul className="scenario-list">
              {compositions.map((c) => (
                <li key={c.id} className="scenario-row">
                  <button className="scenario-open" onClick={() => void openSavedComposition(c.id)} disabled={compositionBusy || recording || capturing}>
                    <span className="project-name">{c.name}</span>
                    <span className="muted">{t('composition.summary', { n: c.items, date: new Date(c.updatedAt).toLocaleString() })}</span>
                  </button>
                  <button className="btn btn-ghost danger scenario-delete" title={t('common.delete')} disabled={compositionBusy || recording || capturing} onClick={(e) => void removeComposition(c, e.currentTarget)}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <GifConverterCard intake={intake} disabled={recording || capturing} />
        </div>

        <div className="home-col home-col-right">
          <section className="card library-card">
            <div className="card-head">
              <h2>
                <FolderOpen size={18} /> {t('home.library')}
              </h2>
            </div>
            {items.length === 0 && <p className="muted">{t('home.nothingYet')}</p>}
            <ul className="project-list">
              {items.map((item) =>
                item.kind === 'recording' ? (
                  projectRow(item.project)
                ) : (
                  <li key={'scenario:' + item.scenario.id} className="scenario-block">
                    <div className="scenario-row">
                      <button
                        className="scenario-open"
                        onClick={() => void openSavedScenario(item.scenario.id)}
                        disabled={scenarioBusy !== null || recording || capturing}
                      >
                        <span className="project-name scenario-name-line">
                          <MousePointerClick size={15} /> {item.scenario.name}
                        </span>
                        <span className="muted">
                          {t('scenario.summary', { n: item.scenario.actions, duration: formatDuration(item.scenario.durationMs) })}
                          {item.children.length > 0 && ` · ${t('home.scenarioRecordings', { n: item.children.length })}`}
                        </span>
                      </button>
                      <button
                        className="btn btn-ghost danger scenario-delete"
                        title={t('common.delete')}
                        disabled={scenarioBusy !== null || recording || capturing}
                        onClick={(e) => void removeScenario(item.scenario, e.currentTarget)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {item.children.length === 0 ? (
                      <p className="muted small scenario-empty">{t('home.scenarioNoRecordings')}</p>
                    ) : (
                      <ul className="scenario-children">{item.children.map(projectRow)}</ul>
                    )}
                  </li>
                )
              )}
            </ul>
          </section>
        </div>
      </div>

      <footer className="home-footer">
        <div className="home-footer-group">
          <label className="lang-select">
            <span>{t('common.language')}</span>
            <select value={lang} onChange={(e) => void changeLanguage(e.target.value as Language)}>
              <option value="en">{t('common.lang.en')}</option>
              <option value="ru">{t('common.lang.ru')}</option>
            </select>
          </label>
          <button className="btn btn-small agent-open" onClick={() => setAgentOpen(true)} disabled={recording || capturing} title={t('agent.buttonTitle')}>
            <Bot size={13} /> {t('agent.button')}
          </button>
        </div>
        {info && (
          <>
            <span className="home-version">
              <span>v{info.version}</span>
              <UpdateStatus />
            </span>
            <button className="link folder-link" title={`${t('home.openRecordingsDir')}\n${info.recordingsDir}`} onClick={() => void window.zc.app.openPath(info.recordingsDir)}>
              {t('home.recordingsDir', { dir: info.recordingsDir })}
            </button>
            {!info.ffmpegPath && <span className="warn">{t('home.ffmpegMissing')}</span>}
          </>
        )}
      </footer>

      {intake.dragging && (
        <div className="home-drop-overlay">
          <div className="home-drop-hint">
            <FileVideo size={30} />
            <p>{t('converter.dropRelease')}</p>
          </div>
        </div>
      )}

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

      {converterVideo && <GifConverterDialog key={converterVideo.path} initialVideo={converterVideo} onClose={() => setConverterVideo(null)} />}
      {agentOpen && <AgentDialog onClose={() => setAgentOpen(false)} />}

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
