import { describe, expect, it } from 'vitest'
import { boxArea, coversDisplay, intersectBox, isVisibleEnough, subtractBox, uncoveredArea, uncoveredShares, type Box } from './windows'

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })
const total = (boxes: Box[]): number => boxes.reduce((s, b) => s + boxArea(b), 0)

describe('window geometry', () => {
  it('intersects boxes, touching edges do not overlap', () => {
    expect(intersectBox(box(0, 0, 0.5, 0.5), box(0.25, 0.25, 0.5, 0.5))).toEqual(box(0.25, 0.25, 0.25, 0.25))
    expect(intersectBox(box(0, 0, 0.5, 0.5), box(0.5, 0, 0.5, 0.5))).toBeNull()
  })

  it('subtracts a box into disjoint pieces that add up', () => {
    const a = box(0, 0, 1, 1)
    expect(subtractBox(a, box(2, 2, 1, 1))).toEqual([a])
    expect(subtractBox(a, box(-1, -1, 3, 3))).toEqual([])
    // a hole in the middle: top, bottom, left and right pieces
    const ring = subtractBox(a, box(0.25, 0.25, 0.5, 0.5))
    expect(ring).toHaveLength(4)
    expect(total(ring)).toBeCloseTo(0.75)
    // a cut over the left half leaves the right half only
    expect(subtractBox(a, box(-0.5, -0.5, 1, 2))).toEqual([box(0.5, 0, 0.5, 1)])
  })

  it('counts the uncovered area exactly, overlapping covers only once', () => {
    const a = box(0, 0, 1, 1)
    expect(uncoveredArea(a, [])).toBeCloseTo(1)
    // two covers overlapping each other: 0.5 + 0.5 - 0.25 covered
    expect(uncoveredArea(a, [box(0, 0, 0.5, 1), box(0, 0, 1, 0.5)])).toBeCloseTo(0.25)
    expect(uncoveredArea(a, [box(0, 0, 1, 1), box(0.2, 0.2, 0.1, 0.1)])).toBe(0)
    expect(uncoveredArea(box(0, 0, 0, 1), [])).toBe(0)
  })

  it('gives each box of a topmost-first list the share nothing above covers', () => {
    const shares = uncoveredShares([box(0, 0, 0.5, 0.5), box(0.25, 0, 0.5, 0.5), box(0, 0, 1, 1)])
    expect(shares[0]).toBeCloseTo(1)
    expect(shares[1]).toBeCloseTo(0.5)
    // the full-display window below both: their union is 0.25 + 0.25 - 0.125
    expect(shares[2]).toBeCloseTo(0.625)
    // the first box hides nothing
    const skipFirst = uncoveredShares([box(0, 0, 0.5, 0.5), box(0.25, 0, 0.5, 0.5), box(0, 0, 1, 1)], (i) => i !== 0)
    expect(skipFirst[1]).toBeCloseTo(1)
    expect(skipFirst[2]).toBeCloseTo(0.75)
  })

  it('recognizes a box over the whole display', () => {
    expect(coversDisplay(box(0, 0, 1, 1))).toBe(true)
    expect(coversDisplay(box(0.001, 0, 0.9995, 1))).toBe(true)
    expect(coversDisplay(box(0, 0, 1, 0.96))).toBe(false)
    expect(coversDisplay(box(0.1, 0, 0.9, 1))).toBe(false)
  })

  it('keeps windows that are mostly visible, or large and partly visible, never tiny ones', () => {
    // half of a mid-size window
    expect(isVisibleEnough(box(0, 0, 0.4, 0.4), 0.5)).toBe(true)
    expect(isVisibleEnough(box(0, 0, 0.4, 0.4), 0.45)).toBe(false)
    // a maximized window with 40 % of it still visible around a window in front
    expect(isVisibleEnough(box(0, 0, 1, 0.97), 0.4)).toBe(true)
    // ... but not a sliver of it
    expect(isVisibleEnough(box(0, 0, 1, 0.97), 0.08)).toBe(false)
    // fully visible, but under 1 % of the display
    expect(isVisibleEnough(box(0, 0, 0.08, 0.1), 1)).toBe(false)
  })
})
