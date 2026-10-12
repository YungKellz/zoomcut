import { describe, expect, it } from 'vitest'
import { AGENT_MAX_CLICKS, outputDurationMs, toAgentProjectView } from './agentProject'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from './defaults'
import type { ClickEvent, CutRange, Project } from './types'

function project(over: Partial<Project> = {}, clicks: ClickEvent[] = []): Project {
  return {
    version: 1,
    id: 'p1',
    name: 'Demo',
    recording: { id: 'p1', createdAt: 1000, dir: 'C:\rec\p1', videoPath: 'C:\rec\p1\source.mp4', width: 1920, height: 1080, durationMs: 10_000, fps: 30, displayName: 'Screen 1' },
    cursorData: { samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks, source: 'uiohook' },
    windows: [{ t: 0, windows: [] }],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio: [{ id: 'a1', kind: 'mic', file: 'mic.m4a', name: 'Microphone', start: -40, durationMs: 9000, volume: 1, muted: false, loop: false, fadeInMs: 0, fadeOutMs: 0 }],
    cursor: DEFAULT_CURSOR_SETTINGS,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: DEFAULT_FRAME_STYLE,
    export: { ...DEFAULT_EXPORT_SETTINGS, fileName: 'p1', folder: 'C:\out' },
    updatedAt: 2000,
    ...over
  }
}

describe('outputDurationMs', () => {
  // [cuts, expected output length of a 10 s recording]: overlapping, reversed, out-of-range and tiny cuts,
  // and kept pieces under MIN_SEGMENT_MS (40 ms), which the editor drops as well
  const cases: Array<[string, CutRange[], number]> = [
    ['no cuts', [], 10_000],
    ['one cut', [{ id: 'a', start: 1000, end: 2000 }], 9000],
    ['overlapping cuts merge', [{ id: 'a', start: 1000, end: 3000 }, { id: 'b', start: 2500, end: 4000 }], 7000],
    ['a reversed cut', [{ id: 'a', start: 5000, end: 4000 }], 9000],
    ['cuts past both ends are clamped', [{ id: 'a', start: -500, end: 700 }, { id: 'b', start: 9800, end: 12_000 }], 9100],
    ['kept pieces under 40 ms vanish', [{ id: 'a', start: 20, end: 9990 }], 0],
    ['everything cut', [{ id: 'a', start: 0, end: 10_000 }], 0],
    ['a cut under 1 ms is ignored', [{ id: 'a', start: 100, end: 100.5 }], 10_000],
    ['adjacent cuts merge, a 30 ms tail vanishes', [{ id: 'a', start: 3000, end: 3010 }, { id: 'b', start: 3010, end: 3020 }, { id: 'c', start: 8000, end: 9970 }], 7980]
  ]
  it.each(cases)('%s', (_name, cuts, expected) => {
    expect(outputDurationMs(10_000, cuts)).toBe(expected)
  })
})

describe('toAgentProjectView', () => {
  it('summarizes a project without the heavy data', () => {
    const p = project({
      cuts: [{ id: 'c1', start: 1000, end: 3000 }],
      origin: { displayId: 7, audio: null, scenarioId: 's1' }
    }, [{ t: 500, x: 0.1, y: 0.2, button: 'left' }])
    const view = toAgentProjectView(p)
    expect(view).toEqual({
      id: 'p1',
      name: 'Demo',
      createdAt: 1000,
      dir: 'C:\rec\p1',
      width: 1920,
      height: 1080,
      fps: 30,
      sourceDurationMs: 10_000,
      outputDurationMs: 8000,
      cuts: p.cuts,
      zooms: [],
      texts: [],
      blurs: [],
      crop: { x: 0, y: 0, w: 1, h: 1 },
      frame: DEFAULT_FRAME_STYLE,
      cursor: DEFAULT_CURSOR_SETTINGS,
      export: p.export,
      origin: { displayId: 7, audio: null, scenarioId: 's1' },
      clicks: [{ t: 500, x: 0.1, y: 0.2, button: 'left' }],
      audio: [{ id: 'a1', kind: 'mic', name: 'Microphone' }]
    })
    expect(JSON.stringify(view)).not.toContain('samples')
  })

  it('reports a missing origin as null and survives a project without clicks', () => {
    const view = toAgentProjectView(project())
    expect(view.origin).toBeNull()
    expect(view.clicks).toEqual([])
  })

  it('thins out a long click list evenly, keeping the order and the start', () => {
    const clicks: ClickEvent[] = Array.from({ length: 2000 }, (_, i) => ({ t: i * 5, x: 0.5, y: 0.5, button: 'left' as const }))
    const view = toAgentProjectView(project({}, clicks))
    expect(view.clicks).toHaveLength(AGENT_MAX_CLICKS)
    expect(view.clicks[0]).toBe(clicks[0])
    const times = view.clicks.map((c) => c.t)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(times.at(-1)!).toBeGreaterThan(9000)
  })
})
