import { describe, expect, it } from 'vitest'
import { PICK_SNAP_MAX, clampPickCenter, pickSnapThreshold, resizePickRect, snapPickCenter, type PickGeometry } from './pickRect'

const MIN = 1 / 5
const MAX = 1 / 1.2

describe('pick rectangle: clamping', () => {
  it('moves the centre so the rectangle stays inside the frame', () => {
    expect(clampPickCenter({ cx: 0, cy: 2, size: 0.4 })).toEqual({ cx: 0.2, cy: 0.8, size: 0.4 })
    const inside = { cx: 0.5, cy: 0.5, size: 0.4 }
    expect(clampPickCenter(inside)).toEqual(inside)
  })
})

describe('pick rectangle: Shift magnet', () => {
  it('limits the reach to about 10 px, but never above 2.5 % of the frame', () => {
    expect(pickSnapThreshold(1000)).toBeCloseTo(0.01, 6)
    expect(pickSnapThreshold(400)).toBeCloseTo(PICK_SNAP_MAX, 6)
    expect(pickSnapThreshold(100)).toBe(PICK_SNAP_MAX)
    expect(pickSnapThreshold(0)).toBe(PICK_SNAP_MAX)
  })

  it('snaps each axis to the centre line on its own', () => {
    const r: PickGeometry = { cx: 0.51, cy: 0.7, size: 0.4 }
    const s = snapPickCenter(r, 0.025, 0.025)
    expect(s.x).toBe(true)
    expect(s.y).toBe(false)
    expect(s.rect).toEqual({ cx: 0.5, cy: 0.7, size: 0.4 })
    const both = snapPickCenter({ cx: 0.49, cy: 0.52, size: 0.3 }, 0.025, 0.025)
    expect([both.x, both.y]).toEqual([true, true])
    expect(both.rect).toEqual({ cx: 0.5, cy: 0.5, size: 0.3 })
  })

  it('leaves the rectangle alone outside the reach (same object)', () => {
    const r: PickGeometry = { cx: 0.6, cy: 0.3, size: 0.4 }
    const s = snapPickCenter(r, 0.025, 0.025)
    expect(s.rect).toBe(r)
    expect([s.x, s.y]).toEqual([false, false])
    // just inside and just outside the reach
    expect(snapPickCenter({ cx: 0.52, cy: 0.5, size: 0.4 }, 0.025, 0.025).x).toBe(true)
    expect(snapPickCenter({ cx: 0.53, cy: 0.5, size: 0.4 }, 0.025, 0.025).x).toBe(false)
  })

  it('uses a separate reach per axis (a non-square frame)', () => {
    const s = snapPickCenter({ cx: 0.515, cy: 0.515, size: 0.3 }, 0.01, 0.02)
    expect([s.x, s.y]).toEqual([false, true])
  })

  it('the centre line stays reachable for the biggest rectangle', () => {
    const big = clampPickCenter({ cx: 0, cy: 1, size: MAX })
    expect(Math.abs(big.cx - 0.5)).toBeLessThan(0.1)
    const s = snapPickCenter({ cx: 0.5 + 0.01, cy: 0.5 - 0.01, size: MAX }, 0.025, 0.025)
    expect(clampPickCenter(s.rect)).toEqual(s.rect)
  })
})

describe('pick rectangle: corner resize', () => {
  const start: PickGeometry = { cx: 0.5, cy: 0.5, size: 0.4 } // spans 0.3..0.7

  it('keeps the opposite corner fixed by default', () => {
    const r = resizePickRect(start, 'se', { x: 0.9, y: 0.8 }, MIN, MAX)
    // anchor (0.3, 0.3); the bigger of the two distances wins: 0.6
    expect(r.size).toBeCloseTo(0.6, 6)
    expect(r.cx - r.size / 2).toBeCloseTo(0.3, 6)
    expect(r.cy - r.size / 2).toBeCloseTo(0.3, 6)
    const nw = resizePickRect(start, 'nw', { x: 0.1, y: 0.2 }, MIN, MAX)
    expect(nw.cx + nw.size / 2).toBeCloseTo(0.7, 6) // east edge stays
    expect(nw.cy + nw.size / 2).toBeCloseTo(0.7, 6) // south edge stays
    expect(nw.size).toBeCloseTo(0.6, 6)
  })

  it('clamps to the size limits and to the frame', () => {
    expect(resizePickRect(start, 'se', { x: 0.31, y: 0.31 }, MIN, MAX).size).toBe(MIN)
    expect(resizePickRect(start, 'se', { x: 5, y: 5 }, MIN, MAX).size).toBeCloseTo(0.7, 6) // frame edge 1 - 0.3
    const near = resizePickRect({ cx: 0.2, cy: 0.2, size: 0.3 }, 'se', { x: 5, y: 5 }, MIN, MAX)
    expect(near.size).toBeCloseTo(MAX, 6)
  })
})

describe('pick rectangle: Alt resizes around the centre', () => {
  const start: PickGeometry = { cx: 0.4, cy: 0.6, size: 0.4 }

  it('keeps the centre fixed and grows in every direction', () => {
    const r = resizePickRect(start, 'se', { x: 0.6, y: 0.7 }, MIN, MAX, true)
    expect(r.cx).toBe(0.4)
    expect(r.cy).toBe(0.6)
    // dominant axis: x, 0.2 away from the centre -> half = 0.2 -> size 0.4
    expect(r.size).toBeCloseTo(0.4, 6)
    const bigger = resizePickRect(start, 'se', { x: 0.7, y: 0.65 }, MIN, MAX, true)
    expect(bigger.size).toBeCloseTo(0.6, 6)
    expect([bigger.cx, bigger.cy]).toEqual([0.4, 0.6])
  })

  it('works from every corner: dragging away from the centre grows, towards it shrinks', () => {
    for (const [corner, away, toward] of [
      ['nw', { x: 0.1, y: 0.3 }, { x: 0.35, y: 0.55 }],
      ['ne', { x: 0.8, y: 0.3 }, { x: 0.45, y: 0.55 }],
      ['sw', { x: 0.1, y: 0.9 }, { x: 0.35, y: 0.65 }],
      ['se', { x: 0.8, y: 0.9 }, { x: 0.45, y: 0.65 }]
    ] as const) {
      const grow = resizePickRect(start, corner, away, MIN, MAX, true)
      const shrink = resizePickRect(start, corner, toward, MIN, MAX, true)
      expect(grow.size).toBeGreaterThan(start.size)
      expect(shrink.size).toBe(MIN)
      expect([grow.cx, grow.cy, shrink.cx, shrink.cy]).toEqual([0.4, 0.6, 0.4, 0.6])
    }
  })

  it('stops at the nearest frame edge, the maximum and the minimum', () => {
    // nearest edge is the left one, 0.4 away -> the biggest size is 0.8, below MAX (0.833)
    expect(resizePickRect(start, 'se', { x: 9, y: 9 }, MIN, MAX, true).size).toBeCloseTo(0.8, 6)
    const middle: PickGeometry = { cx: 0.5, cy: 0.5, size: 0.4 }
    expect(resizePickRect(middle, 'se', { x: 9, y: 9 }, MIN, MAX, true).size).toBeCloseTo(MAX, 6)
    expect(resizePickRect(middle, 'se', { x: 0.5, y: 0.5 }, MIN, MAX, true).size).toBe(MIN)
    const r = resizePickRect(start, 'se', { x: 9, y: 9 }, MIN, MAX, true)
    expect(clampPickCenter(r)).toEqual(r) // still inside the frame
  })
})
