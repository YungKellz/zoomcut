import { describe, expect, it } from 'vitest'
import * as renderer from '../renderer/src/engine/timeline'
import { MIN_SEGMENT_MS, keepSegments, normalizeCuts, outputDuration } from './timeline'

describe('shared timeline rule', () => {
  it('merges, sorts and clamps cuts', () => {
    expect(
      normalizeCuts(
        [
          { id: 'b', start: 4000, end: 3000 },
          { id: 'a', start: 1000, end: 3500 },
          { id: 'c', start: 11_000, end: 12_000 },
          { id: 'd', start: 9000, end: 12_000 }
        ],
        10_000
      )
    ).toEqual([
      { id: 'a', start: 1000, end: 4000 },
      { id: 'd', start: 9000, end: 10_000 }
    ])
  })

  it('keeps the pieces between the cuts and drops those under MIN_SEGMENT_MS', () => {
    const segments = keepSegments(10_000, [
      { id: 'a', start: 1000, end: 2000 },
      { id: 'b', start: 2000 + MIN_SEGMENT_MS - 1, end: 9980 }
    ])
    // 39 ms between the cuts and a 20 ms tail are both under the minimum
    expect(segments).toEqual([{ start: 0, end: 1000 }])
    expect(outputDuration(keepSegments(10_000, [{ id: 'a', start: 1000, end: 3000 }]))).toBe(8000)
  })

  it('is the very code the renderer timeline exports', () => {
    expect(renderer.keepSegments).toBe(keepSegments)
    expect(renderer.normalizeCuts).toBe(normalizeCuts)
    expect(renderer.outputDuration).toBe(outputDuration)
    expect(renderer.MIN_SEGMENT_MS).toBe(MIN_SEGMENT_MS)
  })
})
