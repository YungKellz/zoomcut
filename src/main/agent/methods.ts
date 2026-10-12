import type { EventEmitter } from 'node:events'
import type { z } from 'zod'
import { AgentError, type AgentErrorCode } from '@shared/agent'
import { buildAgentScenario, toAgentScenarioView } from '@shared/agentScenario'
import { toAgentProjectView } from '@shared/agentProject'
import { agentParamSchemas, formatZodError, type AgentMethodName } from '@shared/agentSchemas'
import { DEFAULT_AUDIO_CAPTURE } from '@shared/defaults'
import { scenarioEnd } from '@shared/scenario'
import type {
  AppSettings,
  Project,
  ProjectSummary,
  Rect,
  RecorderBarState,
  RecordingWarning,
  Scenario,
  ScenarioCaptureState,
  ScenarioSummary
} from '@shared/types'
import type { RecorderEvents } from '../recorder/controller'
import type { ScenarioCaptureEvents } from '../scenario/capture'
import type { RendererBridge } from './rendererBridge'
import type { AgentMethodHandler, AgentMethodTable } from './server'
import { waitFor, type Waiter } from './waiter'

/** A display as the agent sees it (no thumbnail: that is what a screenshot is for). */
export interface AgentDisplayInfo {
  id: number
  name: string
  bounds: Rect
  scaleFactor: number
  primary: boolean
}

/** the part of RecordingController the methods use */
export interface RecorderPort extends EventEmitter<RecorderEvents> {
  isActive(): boolean
  /** id of the recording being made or saved: its folder exists, its project.json may not yet */
  activeId(): string | null
  getBarState(): RecorderBarState
  requestStop(): void
  requestCancel(): void
}
/** the part of ScenarioCapture the methods use */
export interface CapturePort extends EventEmitter<ScenarioCaptureEvents> {
  isActive(): boolean
  /** id of the scenario being captured or saved: its folder exists, its scenario.json may not yet */
  activeId(): string | null
  getState(): ScenarioCaptureState
  requestStop(): void
  /** discards the capture (nothing is saved) */
  requestCancel(): void
}

/** Everything the methods touch outside this file: Electron, disk and the renderer. Handed in so the orchestration is unit-testable. */
export interface AgentDeps {
  version: string
  recorder: RecorderPort
  capture: CapturePort
  /** true while something else owns the screen (a scenario preview) */
  otherBusy?: () => boolean
  renderer: Pick<RendererBridge, 'send' | 'getStatus'>
  displays: () => AgentDisplayInfo[]
  /** a screenshot of `display` scaled to at most `maxWidth` px wide */
  captureScreen: (display: AgentDisplayInfo, maxWidth: number) => Promise<{ png: Buffer; width: number; height: number }>
  settings: () => Promise<Pick<AppSettings, 'lastDisplayId' | 'audioDefaults'>>
  projects: {
    list: () => Promise<ProjectSummary[]>
    load: (id: string) => Promise<Project>
    /** the recording is saved (its project.json exists), not just a folder with that name */
    exists: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<void>
  }
  scenarios: {
    list: () => Promise<ScenarioSummary[]>
    load: (id: string) => Promise<Scenario>
    /** the scenario is saved (its scenario.json exists), not just a folder with that name */
    exists: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<void>
    newId: () => Promise<string>
    /** creates the scenario's folder (saving never does) and returns its path */
    reserve: (id: string) => Promise<string>
    save: (scenario: Scenario) => Promise<void>
  }
  /** tells the UI that stored data changed behind its back (agent:data-changed) */
  notifyChanged: (what: 'projects' | 'scenarios') => void
  now?: () => number
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>
}

const DEFAULT_TIMEOUTS = {
  /** from the call to a recording / capture that is actually running (renderer, countdown, display capture) */
  startMs: 45_000,
  /** from the stop request to the finished project (transcode, audio conversion); also what a scenario recording gets once its replay is over */
  stopMs: 15 * 60_000,
  cancelMs: 30_000,
  captureStopMs: 60_000,
  /** a scenario recording may overrun its schedule by this much before it counts as stuck */
  replaySlackMs: 3 * 60_000,
  /** stop_scenario_capture still hands over the result of a capture the user ended on their own for this long */
  lastCaptureMs: 10 * 60_000
}

const WARNING_TEXT: Record<RecordingWarning, string> = {
  systemAudio: 'System audio could not be captured, so the recording has no system audio track'
}

export interface RecordingResult {
  projectId: string
  durationMs: number
  warnings: string[]
}

const CANCELLED_TEXT = 'The request was cancelled'
const NOTHING_SAVED_TEXT = 'Nothing was saved: the capture was cancelled or no actions were captured'

/** What a start that the MCP client gave up on needs from the recorder or the scenario capture. */
interface Attempt {
  isActive(): boolean
  /** discards the attempt (nothing is saved) */
  cancel(): void
  /** listens to the owner's state changes; returns the function that stops listening */
  onState(listener: () => void): () => void
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function fail(code: AgentErrorCode, message: string): never {
  throw new AgentError(code, message)
}

/** The RPC table behind the control server. Every handler validates its parameters with the shared zod schemas first. */
export function createAgentMethods(deps: AgentDeps): AgentMethodTable {
  const { recorder, capture, renderer } = deps
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
  const now = deps.now ?? Date.now
  /** a start (recording, replay, capture) is between the call and the real phase: nothing else may begin meanwhile */
  let starting = false
  /** scenario ids are timestamps: two creates in the same second must not pick the same one */
  let createChain: Promise<unknown> = Promise.resolve()
  /** how the last scenario capture ended, for a stop_scenario_capture that comes after the user stopped it themselves */
  let lastCapture: { scenario: Scenario | null; at: number } | null = null
  capture.on('done', (scenario) => {
    lastCapture = { scenario, at: now() }
  })
  capture.on('state', (s) => {
    if (s.phase === 'countdown') lastCapture = null // a new capture: the old result is no longer "the last one"
  })

  /** `signal` aborts when the MCP client hung up before the answer (see AgentMethodHandler) */
  function define<N extends AgentMethodName>(
    name: N,
    fn: (params: z.infer<(typeof agentParamSchemas)[N]>, signal?: AbortSignal) => Promise<unknown> | unknown
  ): AgentMethodHandler {
    return async (raw, signal) => {
      const parsed = agentParamSchemas[name].safeParse(raw)
      if (!parsed.success) fail('bad_params', `${name}: ${formatZodError(parsed.error)}`)
      return fn(parsed.data as z.infer<(typeof agentParamSchemas)[N]>, signal)
    }
  }

  function recordingPhase(): RecorderBarState['phase'] {
    if (!recorder.isActive()) return 'idle'
    // the bar goes idle when capture stops, but the recording is still being transcoded and saved
    const phase = recorder.getBarState().phase
    return phase === 'idle' ? 'processing' : phase
  }

  function assertIdle(): void {
    if (starting || recorder.isActive()) fail('busy', 'A recording is already in progress (see get_status)')
    if (capture.isActive()) fail('busy', 'A scenario capture is in progress (see get_status)')
    if (deps.otherBusy?.()) fail('busy', 'A scenario preview is running; wait until it ends')
  }

  async function exclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    assertIdle()
    if (signal?.aborted) fail('cancelled', CANCELLED_TEXT)
    starting = true
    try {
      return await fn()
    } finally {
      starting = false
    }
  }

  async function resolveDisplay(id: number | undefined): Promise<AgentDisplayInfo> {
    const all = deps.displays()
    if (all.length === 0) fail('failed', 'No display found')
    if (id !== undefined) {
      return all.find((d) => d.id === id) ?? fail('bad_params', `Unknown displayId ${id}. Available: ${all.map((d) => d.id).join(', ')} (see list_displays)`)
    }
    const { lastDisplayId } = await deps.settings()
    return all.find((d) => d.id === lastDisplayId) ?? all.find((d) => d.primary) ?? all[0]
  }

  async function resolveAudio(p: { mic?: boolean; systemAudio?: boolean }): Promise<{ mic: boolean; systemAudio: boolean }> {
    const defaults = (await deps.settings()).audioDefaults ?? DEFAULT_AUDIO_CAPTURE
    return { mic: p.mic ?? defaults.mic, systemAudio: p.systemAudio ?? defaults.system }
  }

  async function loadProject(id: string): Promise<Project> {
    try {
      return await deps.projects.load(id)
    } catch (err) {
      if (isNotFound(err)) fail('not_found', `No recording with id "${id}" (see list_projects)`)
      throw err
    }
  }

  async function assertProjectExists(id: string): Promise<void> {
    if (!(await deps.projects.exists(id))) fail('not_found', `No recording with id "${id}" (see list_projects)`)
  }

  async function loadScenario(id: string): Promise<Scenario> {
    try {
      return await deps.scenarios.load(id)
    } catch (err) {
      if (isNotFound(err)) fail('not_found', `No scenario with id "${id}" (see list_scenarios)`)
      throw err
    }
  }

  // ---- waits on the recorder / the capture ----

  /** resolves when the recording has really started (bar phase 'recording'); an attempt that ends first rejects */
  function recordingStarted() {
    return waitFor<void>(
      (resolve, reject) => {
        const onState = (s: RecorderBarState): void => {
          if (s.phase === 'recording') resolve()
        }
        // a cancel that carries an error is the replay helper failing, not a person pressing Esc
        const onCancelled = ({ error }: { error?: Error }): void =>
          reject(error ? new AgentError('failed', `The replay failed: ${error.message}`) : new AgentError('cancelled', 'The recording was cancelled before it started'))
        const onFailed = ({ error }: { error: Error }): void => reject(new AgentError('failed', `The recording could not start: ${error.message}`))
        recorder.on('state', onState)
        recorder.on('cancelled', onCancelled)
        recorder.on('failed', onFailed)
        return () => {
          recorder.off('state', onState)
          recorder.off('cancelled', onCancelled)
          recorder.off('failed', onFailed)
        }
      },
      { ms: timeouts.startMs, error: () => new AgentError('failed', 'The recording did not start in time. ZoomCut may be showing an error: check get_status and take_screenshot') }
    )
  }

  /**
   * resolves with the saved project; cancelled / failed attempts reject. `timeoutMs` is the budget
   * for the recording itself; with `processingMs` the budget starts over once, when the recording
   * ends and is being converted and saved (a scenario recording waits through its replay first).
   */
  function recordingFinished(timeoutMs: number, processingMs?: number): Waiter<RecordingResult> {
    let wait: Waiter<RecordingResult> | null = null
    let processing = false
    wait = waitFor<RecordingResult>(
      (resolve, reject) => {
        const onFinished = ({ project, warnings }: { project: Project; warnings: RecordingWarning[] }): void =>
          resolve({
            projectId: project.id,
            durationMs: project.recording.durationMs,
            warnings: warnings.map((w) => WARNING_TEXT[w] ?? w)
          })
        const onCancelled = ({ error }: { error?: Error }): void =>
          reject(error ? new AgentError('failed', `The replay failed: ${error.message}`) : new AgentError('cancelled', 'The recording was cancelled and discarded'))
        const onFailed = ({ error }: { error: Error }): void => reject(new AgentError('failed', `The recording failed: ${error.message}`))
        const onState = (s: RecorderBarState): void => {
          // capture is over (the bar says processing, then idle while the file is converted): the saving gets its own budget
          if (processingMs === undefined || processing || (s.phase !== 'processing' && s.phase !== 'idle')) return
          processing = true
          wait?.rearm(processingMs)
        }
        recorder.on('finished', onFinished)
        recorder.on('cancelled', onCancelled)
        recorder.on('failed', onFailed)
        recorder.on('state', onState)
        return () => {
          recorder.off('finished', onFinished)
          recorder.off('cancelled', onCancelled)
          recorder.off('failed', onFailed)
          recorder.off('state', onState)
        }
      },
      { ms: timeoutMs, error: () => new AgentError('failed', 'Timed out waiting for the recording to finish. Check get_status; it may still complete') }
    )
    return wait
  }

  // ---- the MCP client hanging up ----

  /** rejects `cancelled` when the MCP client hangs up; never resolves */
  function clientGone(signal: AbortSignal | undefined): Waiter<never> {
    return waitFor<never>((_resolve, reject) => {
      if (!signal) return () => undefined
      const onAbort = (): void => reject(new AgentError('cancelled', CANCELLED_TEXT))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      return () => signal.removeEventListener('abort', onAbort)
    })
  }

  /**
   * The MCP client hung up while a start was under way. What the renderer was asked to start must
   * not run on with nobody waiting for it: the attempt is discarded - at once when it already
   * exists, else the moment it shows up (the handover may still be on its way). A handover the
   * renderer refuses leaves nothing to discard. Returns the function that stops watching for the
   * abort once the start is over.
   */
  function discardAbortedStart(signal: AbortSignal | undefined, attempt: Attempt, handover: Promise<unknown>): () => void {
    if (!signal) return () => undefined
    const onAbort = (): void => {
      if (attempt.isActive()) {
        attempt.cancel()
        return
      }
      const off = attempt.onState(() => {
        if (!attempt.isActive()) return
        stop()
        attempt.cancel()
      })
      const timer = setTimeout(() => stop(), timeouts.startMs)
      const stop = (): void => {
        off()
        clearTimeout(timer)
      }
      handover.then(undefined, stop)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  /**
   * Hands a start (recording, replay, capture) to the renderer and waits until it is really running.
   * Returns the function that stops watching for the client hanging up, which the caller calls when
   * the call is over: a client that goes away before then gets the attempt discarded.
   */
  async function handOverStart(
    method: 'recording.start' | 'scenarios.record' | 'capture.start',
    params: unknown,
    started: Waiter<void>,
    attempt: Attempt,
    signal: AbortSignal | undefined
  ): Promise<() => void> {
    const gone = clientGone(signal)
    const handover = renderer.send(method, params)
    const release = discardAbortedStart(signal, attempt, handover)
    try {
      await Promise.race([Promise.all([handover, started.promise]), gone.promise])
    } catch (err) {
      started.cancel()
      release()
      throw err
    } finally {
      gone.cancel()
    }
    return release
  }

  const recorderAttempt: Attempt = {
    isActive: () => recorder.isActive(),
    // a recording that is already being saved is past cancelling
    cancel: () => {
      if (recordingPhase() !== 'processing') recorder.requestCancel()
    },
    onState: (listener) => {
      recorder.on('state', listener)
      return () => recorder.off('state', listener)
    }
  }
  const captureAttempt: Attempt = {
    isActive: () => capture.isActive(),
    cancel: () => capture.requestCancel(),
    onState: (listener) => {
      capture.on('state', listener)
      return () => capture.off('state', listener)
    }
  }

  // ---- the methods ----

  const methods: Record<AgentMethodName, AgentMethodHandler> = {
    status: define('status', () => {
      const ui = renderer.getStatus()
      return {
        version: deps.version,
        screen: ui?.screen ?? 'unknown',
        recording: recordingPhase(),
        scenarioCapture: capture.getState().phase,
        openProjectId: ui?.openProjectId ?? null
      }
    }),

    'displays.list': define('displays.list', () => deps.displays()),

    screenshot: define('screenshot', async (p) => {
      const display = await resolveDisplay(p.displayId)
      const maxWidth = p.maxWidth ?? 1920
      const shot = await deps.captureScreen(display, maxWidth)
      return {
        displayId: display.id,
        bounds: display.bounds,
        // image pixels per DIP: a point in the image divided by this is a point on the display
        scale: Math.round((shot.width / display.bounds.width) * 10_000) / 10_000,
        mimeType: 'image/png',
        data: shot.png.toString('base64')
      }
    }),

    'projects.list': define('projects.list', () => deps.projects.list()),

    'projects.get': define('projects.get', async (p) => toAgentProjectView(await loadProject(p.projectId))),

    'projects.delete': define('projects.delete', async (p) => {
      // a folder that is no saved recording (one still being recorded included) is not_found, never removed
      await assertProjectExists(p.projectId)
      if (recorder.activeId() === p.projectId) fail('busy', 'This recording is still being saved; wait until stop_recording returns')
      const ui = renderer.getStatus()
      if (ui?.openProjectId === p.projectId) {
        fail('busy', 'This recording is open in the ZoomCut editor; it cannot be deleted while open. Ask the user to close it (Back), or leave it')
      }
      if (ui?.compositionProjectIds?.includes(p.projectId)) {
        fail('busy', 'This recording is part of the composition open in ZoomCut; it cannot be deleted while that is open. Ask the user to close it (Back), or leave it')
      }
      await deps.projects.remove(p.projectId)
      deps.notifyChanged('projects')
      return {}
    }),

    'projects.edit': define('projects.edit', async (p) => {
      await assertProjectExists(p.projectId)
      const view = await renderer.send('projects.edit', p)
      deps.notifyChanged('projects') // a rename shows in the home list
      return view
    }),

    'projects.export': define('projects.export', async (p, signal) => {
      await assertProjectExists(p.projectId)
      // an export and a recording / replay / capture would compete for the machine; checked after the await,
      // as one may have started meanwhile
      if (starting || recorder.isActive() || capture.isActive() || deps.otherBusy?.()) {
        fail('busy', 'A recording (also one that is being saved), a scenario replay or preview, or a scenario capture is in progress; export once it has ended (see get_status)')
      }
      // a client that gave up must not leave the export running: the renderer is told to stop it
      return renderer.send('projects.export', p, { signal })
    }),

    'scenarios.list': define('scenarios.list', () => deps.scenarios.list()),

    'scenarios.get': define('scenarios.get', async (p) => toAgentScenarioView(await loadScenario(p.scenarioId))),

    'scenarios.create': define('scenarios.create', (p) => {
      const run = async (): Promise<unknown> => {
        const display = await resolveDisplay(p.displayId)
        const id = await deps.scenarios.newId()
        // throws bad_params before anything is written
        const scenario = buildAgentScenario(p, display, id, now())
        scenario.dir = await deps.scenarios.reserve(id)
        await deps.scenarios.save(scenario)
        deps.notifyChanged('scenarios')
        return { scenarioId: id, actions: scenario.actions.length, durationMs: scenarioEnd(scenario.actions) }
      }
      const result = createChain.then(run, run)
      createChain = result.catch(() => undefined)
      return result
    }),

    'scenarios.delete': define('scenarios.delete', async (p) => {
      // a folder that is no saved scenario (one still being captured included) is not_found, never removed
      if (!(await deps.scenarios.exists(p.scenarioId))) fail('not_found', `No scenario with id "${p.scenarioId}" (see list_scenarios)`)
      if (capture.activeId() === p.scenarioId) fail('busy', 'This scenario is still being captured; wait until stop_scenario_capture returns')
      if (renderer.getStatus()?.openScenarioId === p.scenarioId) {
        fail('busy', 'This scenario is open in the ZoomCut scenario review; it cannot be deleted while open. Ask the user to close it (Back), or leave it')
      }
      await deps.scenarios.remove(p.scenarioId)
      deps.notifyChanged('scenarios')
      return {}
    }),

    'scenarios.captureStart': define('scenarios.captureStart', (p, signal) =>
      exclusive(signal, async () => {
        lastCapture = null
        const display = await resolveDisplay(p.displayId)
        const capturing = waitFor<void>(
          (resolve, reject) => {
            const onState = (s: ScenarioCaptureState): void => {
              if (s.phase === 'capturing') resolve()
            }
            const onDone = (): void => reject(new AgentError('cancelled', 'The scenario capture ended before it started'))
            const onFailed = (error: Error): void => reject(new AgentError('failed', `The scenario capture could not start: ${error.message}`))
            capture.on('state', onState)
            capture.on('done', onDone)
            capture.on('failed', onFailed)
            return () => {
              capture.off('state', onState)
              capture.off('done', onDone)
              capture.off('failed', onFailed)
            }
          },
          { ms: timeouts.startMs, error: () => new AgentError('failed', 'The scenario capture did not start in time. Check get_status and take_screenshot') }
        )
        // the capture is running and the answer goes out: a hang-up from here on is no cancel
        const release = await handOverStart('capture.start', { displayId: display.id }, capturing, captureAttempt, signal)
        release()
        // the user (or the agent through computer use) now performs the scenario; stop_scenario_capture ends it
        return { displayId: display.id }
      })
    ),

    'scenarios.captureStop': define('scenarios.captureStop', async () => {
      const result = (scenario: Scenario): { scenarioId: string; actions: number; durationMs: number } => ({
        scenarioId: scenario.id,
        actions: scenario.actions.length,
        durationMs: scenarioEnd(scenario.actions)
      })
      if (!capture.isActive()) {
        // the user already ended it (Stop on the bar, Ctrl+Alt+R): that result is handed over once
        const last = lastCapture
        lastCapture = null
        if (!last || now() - last.at > timeouts.lastCaptureMs) fail('not_found', 'No scenario capture is in progress')
        if (!last.scenario) fail('cancelled', NOTHING_SAVED_TEXT)
        return result(last.scenario)
      }
      const done = waitFor<Scenario>(
        (resolve, reject) => {
          const onDone = (scenario: Scenario | null): void => {
            if (scenario) resolve(scenario)
            else reject(new AgentError('cancelled', NOTHING_SAVED_TEXT))
          }
          capture.on('done', onDone)
          return () => capture.off('done', onDone)
        },
        { ms: timeouts.captureStopMs, error: () => new AgentError('failed', 'Timed out waiting for the scenario capture to finish') }
      )
      // a capture already saving is just waited for
      if (capture.getState().phase !== 'saving') capture.requestStop()
      try {
        const scenario = await done.promise
        deps.notifyChanged('scenarios')
        return result(scenario)
      } finally {
        lastCapture = null // this call is the one that reports it
      }
    }),

    'recording.start': define('recording.start', (p, signal) =>
      exclusive(signal, async () => {
        const display = await resolveDisplay(p.displayId)
        const audio = await resolveAudio(p)
        const started = recordingStarted()
        // the recording is running and the answer goes out: a hang-up from here on is no cancel
        const release = await handOverStart('recording.start', { displayId: display.id, ...audio }, started, recorderAttempt, signal)
        release()
        return { displayId: display.id, ...audio }
      })
    ),

    'recording.stop': define('recording.stop', async () => {
      if (!recorder.isActive()) fail('not_found', 'No recording is in progress')
      const finished = recordingFinished(timeouts.stopMs)
      // a recording that is already being processed was stopped before: asking again would move its end
      if (recordingPhase() !== 'processing') recorder.requestStop()
      return finished.promise
    }),

    'recording.cancel': define('recording.cancel', async () => {
      if (!recorder.isActive()) fail('not_found', 'No recording is in progress')
      if (recordingPhase() === 'processing') fail('busy', 'The recording was already stopped and is being saved; it can no longer be cancelled. Use delete_project once it is saved')
      const cancelled = waitFor<void>(
        (resolve, reject) => {
          const onCancelled = (): void => resolve()
          const onFinished = ({ project }: { project: Project }): void => reject(new AgentError('busy', `The recording finished before it could be cancelled: ${project.id}`))
          const onFailed = ({ error }: { error: Error }): void => reject(new AgentError('failed', error.message))
          recorder.on('cancelled', onCancelled)
          recorder.on('finished', onFinished)
          recorder.on('failed', onFailed)
          return () => {
            recorder.off('cancelled', onCancelled)
            recorder.off('finished', onFinished)
            recorder.off('failed', onFailed)
          }
        },
        { ms: timeouts.cancelMs, error: () => new AgentError('failed', 'Timed out waiting for the recording to be cancelled') }
      )
      recorder.requestCancel()
      await cancelled.promise
      return {}
    }),

    'scenarios.record': define('scenarios.record', (p, signal) =>
      exclusive(signal, async () => {
        const scenario = await loadScenario(p.scenarioId)
        const audio = await resolveAudio(p)
        const started = recordingStarted()
        // the replay (start, schedule, a little slack) gets one budget, converting and saving the recording another
        const finished = recordingFinished(timeouts.startMs + scenarioEnd(scenario.actions) + timeouts.replaySlackMs, timeouts.stopMs)
        let release = (): void => undefined
        try {
          release = await handOverStart('scenarios.record', { scenarioId: p.scenarioId, ...audio }, started, recorderAttempt, signal)
          // the replay drives the recording and stops it at the end of the schedule, like in the UI; a client
          // that hangs up meanwhile gets the recording discarded (until it is being saved)
          return { scenarioId: p.scenarioId, ...(await finished.promise) }
        } finally {
          release()
          finished.cancel()
        }
      })
    )
  }

  return methods
}
