import { describe, expect, it } from 'vitest'
import {
  clipRegionsToCuts,
  displayTime,
  keepSegments,
  normalizeCuts,
  outToSrc,
  outputDuration,
  playStartTime,
  resolvePlayableTime,
  srcToOut,
  stepFrames
} from './timeline'

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

describe('playback start and frame steps', () => {
  const FRAME = 1000 / 30
  // kept: 0..2000 and 5000..10000 (output length 7000)
  const segments = keepSegments(10000, [{ id: 'a', start: 2000, end: 5000 }])

  it('starts where the playhead is, or at the next kept frame when it sits in a cut', () => {
    expect(playStartTime(1000, segments)).toBe(1000)
    expect(playStartTime(3000, segments)).toBe(5000)
    expect(playStartTime(0, segments)).toBe(0)
  })

  it('starts over from the first kept frame when nothing is left to play', () => {
    expect(playStartTime(10000, segments)).toBe(0)
    expect(playStartTime(9999.5, segments)).toBe(0) // under a millisecond left is the end as well
    expect(playStartTime(9990, segments)).toBe(9990)
    // the end is the end of the LAST kept piece, a cut behind it does not matter
    const tailCut = keepSegments(10000, [{ id: 'a', start: 8000, end: 10000 }])
    expect(playStartTime(8000, tailCut)).toBe(0)
    expect(playStartTime(10000, tailCut)).toBe(0)
    // the first piece starts after a removed head
    const headCut = keepSegments(10000, [{ id: 'a', start: 0, end: 3000 }])
    expect(playStartTime(10000, headCut)).toBe(3000)
    expect(playStartTime(1000, headCut)).toBe(3000)
  })

  it('has nothing to play when everything is cut', () => {
    expect(playStartTime(500, [])).toBe(0)
  })

  it('steps by output frames and jumps over removed pieces', () => {
    expect(stepFrames(0, 1, FRAME, segments)).toBeCloseTo(FRAME)
    expect(stepFrames(1000, -1, FRAME, segments)).toBeCloseTo(1000 - FRAME)
    // forward over the cut: the last frames before it, then the first after it
    expect(stepFrames(2000 - FRAME, 1, FRAME, segments)).toBeCloseTo(5000)
    expect(stepFrames(2000, 1, FRAME, segments)).toBeCloseTo(5000 + FRAME)
    // back over the cut
    expect(stepFrames(5000, -1, FRAME, segments)).toBeCloseTo(2000 - FRAME)
    expect(stepFrames(5000 + FRAME, -1, FRAME, segments)).toBe(5000)
  })

  it('keeps steps inside the kept range', () => {
    expect(stepFrames(0, -1, FRAME, segments)).toBe(0)
    expect(stepFrames(10000, 1, FRAME, segments)).toBe(10000)
    expect(stepFrames(10000 - FRAME / 2, 1, FRAME, segments)).toBe(10000)
    expect(stepFrames(10000, -1, FRAME, segments)).toBeCloseTo(10000 - FRAME)
    // a playhead inside a cut counts as the next kept frame
    expect(stepFrames(3000, -1, FRAME, segments)).toBeCloseTo(2000 - FRAME)
    expect(stepFrames(500, 1, FRAME, [])).toBe(0)
  })

  it('steps along the output, so each frame is one frame of the output', () => {
    // 30 forward steps from the start are exactly one second of output
    let t = 0
    for (let i = 0; i < 30; i++) t = stepFrames(t, 1, FRAME, segments)
    expect(srcToOut(t, segments)).toBeCloseTo(1000, 1)
    // and the same number back again returns to the start
    for (let i = 0; i < 30; i++) t = stepFrames(t, -1, FRAME, segments)
    expect(t).toBeCloseTo(0, 1)
  })

  it('shows the last kept frame at the end of the output', () => {
    expect(displayTime(1234, FRAME, segments)).toBeCloseTo(1234.05, 6) // a hair past the playhead
    expect(displayTime(9990, FRAME, segments)).toBeCloseTo(9990.05, 6)
    expect(displayTime(10000, FRAME, segments)).toBeCloseTo(10000 - FRAME / 2)
    // a removed piece behind the last kept one is never shown
    const tailCut = keepSegments(10000, [{ id: 'a', start: 8000, end: 10000 }])
    expect(displayTime(8000, FRAME, tailCut)).toBeCloseTo(8000 - FRAME / 2)
    expect(displayTime(10000, FRAME, tailCut)).toBeCloseTo(8000 - FRAME / 2)
    expect(displayTime(7000, FRAME, tailCut)).toBeCloseTo(7000.05, 6)
    // a last piece shorter than half a frame stays inside itself
    const sliver = [{ start: 110, end: 120 }]
    expect(displayTime(120, FRAME, sliver)).toBe(110)
    expect(displayTime(500, FRAME, [])).toBeCloseTo(500.05, 6)
  })
})
