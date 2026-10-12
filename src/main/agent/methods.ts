import type { EventEmitter } from 'node:events'
import { isAbsolute } from 'node:path'
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
import { waitFor } from './waiter'

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
  getBarState(): RecorderBarState
  requestStop(): void
  requestCancel(): void
}
/** the part of ScenarioCapture the methods use */
export interface CapturePort extends EventEmitter<ScenarioCaptureEvents> {
  isActive(): boolean
  getState(): ScenarioCaptureState
  requestStop(): void
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
    exists: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<void>
  }
  scenarios: {
    list: () => Promise<ScenarioSummary[]>
    load: (id: string) => Promise<Scenario>
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
  /** from the stop request to the finished project (transcode, audio conversion) */
  stopMs: 15 * 60_000,
  cancelMs: 30_000,
  captureStopMs: 60_000,
  /** a scenario recording may overrun its schedule by this much before it counts as stuck */
  replaySlackMs: 3 * 60_000
}

const WARNING_TEXT: Record<RecordingWarning, string> = {
  systemAudio: 'System audio could not be captured, so the recording has no system audio track'
}

export interface RecordingResult {
  projectId: string
  durationMs: number
  warnings: string[]
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

  function define<N extends AgentMethodName>(name: N, fn: (params: z.infer<(typeof agentParamSchemas)[N]>) => Promise<unknown> | unknown): AgentMethodHandler {
    return async (raw) => {
      const parsed = agentParamSchemas[name].safeParse(raw)
      if (!parsed.success) fail('bad_params', `${name}: ${formatZodError(parsed.error)}`)
      return fn(parsed.data as z.infer<(typeof agentParamSchemas)[N]>)
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

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    assertIdle()
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
        const onCancelled = (): void => reject(new AgentError('cancelled', 'The recording was cancelled before it started'))
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

  /** resolves with the saved project; cancelled / failed attempts reject */
  function recordingFinished(timeoutMs: number) {
    return waitFor<RecordingResult>(
      (resolve, reject) => {
        const onFinished = ({ project, warnings }: { project: Project; warnings: RecordingWarning[] }): void =>
          resolve({
            projectId: project.id,
            durationMs: project.recording.durationMs,
            warnings: warnings.map((w) => WARNING_TEXT[w] ?? w)
          })
        const onCancelled = (): void => reject(new AgentError('cancelled', 'The recording was cancelled and discarded'))
        const onFailed = ({ error }: { error: Error }): void => reject(new AgentError('failed', `The recording failed: ${error.message}`))
        recorder.on('finished', onFinished)
        recorder.on('cancelled', onCancelled)
        recorder.on('failed', onFailed)
        return () => {
          recorder.off('finished', onFinished)
          recorder.off('cancelled', onCancelled)
          recorder.off('failed', onFailed)
        }
      },
      { ms: timeoutMs, error: () => new AgentError('failed', 'Timed out waiting for the recording to finish. Check get_status; it may still complete') }
    )
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
      await assertProjectExists(p.projectId)
      if (renderer.getStatus()?.openProjectId === p.projectId) {
        fail('busy', 'This recording is open in the ZoomCut editor; it cannot be deleted while open. Ask the user to close it (Back), or leave it')
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

    'projects.export': define('projects.export', async (p) => {
      if (p.folder !== undefined && !isAbsolute(p.folder)) fail('bad_params', `projects.export: folder must be an absolute path, got "${p.folder}"`)
      await assertProjectExists(p.projectId)
      return renderer.send('projects.export', p)
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
      if (!(await deps.scenarios.exists(p.scenarioId))) fail('not_found', `No scenario with id "${p.scenarioId}" (see list_scenarios)`)
      await deps.scenarios.remove(p.scenarioId)
      deps.notifyChanged('scenarios')
      return {}
    }),

    'scenarios.captureStart': define('scenarios.captureStart', (p) =>
      exclusive(async () => {
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
        try {
          await Promise.all([renderer.send('capture.start', { displayId: display.id }), capturing.promise])
        } catch (err) {
          capturing.cancel()
          throw err
        }
        // the user (or the agent through computer use) now performs the scenario; stop_scenario_capture ends it
        return { displayId: display.id }
      })
    ),

    'scenarios.captureStop': define('scenarios.captureStop', async () => {
      if (!capture.isActive()) fail('not_found', 'No scenario capture is in progress')
      const done = waitFor<Scenario>(
        (resolve, reject) => {
          const onDone = (scenario: Scenario | null): void => {
            if (scenario) resolve(scenario)
            else reject(new AgentError('cancelled', 'Nothing was saved: the capture was cancelled or no actions were captured'))
          }
          capture.on('done', onDone)
          return () => capture.off('done', onDone)
        },
        { ms: timeouts.captureStopMs, error: () => new AgentError('failed', 'Timed out waiting for the scenario capture to finish') }
      )
      // a capture already saving is just waited for
      if (capture.getState().phase !== 'saving') capture.requestStop()
      const scenario = await done.promise
      deps.notifyChanged('scenarios')
      return { scenarioId: scenario.id, actions: scenario.actions.length, durationMs: scenarioEnd(scenario.actions) }
    }),

    'recording.start': define('recording.start', (p) =>
      exclusive(async () => {
        const display = await resolveDisplay(p.displayId)
        const audio = await resolveAudio(p)
        const started = recordingStarted()
        try {
          await Promise.all([renderer.send('recording.start', { displayId: display.id, ...audio }), started.promise])
        } catch (err) {
          started.cancel()
          throw err
        }
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

    'scenarios.record': define('scenarios.record', (p) =>
      exclusive(async () => {
        const scenario = await loadScenario(p.scenarioId)
        const audio = await resolveAudio(p)
        const started = recordingStarted()
        const finished = recordingFinished(timeouts.startMs + scenarioEnd(scenario.actions) + timeouts.replaySlackMs)
        try {
          await renderer.send('scenarios.record', { scenarioId: p.scenarioId, ...audio })
          await started.promise
        } catch (err) {
          started.cancel()
          finished.cancel()
          throw err
        }
        // the replay drives the recording and stops it at the end of the schedule, like in the UI
        return { scenarioId: p.scenarioId, ...(await finished.promise) }
      })
    )
  }

  return methods
}
