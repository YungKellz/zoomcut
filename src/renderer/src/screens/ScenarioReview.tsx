import type { JSX } from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Hourglass, Play, Trash2 } from 'lucide-react'
import type { AudioCaptureOptions, DisplayInfo, ScenarioAction, ScenarioPoint, ScenarioShot } from '@shared/types'
import { DEFAULT_AUDIO_CAPTURE, SCENARIO_MAX_MS } from '@shared/defaults'
import {
  DURATION_PRESETS_MS,
  PAUSE_PRESETS_MS,
  TYPE_SPEED_MS,
  actionDurationMs,
  actionPauseMs,
  deleteAction,
  describeAction,
  moveActionStart,
  scenarioEnd,
  scenarioSchedule,
  setActionDuration,
  setActionPause,
  setActionText,
  setAllPauses,
  typeDurationForSpeed,
  validateScenario
} from '@shared/scenario'
import type { TypeSpeed } from '@shared/scenario'
import { useScenario, useStore } from '../store'
import { useRecorder } from '../recording/useRecorder'
import { ScenarioTimeline } from '../components/ScenarioTimeline'
import { KIND_ICON, KIND_LABEL_KEY } from '../scenario/kindMeta'
import { audioHintKey, dotPositionPercent, formatMinSec, formatSecondsValue, formatStartTime } from '../scenario/format'
import { PresetButtons, SecondsInput, useSecondsPresets } from '../scenario/fields'
import type { Preset } from '../scenario/fields'
import { useI18n, useT } from '../i18n'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function shotUrl(dir: string, shot: ScenarioShot): string {
  return window.zc.media.url(`${dir}/${shot.file}`)
}

/** CSS-ready version of dotPositionPercent (format.ts) - the click-point dot on a thumbnail. */
function dotStyle(shot: ScenarioShot, point: ScenarioPoint): { left: string; top: string } {
  const { left, top } = dotPositionPercent(shot, point)
  return { left: `${left}%`, top: `${top}%` }
}

/**
 * Review + edit screen for a captured scenario: the action list (thumbnails, kind, timing),
 * a big preview of the selected action, the timeline below, and "Record & replay" which drives
 * a normal recording with the scenario replayed into it (screens/ReplayOverlay.tsx shows what
 * is happening on the recorded display itself).
 */
export function ScenarioReview(): JSX.Element {
  const t = useT()
  const scenario = useScenario()
  const closeScenario = useStore((s) => s.closeScenario)
  const setScenario = useStore((s) => s.setScenario)
  const openProject = useStore((s) => s.openProject)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displaysLoaded, setDisplaysLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [replay, setReplay] = useState<{ index: number; total: number } | null>(null)
  const [audioDefaults, setAudioDefaults] = useState<AudioCaptureOptions | null>(null)

  const recorder = useRecorder(
    (project) => {
      // flush the pending scenario autosave (main.tsx) before navigating away, same as closing
      // the review screen normally - openProject on its own also clears store.scenario, but
      // this makes the "we are done with this scenario" transition explicit at the call site
      closeScenario()
      openProject(project)
    },
    () => setNotice(t('scenario.replayAborted'))
  )
  const busy = recorder.phase !== 'idle' && recorder.phase !== 'error'

  // same audio sources the home screen's checkboxes remember - just for the "Record & replay"
  // hint below; startReplay() re-reads settings fresh at the moment it actually starts
  useEffect(() => {
    void window.zc.app
      .getSettings()
      .then((s) => setAudioDefaults(s.audioDefaults ?? DEFAULT_AUDIO_CAPTURE))
      .catch(() => undefined)
  }, [])

  const refreshDisplays = useCallback(async () => {
    const list = await window.zc.displays.list()
    setDisplays(list)
    setDisplaysLoaded(true)
  }, [])

  useEffect(() => {
    // the replay recording already grabs every screen at 60fps; polling desktopCapturer for
    // every display on top of that (and the input replay) every 5s is needless load - skip it
    // while busy, matching Home's own display-refresh interval, and re-arm once idle again
    if (busy) return
    void refreshDisplays()
    const timer = window.setInterval(() => void refreshDisplays(), 5000)
    return () => window.clearInterval(timer)
  }, [busy, refreshDisplays])

  useEffect(() => {
    const off = window.zc.recording.onReplayState((s) => {
      setReplay(s.phase === 'running' ? { index: s.index + 1, total: s.total } : null)
    })
    return () => off()
  }, [])

  // the right column should not be empty the moment the screen opens
  useEffect(() => {
    if (scenario.actions.length > 0) setSelectedId(scenario.actions[0].id)
    // run once, on entry only - deliberately not reacting to later edits/deletions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeAction = (id: string): void => {
    const idx = scenario.actions.findIndex((a) => a.id === id)
    const next = deleteAction(scenario.actions, id)
    if (next === scenario.actions) return
    setScenario({ ...scenario, actions: next })
    if (selectedId === id) {
      const fallback = next[idx] ?? next[idx - 1]
      setSelectedId(fallback ? fallback.id : null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (busy) return // no edits while a replay/recording is in flight
      if (isTypingTarget(e.target)) return
      if (e.key === 'Delete') {
        if (selectedId) {
          e.preventDefault()
          removeAction(selectedId)
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // removeAction closes over scenario.actions/selectedId, both already deps below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, scenario.actions, busy])

  // every edit goes through the engine, which returns the same array when nothing changed
  const edit = (next: ScenarioAction[]): void => {
    if (next === scenario.actions) return
    setScenario({ ...scenario, actions: next })
  }
  const moveStart = (id: string, startMs: number, ripple: boolean): void => edit(moveActionStart(scenario.actions, id, startMs, ripple))
  const commitDuration = (id: string, ms: number): void => edit(setActionDuration(scenario.actions, id, ms))
  const commitPause = (id: string, ms: number): void => edit(setActionPause(scenario.actions, id, ms))
  const commitText = (id: string, text: string): void => edit(setActionText(scenario.actions, id, text))
  const commitAllPauses = (ms: number): void => edit(setAllPauses(scenario.actions, ms))

  const endMs = useMemo(() => scenarioEnd(scenario.actions), [scenario.actions])
  const over = endMs > SCENARIO_MAX_MS
  const validation = validateScenario(scenario.actions)
  const validationMessage =
    validation === 'empty' ? t('scenario.validation.empty') : validation === 'tooLong' ? t('scenario.validation.tooLong') : null

  const display = displays.find((d) => d.id === scenario.displayId)
  const displayMissing = displaysLoaded && !display
  const displayLabel = display ? display.name : t('scenario.displayUnknown')
  const sizeLabel = `${Math.round(scenario.displayBounds.width * scenario.scaleFactor)}×${Math.round(scenario.displayBounds.height * scenario.scaleFactor)}`

  const selected = scenario.actions.find((a) => a.id === selectedId) ?? null
  const schedule = useMemo(() => scenarioSchedule(scenario.actions), [scenario.actions])

  const startReplay = async (): Promise<void> => {
    setNotice(null)
    // a stale warning from a previous attempt (e.g. "system audio failed") must not linger into
    // this one - NoticeBar (App.tsx) shows store.notice across screens, so it otherwise outlives
    // this component
    useStore.getState().setNotice(null)
    const [list, settings] = await Promise.all([window.zc.displays.list(), window.zc.app.getSettings()])
    const target = list.some((d) => d.id === scenario.displayId) ? scenario.displayId : (list.find((d) => d.primary) ?? list[0])?.id
    if (target === undefined) return
    // the replay recording captures the same audio sources the user picked on the home screen
    await recorder.start(target, { scenario, audio: settings.audioDefaults ?? undefined })
  }

  return (
    <div className="scenario-review">
      <header className="scenario-header">
        <button className="btn btn-ghost scenario-back" onClick={closeScenario} disabled={busy} title={t('editor.back')}>
          <ArrowLeft size={16} /> {t('editor.back')}
        </button>
        <input
          className="scenario-name"
          value={scenario.name}
          onChange={(e) => setScenario({ ...scenario, name: e.target.value })}
          spellCheck={false}
          aria-label={t('scenario.nameLabel')}
        />
        <span className="muted scenario-display">
          {displayLabel} · {sizeLabel}
        </span>
        <span className={'scenario-total' + (over ? ' over' : '')}>
          {formatMinSec(endMs)} / {formatMinSec(SCENARIO_MAX_MS)}
        </span>
        <span className="muted">{t('scenario.actionCount', { n: scenario.actions.length })}</span>
      </header>

      {displayMissing && <div className="scenario-display-warning">{t('scenario.displayMissingWarning')}</div>}

      <div className="scenario-body">
        <div className="scenario-list-col">
          <div className="scenario-list-toolbar">
            <AllPausesControl actions={scenario.actions} disabled={busy} onCommit={commitAllPauses} />
          </div>
          <ul className="scenario-actions">
            {scenario.actions.map((a, i) => (
              <Fragment key={a.id}>
                <ScenarioActionRow
                  action={a}
                  index={i}
                  startMs={schedule[i].start}
                  scenarioDir={scenario.dir}
                  selected={a.id === selectedId}
                  onSelect={setSelectedId}
                  onCommitDuration={commitDuration}
                  onCommitText={commitText}
                  onDelete={removeAction}
                />
                <ScenarioPauseRow action={a} onCommit={commitPause} />
              </Fragment>
            ))}
          </ul>
        </div>

        <div className="scenario-preview">
          {selected ? (
            <ActionPreview action={selected} dir={scenario.dir} />
          ) : (
            <p className="muted scenario-preview-empty">{t('scenario.noSelection')}</p>
          )}
        </div>
      </div>

      <ScenarioTimeline actions={scenario.actions} selectedId={selectedId} onSelect={setSelectedId} onMove={moveStart} />

      <footer className="scenario-footer">
        {notice && (
          <div className="scenario-notice">
            {notice}
            <button className="btn btn-ghost" onClick={() => setNotice(null)}>
              {t('common.close')}
            </button>
          </div>
        )}
        {recorder.error && (
          <div className="error-box">
            <strong>{t('scenario.replayFailed')}</strong> {recorder.error}
            <button className="btn btn-ghost" onClick={recorder.reset}>
              {t('home.dismiss')}
            </button>
          </div>
        )}
        <div className="scenario-footer-row">
          <button className="btn btn-primary btn-replay" disabled={validationMessage !== null || busy} onClick={() => void startReplay()}>
            <Play size={16} /> {t('scenario.replay')}
          </button>
          <span className="muted small scenario-audio-hint">{t(audioHintKey(audioDefaults))}</span>
          <p className={validationMessage ? 'scenario-validation' : 'muted'}>{validationMessage ?? t('scenario.replayHelp')}</p>
        </div>
      </footer>

      {busy && (
        <div className="overlay">
          <div className="overlay-card">
            {recorder.phase === 'starting' && <p>{t('home.preparing')}</p>}
            {recorder.phase === 'countdown' && <p>{t('home.countdown')}</p>}
            {recorder.phase === 'recording' && (
              <p>{t('scenario.replaying', { index: replay?.index ?? 1, total: replay?.total ?? scenario.actions.length })}</p>
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

interface ActionRowProps {
  action: ScenarioAction
  index: number
  /** where the action starts in the replay, from scenarioSchedule - read-only */
  startMs: number
  scenarioDir: string
  selected: boolean
  onSelect: (id: string) => void
  onCommitDuration: (id: string, ms: number) => void
  onCommitText: (id: string, text: string) => void
  onDelete: (id: string) => void
}

const TYPE_SPEEDS: TypeSpeed[] = ['fast', 'normal', 'slow']
const TYPE_SPEED_KEY = { fast: 'scenario.speed.fast', normal: 'scenario.speed.normal', slow: 'scenario.speed.slow' } as const

/** Duration presets of an action: 1 / 1.5 / 2 s, or Fast / Normal / Slow typing for typed text. */
function useDurationPresets(action: ScenarioAction): Preset[] {
  const t = useT()
  const seconds = useSecondsPresets(DURATION_PRESETS_MS)
  if (action.kind !== 'type') return seconds
  return TYPE_SPEEDS.map((speed) => ({
    ms: typeDurationForSpeed(action.text, speed),
    label: t(TYPE_SPEED_KEY[speed]),
    title: t('scenario.msPerChar', { ms: TYPE_SPEED_MS[speed] })
  }))
}

/**
 * One action of the list: thumbnail, kind + start time, the typed text (editable) or key label,
 * and how long the action takes. Text and numbers keep a local draft and commit on blur / Enter
 * only (see SecondsInput) - the text field the same way, Escape reverts, an empty text reverts.
 */
function ScenarioActionRow(props: ActionRowProps): JSX.Element {
  const { action, index, startMs, scenarioDir, selected, onSelect, onCommitDuration, onCommitText, onDelete } = props
  const t = useT()
  const Icon = KIND_ICON[action.kind]
  const desc = describeAction(action)
  const [shotFailed, setShotFailed] = useState(false)
  const [textDraft, setTextDraft] = useState<string | null>(null)
  const revertText = useRef(false)
  const presets = useDurationPresets(action)
  const duration = actionDurationMs(action)

  return (
    <li
      className={'scenario-action' + (selected ? ' selected' : '')}
      data-kind={action.kind}
      data-id={action.id}
      onClick={() => onSelect(action.id)}
    >
      <div className="scenario-action-thumb">
        {action.shot && !shotFailed ? (
          <>
            <img src={shotUrl(scenarioDir, action.shot)} alt="" loading="lazy" decoding="async" onError={() => setShotFailed(true)} />
            <span className="scenario-action-dot" style={dotStyle(action.shot, action)} />
          </>
        ) : (
          <span className="scenario-action-placeholder">
            <Icon size={16} />
          </span>
        )}
      </div>
      <div className="scenario-action-main">
        <div className="scenario-action-head">
          <span className="scenario-action-label">
            <Icon size={13} /> {t(KIND_LABEL_KEY[action.kind])} <span className="muted">#{index + 1}</span>
          </span>
          <span className="scenario-action-start muted" title={t('scenario.startsAt')}>
            {formatStartTime(startMs)}
          </span>
          <button
            className="btn btn-ghost danger scenario-action-delete"
            title={t('scenario.deleteAction')}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(action.id)
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {action.kind === 'type' && (
          <input
            type="text"
            className="scenario-action-text"
            value={textDraft ?? action.text}
            aria-label={t('scenario.textLabel')}
            spellCheck={false}
            onChange={(e) => setTextDraft(e.target.value)}
            onBlur={(e) => {
              const value = revertText.current ? null : e.target.value
              revertText.current = false
              setTextDraft(null)
              if (value !== null && value !== action.text) onCommitText(action.id, value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                revertText.current = true
                e.currentTarget.blur()
              }
            }}
          />
        )}
        {action.kind === 'key' && <span className="scenario-action-detail">{desc.detail}</span>}
        <div className="scenario-action-controls">
          <span className="scenario-field-label">{t('scenario.durationLabel')}</span>
          <SecondsInput
            className="scenario-action-duration"
            value={duration}
            ariaLabel={t('scenario.durationLabel')}
            onCommit={(ms) => onCommitDuration(action.id, ms)}
          />
          <PresetButtons presets={presets} current={duration} onPick={(ms) => onCommitDuration(action.id, ms)} />
        </div>
      </div>
    </li>
  )
}

/** The pause that follows an action: always there, never deletable, not selectable. */
function ScenarioPauseRow({ action, onCommit }: { action: ScenarioAction; onCommit: (id: string, ms: number) => void }): JSX.Element {
  const t = useT()
  const presets = useSecondsPresets(PAUSE_PRESETS_MS)
  const pause = actionPauseMs(action)
  return (
    <li className="scenario-pause" data-id={action.id}>
      <span className="scenario-pause-label">
        <Hourglass size={13} /> {t('scenario.pause')}
      </span>
      <SecondsInput className="scenario-pause-input" value={pause} ariaLabel={t('scenario.pause')} onCommit={(ms) => onCommit(action.id, ms)} />
      <PresetButtons presets={presets} current={pause} onPick={(ms) => onCommit(action.id, ms)} />
    </li>
  )
}

/** Toolbar button + popover that sets the same length for every pause. Closes on a pick, Escape or an outside click. */
function AllPausesControl(props: { actions: ScenarioAction[]; disabled: boolean; onCommit: (ms: number) => void }): JSX.Element {
  const { actions, disabled, onCommit } = props
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const presets = useSecondsPresets(PAUSE_PRESETS_MS)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // capture phase + stopPropagation: the review screen's own Escape handler (clear the selection) must not also fire
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // the shared value while every pause is the same, otherwise nothing is highlighted and the field stays empty
  const pauses = actions.map(actionPauseMs)
  const common = pauses.length > 0 && pauses.every((p) => p === pauses[0]) ? pauses[0] : null
  const pick = (ms: number): void => {
    onCommit(ms)
    setOpen(false)
  }

  return (
    <div className="scenario-allpauses" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost scenario-allpauses-btn"
        disabled={disabled || actions.length === 0}
        title={t('scenario.allPausesTitle')}
        onClick={() => setOpen((o) => !o)}
      >
        <Hourglass size={14} /> {t('scenario.allPauses')}
      </button>
      {open && (
        <div className="scenario-allpauses-pop">
          <div className="scenario-allpauses-presets">
            <PresetButtons presets={presets} current={common} onPick={pick} />
          </div>
          <SecondsInput className="scenario-pause-input scenario-allpauses-input" value={common} ariaLabel={t('scenario.allPauses')} onCommit={pick} />
        </div>
      )}
    </div>
  )
}

function ActionPreview({ action, dir }: { action: ScenarioAction; dir: string }): JSX.Element {
  const t = useT()
  const desc = describeAction(action)
  const lang = useI18n((st) => st.lang)
  const [shotFailed, setShotFailed] = useState(false)
  const activeMods: string[] = []
  if (action.modifiers.ctrl) activeMods.push('Ctrl')
  if (action.modifiers.shift) activeMods.push('Shift')
  if (action.modifiers.alt) activeMods.push('Alt')
  if (action.modifiers.meta) activeMods.push('Win')
  const mods = activeMods.length > 0 ? activeMods.join('+') : t('scenario.detailModifiersNone')

  return (
    <>
      <div className="scenario-preview-shot">
        {action.shot && !shotFailed ? (
          <>
            <img src={shotUrl(dir, action.shot)} alt="" loading="lazy" decoding="async" onError={() => setShotFailed(true)} />
            <span className="scenario-preview-marker" style={dotStyle(action.shot, action)} />
          </>
        ) : (
          <div className="scenario-preview-placeholder">
            {(action.kind === 'type' || action.kind === 'key') && <span className="scenario-preview-big">{desc.detail}</span>}
            {action.kind === 'scroll' && (
              <span className="scenario-preview-big scenario-preview-scroll">
                {Math.round(Math.abs(action.deltaY) + Math.abs(action.deltaX))}
                {'× '}
                {action.deltaY < 0 ? '↑' : action.deltaY > 0 ? '↓' : action.deltaX < 0 ? '←' : '→'}
              </span>
            )}
            {action.kind !== 'type' && action.kind !== 'key' && action.kind !== 'scroll' && <span className="muted">{t('scenario.noShot')}</span>}
          </div>
        )}
      </div>
      <dl className="scenario-details">
        <div>
          <dt>{t('scenario.detailPosition')}</dt>
          <dd>
            ({Math.round(action.x)}, {Math.round(action.y)})
          </dd>
        </div>
        <div>
          <dt>{t('scenario.detailModifiers')}</dt>
          <dd>{mods}</dd>
        </div>
        <div>
          <dt>{t('scenario.detailDuration')}</dt>
          <dd>{t('scenario.detailDurationValue', { s: formatSecondsValue(actionDurationMs(action), lang) })}</dd>
        </div>
      </dl>
    </>
  )
}
