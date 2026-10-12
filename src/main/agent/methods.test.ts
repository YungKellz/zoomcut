import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AgentError } from '@shared/agent'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import type { Project, RecorderBarState, Scenario, ScenarioCaptureState, ScenarioSummary } from '@shared/types'
import type { RecorderEvents } from '../recorder/controller'
import type { ScenarioCaptureEvents } from '../scenario/capture'
import { createAgentMethods, type AgentDeps, type AgentDisplayInfo } from './methods'
import type { AgentMethodTable } from './server'

class FakeRecorder extends EventEmitter<RecorderEvents> {
  active = false
  bar: RecorderBarState = { phase: 'idle', startedAt: null, countdownEndsAt: null }
  requestStop = vi.fn()
  requestCancel = vi.fn()
  isActive(): boolean {
    return this.active
  }
  getBarState(): RecorderBarState {
    return this.bar
  }
  /** what RecordingController.setBarState does */
  setBar(phase: RecorderBarState['phase']): void {
    this.bar = { phase, startedAt: null, countdownEndsAt: null }
    this.emit('state', this.bar)
  }
}

class FakeCapture extends EventEmitter<ScenarioCaptureEvents> {
  state: ScenarioCaptureState = { phase: 'idle', actions: 0, startedAt: null }
  isActive(): boolean {
    return this.state.phase !== 'idle'
  }
  getState(): ScenarioCaptureState {
    return this.state
  }
  requestStop = vi.fn()
  setPhase(phase: ScenarioCaptureState['phase']): void {
    this.state = { phase, actions: 0, startedAt: null }
    this.emit('state', this.state)
  }
}

const DISPLAYS: AgentDisplayInfo[] = [
  { id: 11, name: 'Screen 1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25, primary: true },
  { id: 22, name: 'Screen 2', bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1, primary: false }
]

function project(id: string, over: Partial<Project> = {}): Project {
  return {
    version: 1,
    id,
    name: `Project ${id}`,
    recording: { id, createdAt: 1000, dir: `C:\\rec\\${id}`, videoPath: '', width: 1920, height: 1080, durationMs: 5000, fps: 30, displayName: 'Screen 1' },
    cursorData: { samples: [], clicks: [], source: 'uiohook' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio: [],
    cursor: DEFAULT_CURSOR_SETTINGS,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: DEFAULT_FRAME_STYLE,
    export: { ...DEFAULT_EXPORT_SETTINGS },
    updatedAt: 1,
    ...over
  }
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
}

interface Harness {
  methods: AgentMethodTable
  recorder: FakeRecorder
  capture: FakeCapture
  deps: AgentDeps
  sent: Array<{ method: string; params: unknown }>
  /** what renderer.send answers; set per test */
  rendererReply: { value: (method: string, params: unknown) => Promise<unknown> | unknown }
  ui: { value: { screen: string; openProjectId: string | null } | null }
  projects: Map<string, Project>
  scenarios: Map<string, Scenario>
  saved: Scenario[]
  reserved: string[]
  changed: string[]
  settings: { lastDisplayId: number | null; audioDefaults: { mic: boolean; micDeviceId: string | null; system: boolean } | null }
  nextIds: string[]
}

function harness(over: Partial<AgentDeps> = {}): Harness {
  const recorder = new FakeRecorder()
  const capture = new FakeCapture()
  const sent: Harness['sent'] = []
  const rendererReply: Harness['rendererReply'] = { value: () => ({}) }
  const ui: Harness['ui'] = { value: { screen: 'home', openProjectId: null } }
  const projects = new Map<string, Project>([['p1', project('p1')]])
  const scenarios = new Map<string, Scenario>()
  const saved: Scenario[] = []
  const reserved: string[] = []
  const changed: string[] = []
  const settings: Harness['settings'] = { lastDisplayId: null, audioDefaults: null }
  const nextIds = ['2026-02-03_04-05-06', '2026-02-03_04-05-06-2', '2026-02-03_04-05-06-3']
  const deps: AgentDeps = {
    version: '1.2.3',
    recorder,
    capture,
    renderer: {
      send: async (method, params) => {
        sent.push({ method, params })
        return rendererReply.value(method, params)
      },
      getStatus: () => ui.value
    },
    displays: () => DISPLAYS,
    captureScreen: async (display, maxWidth) => {
      const width = Math.min(display.bounds.width, maxWidth)
      return { png: Buffer.from('PNGDATA'), width, height: Math.round((width * display.bounds.height) / display.bounds.width) }
    },
    settings: async () => settings,
    projects: {
      list: async () => [...projects.values()].map((p) => ({ id: p.id, name: p.name, createdAt: 1, updatedAt: 1, durationMs: 5000, width: 1920, height: 1080, dir: '', scenarioId: null })),
      load: async (id) => {
        const p = projects.get(id)
        if (!p) throw enoent()
        return p
      },
      exists: async (id) => projects.has(id),
      remove: async (id) => {
        projects.delete(id)
      }
    },
    scenarios: {
      list: async () => [...scenarios.values()].map((s): ScenarioSummary => ({ id: s.id, name: s.name, createdAt: s.createdAt, actions: s.actions.length, durationMs: s.durationMs })),
      load: async (id) => {
        const s = scenarios.get(id)
        if (!s) throw enoent()
        return s
      },
      exists: async (id) => scenarios.has(id),
      remove: async (id) => {
        scenarios.delete(id)
      },
      newId: async () => nextIds.shift() ?? 'out-of-ids',
      reserve: async (id) => {
        reserved.push(id)
        return `C:\\scenarios\\${id}`
      },
      save: async (s) => {
        saved.push(s)
        scenarios.set(s.id, s)
      }
    },
    notifyChanged: (what) => changed.push(what),
    now: () => 1_700_000_000_000,
    timeouts: { startMs: 150, stopMs: 400, cancelMs: 150, captureStopMs: 150, replaySlackMs: 100 },
    ...over
  }
  return { methods: createAgentMethods(deps), recorder, capture, deps, sent, rendererReply, ui, projects, scenarios, saved, reserved, changed, settings, nextIds }
}

async function code(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    return err as AgentError
  }
  throw new Error('expected the call to fail')
}

const call = (h: Harness, method: string, params: Record<string, unknown> = {}): Promise<any> => h.methods[method](params) as Promise<any>

describe('every method validates its parameters', () => {
  it('knows all the methods of the contract', () => {
    expect(Object.keys(harness().methods).sort()).toEqual(
      [
        'status', 'displays.list', 'screenshot',
        'projects.list', 'projects.get', 'projects.delete', 'projects.edit', 'projects.export',
        'scenarios.list', 'scenarios.get', 'scenarios.create', 'scenarios.delete', 'scenarios.captureStart', 'scenarios.captureStop',
        'recording.start', 'recording.stop', 'recording.cancel', 'scenarios.record'
      ].sort()
    )
  })

  it('answers bad_params naming the method and the field', async () => {
    const h = harness()
    const err = await code(call(h, 'projects.get', { projectId: '../etc' }))
    expect(err.code).toBe('bad_params')
    expect(err.message).toMatch(/^projects\.get: projectId/)
    expect((await code(call(h, 'projects.edit', { projectId: 'p1', operations: [] }))).code).toBe('bad_params')
    expect((await code(call(h, 'status', { extra: 1 }))).code).toBe('bad_params')
    expect((await code(call(h, 'recording.start', { mic: 'yes' }))).code).toBe('bad_params')
    expect(h.sent).toEqual([])
  })
})

describe('status', () => {
  it('combines the recorder, the capture and what the renderer reported', async () => {
    const h = harness()
    expect(await call(h, 'status')).toEqual({ version: '1.2.3', screen: 'home', recording: 'idle', scenarioCapture: 'idle', openProjectId: null })
    h.ui.value = { screen: 'editor', openProjectId: 'p1' }
    h.recorder.active = true
    h.recorder.bar = { phase: 'recording', startedAt: 1, countdownEndsAt: null }
    h.capture.state = { phase: 'capturing', actions: 2, startedAt: 1 }
    expect(await call(h, 'status')).toEqual({ version: '1.2.3', screen: 'editor', recording: 'recording', scenarioCapture: 'capturing', openProjectId: 'p1' })
  })

  it('says unknown before the renderer reported, and processing while a stopped recording is saved', async () => {
    const h = harness()
    h.ui.value = null
    h.recorder.active = true // bar already idle: capture stopped, the file is being transcoded
    expect(await call(h, 'status')).toMatchObject({ screen: 'unknown', openProjectId: null, recording: 'processing' })
  })
})

describe('displays and screenshots', () => {
  it('lists displays without thumbnails', async () => {
    expect(await call(harness(), 'displays.list')).toEqual(DISPLAYS)
  })

  it('returns a base64 png with the scale of image pixels per DIP', async () => {
    const h = harness()
    const shot = await call(h, 'screenshot', { displayId: 22, maxWidth: 640 })
    expect(shot).toEqual({ displayId: 22, bounds: DISPLAYS[1].bounds, scale: 0.5, mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') })
    // default width 1920 on the 1920 wide primary display
    expect((await call(h, 'screenshot')).scale).toBe(1)
  })

  it('defaults to the last used display while it exists, else the primary one', async () => {
    const h = harness()
    h.settings.lastDisplayId = 22
    expect((await call(h, 'screenshot')).displayId).toBe(22)
    h.settings.lastDisplayId = 999
    expect((await call(h, 'screenshot')).displayId).toBe(11)
  })

  it('rejects an unknown display and lists the valid ones', async () => {
    const err = await code(call(harness(), 'screenshot', { displayId: 5 }))
    expect(err.code).toBe('bad_params')
    expect(err.message).toContain('11, 22')
  })
})

describe('projects', () => {
  it('lists and gets', async () => {
    const h = harness()
    expect((await call(h, 'projects.list')).map((p: { id: string }) => p.id)).toEqual(['p1'])
    const view = await call(h, 'projects.get', { projectId: 'p1' })
    expect(view).toMatchObject({ id: 'p1', sourceDurationMs: 5000, outputDurationMs: 5000, origin: null })
    expect(view).not.toHaveProperty('cursorData')
  })

  it('answers not_found for a missing recording', async () => {
    const h = harness()
    expect((await code(call(h, 'projects.get', { projectId: 'nope' }))).code).toBe('not_found')
    expect((await code(call(h, 'projects.delete', { projectId: 'nope' }))).code).toBe('not_found')
    expect((await code(call(h, 'projects.edit', { projectId: 'nope', operations: [{ op: 'rename', name: 'x' }] }))).code).toBe('not_found')
    expect((await code(call(h, 'projects.export', { projectId: 'nope' }))).code).toBe('not_found')
    expect(h.sent).toEqual([])
  })

  it('deletes a recording and tells the UI', async () => {
    const h = harness()
    expect(await call(h, 'projects.delete', { projectId: 'p1' })).toEqual({})
    expect(h.projects.has('p1')).toBe(false)
    expect(h.changed).toEqual(['projects'])
  })

  it('refuses to delete the recording open in the editor', async () => {
    const h = harness()
    h.ui.value = { screen: 'editor', openProjectId: 'p1' }
    const err = await code(call(h, 'projects.delete', { projectId: 'p1' }))
    expect(err.code).toBe('busy')
    expect(h.projects.has('p1')).toBe(true)
    expect(h.changed).toEqual([])
  })

  it('forwards edits to the renderer and returns its view', async () => {
    const h = harness()
    h.rendererReply.value = () => ({ id: 'p1', name: 'Renamed' })
    const ops = [{ op: 'rename', name: 'Renamed' }, { op: 'addCut', start: 0, end: 500 }]
    expect(await call(h, 'projects.edit', { projectId: 'p1', operations: ops })).toEqual({ id: 'p1', name: 'Renamed' })
    expect(h.sent).toEqual([{ method: 'projects.edit', params: { projectId: 'p1', operations: ops } }])
    expect(h.changed).toEqual(['projects'])
  })

  it('passes a renderer error on unchanged', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      throw new AgentError('bad_params', 'operations[1]: no zoom with id z9')
    }
    const err = await code(call(h, 'projects.edit', { projectId: 'p1', operations: [{ op: 'removeZoom', id: 'z9' }] }))
    expect(err).toMatchObject({ code: 'bad_params', message: 'operations[1]: no zoom with id z9' })
    expect(h.changed).toEqual([])
  })

  it('forwards exports and insists on an absolute folder', async () => {
    const h = harness()
    h.rendererReply.value = () => ({ outputPath: 'C:\\out\\x.mp4', bytes: 10 })
    expect((await code(call(h, 'projects.export', { projectId: 'p1', folder: 'relative\\dir' }))).code).toBe('bad_params')
    expect(await call(h, 'projects.export', { projectId: 'p1', format: 'gif', folder: 'C:\\out', gifColors: 64 })).toEqual({ outputPath: 'C:\\out\\x.mp4', bytes: 10 })
    expect(h.sent).toEqual([{ method: 'projects.export', params: { projectId: 'p1', format: 'gif', folder: 'C:\\out', gifColors: 64 } }])
  })
})

describe('scenarios', () => {
  const input = { name: 'Demo', actions: [{ kind: 'click', x: 100, y: 200 }, { kind: 'type', text: 'hi' }, { kind: 'key', key: 'Enter' }] }

  it('creates a scenario: folder first, then the save, then the notification', async () => {
    const h = harness()
    const order: string[] = []
    const reserve = h.deps.scenarios.reserve
    h.deps.scenarios.reserve = async (id) => {
      order.push('reserve')
      return reserve(id)
    }
    const save = h.deps.scenarios.save
    h.deps.scenarios.save = async (s) => {
      order.push('save')
      return save(s)
    }
    const methods = createAgentMethods(h.deps)
    const result = (await methods['scenarios.create'](input)) as { scenarioId: string; actions: number; durationMs: number }
    expect(order).toEqual(['reserve', 'save'])
    expect(result).toMatchObject({ scenarioId: '2026-02-03_04-05-06', actions: 3 })
    expect(result.durationMs).toBeGreaterThan(0)
    expect(h.saved[0]).toMatchObject({
      version: 2,
      id: '2026-02-03_04-05-06',
      name: 'Demo',
      createdAt: 1_700_000_000_000,
      displayId: 11, // no last display: the primary one
      dir: 'C:\\scenarios\\2026-02-03_04-05-06'
    })
    expect(h.changed).toEqual(['scenarios'])
  })

  it('builds on the requested display with coordinates relative to it', async () => {
    const h = harness()
    await call(h, 'scenarios.create', { name: 'Second', displayId: 22, actions: [{ kind: 'click', x: 10, y: 20 }] })
    expect(h.saved[0]).toMatchObject({ displayId: 22, displayBounds: DISPLAYS[1].bounds })
    expect(h.saved[0].actions[0]).toMatchObject({ x: 1930, y: 20 })
  })

  it('writes nothing for an invalid scenario', async () => {
    const h = harness()
    const err = await code(call(h, 'scenarios.create', { name: 'Bad', actions: [{ kind: 'click', x: 5000, y: 0 }] }))
    expect(err.code).toBe('bad_params')
    expect(err.message).toContain('outside the display')
    expect(h.reserved).toEqual([])
    expect(h.saved).toEqual([])
    expect(h.changed).toEqual([])
  })

  it('gives two creates started together different ids', async () => {
    const h = harness()
    const [a, b] = await Promise.all([call(h, 'scenarios.create', input), call(h, 'scenarios.create', input)])
    expect([a.scenarioId, b.scenarioId]).toEqual(['2026-02-03_04-05-06', '2026-02-03_04-05-06-2'])
  })

  it('keeps creating after a failed create', async () => {
    const h = harness()
    await code(call(h, 'scenarios.create', { name: 'Bad', actions: [{ kind: 'click', x: -1, y: 0 }] }))
    await call(h, 'scenarios.create', input)
    expect(h.saved).toHaveLength(1)
  })

  it('shows, lists and deletes a scenario', async () => {
    const h = harness()
    const { scenarioId } = await call(h, 'scenarios.create', input)
    expect((await call(h, 'scenarios.list')).map((s: { id: string }) => s.id)).toEqual([scenarioId])
    const view = await call(h, 'scenarios.get', { scenarioId })
    expect(view.actions.map((a: { kind: string }) => a.kind)).toEqual(['click', 'type', 'key'])
    h.changed.length = 0
    expect(await call(h, 'scenarios.delete', { scenarioId })).toEqual({})
    expect(h.changed).toEqual(['scenarios'])
    expect((await code(call(h, 'scenarios.get', { scenarioId }))).code).toBe('not_found')
    expect((await code(call(h, 'scenarios.delete', { scenarioId }))).code).toBe('not_found')
  })
})

describe('recording.start', () => {
  it('returns once the recorder is recording, with the audio resolved from the settings', async () => {
    const h = harness()
    h.settings.audioDefaults = { mic: true, micDeviceId: 'm', system: false }
    h.rendererReply.value = () => {
      // the renderer only hands the start to Home; the recorder follows a countdown later
      setTimeout(() => {
        h.recorder.active = true
        h.recorder.setBar('countdown')
        setTimeout(() => h.recorder.setBar('recording'), 20)
      }, 5)
      return {}
    }
    const result = await call(h, 'recording.start', { systemAudio: true })
    expect(result).toEqual({ displayId: 11, mic: true, systemAudio: true })
    expect(h.sent).toEqual([{ method: 'recording.start', params: { displayId: 11, mic: true, systemAudio: true } }])
  })

  it('uses the given display and explicit flags over the defaults', async () => {
    const h = harness()
    h.settings.audioDefaults = { mic: true, micDeviceId: null, system: true }
    h.rendererReply.value = () => {
      setTimeout(() => h.recorder.setBar('recording'), 5)
    }
    await call(h, 'recording.start', { displayId: 22, mic: false, systemAudio: false })
    expect(h.sent[0].params).toEqual({ displayId: 22, mic: false, systemAudio: false })
  })

  it('is busy while a recording, a capture, or another start is going on', async () => {
    const h = harness()
    h.recorder.active = true
    expect((await code(call(h, 'recording.start'))).code).toBe('busy')
    h.recorder.active = false
    h.capture.state = { phase: 'capturing', actions: 0, startedAt: 1 }
    expect((await code(call(h, 'recording.start'))).code).toBe('busy')
    h.capture.state = { phase: 'idle', actions: 0, startedAt: null }
    const preview = harness({ otherBusy: () => true })
    expect((await code(call(preview, 'recording.start'))).code).toBe('busy')
    expect(h.sent).toEqual([])

    h.rendererReply.value = () => new Promise(() => undefined) // a start that never gets going
    const first = call(h, 'recording.start')
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect((await code(call(h, 'recording.start'))).code).toBe('busy')
    expect((await code(first)).code).toBe('failed') // and the first one times out
    h.recorder.setBar('idle')
  })

  it('fails when the renderer refuses', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      throw new AgentError('failed', 'No display available')
    }
    expect(await code(call(h, 'recording.start'))).toMatchObject({ code: 'failed', message: 'No display available' })
    // and the next start is allowed again
    h.rendererReply.value = () => {
      setTimeout(() => h.recorder.setBar('recording'), 5)
    }
    await call(h, 'recording.start')
  })

  it('fails when the attempt dies before it records', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      setTimeout(() => h.recorder.emit('failed', { id: null, error: new Error('Display source not found') }), 5)
    }
    const err = await code(call(h, 'recording.start'))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('Display source not found')
  })

  it('reports cancelled when the attempt is discarded during the countdown', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      setTimeout(() => h.recorder.emit('cancelled', { id: 'x' }), 5)
    }
    expect((await code(call(h, 'recording.start'))).code).toBe('cancelled')
  })

  it('times out when nothing ever starts, and stops listening', async () => {
    const h = harness()
    const err = await code(call(h, 'recording.start'))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('did not start in time')
    expect(h.recorder.listenerCount('state')).toBe(0)
    expect(h.recorder.listenerCount('cancelled')).toBe(0)
  })
})

describe('recording.stop and recording.cancel', () => {
  function recording(h: Harness, phase: RecorderBarState['phase'] = 'recording'): void {
    h.recorder.active = true
    h.recorder.bar = { phase, startedAt: 1, countdownEndsAt: null }
  }

  it('is not_found without a recording', async () => {
    const h = harness()
    expect((await code(call(h, 'recording.stop'))).code).toBe('not_found')
    expect((await code(call(h, 'recording.cancel'))).code).toBe('not_found')
  })

  it('stops and resolves with the saved project and readable warnings', async () => {
    const h = harness()
    recording(h)
    h.recorder.requestStop.mockImplementation(() => {
      h.recorder.setBar('processing')
      setTimeout(() => h.recorder.emit('finished', { project: project('p9', { recording: { ...project('p9').recording, durationMs: 4321 } }), warnings: ['systemAudio'] }), 10)
    })
    const result = await call(h, 'recording.stop')
    expect(result).toEqual({ projectId: 'p9', durationMs: 4321, warnings: [expect.stringContaining('System audio')] })
    expect(h.recorder.requestStop).toHaveBeenCalledTimes(1)
    expect(h.recorder.listenerCount('finished')).toBe(0)
  })

  it('does not ask a recording that is already being saved to stop again', async () => {
    const h = harness()
    h.recorder.active = true
    h.recorder.bar = { phase: 'idle', startedAt: null, countdownEndsAt: null } // capture over, transcoding
    const pending = call(h, 'recording.stop')
    setTimeout(() => h.recorder.emit('finished', { project: project('p2'), warnings: [] }), 10)
    expect((await pending).projectId).toBe('p2')
    expect(h.recorder.requestStop).not.toHaveBeenCalled()
  })

  it('reports a recording that failed while it was saved', async () => {
    const h = harness()
    recording(h)
    h.recorder.requestStop.mockImplementation(() => setTimeout(() => h.recorder.emit('failed', { id: 'x', error: new Error('ffmpeg exited with 1') }), 5))
    const err = await code(call(h, 'recording.stop'))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('ffmpeg exited with 1')
  })

  it('times out when the project never arrives', async () => {
    const h = harness()
    recording(h)
    const err = await code(call(h, 'recording.stop'))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('Timed out')
  })

  it('cancels and resolves once the attempt is discarded', async () => {
    const h = harness()
    recording(h)
    h.recorder.requestCancel.mockImplementation(() => setTimeout(() => h.recorder.emit('cancelled', { id: 'x' }), 5))
    expect(await call(h, 'recording.cancel')).toEqual({})
    expect(h.recorder.requestCancel).toHaveBeenCalledTimes(1)
  })

  it('cannot cancel a recording that is already being saved', async () => {
    const h = harness()
    recording(h, 'processing')
    expect((await code(call(h, 'recording.cancel'))).code).toBe('busy')
    expect(h.recorder.requestCancel).not.toHaveBeenCalled()
  })

  it('times out a cancel that never completes', async () => {
    const h = harness()
    recording(h)
    expect((await code(call(h, 'recording.cancel'))).message).toContain('Timed out')
  })
})

describe('scenarios.record', () => {
  async function makeScenario(h: Harness): Promise<string> {
    return (await call(h, 'scenarios.create', { name: 'S', actions: [{ kind: 'click', x: 10, y: 10, pauseMs: 0, durationMs: 200 }] })).scenarioId
  }

  it('is not_found for an unknown scenario', async () => {
    const h = harness()
    expect((await code(call(h, 'scenarios.record', { scenarioId: 'nope' }))).code).toBe('not_found')
    expect(h.sent).toEqual([])
  })

  it('starts the replay recording through the renderer and returns the project when it ends', async () => {
    const h = harness()
    const scenarioId = await makeScenario(h)
    h.settings.audioDefaults = { mic: false, micDeviceId: null, system: true }
    h.rendererReply.value = () => {
      setTimeout(() => {
        h.recorder.active = true
        h.recorder.setBar('recording')
        setTimeout(() => h.recorder.emit('finished', { project: project('p5'), warnings: [] }), 30)
      }, 5)
    }
    const result = await call(h, 'scenarios.record', { scenarioId })
    expect(result).toEqual({ scenarioId, projectId: 'p5', durationMs: 5000, warnings: [] })
    expect(h.sent.at(-1)).toEqual({ method: 'scenarios.record', params: { scenarioId, mic: false, systemAudio: true } })
  })

  it('reports cancelled when the replay is aborted', async () => {
    const h = harness()
    const scenarioId = await makeScenario(h)
    h.rendererReply.value = () => {
      setTimeout(() => {
        h.recorder.setBar('recording')
        setTimeout(() => h.recorder.emit('cancelled', { id: 'x' }), 20)
      }, 5)
    }
    expect((await code(call(h, 'scenarios.record', { scenarioId }))).code).toBe('cancelled')
  })

  it('fails when the recording never starts', async () => {
    const h = harness()
    const scenarioId = await makeScenario(h)
    const err = await code(call(h, 'scenarios.record', { scenarioId }))
    expect(err.message).toContain('did not start in time')
    expect(h.recorder.listenerCount('finished')).toBe(0)
  })

  it('is busy while something else records', async () => {
    const h = harness()
    const scenarioId = await makeScenario(h)
    h.recorder.active = true
    expect((await code(call(h, 'scenarios.record', { scenarioId }))).code).toBe('busy')
  })
})

describe('scenario capture', () => {
  it('captureStart returns once the capture is running', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      setTimeout(() => {
        h.capture.setPhase('countdown')
        setTimeout(() => h.capture.setPhase('capturing'), 20)
      }, 5)
    }
    expect(await call(h, 'scenarios.captureStart', { displayId: 22 })).toEqual({ displayId: 22 })
    expect(h.sent).toEqual([{ method: 'capture.start', params: { displayId: 22 } }])
  })

  it('captureStart fails if the capture cannot start, or ends first', async () => {
    const h = harness()
    h.rendererReply.value = () => {
      setTimeout(() => h.capture.emit('failed', new Error('The global input hook is unavailable')), 5)
    }
    const err = await code(call(h, 'scenarios.captureStart'))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('input hook')
    h.rendererReply.value = () => {
      setTimeout(() => h.capture.emit('done', null), 5)
    }
    expect((await code(call(h, 'scenarios.captureStart'))).code).toBe('cancelled')
    expect(h.capture.listenerCount('state')).toBe(0)
  })

  it('captureStart is busy during a recording', async () => {
    const h = harness()
    h.recorder.active = true
    expect((await code(call(h, 'scenarios.captureStart'))).code).toBe('busy')
  })

  it('captureStop stops and returns the saved scenario', async () => {
    const h = harness()
    h.capture.state = { phase: 'capturing', actions: 3, startedAt: 1 }
    h.capture.requestStop.mockImplementation(() => {
      setTimeout(() => {
        const scenario = { id: 'sc1', actions: [{}, {}, {}] } as unknown as Scenario
        h.capture.emit('done', scenario)
      }, 5)
    })
    const result = await call(h, 'scenarios.captureStop')
    expect(result).toMatchObject({ scenarioId: 'sc1', actions: 3 })
    expect(h.changed).toEqual(['scenarios'])
  })

  it('captureStop says so when nothing was captured, or nothing runs', async () => {
    const h = harness()
    expect((await code(call(h, 'scenarios.captureStop'))).code).toBe('not_found')
    h.capture.state = { phase: 'capturing', actions: 0, startedAt: 1 }
    h.capture.requestStop.mockImplementation(() => setTimeout(() => h.capture.emit('done', null), 5))
    expect((await code(call(h, 'scenarios.captureStop'))).code).toBe('cancelled')
  })

  it('captureStop waits for a capture that is already saving without stopping it again', async () => {
    const h = harness()
    h.capture.state = { phase: 'saving', actions: 1, startedAt: 1 }
    const pending = call(h, 'scenarios.captureStop')
    setTimeout(() => h.capture.emit('done', { id: 'sc2', actions: [{}] } as unknown as Scenario), 5)
    expect((await pending).scenarioId).toBe('sc2')
    expect(h.capture.requestStop).not.toHaveBeenCalled()
  })
})
