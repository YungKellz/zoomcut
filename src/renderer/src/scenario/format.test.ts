import { describe, expect, it } from 'vitest'
import { dotPositionPercent, formatMinSec, gapBeforeIndex, gapToAt, truncateCaption } from './format'
import type { ScenarioClickAction, ScenarioModifiers, ScenarioShot } from '@shared/types'

const NO_MODS: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }
function click(id: string, at: number): ScenarioClickAction {
  return { id, kind: 'click', at, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null }
}

describe('formatMinSec', () => {
  it('formats without a leading zero on minutes', () => {
    expect(formatMinSec(83_000)).toBe('1:23')
  })

  it('formats the 10-minute cap', () => {
    expect(formatMinSec(600_000)).toBe('10:00')
  })

  it('rounds to the nearest second', () => {
    expect(formatMinSec(1_499)).toBe('0:01')
    expect(formatMinSec(1_500)).toBe('0:02')
  })

  it('clamps negative input to zero', () => {
    expect(formatMinSec(-500)).toBe('0:00')
  })
})

describe('gapBeforeIndex', () => {
  it("is the action's own `at` for the first action", () => {
    expect(gapBeforeIndex([click('a', 1000)], 0)).toBe(1000)
  })

  it('is the time since the previous action ended (click lasts 70ms)', () => {
    const actions = [click('a', 1000), click('b', 1500)]
    expect(gapBeforeIndex(actions, 1)).toBe(1500 - (1000 + 70))
  })

  it('is 0 when the previous action ends exactly where this one starts', () => {
    const actions = [click('a', 1000), click('b', 1070)]
    expect(gapBeforeIndex(actions, 1)).toBe(0)
  })

  it('returns 0 for an out-of-range index', () => {
    expect(gapBeforeIndex([click('a', 1000)], 5)).toBe(0)
    expect(gapBeforeIndex([], 0)).toBe(0)
  })
})

describe('gapToAt (inverse of gapBeforeIndex)', () => {
  it('is exactly the gap for the first action - no previous end to add', () => {
    expect(gapToAt([click('a', 1000)], 0, 250)).toBe(250)
  })

  it('adds the gap to the previous action end (click lasts 70ms)', () => {
    const actions = [click('a', 1000), click('b', 2000)]
    expect(gapToAt(actions, 1, 300)).toBe(1000 + 70 + 300)
  })

  it('round-trips with gapBeforeIndex', () => {
    const actions = [click('a', 1000), click('b', 1500), click('c', 3000)]
    for (let i = 0; i < actions.length; i++) {
      const gap = gapBeforeIndex(actions, i)
      expect(gapToAt(actions, i, gap)).toBe(actions[i].at)
    }
  })
})

describe('dotPositionPercent', () => {
  const shot: ScenarioShot = { file: 'shots/shot_0.png', x: 100, y: 200, w: 360, h: 220 }

  it('places a point at the top-left corner at 0%,0%', () => {
    expect(dotPositionPercent(shot, { x: 100, y: 200 })).toEqual({ left: 0, top: 0 })
  })

  it('places a point at the center at 50%,50%', () => {
    expect(dotPositionPercent(shot, { x: 280, y: 310 })).toEqual({ left: 50, top: 50 })
  })

  it('places a point at the bottom-right corner at 100%,100%', () => {
    expect(dotPositionPercent(shot, { x: 460, y: 420 })).toEqual({ left: 100, top: 100 })
  })

  it('clamps a point outside the rect to the nearest edge', () => {
    expect(dotPositionPercent(shot, { x: -500, y: -500 })).toEqual({ left: 0, top: 0 })
    expect(dotPositionPercent(shot, { x: 5000, y: 5000 })).toEqual({ left: 100, top: 100 })
  })

  it('reports the top-left corner for a degenerate (zero-size) rect instead of dividing by zero', () => {
    const degenerate: ScenarioShot = { file: 'x', x: 0, y: 0, w: 0, h: 0 }
    expect(dotPositionPercent(degenerate, { x: 50, y: 50 })).toEqual({ left: 0, top: 0 })
  })
})

describe('truncateCaption', () => {
  it('keeps short text untouched', () => {
    expect(truncateCaption('hello')).toBe('hello')
  })

  it('keeps text exactly at the limit untouched', () => {
    expect(truncateCaption('x'.repeat(40), 40)).toBe('x'.repeat(40))
  })

  it('cuts long text to the limit and adds an ellipsis', () => {
    const out = truncateCaption('x'.repeat(50), 40)
    expect(out).toBe('x'.repeat(40) + '…')
    expect(out.length).toBe(41)
  })

  it('does not split a multi-byte grapheme (surrogate pair) in half', () => {
    const emoji = '\u{1F600}' // U+1F600, a surrogate pair: 2 UTF-16 code units, 1 grapheme
    const text = emoji.repeat(45) // 90 UTF-16 code units, 45 graphemes
    // a naive text.slice(0, 41) would land mid-surrogate-pair here and produce an invalid string
    const out = truncateCaption(text, 41)
    expect(out).toBe(emoji.repeat(41) + '…')
    expect([...out].length).toBe(42) // 41 whole emoji + 1 ellipsis, iterated by code point
  })
})
