import { describe, expect, it } from 'vitest'
import type { Project, ZoomSegment } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import {
  ZOOM_PART_MIN_MS,
  ZOOM_PART_TRANSITION_MS,
  cameraAt,
  insertZoomPart,
  normalizeZoomParts,
  patchZoomArea,
  removeZoomPart,
  resolveZoomOverlaps,
  shiftZoomParts,
  viewportOf,
  zoomAreaFocusMs,
  zoomAreaIndexAt,
  zoomAreas,
  zoomProgress
} from './camera'
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
    blurs: [],
    audio: [],
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

  it('never expands a short segment over its neighbour', () => {
    const zooms = [
      { ...zoom, id: 'a', start: 400, end: 3000 },
      { ...zoom, id: 'c', start: 3150, end: 7500 },
      { ...zoom, id: 'b', start: 3000, end: 6000 }
    ]
    const resolved = resolveZoomOverlaps(zooms, 'b', 10000)
    const b = resolved.find((z) => z.id === 'b')
    expect(b).toBeDefined()
    expect(b!.start).toBeGreaterThanOrEqual(3000)
    expect(b!.end).toBeLessThanOrEqual(3150)
    for (let i = 1; i < resolved.length; i++) {
      expect(resolved[i].start).toBeGreaterThanOrEqual(resolved[i - 1].end)
    }
  })
})

describe('zoom parts', () => {
  // area 0: 1000..3000 (bottom right), part a: 3000..4500 (top left, 4x), part b: 4500..6000 (center)
  const base: ZoomSegment = {
    id: 'z',
    start: 1000,
    end: 6000,
    scale: 2,
    mode: 'fixed',
    target: { x: 0.8, y: 0.8 },
    easeInMs: 500,
    easeOutMs: 500,
    parts: [
      { id: 'a', start: 3000, target: { x: 0.2, y: 0.2 }, scale: 4 },
      { id: 'b', start: 4500, target: { x: 0.5, y: 0.5 }, scale: 2 }
    ]
  }
  const noParts: ZoomSegment = { ...base, parts: undefined }

  it('lists one area without parts and in follow mode', () => {
    expect(zoomAreas(noParts)).toEqual([{ index: 0, id: null, start: 1000, end: 6000, target: { x: 0.8, y: 0.8 }, scale: 2 }])
    expect(zoomAreas({ ...base, mode: 'follow' })).toHaveLength(1)
    expect(zoomAreaIndexAt({ ...base, mode: 'follow' }, 5000)).toBe(0)
  })

  it('lists the zoom itself and every part as areas', () => {
    const areas = zoomAreas(base)
    expect(areas.map((a) => [a.index, a.id, a.start, a.end, a.scale])).toEqual([
      [0, null, 1000, 3000, 2],
      [1, 'a', 3000, 4500, 4],
      [2, 'b', 4500, 6000, 2]
    ])
    expect([0, 2999, 3000, 4499, 4500, 5999].map((t) => zoomAreaIndexAt(base, t))).toEqual([0, 0, 1, 1, 2, 2])
  })

  it('normalizes: sorts, keeps the minimum spacing, drops what does not fit, keeps identity when unchanged', () => {
    expect(normalizeZoomParts(base)).toBe(base)
    expect(normalizeZoomParts(noParts)).toBe(noParts)
    const follow = { ...base, mode: 'follow' as const, parts: [{ id: 'x', start: 1, target: { x: 0, y: 0 }, scale: 2 }] }
    expect(normalizeZoomParts(follow)).toBe(follow)

    const messy: ZoomSegment = {
      ...base,
      parts: [
        { id: 'late', start: 5900, target: { x: 0.5, y: 0.5 }, scale: 2 },
        { id: 'nan', start: Number.NaN, target: { x: 0.5, y: 0.5 }, scale: 2 },
        { id: 'early', start: 1100, target: { x: 0.5, y: 0.5 }, scale: 2 },
        { id: 'mid', start: 1200, target: { x: 0.5, y: 0.5 }, scale: 2 }
      ]
    }
    // the NaN part goes, 'late' would leave only 100 ms before the end and goes too
    expect(normalizeZoomParts(messy).parts!.map((p) => [p.id, p.start])).toEqual([
      ['early', 1000 + ZOOM_PART_MIN_MS],
      ['mid', 1000 + 2 * ZOOM_PART_MIN_MS]
    ])
  })

  it('drops the parts key when no part is left', () => {
    const squeezed = normalizeZoomParts({ ...base, end: 1200 })
    expect(squeezed.parts).toBeUndefined()
    expect('parts' in squeezed).toBe(false)
  })

  it('inserts a part that copies the area playing there', () => {
    const res = insertZoomPart(base, 3800, 'n')!
    expect(res.index).toBe(2)
    expect(res.zoom.parts!.map((p) => p.id)).toEqual(['a', 'n', 'b'])
    expect(res.zoom.parts![1]).toEqual({ id: 'n', start: 3800, target: { x: 0.2, y: 0.2 }, scale: 4 })
    const first = insertZoomPart(noParts, 2000, 'f')!
    expect(first.index).toBe(1)
    expect(first.zoom.parts![0].target).toEqual(noParts.target)
    expect(first.zoom.parts![0].scale).toBe(2)
  })

  it('refuses to insert too close to the edges, to another boundary, or in follow mode', () => {
    expect(insertZoomPart(base, 1000 + ZOOM_PART_MIN_MS - 1, 'n')).toBeNull()
    expect(insertZoomPart(base, 1000 + ZOOM_PART_MIN_MS, 'n')).not.toBeNull()
    expect(insertZoomPart(base, 6000 - ZOOM_PART_MIN_MS + 1, 'n')).toBeNull()
    expect(insertZoomPart(base, 3000 + ZOOM_PART_MIN_MS - 1, 'n')).toBeNull()
    expect(insertZoomPart(base, 3000 - ZOOM_PART_MIN_MS + 1, 'n')).toBeNull()
    expect(insertZoomPart({ ...base, mode: 'follow' }, 2000, 'n')).toBeNull()
  })

  it('removes a part so the previous area lasts longer', () => {
    expect(zoomAreas(removeZoomPart(base, 1)).map((a) => [a.start, a.end])).toEqual([
      [1000, 4500],
      [4500, 6000]
    ])
    expect(removeZoomPart(base, 0)).toBe(base)
    expect(removeZoomPart(base, 3)).toBe(base)
    expect(removeZoomPart(removeZoomPart(base, 2), 1).parts).toBeUndefined()
  })

  it('shifts every boundary', () => {
    expect(shiftZoomParts(base, 500).parts!.map((p) => p.start)).toEqual([3500, 5000])
    expect(shiftZoomParts(base, 0)).toBe(base)
    expect(shiftZoomParts(noParts, 500)).toBe(noParts)
  })

  it('patches an area and clamps a moved boundary between its neighbours', () => {
    expect(patchZoomArea(base, 1, { start: 0 }).parts![0].start).toBe(1000 + ZOOM_PART_MIN_MS)
    expect(patchZoomArea(base, 1, { start: 9999 }).parts![0].start).toBe(4500 - ZOOM_PART_MIN_MS)
    expect(patchZoomArea(base, 2, { start: 9999 }).parts![1].start).toBe(6000 - ZOOM_PART_MIN_MS)
    expect(patchZoomArea(base, 1, { scale: 3 }).parts![0].scale).toBe(3)
    expect(patchZoomArea(base, 0, { scale: 3 }).scale).toBe(3)
    expect(patchZoomArea(base, 0, { target: { x: 0.1, y: 0.1 } }).target).toEqual({ x: 0.1, y: 0.1 })
    expect(patchZoomArea(base, 5, { scale: 3 })).toBe(base)
    expect(patchZoomArea(base, 1, {})).toBe(base)
  })

  it('parks the playhead after the ease-in or glide of an area, inside it', () => {
    expect(zoomAreaFocusMs(noParts, 0)).toBe(1000 + 500 + 50)
    expect(zoomAreaFocusMs(base, 0)).toBe(1000 + 500 + 50)
    expect(zoomAreaFocusMs(base, 1)).toBe(3000 + ZOOM_PART_TRANSITION_MS + 50)
    const tight = insertZoomPart(base, 3400, 'n')!.zoom // area 'a' is now 3000..3400
    expect(zoomAreaFocusMs(tight, 1)).toBe(3000 + 200 + 50)
    expect(zoomAreaFocusMs(base, 99)).toBeLessThan(6000)
  })

  describe('camera', () => {
    const proj = project([base])
    const at = (t: number): ReturnType<typeof cameraAt> => cameraAt(proj, t, null)

    it('holds area 0 after the ease-in', () => {
      const cam = at(2000)
      expect(cam.scale).toBe(2)
      expect(cam.cx).toBeCloseTo(0.75, 5) // 0.8 clamped to 1 - 0.25
    })

    it('starts gliding exactly at the boundary and reaches the part after the transition', () => {
      expect(at(3000).scale).toBe(2)
      expect(at(3000 + 10).scale).toBeGreaterThan(2)
      const mid = at(3000 + ZOOM_PART_TRANSITION_MS / 2)
      expect(mid.scale).toBeCloseTo(Math.sqrt(2 * 4), 5) // geometric halfway
      const done = at(3000 + ZOOM_PART_TRANSITION_MS)
      expect(done.scale).toBeCloseTo(4, 5)
      expect(done.cx).toBeCloseTo(0.2, 5) // inside the clamp range 0.125..0.875
      expect(done.cy).toBeCloseTo(0.2, 5)
      expect(at(3900)).toEqual(done)
    })

    it('glides over half the area when the area is short', () => {
      const short = project([
        {
          ...base,
          parts: [
            { id: 'a', start: 3000, target: { x: 0.2, y: 0.2 }, scale: 4 },
            { id: 'b', start: 3400, target: { x: 0.5, y: 0.5 }, scale: 2 }
          ]
        }
      ])
      // area 'a' lasts 400 ms, so its glide is 200 ms long
      expect(cameraAt(short, 3200, null).scale).toBeCloseTo(4, 5)
      expect(cameraAt(short, 3100, null).scale).toBeCloseTo(Math.sqrt(8), 5)
    })

    it('eases out from the last area back to the identity at the end', () => {
      expect(at(5500).scale).toBe(2)
      expect(at(5750).scale).toBeCloseTo(1.5, 5)
      expect(at(5999.9999).scale).toBeCloseTo(1, 3)
      expect(at(6000)).toEqual({ cx: 0.5, cy: 0.5, scale: 1 })
    })

    it('keeps the viewport inside the frame all the time', () => {
      for (let t = 1000; t < 6000; t += 7) {
        const vp = viewportOf(at(t))
        expect(vp.x).toBeGreaterThanOrEqual(-1e-9)
        expect(vp.y).toBeGreaterThanOrEqual(-1e-9)
        expect(vp.x + vp.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(vp.y + vp.h).toBeLessThanOrEqual(1 + 1e-9)
      }
    })

    it('ignores the parts in follow mode and without parts', () => {
      const followZoom = { ...base, mode: 'follow' as const }
      expect(cameraAt(project([followZoom]), 4000, null)).toEqual(cameraAt(project([{ ...followZoom, parts: undefined }]), 4000, null))
      expect(cameraAt(project([noParts]), 4000, null).scale).toBe(2)
    })

    it('survives corrupt parts', () => {
      const bad = project([{ ...base, parts: [{ id: 'x', start: Number.NaN, target: { x: 0, y: 0 }, scale: 3 }] }])
      expect(cameraAt(bad, 3000, null).scale).toBe(2)
    })
  })

  it('keeps and normalizes the parts of a zoom that resolveZoomOverlaps changed', () => {
    // the part at 3000 would leave 200 ms before the new end, so it goes
    expect(resolveZoomOverlaps([{ ...base, end: 3200 }], 'z', 10000)[0].parts).toBeUndefined()
    expect(resolveZoomOverlaps([base], 'z', 10000)[0].parts).toHaveLength(2)
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
