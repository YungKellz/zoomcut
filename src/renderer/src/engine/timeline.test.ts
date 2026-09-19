import { describe, expect, it } from 'vitest'
import { clipRegionsToCuts, keepSegments, normalizeCuts, outToSrc, outputDuration, resolvePlayableTime, srcToOut } from './timeline'

describe('timeline cuts', () => {
  it('merges overlapping cuts and clamps them to the duration', () => {
    const cuts = normalizeCuts(
      [
        { id: 'a', start: 5000, end: 2000 },
        { id: 'b', start: 4000, end: 7000 },
        { id: 'c', start: 9000, end: 20000 }
      ],
      10000
    )
    expect(cuts.map((c) => [c.start, c.end])).toEqual([
      [2000, 7000],
      [9000, 10000]
    ])
  })

  it('computes kept segments and output duration', () => {
    const segments = keepSegments(10000, [
      { id: 'a', start: 0, end: 1000 },
      { id: 'b', start: 4000, end: 6000 }
    ])
    expect(segments).toEqual([
      { start: 1000, end: 4000 },
      { start: 6000, end: 10000 }
    ])
    expect(outputDuration(segments)).toBe(7000)
  })

  it('maps between source and output time', () => {
    const segments = keepSegments(10000, [{ id: 'a', start: 2000, end: 5000 }])
    expect(srcToOut(1000, segments)).toBe(1000)
    expect(srcToOut(3000, segments)).toBe(2000) // inside the cut → next kept frame
    expect(srcToOut(6000, segments)).toBe(3000)
    expect(outToSrc(1000, segments)).toBe(1000)
    expect(outToSrc(3000, segments)).toBe(6000)
    expect(outToSrc(99999, segments)).toBe(10000)
  })

  it('clips regions to cuts', () => {
    const cuts = [{ id: 'a', start: 2000, end: 4000 }]
    const regions = [
      { id: 'inside', start: 2500, end: 3500 },
      { id: 'startOverlap', start: 3000, end: 6000 },
      { id: 'endOverlap', start: 1000, end: 3000 },
      { id: 'spanning', start: 1000, end: 6000 },
      { id: 'outside', start: 5000, end: 7000 }
    ]
    const clipped = clipRegionsToCuts(regions, cuts, 10000)
    expect(clipped.map((r) => [r.id, r.start, r.end])).toEqual([
      ['startOverlap', 4000, 6000],
      ['endOverlap', 1000, 2000],
      ['spanning', 1000, 6000],
      ['outside', 5000, 7000]
    ])
  })

  it('resolves playable time across cuts', () => {
    const segments = keepSegments(10000, [{ id: 'a', start: 2000, end: 5000 }])
    expect(resolvePlayableTime(1000, segments)).toBe(1000)
    expect(resolvePlayableTime(3000, segments)).toBe(5000)
    expect(resolvePlayableTime(10000, segments)).toBeNull()
  })
})
