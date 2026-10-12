import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Project, Scenario, ScenarioClickAction } from '@shared/types'
import type { AgentCommand, AgentProjectView, AgentReply, AgentRendererMethod } from '@shared/agent'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'

// The executor talks to `window.zc` (the preload API) and the zustand store only; a fake `zc` on
// globalThis is enough to run it in node. The exporter (Mediabunny / WebCodecs) is replaced.
const h = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const zc = {
    agent: { onCommand: vi.fn(), reply: vi.fn(), pushStatus: vi.fn(), mcpConfig: vi.fn() },
    projects: { load: vi.fn(), save: vi.fn() },
    scenario: { load: vi.fn() },
    app: { getSettings: vi.fn() },
    displays: { list: vi.fn() }
  }
  g.window = globalThis
  g.zc = zc
  if (!g.navigator) g.navigator = { language: 'en-US' }
  return { zc }
})
vi.mock('../export/exporter', () => ({ runExport: vi.fn() }))

import { useStore } from '../store'
import { useI18n } from '../i18n'
import { runExport } from '../export/exporter'
import { installAgentExecutor } from './executor'

const zc = h.zc
const runExportMock = vi.mocked(runExport)

function makeProject(id = 'p1'): Project {
  return {
    version: 1,
    id,
    name: 'Demo',
    recording: {
      id,
      createdAt: 0,
      dir: `C:\\Videos\\ZoomCut\\${id}`,
      videoPath: `C:\\Videos\\ZoomCut\\${id}\\recording.mp4`,
      width: 1920,
      height: 1080,
      durationMs: 10000,
      fps: 30,
      displayName: 'Display 1'
    },
    cursorData: { samples: [], clicks: [], source: 'uiohook' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio: [],
    cursor: { ...DEFAULT_CURSOR_SETTINGS },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: { ...DEFAULT_FRAME_STYLE },
    export: { ...DEFAULT_EXPORT_SETTINGS },
    updatedAt: 0
  }
}

function makeScenario(id = 's1', withAction = true): Scenario {
  const click: ScenarioClickAction = {
    id: 'a1',
    kind: 'click',
    at: 0,
    x: 100,
    y: 100,
    path: [],
    modifiers: { ctrl: false, shift: false, alt: false, meta: false },
    shot: null,
    durationMs: 800,
    pauseMs: 1500
  }
  return {
    version: 2,
    id,
    name: 'Scenario',
    createdAt: 0,
    displayId: 4,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: withAction ? [click] : [],
    durationMs: 5000,
    dir: `C:\\scenarios\\${id}`
  }
}

const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({
  lastExportFolder: null,
  lastDisplayId: null,
  language: 'en',
  cursorDefaults: null,
  frameDefaults: null,
  audioDefaults: null,
  ...patch
})

let handler: (c: AgentCommand) => void
let dispose: () => void
let seq = 0
/** a fake disk: projects.load / projects.save */
let disk: Map<string, Project>

/** replies by request id, so commands that run at the same time get their own answer */
const waiting = new Map<string, (r: AgentReply) => void>()

/** Sends one command and resolves with the reply the executor produced. */
function call(method: AgentRendererMethod, params: unknown, requestId = `r${++seq}`): Promise<AgentReply> {
  return new Promise((resolve) => {
    waiting.set(requestId, resolve)
    handler({ requestId, method, params })
  })
}

function okResult<T>(reply: AgentReply): T {
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}: ${reply.error.message}`)
  return reply.result as T
}

function errorOf(reply: AgentReply): { code: string; message: string } {
  if (reply.ok) throw new Error('expected an error reply')
  return reply.error
}

/** What Home / ScenarioReview do: take the pending start the moment it is set. */
function fakeScreenTakingStarts(taken: unknown[]): () => void {
  return useStore.subscribe((s) => {
    if (!s.pendingStart) return
    queueMicrotask(() => {
      const start = useStore.getState().takePendingStart(() => true)
      if (start) taken.push(start)
    })
  })
}

beforeEach(() => {
  // reset, not just clear: an unused mockXOnce from an earlier test must not leak into the next
  vi.resetAllMocks()
  waiting.clear()
  disk = new Map()
  // the notices are asserted in English whatever the language of the machine running the tests
  useI18n.getState().apply('en')
  useStore.setState({
    screen: 'home',
    notice: null,
    pendingStart: null,
    project: null,
    scenario: null,
    composition: null,
    selection: null,
    mode: 'normal',
    history: [],
    future: []
  })
  zc.agent.onCommand.mockImplementation((cb: (c: AgentCommand) => void) => {
    handler = cb
    return () => undefined
  })
  zc.agent.reply.mockImplementation(async (r: AgentReply) => {
    waiting.get(r.requestId)?.(r)
  })
  zc.agent.pushStatus.mockResolvedValue(undefined)
  zc.projects.load.mockImplementation(async (id: string) => {
    const p = disk.get(id)
    if (!p) throw new Error(`Error invoking remote method 'projects:load': Error: not found ${id}`)
    return p
  })
  zc.projects.save.mockImplementation(async (p: Project) => {
    disk.set(p.id, p)
  })
  zc.app.getSettings.mockResolvedValue(settings())
  zc.displays.list.mockResolvedValue([])
  dispose = installAgentExecutor()
})

afterEach(() => {
  dispose()
  vi.useRealTimers()
})

describe('status', () => {
  it('pushes the screen and the open project, only when they change', () => {
    expect(zc.agent.pushStatus).toHaveBeenCalledTimes(1)
    expect(zc.agent.pushStatus).toHaveBeenLastCalledWith({ screen: 'home', openProjectId: null })
    useStore.getState().openProject(makeProject())
    expect(zc.agent.pushStatus).toHaveBeenLastCalledWith({ screen: 'editor', openProjectId: 'p1' })
    useStore.getState().setPlayhead(500)
    useStore.getState().select({ kind: 'zoom', id: 'x' })
    expect(zc.agent.pushStatus).toHaveBeenCalledTimes(2)
    useStore.getState().closeProject()
    expect(zc.agent.pushStatus).toHaveBeenLastCalledWith({ screen: 'home', openProjectId: null })
  })

  it('survives a main process that does not answer', () => {
    zc.agent.pushStatus.mockRejectedValue(new Error('no handler'))
    expect(() => useStore.getState().openProject(makeProject())).not.toThrow()
  })

  it('listens for commands before it announces itself, and repeats a first push that failed', async () => {
    dispose()
    vi.useFakeTimers()
    vi.resetAllMocks()
    const order: string[] = []
    zc.agent.onCommand.mockImplementation((cb: (c: AgentCommand) => void) => {
      order.push('listen')
      handler = cb
      return () => undefined
    })
    zc.agent.pushStatus.mockImplementationOnce(async () => {
      order.push('push')
      throw new Error('main is not ready')
    })
    zc.agent.pushStatus.mockImplementation(async () => {
      order.push('push')
    })
    dispose = installAgentExecutor()
    expect(order).toEqual(['listen', 'push'])
    await vi.advanceTimersByTimeAsync(500)
    expect(order).toEqual(['listen', 'push', 'push'])
    expect(zc.agent.pushStatus).toHaveBeenLastCalledWith({ screen: 'home', openProjectId: null })
    // once it got through nothing is repeated
    await vi.advanceTimersByTimeAsync(5000)
    expect(zc.agent.pushStatus).toHaveBeenCalledTimes(2)
  })
})

describe('command loop', () => {
  it('answers an unknown method with unknown_method', async () => {
    const reply = await call('nope' as AgentRendererMethod, {})
    expect(errorOf(reply).code).toBe('unknown_method')
  })

  it('replies exactly once, even when the same request arrives twice', async () => {
    disk.set('p1', makeProject())
    const first = call('projects.edit', { projectId: 'p1', operations: [] }, 'dup')
    handler({ requestId: 'dup', method: 'projects.edit', params: { projectId: 'p1', operations: [] } })
    await first
    await new Promise((r) => setTimeout(r, 10))
    expect(zc.agent.reply).toHaveBeenCalledTimes(1)
  })

  it('maps a thrown error to a failed reply with the cleaned message', async () => {
    zc.app.getSettings.mockRejectedValue(new Error("Error invoking remote method 'app:get-settings': Error: disk gone"))
    const reply = await call('capture.start', {})
    expect(errorOf(reply)).toEqual({ code: 'failed', message: 'disk gone' })
  })
})

describe('projects.edit', () => {
  it('edits the open project as one undo step and saves it right away', async () => {
    useStore.getState().openProject(makeProject())
    const reply = await call('projects.edit', {
      projectId: 'p1',
      operations: [
        { op: 'addCut', start: 1000, end: 2000 },
        { op: 'addText', start: 3000, end: 4000, text: 'Hello' }
      ]
    })
    const view = okResult<AgentProjectView>(reply)
    expect(view.cuts).toHaveLength(1)
    expect(view.texts).toHaveLength(1)
    expect(view.outputDurationMs).toBe(9000)

    const state = useStore.getState()
    expect(state.project?.cuts).toHaveLength(1)
    expect(state.history).toHaveLength(1)
    expect(zc.projects.load).not.toHaveBeenCalled()
    expect(zc.projects.save).toHaveBeenCalledTimes(1)
    expect(zc.projects.save.mock.calls[0][0]).toBe(state.project)

    state.undo()
    expect(useStore.getState().project?.cuts).toEqual([])
    expect(useStore.getState().project?.texts).toEqual([])
  })

  it('does not touch the project when an operation is invalid', async () => {
    useStore.getState().openProject(makeProject())
    const before = useStore.getState().project
    const reply = await call('projects.edit', {
      projectId: 'p1',
      operations: [{ op: 'addCut', start: 1000, end: 2000 }, { op: 'addZoom', start: 0, end: 1000, mode: 'sideways' }]
    })
    expect(errorOf(reply)).toMatchObject({ code: 'bad_params' })
    expect(errorOf(reply).message).toMatch(/^operations\[1\] \(addZoom\)/)
    expect(useStore.getState().project).toBe(before)
    expect(useStore.getState().history).toHaveLength(0)
    expect(zc.projects.save).not.toHaveBeenCalled()
  })

  it('drops a selection that no longer exists', async () => {
    const p = makeProject()
    p.zooms = [{ id: 'z1', start: 1000, end: 3000, scale: 2, mode: 'follow', target: { x: 0.5, y: 0.5 }, easeInMs: 600, easeOutMs: 500 }]
    useStore.getState().openProject(p)
    useStore.getState().select({ kind: 'zoom', id: 'z1' })
    await call('projects.edit', { projectId: 'p1', operations: [{ op: 'removeZoom', id: 'z1' }] })
    expect(useStore.getState().selection).toBeNull()
    expect(useStore.getState().project?.zooms).toEqual([])
  })

  it('keeps a selection that still exists', async () => {
    const p = makeProject()
    p.texts = []
    useStore.getState().openProject(p)
    await call('projects.edit', { projectId: 'p1', operations: [{ op: 'addText', start: 0, end: 1000, text: 'a' }] })
    const id = useStore.getState().project!.texts[0].id
    useStore.getState().select({ kind: 'text', id })
    await call('projects.edit', { projectId: 'p1', operations: [{ op: 'updateText', id, text: 'b' }] })
    expect(useStore.getState().selection).toEqual({ kind: 'text', id })
  })

  it('edits a project from disk when it is not open', async () => {
    disk.set('p2', makeProject('p2'))
    const reply = await call('projects.edit', { projectId: 'p2', operations: [{ op: 'rename', name: 'Renamed' }] })
    expect(okResult<AgentProjectView>(reply).name).toBe('Renamed')
    expect(disk.get('p2')?.name).toBe('Renamed')
    expect(useStore.getState().project).toBeNull()
  })

  it('answers not_found for an unknown cut, zoom, text or blur id', async () => {
    useStore.getState().openProject(makeProject())
    const reply = await call('projects.edit', { projectId: 'p1', operations: [{ op: 'removeZoom', id: 'ghost' }] })
    expect(errorOf(reply).code).toBe('not_found')
    expect(errorOf(reply).message).toMatch(/^operations\[0\] \(removeZoom\): unknown zoom id "ghost"/)
  })

  it('answers not_found for an unknown project', async () => {
    const reply = await call('projects.edit', { projectId: 'ghost', operations: [] })
    expect(errorOf(reply).code).toBe('not_found')
  })

  it('answers bad_params for missing params', async () => {
    expect(errorOf(await call('projects.edit', { operations: [] })).code).toBe('bad_params')
    expect(errorOf(await call('projects.edit', { projectId: 'p1' })).code).toBe('bad_params')
  })

  it('runs edits to one project in order, so none is lost', async () => {
    disk.set('p2', makeProject('p2'))
    const [a, b, c] = await Promise.all([
      call('projects.edit', { projectId: 'p2', operations: [{ op: 'addCut', start: 0, end: 1000 }] }),
      call('projects.edit', { projectId: 'p2', operations: [{ op: 'addCut', start: 2000, end: 3000 }] }),
      call('projects.edit', { projectId: 'p2', operations: [{ op: 'rename', name: 'Both' }] })
    ])
    expect(okResult<AgentProjectView>(a).cuts).toHaveLength(1)
    expect(okResult<AgentProjectView>(b).cuts).toHaveLength(2)
    expect(okResult<AgentProjectView>(c).name).toBe('Both')
    expect(disk.get('p2')?.cuts).toHaveLength(2)
    expect(disk.get('p2')?.name).toBe('Both')
  })

  it('reports a save failure instead of pretending it worked', async () => {
    disk.set('p2', makeProject('p2'))
    zc.projects.save.mockRejectedValueOnce(new Error('disk full'))
    const reply = await call('projects.edit', { projectId: 'p2', operations: [{ op: 'rename', name: 'x' }] })
    expect(errorOf(reply)).toMatchObject({ code: 'failed' })
    expect(errorOf(reply).message).toMatch(/could not be saved: disk full/)
  })
})

describe('projects.export', () => {
  it('exports the open project with its current edits and the resolved settings', async () => {
    const p = makeProject()
    useStore.getState().openProject(p)
    useStore.getState().addCut(0, 1000)
    zc.app.getSettings.mockResolvedValue(settings({ lastExportFolder: 'D:\\Exports' }))
    let noticeDuring: string | null = null
    runExportMock.mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: 'render', percent: 42.7 })
      noticeDuring = useStore.getState().notice
      return { outputPath: 'D:\\Exports\\Demo.mp4', bytes: 1234 }
    })

    const reply = await call('projects.export', { projectId: 'p1', fileName: 'Demo.mp4', fps: 60 })

    expect(okResult(reply)).toEqual({ outputPath: 'D:\\Exports\\Demo.mp4', bytes: 1234 })
    expect(runExportMock).toHaveBeenCalledTimes(1)
    const args = runExportMock.mock.calls[0][0]
    expect(args.project.cuts).toHaveLength(1)
    expect(args.settings).toMatchObject({ format: 'mp4', fps: 60, fileName: 'Demo', folder: 'D:\\Exports' })
    expect(args.followPath).toBeNull()
    expect(noticeDuring).toMatch(/exporting a video… 42%/)
    // cleared afterwards, and the used settings are the project's now
    expect(useStore.getState().notice).toBeNull()
    expect(useStore.getState().project?.export).toMatchObject({ fps: 60, fileName: 'Demo', folder: 'D:\\Exports' })
  })

  it('exports a project from disk and saves the settings into it', async () => {
    disk.set('p2', makeProject('p2'))
    runExportMock.mockResolvedValue({ outputPath: 'x.gif', bytes: 1 })
    await call('projects.export', { projectId: 'p2', format: 'gif', folder: 'E:\\Out' })
    expect(runExportMock.mock.calls[0][0].settings).toMatchObject({ format: 'gif', fps: 15, scale: 0.5, folder: 'E:\\Out' })
    expect(disk.get('p2')?.export).toMatchObject({ format: 'gif', folder: 'E:\\Out' })
  })

  it('refuses a second export while one runs, then accepts the next', async () => {
    disk.set('p2', makeProject('p2'))
    let finish: () => void = () => undefined
    runExportMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outputPath: 'a.mp4', bytes: 1 })
        })
    )
    const first = call('projects.export', { projectId: 'p2' })
    await vi.waitFor(() => expect(runExportMock).toHaveBeenCalledTimes(1))
    const second = await call('projects.export', { projectId: 'p2' })
    expect(errorOf(second).code).toBe('busy')
    finish()
    expect(okResult(await first)).toEqual({ outputPath: 'a.mp4', bytes: 1 })

    runExportMock.mockResolvedValueOnce({ outputPath: 'b.mp4', bytes: 2 })
    expect(okResult(await call('projects.export', { projectId: 'p2' }))).toEqual({ outputPath: 'b.mp4', bytes: 2 })
  })

  it('reports an exporter failure, clears the notice and frees the slot', async () => {
    disk.set('p2', makeProject('p2'))
    runExportMock.mockRejectedValueOnce(new Error('ffmpeg exploded'))
    const reply = await call('projects.export', { projectId: 'p2' })
    expect(errorOf(reply)).toEqual({ code: 'failed', message: 'ffmpeg exploded' })
    expect(useStore.getState().notice).toBeNull()
    runExportMock.mockResolvedValueOnce({ outputPath: 'ok.mp4', bytes: 1 })
    okResult(await call('projects.export', { projectId: 'p2' }))
  })

  it('rejects bad parameters and an all-cut recording before exporting anything', async () => {
    disk.set('p2', { ...makeProject('p2'), cuts: [{ id: 'c', start: 0, end: 10000 }] })
    expect(errorOf(await call('projects.export', { projectId: 'p2' })).message).toMatch(/whole recording is cut out/)
    disk.set('p3', makeProject('p3'))
    expect(errorOf(await call('projects.export', { projectId: 'p3', fps: 15 })).message).toMatch(/not available for MP4/)
    expect(errorOf(await call('projects.export', { projectId: 'p3', folder: 'relative' })).code).toBe('bad_params')
    expect(errorOf(await call('projects.export', { projectId: 'ghost' })).code).toBe('not_found')
    expect(runExportMock).not.toHaveBeenCalled()
  })

  it('leaves a notice the user dismissed alone', async () => {
    disk.set('p2', makeProject('p2'))
    runExportMock.mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: 'render', percent: 10 })
      useStore.getState().setNotice(null)
      onProgress({ phase: 'render', percent: 20 })
      return { outputPath: 'x.mp4', bytes: 1 }
    })
    await call('projects.export', { projectId: 'p2' })
    expect(useStore.getState().notice).toBeNull()
  })
})

describe('recording.start', () => {
  it('closes the editor, hands over a record start with the remembered audio and replies once it was taken', async () => {
    useStore.getState().openProject(makeProject())
    zc.app.getSettings.mockResolvedValue(settings({ lastDisplayId: 7, audioDefaults: { mic: false, micDeviceId: null, system: true } }))
    const taken: unknown[] = []
    const off = fakeScreenTakingStarts(taken)

    const reply = await call('recording.start', { mic: true })
    off()

    expect(okResult(reply)).toEqual({})
    expect(taken).toEqual([{ kind: 'record', displayId: 7, audio: { mic: true, micDeviceId: null, system: true } }])
    expect(useStore.getState().project).toBeNull()
    expect(useStore.getState().screen).toBe('home')
    expect(useStore.getState().pendingStart).toBeNull()
  })

  it('uses the given display and falls back to the primary one', async () => {
    const taken: unknown[] = []
    const off = fakeScreenTakingStarts(taken)
    await call('recording.start', { displayId: 3, systemAudio: true })
    zc.displays.list.mockResolvedValue([
      { id: 1, primary: false },
      { id: 2, primary: true }
    ])
    await call('recording.start', {})
    off()
    expect(taken).toEqual([
      { kind: 'record', displayId: 3, audio: { mic: false, micDeviceId: null, system: true } },
      { kind: 'record', displayId: 2, audio: { mic: false, micDeviceId: null, system: false } }
    ])
  })

  it('leaves a composition and a scenario screen too', async () => {
    useStore.setState({ screen: 'scenario', scenario: makeScenario() })
    const off = fakeScreenTakingStarts([])
    await call('recording.start', { displayId: 1 })
    off()
    expect(useStore.getState().scenario).toBeNull()
    expect(useStore.getState().screen).toBe('home')
  })

  it('fails and withdraws the start when no screen takes it', async () => {
    vi.useFakeTimers()
    const pending = call('recording.start', { displayId: 1 })
    await vi.advanceTimersByTimeAsync(10_500)
    expect(errorOf(await pending).code).toBe('failed')
    expect(useStore.getState().pendingStart).toBeNull()
  })

  it('rejects wrong parameter types', async () => {
    expect(errorOf(await call('recording.start', { mic: 'yes' })).code).toBe('bad_params')
    expect(errorOf(await call('recording.start', { displayId: 'main' })).code).toBe('bad_params')
  })
})

describe('scenarios.record', () => {
  it('opens the scenario with a replay queued', async () => {
    zc.scenario.load.mockResolvedValue(makeScenario('s1'))
    zc.app.getSettings.mockResolvedValue(settings({ audioDefaults: { mic: true, micDeviceId: 'usb', system: false } }))
    useStore.getState().openProject(makeProject())
    const taken: unknown[] = []
    const off = fakeScreenTakingStarts(taken)

    const reply = await call('scenarios.record', { scenarioId: 's1', systemAudio: true })
    off()

    expect(okResult(reply)).toEqual({})
    expect(taken).toEqual([{ kind: 'replay', scenarioId: 's1', audio: { mic: true, micDeviceId: 'usb', system: true } }])
    expect(useStore.getState().screen).toBe('scenario')
    expect(useStore.getState().scenario?.id).toBe('s1')
    expect(useStore.getState().project).toBeNull()
  })

  it('replays the scenario already on screen, with its unsaved edits', async () => {
    const shown = { ...makeScenario('s1'), name: 'edited in the review screen' }
    useStore.setState({ screen: 'scenario', scenario: shown })
    const off = fakeScreenTakingStarts([])
    okResult(await call('scenarios.record', { scenarioId: 's1' }))
    off()
    expect(zc.scenario.load).not.toHaveBeenCalled()
    expect(useStore.getState().scenario).toBe(shown)
  })

  it('switches from another open scenario', async () => {
    useStore.setState({ screen: 'scenario', scenario: makeScenario('other') })
    zc.scenario.load.mockResolvedValue(makeScenario('s2'))
    const off = fakeScreenTakingStarts([])
    okResult(await call('scenarios.record', { scenarioId: 's2' }))
    off()
    expect(useStore.getState().scenario?.id).toBe('s2')
  })

  it('answers not_found and bad_params without touching the UI', async () => {
    zc.scenario.load.mockRejectedValueOnce(new Error('missing'))
    expect(errorOf(await call('scenarios.record', { scenarioId: 'ghost' })).code).toBe('not_found')
    zc.scenario.load.mockResolvedValueOnce(makeScenario('empty', false))
    expect(errorOf(await call('scenarios.record', { scenarioId: 'empty' })).message).toMatch(/no actions/)
    expect(errorOf(await call('scenarios.record', {})).code).toBe('bad_params')
    expect(useStore.getState().pendingStart).toBeNull()
    expect(useStore.getState().screen).toBe('home')
  })
})

describe('capture.start', () => {
  it('goes home and hands over a capture on the display', async () => {
    useStore.getState().openProject(makeProject())
    const taken: unknown[] = []
    const off = fakeScreenTakingStarts(taken)
    okResult(await call('capture.start', { displayId: 5 }))
    off()
    expect(taken).toEqual([{ kind: 'capture', displayId: 5 }])
    expect(useStore.getState().screen).toBe('home')
  })

  it('works without parameters', async () => {
    zc.app.getSettings.mockResolvedValue(settings({ lastDisplayId: 9 }))
    const taken: unknown[] = []
    const off = fakeScreenTakingStarts(taken)
    okResult(await call('capture.start', undefined))
    off()
    expect(taken).toEqual([{ kind: 'capture', displayId: 9 }])
  })
})
