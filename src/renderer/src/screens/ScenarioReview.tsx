import type { JSX } from 'react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Play, Trash2 } from 'lucide-react'
import type { AudioCaptureOptions, DisplayInfo, ScenarioAction, ScenarioPoint, ScenarioShot } from '@shared/types'
import { DEFAULT_AUDIO_CAPTURE, SCENARIO_MAX_MS } from '@shared/defaults'
import { actionDuration, deleteAction, describeAction, retimeAction, scenarioEnd, validateScenario } from '@shared/scenario'
import { useScenario, useStore } from '../store'
import { useRecorder } from '../recording/useRecorder'
import { ScenarioTimeline } from '../components/ScenarioTimeline'
import { KIND_ICON, KIND_LABEL_KEY } from '../scenario/kindMeta'
import { audioHintKey, dotPositionPercent, formatMinSec, gapBeforeIndex, gapToAt } from '../scenario/format'
import { useT } from '../i18n'

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

  const retime = (id: string, atMs: number, ripple: boolean): void => {
    const next = retimeAction(scenario.actions, id, Math.round(atMs), ripple)
    if (next === scenario.actions) return
    setScenario({ ...scenario, actions: next })
  }
  const commitTime = (id: string, secs: number): void => retime(id, secs * 1000, false)
  const commitGap = (id: string, index: number, secs: number): void =>
    retime(id, gapToAt(scenario.actions, index, Math.round(secs * 1000)), true)

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
        <ul className="scenario-actions">
          {scenario.actions.map((a, i) => (
            <ScenarioActionRow
              key={a.id}
              action={a}
              index={i}
              scenarioDir={scenario.dir}
              selected={a.id === selectedId}
              gapMs={gapBeforeIndex(scenario.actions, i)}
              onSelect={setSelectedId}
              onCommitTime={commitTime}
              onCommitGap={commitGap}
              onDelete={removeAction}
            />
          ))}
        </ul>

        <div className="scenario-preview">
          {selected ? (
            <ActionPreview action={selected} dir={scenario.dir} />
          ) : (
            <p className="muted scenario-preview-empty">{t('scenario.noSelection')}</p>
          )}
        </div>
      </div>

      <ScenarioTimeline actions={scenario.actions} selectedId={selectedId} onSelect={setSelectedId} onRetime={retime} />

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
  scenarioDir: string
  selected: boolean
  /** ms since the previous action ended - precomputed by the parent in O(1) per row (gapBeforeIndex from an index it already has while mapping), never re-derived here */
  gapMs: number
  onSelect: (id: string) => void
  onCommitTime: (id: string, secs: number) => void
  onCommitGap: (id: string, index: number, secs: number) => void
  onDelete: (id: string) => void
}

/**
 * One row of the action list. Time/gap inputs keep a local "draft" string while being edited
 * (value = draft ?? the formatted number) and only commit - i.e. call back into retimeAction -
 * on blur or Enter, and only when the draft parses to a finite number: a fully-controlled input
 * that recomputes `Number(value)` on every keystroke turns a half-typed "1." or a momentarily
 * empty field into `Number('') === 0`, which would retime the action to 0 (and, for the gap
 * field, ripple every following action) while the user is still typing.
 */
function ScenarioActionRow(props: ActionRowProps): JSX.Element {
  const { action, index, scenarioDir, selected, gapMs, onSelect, onCommitTime, onCommitGap, onDelete } = props
  const t = useT()
  const Icon = KIND_ICON[action.kind]
  const desc = describeAction(action)
  const [timeDraft, setTimeDraft] = useState<string | null>(null)
  const [gapDraft, setGapDraft] = useState<string | null>(null)
  const [shotFailed, setShotFailed] = useState(false)

  const timeValue = timeDraft ?? (action.at / 1000).toFixed(2)
  const gapValue = gapDraft ?? (gapMs / 1000).toFixed(2)

  const commitTimeDraft = (raw: string): void => {
    const secs = Number(raw)
    if (raw !== '' && Number.isFinite(secs)) onCommitTime(action.id, secs)
  }
  const commitGapDraft = (raw: string): void => {
    const secs = Number(raw)
    if (raw !== '' && Number.isFinite(secs)) onCommitGap(action.id, index, secs)
  }
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }

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
      <div className="scenario-action-info">
        <span className="scenario-action-label">
          <Icon size={13} /> {t(KIND_LABEL_KEY[action.kind])}
        </span>
        {desc.detail && <span className="scenario-action-detail">{desc.detail}</span>}
      </div>
      <div className="scenario-action-controls" onClick={(e) => e.stopPropagation()}>
        <label className="scenario-action-field">
          <span>{t('scenario.timeLabel')}</span>
          <input
            type="number"
            className="scenario-action-time"
            step="0.01"
            min={0}
            lang="en"
            inputMode="decimal"
            value={timeValue}
            onChange={(e) => setTimeDraft(e.target.value)}
            onBlur={(e) => {
              commitTimeDraft(e.target.value)
              setTimeDraft(null)
            }}
            onKeyDown={blurOnEnter}
          />
        </label>
        <label className="scenario-action-field">
          <span>{t('scenario.gapLabel')}</span>
          <input
            type="number"
            className="scenario-action-gap"
            step="0.01"
            min={0}
            lang="en"
            inputMode="decimal"
            value={gapValue}
            onChange={(e) => setGapDraft(e.target.value)}
            onBlur={(e) => {
              commitGapDraft(e.target.value)
              setGapDraft(null)
            }}
            onKeyDown={blurOnEnter}
          />
        </label>
        <button className="btn btn-ghost danger scenario-action-delete" title={t('scenario.deleteAction')} onClick={() => onDelete(action.id)}>
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  )
}

function ActionPreview({ action, dir }: { action: ScenarioAction; dir: string }): JSX.Element {
  const t = useT()
  const desc = describeAction(action)
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
          <dd>{t('scenario.detailDurationValue', { ms: actionDuration(action) })}</dd>
        </div>
        <div>
          <dt>{t('scenario.detailPath')}</dt>
          <dd>{t('scenario.detailPathValue', { n: action.path.length })}</dd>
        </div>
        {action.kind === 'drag' && (
          <div>
            <dt>{t('scenario.detailDragPath')}</dt>
            <dd>{t('scenario.detailPathValue', { n: action.dragPath.length })}</dd>
          </div>
        )}
      </dl>
    </>
  )
}
