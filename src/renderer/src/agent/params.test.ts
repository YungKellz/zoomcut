import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { AgentError } from '@shared/agent'
import { DEFAULT_AUDIO_CAPTURE, DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import {
  errorPayload,
  parseCancelParams,
  parseCaptureParams,
  parseEditParams,
  parseExportParams,
  parseRecordParams,
  parseScenarioRecordParams,
  resolveAudio,
  resolveExportSettings
} from './params'

function project(patch: Partial<Project> = {}): Project {
  return {
    version: 1,
    id: 'p1',
    name: 'Product tour',
    recording: {
      id: 'p1',
      createdAt: 0,
      dir: 'C:\\Videos\\ZoomCut\\p1',
      videoPath: 'C:\\Videos\\ZoomCut\\p1\\recording.mp4',
      width: 2560,
      height: 1440,
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
    updatedAt: 0,
    ...patch
  }
}

function badParams(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).code).toBe('bad_params')
    return (err as AgentError).message
  }
  throw new Error('expected bad_params')
}

describe('parseEditParams', () => {
  it('needs a project id and an operations array', () => {
    expect(parseEditParams({ projectId: 'p1', operations: [] })).toEqual({ projectId: 'p1', operations: [] })
    expect(badParams(() => parseEditParams({ operations: [] }))).toMatch(/projectId is required/)
    expect(badParams(() => parseEditParams({ projectId: 'p1' }))).toMatch(/operations must be an array/)
    expect(badParams(() => parseEditParams(null))).toMatch(/params must be an object/)
  })
})

describe('parseExportParams', () => {
  it('accepts the documented fields', () => {
    expect(
      parseExportParams({ projectId: 'p1', format: 'gif', folder: 'C:\\Out', fileName: 'Demo', fps: 15, scale: 0.5, mp4Quality: 'max', gifColors: 64 })
    ).toEqual({ projectId: 'p1', format: 'gif', folder: 'C:\\Out', fileName: 'Demo', fps: 15, scale: 0.5, mp4Quality: 'max', gifColors: 64 })
    expect(parseExportParams({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
  })

  it('strips a pasted extension from the file name', () => {
    expect(parseExportParams({ projectId: 'p1', fileName: 'demo.MP4' }).fileName).toBe('demo')
    expect(parseExportParams({ projectId: 'p1', fileName: 'my.video' }).fileName).toBe('my.video')
    badParams(() => parseExportParams({ projectId: 'p1', fileName: '.gif' }))
  })

  it('requires an absolute folder', () => {
    expect(parseExportParams({ projectId: 'p1', folder: '/tmp/out' }).folder).toBe('/tmp/out')
    expect(parseExportParams({ projectId: 'p1', folder: '\\\\server\\share' }).folder).toBe('\\\\server\\share')
    expect(badParams(() => parseExportParams({ projectId: 'p1', folder: 'exports' }))).toMatch(/absolute path/)
  })

  it('rejects out-of-range values', () => {
    badParams(() => parseExportParams({ projectId: 'p1', format: 'webm' }))
    badParams(() => parseExportParams({ projectId: 'p1', scale: 2 }))
    badParams(() => parseExportParams({ projectId: 'p1', scale: 0 }))
    badParams(() => parseExportParams({ projectId: 'p1', mp4Quality: 'ultra' }))
    badParams(() => parseExportParams({ projectId: 'p1', gifColors: 100 }))
    badParams(() => parseExportParams({ projectId: 'p1', fps: '30' }))
  })
})

describe('resolveExportSettings', () => {
  const ctx = { lastExportFolder: null as string | null }

  it('starts from the saved settings, a name from the project and the project folder as the last resort', () => {
    const s = resolveExportSettings(project(), { projectId: 'p1' }, ctx)
    expect(s).toMatchObject({ format: 'mp4', fps: 30, scale: 1, mp4Quality: 'high', fileName: 'Product tour', folder: 'C:\\Videos\\ZoomCut\\p1' })
  })

  it('prefers the project folder setting, then the last export folder', () => {
    expect(resolveExportSettings(project(), { projectId: 'p1' }, { lastExportFolder: 'D:\\Exports' }).folder).toBe('D:\\Exports')
    const saved = project({ export: { ...DEFAULT_EXPORT_SETTINGS, folder: 'E:\\Saved', fileName: 'last-name' } })
    expect(resolveExportSettings(saved, { projectId: 'p1' }, { lastExportFolder: 'D:\\Exports' })).toMatchObject({ folder: 'E:\\Saved', fileName: 'last-name' })
    expect(resolveExportSettings(saved, { projectId: 'p1', folder: 'F:\\Given', fileName: 'x' }, ctx)).toMatchObject({ folder: 'F:\\Given', fileName: 'x' })
  })

  it('switches to GIF like the dialog: valid fps, half size for a wide recording', () => {
    const s = resolveExportSettings(project(), { projectId: 'p1', format: 'gif' }, ctx)
    expect(s).toMatchObject({ format: 'gif', fps: 15, scale: 0.5 })
    // an explicit scale wins over the half-size default
    expect(resolveExportSettings(project(), { projectId: 'p1', format: 'gif', scale: 1 }, ctx).scale).toBe(1)
    // a narrow recording keeps its size
    const narrow = project({ recording: { ...project().recording, width: 1280, height: 720 } })
    expect(resolveExportSettings(narrow, { projectId: 'p1', format: 'gif' }, ctx).scale).toBe(1)
  })

  it('applies the explicit parameters', () => {
    const s = resolveExportSettings(project(), { projectId: 'p1', fps: 60, mp4Quality: 'low', scale: 0.75 }, ctx)
    expect(s).toMatchObject({ fps: 60, mp4Quality: 'low', scale: 0.75 })
    const g = resolveExportSettings(project(), { projectId: 'p1', format: 'gif', fps: 10, gifColors: 32 }, ctx)
    expect(g).toMatchObject({ fps: 10 })
    expect(g.gif.colors).toBe(32)
  })

  it('rejects a frame rate the format does not offer, naming the valid ones', () => {
    expect(badParams(() => resolveExportSettings(project(), { projectId: 'p1', fps: 15 }, ctx))).toMatch(/not available for MP4.*24, 30, 60/)
    expect(badParams(() => resolveExportSettings(project(), { projectId: 'p1', format: 'gif', fps: 30 }, ctx))).toMatch(/GIF.*10, 12, 15, 20, 25/)
  })

  it('does not touch the project it reads', () => {
    const p = project()
    const before = JSON.stringify(p)
    resolveExportSettings(p, { projectId: 'p1', format: 'gif', gifColors: 32 }, ctx)
    expect(JSON.stringify(p)).toBe(before)
  })
})

describe('parseCancelParams', () => {
  it('needs the request id to cancel', () => {
    expect(parseCancelParams({ requestId: 'r7' })).toEqual({ requestId: 'r7' })
    expect(badParams(() => parseCancelParams({}))).toMatch(/requestId is required/)
    expect(badParams(() => parseCancelParams({ requestId: '  ' }))).toMatch(/requestId is required/)
    expect(badParams(() => parseCancelParams(undefined))).toMatch(/params must be an object/)
  })
})

describe('recording parameters', () => {
  it('accepts missing params for a plain recording', () => {
    expect(parseRecordParams(undefined)).toEqual({ displayId: undefined, mic: undefined, systemAudio: undefined })
    expect(parseRecordParams({ displayId: 2528732444, mic: true })).toMatchObject({ displayId: 2528732444, mic: true })
    expect(parseCaptureParams({})).toEqual({ displayId: undefined })
  })

  it('rejects wrong types', () => {
    badParams(() => parseRecordParams({ displayId: 1.5 }))
    badParams(() => parseRecordParams({ mic: 'yes' }))
    badParams(() => parseScenarioRecordParams({ systemAudio: true }))
    expect(parseScenarioRecordParams({ scenarioId: 's1', systemAudio: true })).toMatchObject({ scenarioId: 's1', systemAudio: true })
  })

  it('overrides the remembered audio choice with the given flags', () => {
    const remembered = { mic: true, micDeviceId: 'usb-mic', system: false }
    expect(resolveAudio(remembered, {})).toEqual(remembered)
    expect(resolveAudio(remembered, { mic: false, systemAudio: true })).toEqual({ mic: false, micDeviceId: 'usb-mic', system: true })
    expect(resolveAudio(null, {})).toEqual(DEFAULT_AUDIO_CAPTURE)
    expect(resolveAudio(null, { mic: true })).toEqual({ ...DEFAULT_AUDIO_CAPTURE, mic: true })
  })
})

describe('errorPayload', () => {
  it('keeps the code of an AgentError', () => {
    expect(errorPayload(new AgentError('busy', 'an export is running'))).toEqual({ code: 'busy', message: 'an export is running' })
  })

  it('maps an abort to cancelled and anything else to failed', () => {
    expect(errorPayload(new DOMException('Export cancelled', 'AbortError')).code).toBe('cancelled')
    expect(errorPayload(new Error('disk full'))).toEqual({ code: 'failed', message: 'disk full' })
    expect(errorPayload('boom')).toEqual({ code: 'failed', message: 'boom' })
  })

  it('unwraps an IPC rejection', () => {
    const err = new Error("Error invoking remote method 'projects:load': Error: Project not found: abc")
    expect(errorPayload(err)).toEqual({ code: 'failed', message: 'Project not found: abc' })
  })
})
