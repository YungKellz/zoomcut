import { describe, expect, it } from 'vitest'
import {
  buildInputMarks,
  clipMarksToSegments,
  marksFromClicks,
  type RawHookEvent,
  type RawKeyDown,
  type RawKeyUp,
  type RawPointerDown,
  type RawPointerUp
} from './inputMarks'
import type { ClickEvent, InputMark, MouseButton } from './types'

// uiohook keycodes (set-1 scancodes, extended keys with their prefix)
const KEY = {
  A: 30,
  S: 31,
  C: 46,
  V: 47,
  T: 20,
  R: 19,
  Q: 16,
  Space: 57,
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  Escape: 1,
  CapsLock: 58,
  F5: 63,
  Delete: 3667,
  ArrowDown: 57424,
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Shift: 42,
  Meta: 3675
}

type Mods = Partial<Pick<RawKeyDown, 'ctrl' | 'alt' | 'shift' | 'meta'>>

function down(t: number, x = 100, y = 100, button: MouseButton = 'left', clicks?: number): RawPointerDown {
  return { t, type: 'down', button, x, y, clicks }
}
function up(t: number, x = 100, y = 100, button: MouseButton = 'left'): RawPointerUp {
  return { t, type: 'up', button, x, y }
}
function kd(t: number, keycode: number, mods: Mods = {}): RawKeyDown {
  return { t, type: 'keydown', keycode, ctrl: false, alt: false, shift: false, meta: false, ...mods }
}
function ku(t: number, keycode: number): RawKeyUp {
  return { t, type: 'keyup', keycode }
}
/** one keystroke held for `holdMs` */
function press(t: number, keycode: number, mods: Mods = {}, holdMs = 60): RawHookEvent[] {
  return [kd(t, keycode, mods), ku(t + holdMs, keycode)]
}
/** `n` typing keystrokes `gap` ms apart, starting at `t` */
function typeKeys(t: number, n: number, gap = 120): RawHookEvent[] {
  const out: RawHookEvent[] = []
  for (let i = 0; i < n; i++) out.push(...press(t + i * gap, KEY.A + (i % 3)))
  return out
}
/** a combination: modifiers down, key pressed, modifiers up */
function combo(t: number, keycode: number, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): RawHookEvent[] {
  const modKeys = [mods.ctrl && KEY.Ctrl, mods.meta && KEY.Meta, mods.alt && KEY.Alt, mods.shift && KEY.Shift].filter((k): k is number => typeof k === 'number')
  return [
    ...modKeys.map((k, i) => kd(t - 40 + i, k, mods)),
    ...press(t, keycode, mods),
    ...modKeys.map((k, i) => ku(t + 100 + i, k))
  ]
}

describe('buildInputMarks: mouse', () => {
  it('a press without movement is a click, 6px or more of movement is a drag spanning down -> up', () => {
    const marks = buildInputMarks([down(1000), up(1080, 102, 101), down(3000, 100, 100), up(3900, 400, 300)])
    expect(marks).toEqual([
      { t: 1000, end: 1000, kind: 'click' },
      { t: 3000, end: 3900, kind: 'drag' }
    ])
  })

  it('two clicks close in time and space make one double click; far apart they stay two clicks', () => {
    expect(buildInputMarks([down(1000), up(1060), down(1250), up(1310)])).toEqual([{ t: 1000, end: 1000, kind: 'doubleClick' }])
    expect(buildInputMarks([down(1000), up(1060), down(1250, 300, 300), up(1310, 300, 300)]).map((m) => m.kind)).toEqual(['click', 'click'])
    expect(buildInputMarks([down(1000), up(1060), down(1900), up(1960)]).map((m) => m.kind)).toEqual(['click', 'click'])
  })

  it("trusts the hook's own double-click counter for the timing, never for the distance", () => {
    expect(buildInputMarks([down(1000), up(1060), down(1600, 101, 100, 'left', 2), up(1660, 101, 100)])).toEqual([
      { t: 1000, end: 1000, kind: 'doubleClick' }
    ])
    expect(buildInputMarks([down(1000), up(1060), down(1100, 500, 500, 'left', 2), up(1160, 500, 500)]).map((m) => m.kind)).toEqual(['click', 'click'])
  })

  it('right and middle presses are their own instant marks', () => {
    const marks = buildInputMarks([down(500, 10, 10, 'right'), up(600, 10, 10, 'right'), down(900, 10, 10, 'middle'), up(950, 10, 10, 'middle')])
    expect(marks).toEqual([
      { t: 500, end: 500, kind: 'rightClick' },
      { t: 900, end: 900, kind: 'middleClick' }
    ])
  })

  it('a button still down at the stop counts as a press, a lost mouseup does not swallow the next one', () => {
    expect(buildInputMarks([down(700)])).toEqual([{ t: 700, end: 700, kind: 'click' }])
    expect(buildInputMarks([down(700), down(5000), up(5050)]).map((m) => m.t)).toEqual([700, 5000])
  })

  it('wheel events less than 400ms apart are one scroll burst', () => {
    const wheel = (t: number): RawHookEvent => ({ t, type: 'wheel' })
    const marks = buildInputMarks([wheel(1000), wheel(1100), wheel(1450), wheel(1800), wheel(2500)])
    expect(marks).toEqual([
      { t: 1000, end: 1800, kind: 'scroll' },
      { t: 2500, end: 2500, kind: 'scroll' }
    ])
  })
})

describe('buildInputMarks: keyboard', () => {
  it('typing keys less than 1.5s apart are one burst that lasts until the last key is released', () => {
    const marks = buildInputMarks([...typeKeys(1000, 5), ...typeKeys(4000, 3)])
    expect(marks).toEqual([
      { t: 1000, end: 1000 + 4 * 120 + 60, kind: 'type' },
      { t: 4000, end: 4000 + 2 * 120 + 60, kind: 'type' }
    ])
  })

  it('Shift, Space and a Backspace inside a burst stay typing; a lone Backspace is a key of its own', () => {
    const marks = buildInputMarks([
      ...press(1000, KEY.A, { shift: true }),
      ...press(1200, KEY.Space),
      ...press(1400, KEY.Backspace),
      ...press(1600, KEY.S),
      ...press(5000, KEY.Backspace)
    ])
    expect(marks).toEqual([
      { t: 1000, end: 1660, kind: 'type' },
      { t: 5000, end: 5060, kind: 'key', label: 'Backspace' }
    ])
  })

  it('keeps no trace of what was typed: a type mark is only its span, labels belong to key marks only', () => {
    const marks = buildInputMarks([...typeKeys(1000, 12), ...combo(3500, KEY.C, { ctrl: true }), ...typeKeys(4000, 6)])
    for (const m of marks) {
      if (m.kind === 'type') expect(Object.keys(m).sort()).toEqual(['end', 'kind', 't'])
      else expect(m.label).toBeDefined()
    }
    const labels = marks.map((m) => m.label).filter(Boolean)
    expect(labels).toEqual(['Ctrl+C'])
  })

  it('a key with Ctrl / Alt / Win is a combination labelled with its modifiers', () => {
    const marks = buildInputMarks([
      ...combo(1000, KEY.C, { ctrl: true }),
      ...combo(3000, KEY.T, { ctrl: true, shift: true }),
      ...combo(5000, KEY.S, { meta: true, shift: true }),
      ...combo(7000, KEY.Delete, { ctrl: true, alt: true })
    ])
    expect(marks.map((m) => [m.kind, m.label])).toEqual([
      ['key', 'Ctrl+C'],
      ['key', 'Ctrl+Shift+T'],
      ['key', 'Win+Shift+S'],
      ['key', 'Ctrl+Alt+Delete']
    ])
  })

  it('special keys get a mark without a modifier and end a typing burst', () => {
    const marks = buildInputMarks([...typeKeys(1000, 3), ...press(1500, KEY.Enter), ...press(1700, KEY.A), ...press(4000, KEY.F5), ...press(6000, KEY.Escape), ...press(8000, KEY.Tab, { shift: true })])
    expect(marks.map((m) => [m.kind, m.label ?? null, m.t])).toEqual([
      ['type', null, 1000],
      ['key', 'Enter', 1500],
      ['type', null, 1700],
      ['key', 'F5', 4000],
      ['key', 'Esc', 6000],
      ['key', 'Shift+Tab', 8000]
    ])
  })

  it('the same key pressed again soon extends its mark (arrows), auto-repeat too', () => {
    const marks = buildInputMarks([
      ...press(1000, KEY.ArrowDown),
      ...press(1300, KEY.ArrowDown),
      ...press(1600, KEY.ArrowDown),
      // held: auto-repeat keydowns without keyups, then the keyup
      kd(5000, KEY.ArrowDown),
      kd(5500, KEY.ArrowDown),
      kd(5533, KEY.ArrowDown),
      kd(5566, KEY.ArrowDown),
      ku(5600, KEY.ArrowDown)
    ])
    expect(marks).toEqual([
      { t: 1000, end: 1660, kind: 'key', label: '↓' },
      { t: 5000, end: 5600, kind: 'key', label: '↓' }
    ])
  })

  it('a combination held on to (Alt+Tab, Tab pressed again and again) is one mark until Alt is let go', () => {
    const marks = buildInputMarks([
      kd(1000, KEY.Alt, { alt: true }),
      ...press(1100, KEY.Tab, { alt: true }),
      ...press(2600, KEY.Tab, { alt: true }),
      ...press(4200, KEY.Tab, { alt: true }),
      ku(4900, KEY.Alt),
      // released and pressed again much later: a new mark
      ...combo(9000, KEY.Tab, { alt: true })
    ])
    expect(marks).toEqual([
      { t: 1100, end: 4900, kind: 'key', label: 'Alt+Tab' },
      { t: 9000, end: 9100, kind: 'key', label: 'Alt+Tab' }
    ])
  })

  it('a modifier released long after the combination does not stretch it', () => {
    const marks = buildInputMarks([kd(1000, KEY.Ctrl, { ctrl: true }), ...press(1100, KEY.C, { ctrl: true }), ku(9000, KEY.Ctrl)])
    expect(marks).toEqual([{ t: 1100, end: 1160, kind: 'key', label: 'Ctrl+C' }])
  })

  it('different combinations in a row stay separate marks', () => {
    const marks = buildInputMarks([kd(900, KEY.Ctrl, { ctrl: true }), ...press(1000, KEY.C, { ctrl: true }), ...press(1300, KEY.V, { ctrl: true }), ku(1500, KEY.Ctrl)])
    expect(marks.map((m) => [m.label, m.t, m.end])).toEqual([
      ['Ctrl+C', 1000, 1060],
      ['Ctrl+V', 1300, 1500]
    ])
  })

  it('AltGr (Ctrl+Alt with the right Alt down) types, it is no shortcut', () => {
    const marks = buildInputMarks([
      kd(1000, KEY.Ctrl, { ctrl: true }),
      kd(1001, KEY.AltRight, { ctrl: true, alt: true }),
      ...press(1100, KEY.Q, { ctrl: true, alt: true }),
      ku(1300, KEY.AltRight),
      ku(1301, KEY.Ctrl),
      ...press(1500, KEY.A)
    ])
    expect(marks).toEqual([{ t: 1100, end: 1560, kind: 'type' }])
  })

  it('keycode 0 (text injected with KEYEVENTF_UNICODE, e.g. a scenario replay) is typing', () => {
    const events: RawHookEvent[] = []
    for (let i = 0; i < 10; i++) events.push(kd(2000 + i * 40, 0), ku(2010 + i * 40, 0))
    expect(buildInputMarks(events)).toEqual([{ t: 2000, end: 2370, kind: 'type' }])
  })

  it('bare modifiers, lock keys and unknown keys without a modifier leave no mark', () => {
    const marks = buildInputMarks([
      ...press(1000, KEY.Shift, { shift: true }),
      ...press(1500, KEY.Ctrl, { ctrl: true }),
      ...press(2000, KEY.Meta, { meta: true }),
      ...press(2500, KEY.CapsLock),
      ...press(3000, 0xe020) // a media key
    ])
    expect(marks).toEqual([])
  })

  it('a mouse press ends a typing burst and the other way round', () => {
    const marks = buildInputMarks([...press(1000, KEY.A), down(1200), up(1250), ...press(1400, KEY.S)])
    expect(marks.map((m) => [m.kind, m.t])).toEqual([
      ['type', 1000],
      ['click', 1200],
      ['type', 1400]
    ])
  })
})

describe('buildInputMarks: time window', () => {
  it('drops what happened before the start and from the cutoff on (the Stop click / shortcut)', () => {
    const marks = buildInputMarks(
      [down(-500), up(-450), ...press(-200, KEY.A), ...press(100, KEY.S), down(4000), up(4050), ...combo(5000, KEY.R, { ctrl: true, alt: true })],
      { cutoffMs: 4980 }
    )
    expect(marks.map((m) => [m.kind, m.t])).toEqual([
      ['type', 100],
      ['click', 4000]
    ])
  })

  it('returns marks sorted by start even when a press closes after a later one', () => {
    // the left button is held through a right click
    const marks = buildInputMarks([down(1000), down(1200, 100, 100, 'right'), up(1250, 100, 100, 'right'), up(2000, 400, 400)])
    expect(marks.map((m) => m.kind)).toEqual(['drag', 'rightClick'])
  })
})

describe('marksFromClicks', () => {
  const click = (t: number, x: number, y: number, button: MouseButton = 'left'): ClickEvent => ({ t, x, y, button })

  it('tells clicks, double clicks and right / middle clicks apart from mousedown clicks alone', () => {
    const marks = marksFromClicks([
      click(1000, 0.5, 0.5),
      click(1200, 0.501, 0.5),
      click(3000, 0.2, 0.2),
      click(3200, 0.6, 0.6),
      click(5000, 0.3, 0.3, 'right'),
      click(6000, 0.3, 0.3, 'middle')
    ])
    expect(marks.map((m) => [m.kind, m.t])).toEqual([
      ['doubleClick', 1000],
      ['click', 3000],
      ['click', 3200],
      ['rightClick', 5000],
      ['middleClick', 6000]
    ])
  })
})

describe('clipMarksToSegments', () => {
  const segments = [
    { start: 0, end: 2000 },
    { start: 3000, end: 6000 }
  ]
  const mark = (t: number, end: number, kind: InputMark['kind'] = 'type'): InputMark => ({ t, end, kind })

  it('keeps instants inside kept segments only', () => {
    expect(clipMarksToSegments([mark(500, 500, 'click'), mark(2500, 2500, 'click'), mark(6000, 6000, 'click')], segments)).toEqual([
      mark(500, 500, 'click')
    ])
  })

  it('clips spans to their first and last kept moment and drops spans that were cut entirely', () => {
    expect(clipMarksToSegments([mark(1500, 3500), mark(2200, 2800), mark(2500, 4000), mark(5000, 7000), mark(100, 900)], segments)).toEqual([
      mark(1500, 3500),
      mark(3000, 4000),
      mark(5000, 6000),
      mark(100, 900)
    ])
  })

  it('keeps the label of a key mark', () => {
    expect(clipMarksToSegments([{ t: 2500, end: 3200, kind: 'key', label: 'Alt+Tab' }], segments)).toEqual([
      { t: 3000, end: 3200, kind: 'key', label: 'Alt+Tab' }
    ])
  })
})
