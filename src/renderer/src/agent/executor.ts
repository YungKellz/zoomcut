import type { AppSettings, ExportFinishResult, ExportSettings, Project, Scenario } from '@shared/types'
import { AgentError, type AgentCommand, type AgentProjectView, type AgentReply, type AgentUiStatus } from '@shared/agent'
import { validateScenario } from '@shared/scenario'
import { useStore, type PendingStart, type Selection } from '../store'
import { followPathFor } from '../engine/cursor'
import { keepSegments, outputDuration } from '../engine/timeline'
import { runExport } from '../export/exporter'
import { t } from '../i18n'
import { applyAgentEdits, toAgentProjectView } from './edits'
import {
  errorPayload,
  parseCaptureParams,
  parseEditParams,
  parseExportParams,
  parseRecordParams,
  parseScenarioRecordParams,
  resolveAudio,
  resolveExportSettings
} from './params'

/**
 * Runs the commands an AI agent sent through the MCP bridge (forwarded by the main process as
 * `agent:command`, see src/shared/agent.ts) in the main window and answers each one exactly once.
 *
 * - projects.edit applies applyAgentEdits to the open project as one undo step (or to a project
 *   from disk) and saves it at once, so the main process, which answers get_project from disk,
 *   never sees stale data.
 * - projects.export runs the editor's own exporter, with no dialog; a store notice tells the user.
 * - recording.start, scenarios.record and capture.start only hand the start to the screen that owns
 *   the recorder (store.pendingStart, like "Record again") and reply once that screen took it;
 *   the main process waits for the real recorder / capture phase itself.
 * Nothing here ever opens a confirm() or alert(): an agent cannot click them.
 */

/** How long a screen may take to pick up a handed-over start (it only has to mount and run an effect). */
const HANDOVER_TIMEOUT_MS = 10_000

export function installAgentExecutor(): () => void {
  const offStatus = pushStatusOnChange()
  const offCommand = window.zc.agent.onCommand((cmd) => void run(cmd))
  return () => {
    offStatus()
    offCommand()
  }
}

// ---- status for get_status ----

function pushStatusOnChange(): () => void {
  let last = ''
  const push = (): void => {
    const s = useStore.getState()
    const status: AgentUiStatus = { screen: s.screen, openProjectId: s.project?.id ?? null }
    const key = `${status.screen}\n${status.openProjectId ?? ''}`
    if (key === last) return
    last = key
    // best effort: the status is only a cache in the main process
    void window.zc.agent.pushStatus(status).catch(() => undefined)
  }
  push()
  return useStore.subscribe(push)
}

// ---- command loop ----

const inFlight = new Set<string>()

async function run(cmd: AgentCommand): Promise<void> {
  if (inFlight.has(cmd.requestId)) return
  inFlight.add(cmd.requestId)
  let reply: AgentReply
  try {
    reply = { requestId: cmd.requestId, ok: true, result: await dispatch(cmd) }
  } catch (err) {
    if (!(err instanceof AgentError)) console.error('[agent] command failed', cmd.method, err)
    reply = { requestId: cmd.requestId, ok: false, error: errorPayload(err) }
  }
  try {
    await window.zc.agent.reply(reply)
  } catch (err) {
    console.error('[agent] could not send the reply', err)
  } finally {
    inFlight.delete(cmd.requestId)
  }
}

async function dispatch(cmd: AgentCommand): Promise<unknown> {
  switch (cmd.method) {
    case 'projects.edit':
      return editProject(cmd.params)
    case 'projects.export':
      return exportProject(cmd.params)
    case 'recording.start':
      return startRecording(cmd.params)
    case 'scenarios.record':
      return recordScenario(cmd.params)
    case 'capture.start':
      return startCapture(cmd.params)
    default:
      throw new AgentError('unknown_method', `the renderer does not handle "${String(cmd.method)}"`)
  }
}

// ---- projects ----

async function loadProject(id: string): Promise<Project> {
  try {
    return await window.zc.projects.load(id)
  } catch (err) {
    throw new AgentError('not_found', `no recording with id "${id}": ${errorPayload(err).message}`)
  }
}

/** Edits to one project run one after another: a read-modify-write of a project on disk must not interleave. */
const editQueues = new Map<string, Promise<unknown>>()

function inQueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const done = (editQueues.get(key) ?? Promise.resolve()).then(job, job)
  editQueues.set(key, done)
  const cleanup = (): void => {
    if (editQueues.get(key) === done) editQueues.delete(key)
  }
  done.then(cleanup, cleanup)
  return done
}

function selectionExists(p: Project, sel: NonNullable<Selection>): boolean {
  const list = sel.kind === 'cut' ? p.cuts : sel.kind === 'zoom' ? p.zooms : sel.kind === 'text' ? p.texts : sel.kind === 'blur' ? p.blurs : p.audio
  return list.some((x) => x.id === sel.id)
}

/** After an agent edit the editor must not point at something that no longer exists. */
function dropStaleSelection(): void {
  const { project, selection, mode } = useStore.getState()
  if (!project || !selection || selectionExists(project, selection)) return
  const store = useStore.getState()
  store.select(null)
  if (mode === 'pickTarget') store.setMode('normal')
}

function editProject(params: unknown): Promise<AgentProjectView> {
  const { projectId, operations } = parseEditParams(params)
  return inQueue(projectId, async () => {
    const open = useStore.getState().project
    if (open?.id === projectId) {
      // the project in the editor: one undo step, autosave picks it up - and it is saved right away too
      const next = applyAgentEdits(open, operations)
      if (next === open) return toAgentProjectView(open)
      useStore.getState().mutate(() => next, true)
      dropStaleSelection()
      const edited = useStore.getState().project!
      await saveEdited(edited)
      return toAgentProjectView(edited)
    }
    const project = await loadProject(projectId)
    const next = applyAgentEdits(project, operations)
    if (next === project) return toAgentProjectView(project)
    const edited = { ...next, updatedAt: Date.now() }
    await saveEdited(edited)
    return toAgentProjectView(edited)
  })
}

async function saveEdited(project: Project): Promise<void> {
  try {
    await window.zc.projects.save(project)
  } catch (err) {
    throw new AgentError('failed', `the edit was applied but could not be saved: ${errorPayload(err).message}`)
  }
}

// ---- export ----

let exporting = false
/** the notice text this module put up, so it only ever clears (or updates) its own */
let exportNotice: string | null = null

function showExportProgress(percent: number): void {
  const store = useStore.getState()
  // the user dismissed it, or something else took the bar over: leave it alone
  if (exportNotice !== null && store.notice !== exportNotice) return
  const text = t('agent.exporting', { percent: Math.max(0, Math.min(100, Math.floor(percent))) })
  if (store.notice === text) return
  exportNotice = text
  store.setNotice(text)
}

function clearExportNotice(): void {
  const store = useStore.getState()
  if (exportNotice !== null && store.notice === exportNotice) store.setNotice(null)
  exportNotice = null
}

/** The used settings become the project's, like the export dialog does when it starts. */
async function rememberExportSettings(projectId: string, settings: ExportSettings): Promise<void> {
  if (useStore.getState().project?.id === projectId) {
    useStore.getState().updateExport(settings)
    return
  }
  // not in the editor: patch the saved project, after any edit still queued for it
  await inQueue(projectId, async () => {
    const saved = await loadProject(projectId)
    await saveEdited({ ...saved, export: settings, updatedAt: Date.now() })
  })
}

async function exportProject(params: unknown): Promise<ExportFinishResult> {
  const p = parseExportParams(params)
  if (exporting) throw new AgentError('busy', 'another export is already running; wait for it to finish')
  exporting = true
  try {
    const open = useStore.getState().project
    const isOpen = open?.id === p.projectId
    const project = isOpen ? open : await loadProject(p.projectId)
    if (outputDuration(keepSegments(project.recording.durationMs, project.cuts)) <= 0) {
      throw new AgentError('bad_params', 'nothing to export: the whole recording is cut out')
    }
    const settings = resolveExportSettings(project, p, { lastExportFolder: (await window.zc.app.getSettings()).lastExportFolder })

    await rememberExportSettings(project.id, settings)

    showExportProgress(0)
    return await runExport({
      project,
      settings,
      followPath: followPathFor(project),
      onProgress: (progress) => showExportProgress(progress.phase === 'finalize' ? 100 : progress.percent),
      signal: new AbortController().signal
    })
  } finally {
    exporting = false
    clearExportNotice()
  }
}

// ---- starting a recording / replay / capture ----

/** Closes whatever is open (the autosaves flush as usual) and lands on Home. */
function leaveToHome(): void {
  const store = useStore.getState()
  if (store.project) store.closeProject()
  if (useStore.getState().composition) useStore.getState().closeComposition()
  if (useStore.getState().scenario) useStore.getState().closeScenario()
}

/**
 * Sets the pending start (then runs `then`, e.g. opening the scenario review) and resolves once
 * the screen that owns the recorder took it. Gives up, and withdraws it, after HANDOVER_TIMEOUT_MS.
 */
function handOver(start: PendingStart, then?: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const unsubscribe = useStore.subscribe((s) => {
      if (s.pendingStart === start) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve()
    })
    const timer = window.setTimeout(() => {
      unsubscribe()
      if (useStore.getState().pendingStart === start) useStore.getState().setPendingStart(null)
      reject(new AgentError('failed', 'ZoomCut did not start the recording in time; make sure its window is not blocked by a dialog'))
    }, HANDOVER_TIMEOUT_MS)
    useStore.getState().setPendingStart(start)
    then?.()
  })
}

/** The display to record: the given one, else the last used, else the primary. */
async function resolveDisplay(given: number | undefined, settings: AppSettings): Promise<number> {
  if (given !== undefined) return given
  if (settings.lastDisplayId !== null) return settings.lastDisplayId
  const displays = await window.zc.displays.list()
  const display = displays.find((d) => d.primary) ?? displays[0]
  if (!display) throw new AgentError('failed', 'no display found to record')
  return display.id
}

async function startRecording(params: unknown): Promise<Record<string, never>> {
  const { displayId, mic, systemAudio } = parseRecordParams(params)
  const settings = await window.zc.app.getSettings()
  const display = await resolveDisplay(displayId, settings)
  const audio = resolveAudio(settings.audioDefaults, { mic, systemAudio })
  leaveToHome()
  await handOver({ kind: 'record', displayId: display, audio })
  return {}
}

async function recordScenario(params: unknown): Promise<Record<string, never>> {
  const { scenarioId, mic, systemAudio } = parseScenarioRecordParams(params)
  // the scenario on screen may carry edits that are not saved yet: replay what the user sees
  const shown = useStore.getState().scenario
  let scenario: Scenario
  if (shown?.id === scenarioId) {
    scenario = shown
  } else {
    try {
      scenario = await window.zc.scenario.load(scenarioId)
    } catch (err) {
      throw new AgentError('not_found', `no scenario with id "${scenarioId}": ${errorPayload(err).message}`)
    }
  }
  const invalid = validateScenario(scenario.actions)
  if (invalid) {
    throw new AgentError('bad_params', invalid === 'empty' ? 'the scenario has no actions' : 'the scenario is longer than the maximum of 10 minutes')
  }
  const audio = resolveAudio((await window.zc.app.getSettings()).audioDefaults, { mic, systemAudio })

  const store = useStore.getState()
  if (store.project) store.closeProject()
  if (useStore.getState().composition) useStore.getState().closeComposition()
  const alreadyOpen = useStore.getState().scenario?.id === scenario.id
  // another scenario is replaced the way the UI switches: closing flushes its pending autosave
  if (!alreadyOpen && useStore.getState().scenario) useStore.getState().closeScenario()
  await handOver({ kind: 'replay', scenarioId: scenario.id, audio }, alreadyOpen ? undefined : () => useStore.getState().openScenario(scenario))
  return {}
}

async function startCapture(params: unknown): Promise<Record<string, never>> {
  const displayId = await resolveDisplay(parseCaptureParams(params).displayId, await window.zc.app.getSettings())
  leaveToHome()
  await handOver({ kind: 'capture', displayId })
  return {}
}
