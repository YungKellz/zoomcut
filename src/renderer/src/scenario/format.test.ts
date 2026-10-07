import { describe, expect, it } from 'vitest'
import {
  audioHintKey,
  dotPositionPercent,
  formatMinSec,
  formatSecondsValue,
  formatStartTime,
  parseSecondsInput,
  spanLabel,
  spanWidthPx,
  truncateCaption
} from './format'
import type { AudioCaptureOptions, ScenarioClickAction, ScenarioModifiers, ScenarioShot, ScenarioTypeAction } from '@shared/types'

const NO_MODS: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }
function click(id: string): ScenarioClickAction {
  return { id, kind: 'click', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, durationMs: 1000, pauseMs: 1500 }
}
function typeAction(text: string): ScenarioTypeAction {
  return { id: 't', kind: 'type', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, text, durationMs: 1000, pauseMs: 1500 }
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

describe('audioHintKey', () => {
  const opts = (mic: boolean, system: boolean): AudioCaptureOptions => ({ mic, micDeviceId: null, system })

  it('reports both sources when mic and system are enabled', () => {
    expect(audioHintKey(opts(true, true))).toBe('scenario.audioHintBoth')
  })

  it('reports mic only', () => {
    expect(audioHintKey(opts(true, false))).toBe('scenario.audioHintMic')
  })

  it('reports system only', () => {
    expect(audioHintKey(opts(false, true))).toBe('scenario.audioHintSystem')
  })

  it('reports none when neither source is enabled', () => {
    expect(audioHintKey(opts(false, false))).toBe('scenario.audioHintNone')
  })

  it('reports none when settings were never loaded (null/undefined)', () => {
    expect(audioHintKey(null)).toBe('scenario.audioHintNone')
    expect(audioHintKey(undefined)).toBe('scenario.audioHintNone')
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

describe('formatStartTime', () => {
  it('shows one decimal, truncated', () => {
    expect(formatStartTime(0)).toBe('0:00.0')
    expect(formatStartTime(3500)).toBe('0:03.5')
    expect(formatStartTime(3599)).toBe('0:03.5')
    expect(formatStartTime(83_400)).toBe('1:23.4')
  })
})

describe('formatSecondsValue', () => {
  it('trims trailing zeros and keeps up to two decimals', () => {
    expect(formatSecondsValue(1000, 'en')).toBe('1')
    expect(formatSecondsValue(1500, 'en')).toBe('1.5')
    expect(formatSecondsValue(1250, 'en')).toBe('1.25')
    expect(formatSecondsValue(10_000, 'en')).toBe('10')
    expect(formatSecondsValue(0, 'en')).toBe('0')
  })

  it('uses a decimal comma in Russian', () => {
    expect(formatSecondsValue(1500, 'ru')).toBe('1,5')
    expect(formatSecondsValue(2000, 'ru')).toBe('2')
  })
})

describe('parseSecondsInput', () => {
  it('accepts a dot or a comma', () => {
    expect(parseSecondsInput('1.5')).toBe(1500)
    expect(parseSecondsInput('1,5')).toBe(1500)
    expect(parseSecondsInput(' 2 ')).toBe(2000)
    expect(parseSecondsInput('.5')).toBe(500)
    expect(parseSecondsInput('0')).toBe(0)
  })

  it('rounds to whole milliseconds', () => {
    expect(parseSecondsInput('1.2346')).toBe(1235)
  })

  it('rejects empty, negative and non-numeric drafts', () => {
    expect(parseSecondsInput('')).toBeNull()
    expect(parseSecondsInput('   ')).toBeNull()
    expect(parseSecondsInput('-1')).toBeNull()
    expect(parseSecondsInput('abc')).toBeNull()
    expect(parseSecondsInput('1.2.3')).toBeNull()
    expect(parseSecondsInput('1e3')).toBeNull()
    expect(parseSecondsInput('.')).toBeNull()
  })
})

describe('spanLabel', () => {
  it('is the truncated typed text for a type action', () => {
    const text = 'x'.repeat(40)
    expect(spanLabel(typeAction(text))).toBe(truncateCaption(text, 24))
  })

  it('is null for every other kind', () => {
    expect(spanLabel(click('a'))).toBeNull()
  })
})

describe('spanWidthPx', () => {
  it("scales with the action's length and the timeline's scale", () => {
    expect(spanWidthPx(1000, 2000, 0.1)).toBe(100)
  })

  it('never goes below the minimum visual width', () => {
    expect(spanWidthPx(0, 200, 0.01)).toBe(24)
  })
})
