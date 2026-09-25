import { describe, expect, it } from 'vitest'
import type { AudioClip, Project } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { centerBox, compositionAudioPlan, compositionFrame, compositionLayout, fitOutputSize, locate, makeEntry } from './layout'

function makeProject(id: string, durationMs: number, width = 1920, height = 1080, patch: Partial<Project> = {}): Project {
  return {
    version: 1,
    id,
    name: id,
    recording: { id, createdAt: 0, dir: `/rec/${id}`, videoPath: `/rec/${id}/source.mp4`, width, height, durationMs, fps: 30, displayName: 'Display 1' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio: [],
    cursor: DEFAULT_CURSOR_SETTINGS,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: DEFAULT_FRAME_STYLE,
    export: { ...DEFAULT_EXPORT_SETTINGS, gif: { ...DEFAULT_EXPORT_SETTINGS.gif } },
    updatedAt: 0,
    ...patch
  }
}

const item = (id: string, projectId: string): { id: string; projectId: string } => ({ id, projectId })

describe('compositionLayout', () => {
  it('places recordings back to back by their output (post-cut) duration', () => {
    const a = makeEntry(item('i1', 'a'), makeProject('a', 10_000, 1920, 1080, { cuts: [{ id: 'c', start: 2000, end: 5000 }] }))
    const b = makeEntry(item('i2', 'b'), makeProject('b', 4000))
    const layout = compositionLayout([a, b])
    expect(layout.spans.map((s) => s.outOffset)).toEqual([0, 7000])
    expect(layout.totalMs).toBe(11_000)
  })

  it('skips a recording that is cut out completely', () => {
    const a = makeEntry(item('i1', 'a'), makeProject('a', 3000, 1920, 1080, { cuts: [{ id: 'c', start: 0, end: 3000 }] }))
    const b = makeEntry(item('i2', 'b'), makeProject('b', 4000))
    const layout = compositionLayout([a, b])
    expect(layout.spans).toHaveLength(1)
    expect(layout.spans[0].entry.item.id).toBe('i2')
    expect(layout.totalMs).toBe(4000)
  })
})

describe('locate', () => {
  const layout = compositionLayout([makeEntry(item('i1', 'a'), makeProject('a', 5000)), makeEntry(item('i2', 'b'), makeProject('b', 3000))])

  it('finds the span and the local time', () => {
    expect(locate(layout, 0)).toEqual({ index: 0, localOut: 0 })
    expect(locate(layout, 4999)).toEqual({ index: 0, localOut: 4999 })
    expect(locate(layout, 5000)).toEqual({ index: 1, localOut: 0 })
    expect(locate(layout, 6500)).toEqual({ index: 1, localOut: 1500 })
  })

  it('clamps past the end to the end of the last recording', () => {
    expect(locate(layout, 99_000)).toEqual({ index: 1, localOut: 3000 })
  })

  it('returns null for an empty composition', () => {
    expect(locate(compositionLayout([]), 0)).toBeNull()
  })
})

describe('frame geometry', () => {
  it('uses the first recording output size unless a size is chosen', () => {
    const e = makeEntry(item('i1', 'a'), makeProject('a', 1000, 1280, 720))
    expect(compositionFrame({ size: null }, [e])).toEqual({ width: 1280, height: 720 })
    expect(compositionFrame({ size: { width: 1080, height: 1080 } }, [e])).toEqual({ width: 1080, height: 1080 })
    expect(compositionFrame({ size: null }, [])).toEqual({ width: 1920, height: 1080 })
  })

  it('fits a recording inside the frame, up or down, keeping its aspect', () => {
    const wide = makeProject('a', 1000, 1920, 1080)
    const small = fitOutputSize(wide, 1080, 1080)
    expect(small.outW).toBe(1080)
    expect(small.outH).toBe(608)
    const tall = makeProject('b', 1000, 640, 360)
    const big = fitOutputSize(tall, 1920, 1080)
    expect(big.outW).toBe(1920)
    expect(big.outH).toBe(1080)
    expect(centerBox(small.outW, small.outH, 1080, 1080)).toEqual({ x: 0, y: 236 })
  })
})

describe('compositionAudioPlan', () => {
  const clip: AudioClip = {
    id: 'c1',
    kind: 'system',
    file: 'system.m4a',
    name: 'System audio',
    start: 0,
    durationMs: 4000,
    volume: 1,
    muted: false,
    loop: false,
    fadeInMs: 0,
    fadeOutMs: 0
  }

  it('shifts every recording plan to where the recording starts', () => {
    const a = makeEntry(item('i1', 'a'), makeProject('a', 4000, 1920, 1080, { audio: [clip] }))
    const b = makeEntry(item('i2', 'b'), makeProject('b', 4000, 1920, 1080, { audio: [clip] }))
    const plan = compositionAudioPlan(compositionLayout([a, b]))
    expect(plan?.outDurationMs).toBe(8000)
    expect(plan?.tracks.map((t) => t.pieces[0].outAt)).toEqual([0, 4000])
  })

  it('is null when nothing is audible', () => {
    const a = makeEntry(item('i1', 'a'), makeProject('a', 4000))
    expect(compositionAudioPlan(compositionLayout([a]))).toBeNull()
  })
})
