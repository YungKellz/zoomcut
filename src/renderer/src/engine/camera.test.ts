import { describe, expect, it } from 'vitest'
import type { Project, ZoomSegment } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { cameraAt, resolveZoomOverlaps, viewportOf, zoomProgress } from './camera'
import { buildFollowPath, cursorAt, followAt } from './cursor'
import { generateZoomsFromClicks } from './zoomAuto'

function project(zooms: ZoomSegment[], samples = [{ t: 0, x: 0.9, y: 0.9 }]): Project {
  return {
    version: 1,
    id: 'p',
    name: 'p',
    recording: {
      id: 'p',
      createdAt: 0,
      dir: '',
      videoPath: '',
      width: 1920,
      height: 1080,
      durationMs: 10000,
      fps: 30,
      displayName: ''
    },
    cursorData: { samples, clicks: [], source: 'polling' },
    windows: [],
    cuts: [],
    texts: [],
    zooms,
    cursor: { ...DEFAULT_CURSOR_SETTINGS },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: { ...DEFAULT_FRAME_STYLE },
    export: { ...DEFAULT_EXPORT_SETTINGS },
    updatedAt: 0
  }
}

describe('camera', () => {
  const zoom: ZoomSegment = {
    id: 'z',
    start: 1000,
    end: 5000,
    scale: 2,
    mode: 'fixed',
    target: { x: 0.9, y: 0.9 },
    easeInMs: 500,
    easeOutMs: 500
  }

  it('eases in and out', () => {
    expect(zoomProgress(zoom, 1000)).toBe(0)
    expect(zoomProgress(zoom, 1250)).toBeCloseTo(0.5, 5)
    expect(zoomProgress(zoom, 3000)).toBe(1)
    expect(zoomProgress(zoom, 4750)).toBeCloseTo(0.5, 5)
  })

  it('keeps the viewport inside the frame', () => {
    const cam = cameraAt(project([zoom]), 3000, null)
    expect(cam.scale).toBe(2)
    const vp = viewportOf(cam)
    expect(vp.x + vp.w).toBeLessThanOrEqual(1.000001)
    expect(vp.y + vp.h).toBeLessThanOrEqual(1.000001)
    expect(cam.cx).toBeCloseTo(0.75, 5)
  })

  it('is identity outside zoom segments', () => {
    const cam = cameraAt(project([zoom]), 500, null)
    expect(cam).toEqual({ cx: 0.5, cy: 0.5, scale: 1 })
  })

  it('resolves overlaps by clamping to neighbours', () => {
    const zooms = [
      { ...zoom, id: 'a', start: 0, end: 2000 },
      { ...zoom, id: 'b', start: 1500, end: 4000 }
    ]
    const resolved = resolveZoomOverlaps(zooms, 'b', 10000)
    expect(resolved.find((z) => z.id === 'b')?.start).toBe(2000)
  })
})

describe('cursor', () => {
  const samples = [
    { t: 0, x: 0, y: 0 },
    { t: 100, x: 1, y: 1 },
    { t: 1000, x: 0.5, y: 0.5 }
  ]

  it('interpolates between close samples and holds across gaps', () => {
    expect(cursorAt(samples, 50)).toEqual({ x: 0.5, y: 0.5 })
    expect(cursorAt(samples, 500)).toEqual({ x: 1, y: 1 })
    expect(cursorAt(samples, 5000)).toEqual({ x: 0.5, y: 0.5 })
    expect(cursorAt([], 5)).toBeNull()
  })

  it('follow path moves towards the cursor and stays within bounds', () => {
    const path = buildFollowPath(
      [
        { t: 0, x: 0.1, y: 0.1 },
        { t: 3000, x: 0.9, y: 0.9 }
      ],
      { followSmoothing: 0.3, followDeadZone: 0.05, offsetMs: 0 },
      4000
    )
    const early = followAt(path, 0)
    const late = followAt(path, 4000)
    expect(early.x).toBeCloseTo(0.1, 1)
    expect(late.x).toBeGreaterThan(0.8)
    expect(late.x).toBeLessThanOrEqual(0.9)
  })
})

describe('auto zoom', () => {
  it('groups clicks into segments and skips cuts', () => {
    const zooms = generateZoomsFromClicks(
      [
        { t: 1000, x: 0.1, y: 0.1, button: 'left' },
        { t: 1500, x: 0.1, y: 0.1, button: 'left' },
        { t: 8000, x: 0.1, y: 0.1, button: 'left' },
        { t: 12000, x: 0.1, y: 0.1, button: 'left' }
      ],
      20000,
      [{ id: 'c', start: 7000, end: 9000 }]
    )
    expect(zooms).toHaveLength(2)
    expect(zooms[0].start).toBe(300)
    expect(zooms[0].end).toBe(3100)
    expect(zooms[1].start).toBe(11300)
  })
})
