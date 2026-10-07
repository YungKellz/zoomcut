import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAUSE_MS,
  DURATION_MAX_MS,
  DURATION_PRESETS_MS,
  PAUSE_MAX_MS,
  PAUSE_PRESETS_MS,
  SCENARIO_VERSION,
  TYPE_SPEED_MS,
  actionDurationMs,
  actionPauseMs,
  compileScenario,
  defaultDurationMs,
  deleteAction,
  describeAction,
  graphemes,
  groupRawEvents,
  migrateScenario,
  minDurationMs,
  moveActionStart,
  scenarioEnd,
  scenarioSchedule,
  setActionDuration,
  setActionPause,
  setActionText,
  setAllPauses,
  typeDurationForSpeed,
  validateScenario,
  withDefaultTiming,
  type RawDownEvent,
  type RawInputEvent,
  type RawKeyEvent,
  type RawUpEvent,
  type RawWheelEvent,
  type ReplayStep
} from './scenario'
import { SCENARIO_MAX_MS } from './defaults'
import type {
  Scenario,
  ScenarioAction,
  ScenarioClickAction,
  ScenarioDragAction,
  ScenarioKeyAction,
  ScenarioModifiers,
  ScenarioPoint,
  ScenarioScrollAction,
  ScenarioTypeAction
} from './types'

// ---- fixtures ----

const NO_MODS: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }
function withMods(p: Partial<ScenarioModifiers>): ScenarioModifiers {
  return { ...NO_MODS, ...p }
}
function downEvt(id: string, t: number, x: number, y: number, extra: Partial<RawDownEvent> = {}): RawDownEvent {
  return { id, t, type: 'down', button: 'left', x, y, mods: NO_MODS, shot: null, ...extra }
}
function upEvt(t: number, x: number, y: number, extra: Partial<RawUpEvent> = {}): RawUpEvent {
  return { t, type: 'up', button: 'left', x, y, mods: NO_MODS, ...extra }
}
function moveEvt(t: number, x: number, y: number): RawInputEvent {
  return { t, type: 'move', x, y }
}
function wheelEvt(id: string, t: number, rotation: number, extra: Partial<RawWheelEvent> = {}): RawWheelEvent {
  return { id, t, type: 'wheel', rotation, horizontal: false, x: 0, y: 0, mods: NO_MODS, ...extra }
}
function keyEvt(id: string, t: number, scan: number, vk: number, text: string | null, extra: Partial<RawKeyEvent> = {}): RawKeyEvent {
  return { id, t, type: 'key', scan, vk, extended: false, text, mods: NO_MODS, x: 0, y: 0, ...extra }
}

// Action builders. Defaults match a fresh capture's timing (1 s, then a 1.5 s pause) unless the
// kind has its own default; `at` is deliberately a value that matches nothing, because nothing
// may read it.
function baseFields(id: string, durationMs: number, pauseMs = 1500) {
  return { id, at: 123_456, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, durationMs, pauseMs }
}
function click(id: string, extra: Partial<ScenarioClickAction> = {}): ScenarioClickAction {
  return { ...baseFields(id, 1000), kind: 'click', ...extra }
}
function clickOf(kind: ScenarioClickAction['kind'], id: string, extra: Partial<ScenarioClickAction> = {}): ScenarioClickAction {
  return { ...baseFields(id, 1000), ...extra, kind }
}
function drag(id: string, extra: Partial<ScenarioDragAction> = {}): ScenarioDragAction {
  return { ...baseFields(id, 1500), kind: 'drag', toX: 100, toY: 0, dragPath: [], ...extra }
}
function scroll(id: string, deltaY: number, extra: Partial<ScenarioScrollAction> = {}): ScenarioScrollAction {
  return { ...baseFields(id, 1000), kind: 'scroll', deltaY, deltaX: 0, ...extra }
}
function typed(id: string, text: string, extra: Partial<ScenarioTypeAction> = {}): ScenarioTypeAction {
  return { ...baseFields(id, 1000), kind: 'type', text, ...extra }
}
function key(id: string, extra: Partial<ScenarioKeyAction> = {}): ScenarioKeyAction {
  return { ...baseFields(id, 500), kind: 'key', key: 'Enter', vk: 13, scan: 28, extended: false, ...extra }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** pauseEnd of every action, to read where each next action starts */
function starts(actions: ScenarioAction[]): number[] {
  return scenarioSchedule(actions).map((s) => s.start)
}
function pauses(actions: ScenarioAction[]): number[] {
  return actions.map((a) => a.pauseMs)
}

describe('groupRawEvents', () => {
  it('turns a small down+up into a click', () => {
    const actions = groupRawEvents([downEvt('d1', 1000, 100, 100), upEvt(1050, 101, 100)])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ id: 'd1', kind: 'click', at: 1000, x: 100, y: 100 })
  })

  it('merges a second close click into a doubleClick (time+distance rule)', () => {
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100), upEvt(1050, 100, 100),
      downEvt('d2', 1200, 102, 101), upEvt(1230, 102, 101)
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ id: 'd1', kind: 'doubleClick', at: 1000, x: 100, y: 100 })
  })

  it('merges into a doubleClick when the hook reports clicks === 2, even well beyond the 400ms window', () => {
    // same spot, but 2s apart - our own time rule alone would not merge this
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100), upEvt(1050, 100, 100),
      downEvt('d2', 3000, 102, 101, { clicks: 2 }), upEvt(3030, 102, 101, { clicks: 2 })
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('doubleClick')
  })

  it('never merges two clicks on different elements, even when the hook reports clicks === 2', () => {
    // regression: a real hook was observed reporting clicks === 2 for a click on a
    // completely different, far-away element - distance must always gate the merge
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100), upEvt(1050, 100, 100),
      downEvt('d2', 1200, 900, 900, { clicks: 2 }), upEvt(1230, 900, 900, { clicks: 2 })
    ])
    expect(actions).toHaveLength(2)
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click'])
  })

  it('does not merge two clicks that are far apart with no clicks===2 signal', () => {
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100), upEvt(1050, 100, 100),
      downEvt('d2', 3000, 900, 900), upEvt(3030, 900, 900)
    ])
    expect(actions).toHaveLength(2)
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click'])
  })

  it('turns a down+move+up past the drag threshold into a drag with a dragPath', () => {
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100),
      moveEvt(1020, 150, 100),
      moveEvt(1040, 200, 100),
      upEvt(1060, 250, 100)
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('drag')
    const drag = actions[0] as ScenarioDragAction
    expect(drag.toX).toBe(250)
    expect(drag.toY).toBe(100)
    expect(drag.dragPath).toEqual([
      { x: 150, y: 100, dt: 20 },
      { x: 200, y: 100, dt: 20 }
    ])
  })

  it('sorts the output by `at`, even when a shorter gesture closes before an earlier-started one', () => {
    // left button held from t=0 to t=2000 (a drag, at=0); a right click happens entirely
    // while it is still held, so it is pushed to the output first even though it started later
    const actions = groupRawEvents([
      downEvt('left', 0, 100, 100),
      moveEvt(500, 400, 100),
      downEvt('right', 300, 500, 500, { button: 'right' }),
      upEvt(350, 500, 500, { button: 'right' }),
      upEvt(2000, 400, 100)
    ])
    expect(actions.map((a) => a.kind)).toEqual(['drag', 'rightClick'])
    expect(actions.map((a) => a.at)).toEqual([0, 300])
  })

  it('does not leak a closed gesture\'s own moves into the next action as zero-dt path points', () => {
    const actions = groupRawEvents([
      downEvt('d1', 0, 100, 100),
      moveEvt(50, 150, 100),
      moveEvt(100, 200, 100),
      upEvt(150, 200, 100), // drag, dragPath has the two moves above
      downEvt('d2', 200, 200, 100), // no new moves before this - path must be empty
      upEvt(250, 200, 100)
    ])
    expect(actions.map((a) => a.kind)).toEqual(['drag', 'click'])
    expect(actions[1].path).toEqual([])
  })

  it('starts the next leading path after the previous click really ended (its button-up), not after a fixed guess', () => {
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100),
      moveEvt(1020, 101, 100), // jitter while the button is still down: part of the click
      upEvt(1050, 101, 100),
      moveEvt(1200, 150, 120),
      moveEvt(1300, 200, 140),
      downEvt('d2', 1500, 200, 140),
      upEvt(1530, 200, 140)
    ])
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click'])
    expect(actions[1].path).toEqual([
      { x: 150, y: 120, dt: 150 }, // 1200 - 1050
      { x: 200, y: 140, dt: 100 }
    ])
  })

  it('starts the leading path of the action after typed text from the last keystroke', () => {
    const actions = groupRawEvents([
      keyEvt('k1', 1000, 35, 72, 'h'),
      moveEvt(1050, 10, 10), // the mouse moved while typing: not the click's approach
      keyEvt('k2', 1100, 23, 73, 'i'),
      moveEvt(1300, 50, 60),
      downEvt('d1', 1500, 50, 60),
      upEvt(1530, 50, 60)
    ])
    expect(actions.map((a) => a.kind)).toEqual(['type', 'click'])
    expect(actions[1].path).toEqual([{ x: 50, y: 60, dt: 200 }]) // 1300 - 1100
  })

  it('produces rightClick / middleClick for the other buttons', () => {
    const actions = groupRawEvents([
      downEvt('r1', 1000, 10, 10, { button: 'right' }), upEvt(1030, 10, 10, { button: 'right' }),
      downEvt('m1', 2000, 20, 20, { button: 'middle' }), upEvt(2030, 20, 20, { button: 'middle' })
    ])
    expect(actions.map((a) => a.kind)).toEqual(['rightClick', 'middleClick'])
  })

  it('merges wheel events closer than 400ms into one scroll and starts a new one after a gap', () => {
    const actions = groupRawEvents([
      wheelEvt('w1', 1000, 1),
      wheelEvt('w2', 1100, 1),
      wheelEvt('w3', 1900, 1)
    ])
    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({ id: 'w1', kind: 'scroll', at: 1000, deltaY: 2, deltaX: 0 })
    expect(actions[1]).toMatchObject({ id: 'w3', kind: 'scroll', at: 1900, deltaY: 1 })
  })

  it('sums horizontal and vertical wheel notches separately', () => {
    const actions = groupRawEvents([
      wheelEvt('w1', 1000, 1, { horizontal: true }),
      wheelEvt('w2', 1100, -1)
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ deltaX: 1, deltaY: -1 })
  })

  it('collapses typed keys into one `type` action and folds Backspace into the buffer', () => {
    const actions = groupRawEvents([
      keyEvt('k1', 1000, 35, 72, 'h'),
      keyEvt('k2', 1050, 23, 73, 'i'),
      keyEvt('k3', 1100, 14, 8, null), // Backspace: removes the trailing "i"
      keyEvt('k4', 1150, 23, 73, 'i'),
      keyEvt('k5', 1200, 2, 49, '!')
    ])
    expect(actions).toHaveLength(1)
    // the 200ms the keystrokes really took does not matter: 3 characters at the default 80ms each
    expect(actions[0]).toMatchObject({ id: 'k1', kind: 'type', at: 1000, text: 'hi!', durationMs: 240 })
  })

  it('treats Backspace on an empty buffer as its own key action', () => {
    const actions = groupRawEvents([keyEvt('k1', 1000, 14, 8, null)])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ id: 'k1', kind: 'key', key: 'Backspace' })
  })

  it('treats a Ctrl/Alt/Win chord as a key action, never as typed text', () => {
    const withoutText = groupRawEvents([keyEvt('k1', 1000, 31, 83, null, { mods: withMods({ ctrl: true }) })])
    expect(withoutText[0]).toMatchObject({ kind: 'key', key: 'Ctrl+S' })

    // even if keytext.ps1 somehow resolved text while Ctrl was held, it must not become `type`
    const withText = groupRawEvents([keyEvt('k1', 1000, 31, 83, 's', { mods: withMods({ ctrl: true }) })])
    expect(withText[0].kind).toBe('key')
  })

  it('drops pure modifier presses', () => {
    const ctrl = keyEvt('m1', 1000, 29, 17, null, { mods: withMods({ ctrl: true }) })
    const shift = keyEvt('m2', 1100, 42, 16, null, { mods: withMods({ shift: true }) })
    expect(groupRawEvents([ctrl, shift])).toHaveLength(0)
  })

  it('ignores raw events at or after the stop cutoff', () => {
    const actions = groupRawEvents(
      [
        downEvt('d1', 1000, 10, 10), upEvt(1050, 10, 10),
        downEvt('d2', 5000, 20, 20), upEvt(5050, 20, 20)
      ],
      { cutoffMs: 2000 }
    )
    expect(actions).toHaveLength(1)
    expect(actions[0].id).toBe('d1')
  })

  it('silently drops a gesture whose down is before the cutoff but whose up is not', () => {
    const actions = groupRawEvents(
      [
        downEvt('d1', 1000, 10, 10), upEvt(1050, 10, 10),
        downEvt('d2', 1900, 20, 20), upEvt(2500, 20, 20)
      ],
      { cutoffMs: 2000 }
    )
    expect(actions).toHaveLength(1)
    expect(actions[0].id).toBe('d1')
  })

  it('returns default-timed actions whatever the recorded durations were', () => {
    const actions = groupRawEvents([
      downEvt('c', 1000, 10, 10), upEvt(1050, 10, 10),
      downEvt('r', 2000, 20, 20, { button: 'right' }), upEvt(2030, 20, 20, { button: 'right' }),
      downEvt('d', 3000, 30, 30), moveEvt(3500, 130, 30), upEvt(8000, 230, 30), // a drag held for 5 s
      wheelEvt('w1', 10_000, 1), wheelEvt('w2', 10_100, 1),
      keyEvt('t1', 12_000, 35, 72, 'h'), keyEvt('t2', 13_000, 23, 73, 'i'), keyEvt('t3', 14_000, 23, 73, 'j'), // typed for 2 s
      keyEvt('enter', 20_000, 28, 13, null)
    ])
    expect(actions.map((a) => a.kind)).toEqual(['click', 'rightClick', 'drag', 'scroll', 'type', 'key'])
    expect(actions.map((a) => a.durationMs)).toEqual([1000, 1000, 1500, 1000, 240, 500])
    expect(actions.map((a) => a.pauseMs)).toEqual(Array(6).fill(DEFAULT_PAUSE_MS))
    for (const a of actions) expect(a.durationMs).toBe(defaultDurationMs(a))
  })

  it('times a click that became a doubleClick like a doubleClick', () => {
    const actions = groupRawEvents([
      downEvt('d1', 1000, 100, 100), upEvt(1050, 100, 100),
      downEvt('d2', 1200, 100, 100), upEvt(1230, 100, 100)
    ])
    expect(actions[0].kind).toBe('doubleClick')
    expect(actions[0].durationMs).toBe(defaultDurationMs(actions[0]))
    expect(actions[0].pauseMs).toBe(DEFAULT_PAUSE_MS)
  })
})

// ---- the timing model ----

describe('presets and constants', () => {
  it('has the documented presets and typing speeds', () => {
    expect(PAUSE_PRESETS_MS).toEqual([1000, 1500, 2000])
    expect(DURATION_PRESETS_MS).toEqual([1000, 1500, 2000])
    expect(TYPE_SPEED_MS).toEqual({ fast: 40, normal: 80, slow: 150 })
    expect(DEFAULT_PAUSE_MS).toBe(1500)
    expect(SCENARIO_VERSION).toBe(2)
    expect(PAUSE_PRESETS_MS).toContain(DEFAULT_PAUSE_MS)
  })
})

describe('defaultDurationMs', () => {
  it('has the documented default per kind', () => {
    expect(defaultDurationMs(click('a'))).toBe(1000)
    expect(defaultDurationMs(clickOf('doubleClick', 'a'))).toBe(1000)
    expect(defaultDurationMs(clickOf('rightClick', 'a'))).toBe(1000)
    expect(defaultDurationMs(clickOf('middleClick', 'a'))).toBe(1000)
    expect(defaultDurationMs(drag('a'))).toBe(1500)
    expect(defaultDurationMs(scroll('a', 3))).toBe(1000)
    expect(defaultDurationMs(key('a'))).toBe(500)
  })

  it('types at 80ms per character, but never below the 200ms floor', () => {
    expect(defaultDurationMs(typed('a', 'hello'))).toBe(400)
    expect(defaultDurationMs(typed('a', 'x'.repeat(10)))).toBe(800)
    expect(defaultDurationMs(typed('a', 'h'))).toBe(200) // 80 would be under the floor
  })

  it('counts typed characters as graphemes, not UTF-16 units', () => {
    // two thumbs-up with a skin-tone modifier: 2 graphemes, 4 code points, 8 UTF-16 units
    const two = String.fromCodePoint(0x1f44d, 0x1f3fd, 0x1f44d, 0x1f3fd)
    expect(graphemes(two)).toHaveLength(2)
    expect(defaultDurationMs(typed('a', two))).toBe(200) // 2 x 80 is under the floor
    expect(defaultDurationMs(typed('a', two.repeat(5)))).toBe(800) // 10 graphemes
  })

  it('stretches a scroll with many notches so they stay 40ms apart', () => {
    expect(defaultDurationMs(scroll('a', 30))).toBe(minDurationMs(scroll('a', 30)))
    expect(defaultDurationMs(scroll('a', 30))).toBeGreaterThan(1000)
  })

  it('is capped at DURATION_MAX_MS', () => {
    expect(defaultDurationMs(typed('a', 'x'.repeat(1000)))).toBe(DURATION_MAX_MS)
  })
})

describe('minDurationMs', () => {
  it('has the documented fixed floors', () => {
    expect(minDurationMs(click('a'))).toBe(200)
    expect(minDurationMs(clickOf('rightClick', 'a'))).toBe(200)
    expect(minDurationMs(clickOf('middleClick', 'a'))).toBe(200)
    expect(minDurationMs(clickOf('doubleClick', 'a'))).toBe(300)
    expect(minDurationMs(drag('a'))).toBe(500)
    expect(minDurationMs(key('a'))).toBe(150)
  })

  it('floors typed text at 25ms per character and at least 200ms', () => {
    expect(minDurationMs(typed('a', 'hi'))).toBe(200)
    expect(minDurationMs(typed('a', 'x'.repeat(20)))).toBe(500)
    expect(minDurationMs(typed('a', 'x'.repeat(100)))).toBe(2500)
  })

  it('floors a scroll so its notches stay 40ms apart: ceil(((n - 1) * 40 + 20) / 0.6), at least 300ms', () => {
    expect(minDurationMs(scroll('a', 0))).toBe(300)
    expect(minDurationMs(scroll('a', 1))).toBe(300)
    expect(minDurationMs(scroll('a', 5))).toBe(300) // (4 * 40 + 20) / 0.6 = 300
    expect(minDurationMs(scroll('a', 6))).toBe(367) // 220 / 0.6 = 366.67
    expect(minDurationMs(scroll('a', 11))).toBe(700) // 420 / 0.6
    expect(minDurationMs(scroll('a', 21))).toBe(1367) // 820 / 0.6 = 1366.67
  })

  it('counts both axes, direction and partial notches', () => {
    expect(minDurationMs(scroll('a', 3, { deltaX: -3 }))).toBe(367) // 6 notches
    expect(minDurationMs(scroll('a', -6))).toBe(367)
    expect(minDurationMs(scroll('a', 0.2, { deltaX: 4.5 }))).toBe(367) // ceil(0.2) + ceil(4.5) = 1 + 5 = 6 notches
  })

  it('lets the floor win over DURATION_MAX_MS for an enormous scroll (the notches must stay apart)', () => {
    const huge = scroll('a', 1000, { durationMs: 1000 })
    expect(minDurationMs(huge)).toBe(66_634) // ceil(39980 / 0.6)
    expect(actionDurationMs(huge)).toBe(66_634)
  })

  it('treats a non-finite delta as no notches instead of poisoning the duration', () => {
    const broken = scroll('a', Number.NaN, { deltaX: Number.POSITIVE_INFINITY })
    expect(minDurationMs(broken)).toBe(300)
    expect(actionDurationMs(broken)).toBe(1000)
  })
})

describe('actionDurationMs / actionPauseMs: stored garbage never gets through', () => {
  const asNumber = (v: unknown): number => v as number

  it('falls back to the default for a missing, non-finite or non-numeric durationMs', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, '900', {}]) {
      expect(actionDurationMs(click('a', { durationMs: asNumber(bad) }))).toBe(1000)
      expect(actionDurationMs(drag('a', { durationMs: asNumber(bad) }))).toBe(1500)
      expect(actionDurationMs(typed('a', 'hello', { durationMs: asNumber(bad) }))).toBe(400)
    }
  })

  it('rounds to whole ms', () => {
    expect(actionDurationMs(click('a', { durationMs: 1000.4 }))).toBe(1000)
    expect(actionDurationMs(click('a', { durationMs: 1000.5 }))).toBe(1001)
  })

  it('lifts a value under the floor to the floor of its kind', () => {
    expect(actionDurationMs(click('a', { durationMs: 100 }))).toBe(200)
    expect(actionDurationMs(click('a', { durationMs: -50 }))).toBe(200)
    expect(actionDurationMs(clickOf('doubleClick', 'a', { durationMs: 250 }))).toBe(300)
    expect(actionDurationMs(drag('a', { durationMs: 100 }))).toBe(500)
    expect(actionDurationMs(key('a', { durationMs: 0 }))).toBe(150)
    expect(actionDurationMs(typed('a', 'hello', { durationMs: 100 }))).toBe(200)
    expect(actionDurationMs(typed('a', 'x'.repeat(40), { durationMs: 100 }))).toBe(1000)
    expect(actionDurationMs(scroll('a', 11, { durationMs: 100 }))).toBe(700)
  })

  it('caps a huge value at DURATION_MAX_MS', () => {
    expect(actionDurationMs(click('a', { durationMs: 1e9 }))).toBe(DURATION_MAX_MS)
    expect(actionDurationMs(click('a', { durationMs: DURATION_MAX_MS + 1 }))).toBe(DURATION_MAX_MS)
    expect(actionDurationMs(click('a', { durationMs: DURATION_MAX_MS }))).toBe(DURATION_MAX_MS)
  })

  it('keeps a sane pause, rounds it and falls back to 1.5s for garbage', () => {
    expect(actionPauseMs(click('a', { pauseMs: 0 }))).toBe(0)
    expect(actionPauseMs(click('a', { pauseMs: 2000 }))).toBe(2000)
    expect(actionPauseMs(click('a', { pauseMs: 1234.6 }))).toBe(1235)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '500']) {
      expect(actionPauseMs(click('a', { pauseMs: asNumber(bad) }))).toBe(DEFAULT_PAUSE_MS)
    }
  })

  it('clamps a pause into [0, PAUSE_MAX_MS] and never returns -0', () => {
    expect(actionPauseMs(click('a', { pauseMs: -500 }))).toBe(0)
    expect(Object.is(actionPauseMs(click('a', { pauseMs: -0.2 })), 0)).toBe(true)
    expect(actionPauseMs(click('a', { pauseMs: 1e12 }))).toBe(PAUSE_MAX_MS)
  })

  it('schedules and ends with the clamped values, so garbage cannot desync replay and display', () => {
    const garbage = [
      click('a', { durationMs: Number.NaN, pauseMs: -10 }),
      drag('b', { durationMs: 10, pauseMs: 1e12 })
    ]
    expect(scenarioSchedule(garbage)).toEqual([
      { start: 0, effectAt: 910, end: 1000, pauseEnd: 1000 },
      { start: 1000, effectAt: 1200, end: 1500, pauseEnd: 61_500 }
    ])
    expect(scenarioEnd(garbage)).toBe(61_500)
    expect(compileScenario(garbage, { startPos: { x: 0, y: 0 } })).toEqual(
      compileScenario(
        [click('a', { durationMs: 1000, pauseMs: 0 }), drag('b', { durationMs: 500, pauseMs: PAUSE_MAX_MS })],
        { startPos: { x: 0, y: 0 } }
      )
    )
  })
})

describe('typeDurationForSpeed', () => {
  it('is the grapheme count times the speed preset', () => {
    const text = 'hello world' // 11 characters
    expect(typeDurationForSpeed(text, 'fast')).toBe(440)
    expect(typeDurationForSpeed(text, 'normal')).toBe(880)
    expect(typeDurationForSpeed(text, 'slow')).toBe(1650)
    expect(typeDurationForSpeed(text, 'normal')).toBe(defaultDurationMs(typed('a', text)))
  })

  it('is clamped like a type action: 200ms floor, DURATION_MAX_MS cap', () => {
    expect(typeDurationForSpeed('h', 'fast')).toBe(200)
    expect(typeDurationForSpeed('hi', 'slow')).toBe(300)
    expect(typeDurationForSpeed('x'.repeat(1000), 'slow')).toBe(DURATION_MAX_MS)
  })

  it('counts graphemes', () => {
    const emoji = String.fromCodePoint(0x1f44d, 0x1f3fd) // one grapheme
    expect(typeDurationForSpeed(emoji.repeat(10), 'slow')).toBe(1500)
  })
})

describe('scenarioSchedule / scenarioEnd', () => {
  it('is empty for no actions, and the end is 0', () => {
    expect(scenarioSchedule([])).toEqual([])
    expect(scenarioEnd([])).toBe(0)
  })

  it('runs the actions one after the other: start, end, then the pause, then the next start', () => {
    const actions = [
      click('a', { durationMs: 1000, pauseMs: 1500 }),
      drag('b', { durationMs: 1500, pauseMs: 500 }),
      key('c', { durationMs: 500, pauseMs: 0 })
    ]
    expect(scenarioSchedule(actions)).toEqual([
      { start: 0, effectAt: 910, end: 1000, pauseEnd: 2500 },
      { start: 2500, effectAt: 3100, end: 4000, pauseEnd: 4500 },
      { start: 4500, effectAt: 4940, end: 5000, pauseEnd: 5000 }
    ])
    expect(scenarioEnd(actions)).toBe(5000)
    expect(starts(actions)).toEqual([0, 2500, 4500])
  })

  it('has the last pause in the end, so a lone default click ends at 2.5s', () => {
    expect(scenarioEnd([click('a')])).toBe(2500)
  })

  it('puts the effect where each kind visibly happens', () => {
    const effect = (a: ScenarioAction): number => scenarioSchedule([a])[0].effectAt
    expect(effect(click('a', { durationMs: 1000 }))).toBe(910) // button down 90ms before the end
    expect(effect(clickOf('rightClick', 'a', { durationMs: 1000 }))).toBe(910)
    expect(effect(clickOf('middleClick', 'a', { durationMs: 1000 }))).toBe(910)
    expect(effect(clickOf('doubleClick', 'a', { durationMs: 1000 }))).toBe(820) // first press 180ms before the end
    expect(effect(drag('a', { durationMs: 1500 }))).toBe(600) // 40% of the duration
    expect(effect(drag('a', { durationMs: 1000 }))).toBe(400)
    expect(effect(scroll('a', 3, { durationMs: 1000 }))).toBe(400)
    expect(effect(scroll('a', 3, { durationMs: 333 }))).toBe(133) // 133.2 rounded
    expect(effect(typed('a', 'hello'))).toBe(0) // the first character
    expect(effect(key('a', { durationMs: 500 }))).toBe(440) // key down 60ms before the end
  })

  it('offsets every effect by the action start', () => {
    const schedule = scenarioSchedule([click('a'), typed('b', 'hi', { durationMs: 400 }), key('c')])
    expect(schedule.map((s) => s.effectAt - s.start)).toEqual([910, 0, 440])
    expect(schedule.map((s) => s.start)).toEqual([0, 2500, 4400])
  })

  it('never reads `at`: the recorded time has no say in the timeline', () => {
    const a = [click('a', { at: 0 }), click('b', { at: 0 }), click('c', { at: 0 })]
    const b = [click('a', { at: 999_999 }), click('b', { at: 5 }), click('c', { at: 70_000 })]
    expect(scenarioSchedule(a)).toEqual(scenarioSchedule(b))
    expect(scenarioEnd(a)).toBe(scenarioEnd(b))
  })
})

describe('validateScenario', () => {
  it('flags an empty scenario', () => {
    expect(validateScenario([])).toBe('empty')
  })

  it('accepts a scenario that ends exactly at SCENARIO_MAX_MS and rejects one past it', () => {
    const tenMinutes = Array.from({ length: 10 }, (_, i) => click(`a${i}`, { durationMs: 1000, pauseMs: 59_000 }))
    expect(scenarioEnd(tenMinutes)).toBe(SCENARIO_MAX_MS)
    expect(validateScenario(tenMinutes)).toBeNull()
    expect(validateScenario([...tenMinutes, click('one-more', { pauseMs: 0 })])).toBe('tooLong')
  })

  it('counts the final pause', () => {
    const lastPause = (pauseMs: number): ScenarioAction[] => [
      ...Array.from({ length: 9 }, (_, i) => click(`a${i}`, { durationMs: 1000, pauseMs: 59_000 })), // 540 s
      click('last', { durationMs: 1000, pauseMs })
    ]
    expect(validateScenario(lastPause(59_000))).toBeNull() // exactly 600 s
    expect(validateScenario(lastPause(60_000))).toBe('tooLong') // the last pause alone tips it over
    expect(validateScenario([click('a')])).toBeNull()
  })

  it('judges a pause only up to PAUSE_MAX_MS, like replay does', () => {
    expect(validateScenario([click('a', { durationMs: 1000, pauseMs: SCENARIO_MAX_MS })])).toBeNull() // 61 s in effect
  })
})

describe('withDefaultTiming', () => {
  it('gives every action its default duration and the default pause, replacing what was there', () => {
    const input = [
      click('a', { durationMs: 77, pauseMs: 5 }),
      drag('b', { durationMs: 9999, pauseMs: 0 }),
      typed('c', 'hello', { durationMs: 1, pauseMs: 99_999 }),
      scroll('d', 21, { durationMs: 50 })
    ]
    const out = withDefaultTiming(input)
    expect(out.map((a) => a.durationMs)).toEqual([1000, 1500, 400, 1367])
    expect(out.map((a) => a.pauseMs)).toEqual([1500, 1500, 1500, 1500])
    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never mutates its input', () => {
    const input = deepFreeze([click('a', { durationMs: 77 })])
    expect(() => withDefaultTiming(input)).not.toThrow()
    expect(input[0].durationMs).toBe(77)
  })
})

describe('migrateScenario', () => {
  function v1Scenario(): Record<string, unknown> {
    return {
      version: 1,
      id: 'old',
      name: 'Old one',
      createdAt: 1_700_000_000_000,
      displayId: 7,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1.5,
      startPoint: { x: 5, y: 6 },
      durationMs: 31_000,
      dir: 'C:/scenarios/old',
      actions: [
        { id: 'c', kind: 'click', at: 30_000, x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null },
        { id: 'd', kind: 'drag', at: 31_000, x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null, toX: 9, toY: 9, dragPath: [], durationMs: 300 },
        { id: 't', kind: 'type', at: 33_000, x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null, text: 'abc', durationMs: 90 },
        { id: 's', kind: 'scroll', at: 35_000, x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null, deltaY: 2, deltaX: 0, durationMs: 40 }
      ]
    }
  }

  it('moves a version 1 scenario to version 2 with the default timing, not a conversion of the old times', () => {
    const migrated = migrateScenario(v1Scenario())
    expect(migrated.version).toBe(2)
    expect(migrated.actions.map((a) => a.durationMs)).toEqual([1000, 1500, 240, 1000])
    expect(migrated.actions.map((a) => a.pauseMs)).toEqual([1500, 1500, 1500, 1500])
    // the recorded time stays, as information
    expect(migrated.actions.map((a) => a.at)).toEqual([30_000, 31_000, 33_000, 35_000])
  })

  it('treats a file without a version like version 1', () => {
    const raw = v1Scenario()
    delete raw['version']
    const migrated = migrateScenario(raw)
    expect(migrated.version).toBe(2)
    expect(migrated.actions[1].durationMs).toBe(1500)
    expect(migrated.actions[0].pauseMs).toBe(DEFAULT_PAUSE_MS)
  })

  it('copies every other field as is', () => {
    const raw = v1Scenario()
    const migrated = migrateScenario(raw)
    const { actions: _rawActions, version: _rawVersion, ...rawRest } = raw
    const { actions: _actions, version: _version, ...rest } = migrated
    expect(rest).toEqual(rawRest)
    // and the actions keep everything but the timing
    const { durationMs: _d, pauseMs: _p, ...first } = migrated.actions[0]
    expect(first).toEqual((raw['actions'] as unknown[])[0])
  })

  it('keeps usable timing of a version 2 scenario and replaces only what is missing or not a finite number', () => {
    const scenario: Scenario = {
      version: 2,
      id: 's',
      name: 'n',
      createdAt: 1,
      displayId: 1,
      displayBounds: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 1,
      durationMs: 5,
      dir: 'x',
      actions: [click('a', { durationMs: 2000, pauseMs: 500 }), drag('b'), typed('c', 'hello'), key('d')]
    }
    const raw = JSON.parse(JSON.stringify(scenario)) as { actions: Array<Record<string, unknown>> }
    delete raw.actions[1]['durationMs']
    raw.actions[1]['pauseMs'] = 'soon'
    raw.actions[2]['durationMs'] = null // what NaN becomes in JSON
    raw.actions[3]['pauseMs'] = null
    raw.actions[3]['durationMs'] = 123_456 // finite: kept (the accessors clamp it), not rewritten

    const migrated = migrateScenario(raw)
    expect(migrated.version).toBe(2)
    expect(migrated.actions.map((a) => a.durationMs)).toEqual([2000, 1500, 400, 123_456])
    expect(migrated.actions.map((a) => a.pauseMs)).toEqual([500, 1500, 1500, 1500])
    expect(actionDurationMs(migrated.actions[3])).toBe(DURATION_MAX_MS)
  })

  it('leaves a healthy version 2 scenario equal to itself, also through a JSON round trip', () => {
    const scenario: Scenario = {
      version: 2,
      id: 's',
      name: 'n',
      createdAt: 1,
      displayId: 1,
      displayBounds: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 1,
      startPoint: { x: 3, y: 4 },
      durationMs: 5,
      dir: 'x',
      actions: [click('a', { durationMs: 2000, pauseMs: 0 }), typed('b', 'hi', { durationMs: 400 })]
    }
    expect(migrateScenario(scenario)).toEqual(scenario)
    expect(migrateScenario(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario)
  })

  it('never mutates its input and returns copies', () => {
    const raw = deepFreeze(v1Scenario())
    const migrated = migrateScenario(raw)
    expect(migrated).not.toBe(raw)
    expect(migrated.actions).not.toBe(raw['actions'])
    expect(raw['version']).toBe(1)
    expect(raw['actions']).toEqual(v1Scenario()['actions'])

    const v2 = deepFreeze({ ...v1Scenario(), version: 2 })
    expect(() => migrateScenario(v2)).not.toThrow()
  })

  it('throws "Not a scenario" for anything without an actions array', () => {
    for (const garbage of [null, undefined, 42, 'scenario', true, [], {}, { actions: 'nope' }, { actions: {} }, { version: 2 }]) {
      expect(() => migrateScenario(garbage)).toThrow('Not a scenario')
    }
  })

  it('accepts a scenario without actions as an empty one', () => {
    expect(migrateScenario({ version: 2, actions: [] }).actions).toEqual([])
  })
})

describe('editing: setActionDuration', () => {
  const base = (): ScenarioAction[] => [click('a'), drag('b'), scroll('c', 11)]

  it('sets one action and leaves the others (the very same objects) alone', () => {
    const actions = base()
    const out = setActionDuration(actions, 'b', 2500)
    expect(out).not.toBe(actions)
    expect(out[1].durationMs).toBe(2500)
    expect(out[0]).toBe(actions[0])
    expect(out[2]).toBe(actions[2])
    expect(actions[1].durationMs).toBe(1500) // the input was not touched
  })

  it('rounds and clamps into [minDurationMs, DURATION_MAX_MS]', () => {
    expect(setActionDuration(base(), 'a', 1234.4)[0].durationMs).toBe(1234)
    expect(setActionDuration(base(), 'a', 50)[0].durationMs).toBe(200)
    expect(setActionDuration(base(), 'b', 100)[1].durationMs).toBe(500)
    expect(setActionDuration(base(), 'c', 100)[2].durationMs).toBe(700) // 11 notches
    expect(setActionDuration(base(), 'a', 1e9)[0].durationMs).toBe(DURATION_MAX_MS)
  })

  it('returns the same array for an unknown id, a non-finite number or an unchanged value', () => {
    const actions = base()
    expect(setActionDuration(actions, 'nope', 2000)).toBe(actions)
    expect(setActionDuration(actions, 'a', Number.NaN)).toBe(actions)
    expect(setActionDuration(actions, 'a', Number.POSITIVE_INFINITY)).toBe(actions)
    expect(setActionDuration(actions, 'a', 1000)).toBe(actions) // already 1000
    expect(setActionDuration(actions, 'a', 1000.2)).toBe(actions) // rounds to the same
    expect(setActionDuration(actions, 'a', 1)).not.toBe(actions) // clamps to 200: a change
  })

  it('does not mutate frozen input', () => {
    const actions = deepFreeze(base())
    expect(() => setActionDuration(actions, 'a', 2000)).not.toThrow()
  })

  it('writes the effective value when the stored one was garbage, even if it clamps to the same', () => {
    const actions = [click('a', { durationMs: Number.NaN })]
    const out = setActionDuration(actions, 'a', 1000)
    expect(out).not.toBe(actions)
    expect(out[0].durationMs).toBe(1000)
  })
})

describe('editing: setActionPause / setAllPauses', () => {
  const base = (): ScenarioAction[] => [click('a'), click('b', { pauseMs: 500 }), click('c', { pauseMs: 0 })]

  it('sets one pause and leaves the others alone', () => {
    const actions = base()
    const out = setActionPause(actions, 'a', 2000)
    expect(pauses(out)).toEqual([2000, 500, 0])
    expect(out[1]).toBe(actions[1])
    expect(pauses(actions)).toEqual([1500, 500, 0])
  })

  it('rounds and clamps into [0, PAUSE_MAX_MS]', () => {
    expect(pauses(setActionPause(base(), 'a', 1234.5))).toEqual([1235, 500, 0])
    expect(pauses(setActionPause(base(), 'a', -300))).toEqual([0, 500, 0])
    expect(pauses(setActionPause(base(), 'a', 1e9))).toEqual([PAUSE_MAX_MS, 500, 0])
  })

  it('returns the same array for an unknown id, a non-finite number or an unchanged value', () => {
    const actions = base()
    expect(setActionPause(actions, 'nope', 1000)).toBe(actions)
    expect(setActionPause(actions, 'a', Number.NaN)).toBe(actions)
    expect(setActionPause(actions, 'a', 1500)).toBe(actions)
    expect(setActionPause(actions, 'c', -5)).toBe(actions) // clamps to the 0 it already has
  })

  it('setAllPauses applies one value to every action (the "all pauses" presets)', () => {
    const actions = base()
    const out = setAllPauses(actions, 1000)
    expect(pauses(out)).toEqual([1000, 1000, 1000])
    expect(pauses(actions)).toEqual([1500, 500, 0])
    expect(pauses(setAllPauses(actions, 99_999_999))).toEqual([PAUSE_MAX_MS, PAUSE_MAX_MS, PAUSE_MAX_MS])
    expect(pauses(setAllPauses(actions, -1))).toEqual([0, 0, 0])
    expect(pauses(setAllPauses(actions, 1500.4))).toEqual([1500, 1500, 1500])
  })

  it('setAllPauses keeps the objects that already have the value, and returns the same array when nothing changes', () => {
    const actions = [click('a', { pauseMs: 1000 }), click('b', { pauseMs: 500 })]
    const out = setAllPauses(actions, 1000)
    expect(out[0]).toBe(actions[0])
    expect(out[1]).not.toBe(actions[1])
    expect(setAllPauses(out, 1000)).toBe(out)
    expect(setAllPauses(actions, Number.NaN)).toBe(actions)
    const none: ScenarioAction[] = []
    expect(setAllPauses(none, 1000)).toBe(none)
  })
})

describe('editing: setActionText', () => {
  const controls = String.fromCharCode(0, 7, 8, 9, 10, 13, 27, 0x7f, 0x85, 0x9f)

  it('replaces the text and rescales the duration so the speed per character stays', () => {
    const actions = [typed('t', 'abcd', { durationMs: 320 })] // 80 ms per character
    const out = setActionText(actions, 't', 'abcdefgh')
    expect(out[0]).toMatchObject({ kind: 'type', text: 'abcdefgh', durationMs: 640 })
    expect(actions[0]).toMatchObject({ text: 'abcd', durationMs: 320 })
  })

  it('keeps a slow speed slow', () => {
    const actions = [typed('t', 'abcd', { durationMs: 600 })] // 150 ms per character
    expect((setActionText(actions, 't', 'abcdef')[0] as ScenarioTypeAction).durationMs).toBe(900)
    expect((setActionText(actions, 't', 'ab')[0] as ScenarioTypeAction).durationMs).toBe(300)
  })

  it('applies the usual limits to the rescaled duration', () => {
    const fast = [typed('t', 'abcdefghij', { durationMs: 400 })] // 40 ms per character
    expect((setActionText(fast, 't', 'a')[0] as ScenarioTypeAction).durationMs).toBe(200) // floor
    const slow = [typed('t', 'ab', { durationMs: 20_000 })]
    expect((setActionText(slow, 't', 'abcdef')[0] as ScenarioTypeAction).durationMs).toBe(DURATION_MAX_MS) // cap
  })

  it('rescales from the effective duration when the stored one is garbage', () => {
    const actions = [typed('t', 'abcd', { durationMs: Number.NaN })] // effective: 4 x 80
    expect((setActionText(actions, 't', 'abcdefgh')[0] as ScenarioTypeAction).durationMs).toBe(640)
  })

  it('counts graphemes, so an emoji is one character', () => {
    const thumbs = String.fromCodePoint(0x1f44d, 0x1f3fd)
    const actions = [typed('t', 'abcd', { durationMs: 400 })] // 100 ms per character
    const out = setActionText(actions, 't', thumbs + thumbs + thumbs)
    expect(out[0]).toMatchObject({ text: thumbs + thumbs + thumbs, durationMs: 300 })
  })

  it('strips control characters: Enter and Tab are key actions of their own', () => {
    const actions = [typed('t', 'ab', { durationMs: 400 })]
    const out = setActionText(actions, 't', 'x' + controls + 'yz\n')
    expect((out[0] as ScenarioTypeAction).text).toBe('xyz')
    expect((out[0] as ScenarioTypeAction).durationMs).toBe(600) // 3 characters at 200 ms (400 / 2)
  })

  it('keeps spaces and printable non-ASCII text', () => {
    const out = setActionText([typed('t', 'ab')], 't', ' привет, мир ')
    expect((out[0] as ScenarioTypeAction).text).toBe(' привет, мир ')
  })

  it('rejects text that is empty after cleaning', () => {
    const actions = [typed('t', 'ab')]
    expect(setActionText(actions, 't', '')).toBe(actions)
    expect(setActionText(actions, 't', controls)).toBe(actions)
  })

  it('is a no-op for the same text, an unknown id, a non-string and any other kind', () => {
    const actions: ScenarioAction[] = [typed('t', 'ab'), click('c'), key('k')]
    expect(setActionText(actions, 't', 'ab')).toBe(actions)
    expect(setActionText(actions, 't', 'ab' + controls)).toBe(actions) // cleans to the same text
    expect(setActionText(actions, 'nope', 'x')).toBe(actions)
    expect(setActionText(actions, 't', 42 as unknown as string)).toBe(actions)
    expect(setActionText(actions, 'c', 'x')).toBe(actions)
    expect(setActionText(actions, 'k', 'x')).toBe(actions)
  })

  it('leaves the other actions and the other fields of the edited one alone', () => {
    const actions: ScenarioAction[] = [click('c'), typed('t', 'ab', { x: 42, y: 7, pauseMs: 321 })]
    const out = setActionText(actions, 't', 'abc')
    expect(out[0]).toBe(actions[0])
    expect(out[1]).toMatchObject({ x: 42, y: 7, pauseMs: 321, at: 123_456 })
  })
})

describe('editing: moveActionStart', () => {
  // three default clicks: starts 0, 2500, 5000; the end is 7500
  const three = (): ScenarioAction[] => [click('a'), click('b'), click('c')]

  it('pins the first action at 0', () => {
    const actions = three()
    expect(moveActionStart(actions, 'a', 500, true)).toBe(actions)
    expect(moveActionStart(actions, 'a', 500, false)).toBe(actions)
  })

  it('is a no-op for an unknown id and for a non-finite start', () => {
    const actions = three()
    expect(moveActionStart(actions, 'nope', 500, true)).toBe(actions)
    expect(moveActionStart(actions, 'b', Number.NaN, true)).toBe(actions)
    expect(moveActionStart(actions, 'b', Number.POSITIVE_INFINITY, false)).toBe(actions)
  })

  it('is a no-op when the action is already there', () => {
    const actions = three()
    expect(moveActionStart(actions, 'b', 2500, true)).toBe(actions)
    expect(moveActionStart(actions, 'b', 2500, false)).toBe(actions)
    expect(moveActionStart(actions, 'b', 2500.4, true)).toBe(actions) // rounds to the same
  })

  describe('ripple', () => {
    it('stretches only the previous pause; everything after shifts along', () => {
      const out = moveActionStart(three(), 'b', 3000, true)
      expect(pauses(out)).toEqual([2000, 1500, 1500])
      expect(starts(out)).toEqual([0, 3000, 5500])
      expect(scenarioEnd(out)).toBe(8000)
    })

    it('shrinks the previous pause when moved left', () => {
      const out = moveActionStart(three(), 'b', 2000, true)
      expect(pauses(out)).toEqual([1000, 1500, 1500])
      expect(starts(out)).toEqual([0, 2000, 4500])
    })

    it('can only go as far left as the previous pause allows (it cannot overlap the previous action)', () => {
      const out = moveActionStart(three(), 'b', 1000, true)
      expect(pauses(out)).toEqual([0, 1500, 1500])
      expect(starts(out)).toEqual([0, 1000, 3500])
      expect(moveActionStart(three(), 'b', -5000, true)).toEqual(out) // asking for more changes nothing
    })

    it('rounds the requested start', () => {
      expect(starts(moveActionStart(three(), 'b', 2999.6, true))).toEqual([0, 3000, 5500])
    })

    it('moves the last action too, and leaves the earlier pauses alone', () => {
      const out = moveActionStart(three(), 'c', 6000, true)
      expect(pauses(out)).toEqual([1500, 2500, 1500])
      expect(starts(out)).toEqual([0, 2500, 6000])
    })

    it('caps the previous pause at PAUSE_MAX_MS', () => {
      const out = moveActionStart(three(), 'b', 10_000_000, true)
      expect(pauses(out)).toEqual([PAUSE_MAX_MS, 1500, 1500])
      expect(starts(out)[1]).toBe(1000 + PAUSE_MAX_MS)
    })

    // a long scenario whose end sits `lastPause - 47_000 + 599_500` ms from the start
    const nearTheLimit = (lastPause: number): ScenarioAction[] => {
      const actions: ScenarioAction[] = [click('a0', { pauseMs: 1500 })]
      for (let i = 1; i <= 9; i++) actions.push(click(`m${i}`, { pauseMs: 60_000 }))
      actions.push(click('last', { pauseMs: lastPause }))
      return actions
    }

    it('does not let a move to the right grow the scenario past SCENARIO_MAX_MS', () => {
      const actions = nearTheLimit(47_000) // ends 500 ms before the limit
      expect(scenarioEnd(actions)).toBe(SCENARIO_MAX_MS - 500)
      const out = moveActionStart(actions, 'm1', 2500 + 2000, true)
      expect(scenarioEnd(out)).toBe(SCENARIO_MAX_MS)
      expect(out[0].pauseMs).toBe(2000)
      expect(validateScenario(out)).toBeNull()
    })

    it('lets a scenario that is already past the limit only get shorter', () => {
      const actions = nearTheLimit(48_000) // 500 ms past it
      expect(validateScenario(actions)).toBe('tooLong')
      expect(moveActionStart(actions, 'm1', 2500 + 1000, true)).toBe(actions)
      const shorter = moveActionStart(actions, 'm1', 2500 - 1000, true)
      expect(shorter[0].pauseMs).toBe(500)
      expect(scenarioEnd(shorter)).toBe(SCENARIO_MAX_MS - 500)
    })
  })

  describe('without ripple', () => {
    it('moves the pause between the action and its predecessor, so the next action stays put', () => {
      const out = moveActionStart(three(), 'b', 3000, false)
      expect(pauses(out)).toEqual([2000, 1000, 1500])
      expect(starts(out)).toEqual([0, 3000, 5000])
      expect(scenarioEnd(out)).toBe(7500)
    })

    it('stops at the next action: its own pause is the room it has', () => {
      const out = moveActionStart(three(), 'b', 99_999, false)
      expect(pauses(out)).toEqual([3000, 0, 1500]) // b may eat its own 1500ms pause, no more
      expect(starts(out)).toEqual([0, 4000, 5000])
    })

    it('moves left as far as the previous pause allows', () => {
      const out = moveActionStart(three(), 'b', 0, false)
      expect(pauses(out)).toEqual([0, 3000, 1500])
      expect(starts(out)).toEqual([0, 1000, 5000])
    })

    it('keeps the scenario end when the last action moves', () => {
      const out = moveActionStart(three(), 'c', 6000, false)
      expect(pauses(out)).toEqual([1500, 2500, 500])
      expect(starts(out)).toEqual([0, 2500, 6000])
      expect(scenarioEnd(out)).toBe(7500)
    })

    it('keeps both pauses within PAUSE_MAX_MS', () => {
      const actions = [click('a'), click('b', { pauseMs: 59_000 }), click('c')]
      const out = moveActionStart(actions, 'b', 0, false)
      expect(pauses(out)).toEqual([500, PAUSE_MAX_MS, 1500]) // a move of -1000 at most
      expect(starts(out)[2]).toBe(starts(actions)[2])
      expect(out.every((a) => a.pauseMs >= 0 && a.pauseMs <= PAUSE_MAX_MS)).toBe(true)
    })

    it('never changes the end of the scenario, whatever it asks for', () => {
      for (const target of [-9999, 0, 1000, 2500, 3500, 4999, 5000, 123_456]) {
        const out = moveActionStart(three(), 'b', target, false)
        expect(scenarioEnd(out)).toBe(7500)
        expect(starts(out)[2]).toBe(5000)
      }
    })
  })

  it('only touches the neighbours it must, and never mutates its input', () => {
    const actions = deepFreeze(three())
    const out = moveActionStart(actions, 'b', 3000, true)
    expect(out[1]).toBe(actions[1])
    expect(out[2]).toBe(actions[2])
    expect(out[0]).not.toBe(actions[0])
    const out2 = moveActionStart(actions, 'b', 3000, false)
    expect(out2[2]).toBe(actions[2])
  })

  it('works on a stored pause that was garbage (uses what replay uses)', () => {
    const actions = [click('a', { pauseMs: Number.NaN }), click('b')]
    const out = moveActionStart(actions, 'b', 3000, true) // a's effective pause is 1500, start of b is 2500
    expect(out[0].pauseMs).toBe(2000)
    expect(starts(out)[1]).toBe(3000)
  })
})

describe('deleteAction', () => {
  it('removes the action and clears the following action\'s recorded path', () => {
    const scenario: ScenarioAction[] = [
      click('a'),
      { ...click('b'), path: [{ x: 1, y: 1, dt: 5 }] },
      click('c')
    ]
    const result = deleteAction(scenario, 'a')
    expect(result.map((a) => a.id)).toEqual(['b', 'c'])
    expect(result[0].path).toEqual([])
  })

  it('is a no-op for an unknown id', () => {
    const scenario = [click('a')]
    expect(deleteAction(scenario, 'nope')).toBe(scenario)
  })

  it('handles deleting the last action', () => {
    const scenario = [click('a'), click('b')]
    expect(deleteAction(scenario, 'b').map((a) => a.id)).toEqual(['a'])
  })

  it('takes the action\'s pause with it and keeps everyone else\'s timing', () => {
    const scenario = [
      click('a', { durationMs: 1000, pauseMs: 100 }),
      drag('b', { durationMs: 2000, pauseMs: 700 }),
      click('c', { durationMs: 1000, pauseMs: 300 })
    ]
    const result = deleteAction(scenario, 'b')
    expect(result.map((a) => [a.durationMs, a.pauseMs])).toEqual([[1000, 100], [1000, 300]])
    expect(starts(result)).toEqual([0, 1100]) // c now follows a's pause directly
    expect(scenarioEnd(result)).toBe(scenarioEnd(scenario) - 2000 - 700)
  })
})

// ---- compileScenario ----

function isMove(s: ReplayStep): s is Extract<ReplayStep, { op: 'move' }> {
  return s.op === 'move'
}
function isKey(s: ReplayStep): s is Extract<ReplayStep, { op: 'key' }> {
  return s.op === 'key'
}
function isText(s: ReplayStep): s is Extract<ReplayStep, { op: 'text' }> {
  return s.op === 'text'
}
function isMarker(s: ReplayStep): s is Extract<ReplayStep, { op: 'action' }> {
  return s.op === 'action'
}
function isWheel(s: ReplayStep): s is Extract<ReplayStep, { op: 'wheel' }> {
  return s.op === 'wheel'
}
function isEnd(s: ReplayStep): s is Extract<ReplayStep, { op: 'end' }> {
  return s.op === 'end'
}
type ButtonStep = { t: number; op: 'down' | 'up'; button: 'left' | 'right' | 'middle' }
function isButtonOp(op: 'down' | 'up') {
  return (s: ReplayStep): s is ButtonStep => s.op === op
}
/** every step but the progress markers and the closing `end` */
function physical(steps: ReplayStep[]): ReplayStep[] {
  return steps.filter((s) => !isMarker(s) && !isEnd(s))
}
function compile(actions: ScenarioAction[], startPos: ScenarioPoint = { x: 0, y: 0 }): ReplayStep[] {
  return compileScenario(actions, { startPos })
}
/** the steps of the one action `a`, compiled alone */
function solo(a: ScenarioAction, startPos?: ScenarioPoint): ReplayStep[] {
  return physical(compile([a], startPos))
}

describe('compileScenario: the schedule', () => {
  it('closes every schedule with an `end` step at scenarioEnd, even an empty one', () => {
    const actions = [click('a'), key('b', { pauseMs: 3000 })]
    const steps = compile(actions)
    expect(steps[steps.length - 1]).toEqual({ t: scenarioEnd(actions), op: 'end' })
    expect(steps.filter(isEnd)).toHaveLength(1)
    expect(compile([])).toEqual([{ t: 0, op: 'end' }])
  })

  it('waits out the final pause: the end step comes that long after the last action ends', () => {
    const actions = [click('a'), key('b', { durationMs: 500, pauseMs: 3000 })]
    const steps = compile(actions)
    const lastWindowEnd = scenarioSchedule(actions)[1].end // 3000
    const lastReal = physical(steps).reduce((m, s) => Math.max(m, s.t), 0)
    expect(lastReal).toBeLessThanOrEqual(lastWindowEnd)
    expect(steps[steps.length - 1].t).toBe(lastWindowEnd + 3000)
  })

  it('accepts a Scenario as well as a bare action list', () => {
    const actions = [click('a', { x: 300, y: 200 }), typed('b', 'hi')]
    const scenario: Scenario = {
      version: 2, id: 's', name: 'n', createdAt: 0, displayId: 1,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1,
      actions, durationMs: 0, dir: 'x'
    }
    expect(compileScenario(scenario, { startPos: { x: 0, y: 0 } })).toEqual(compile(actions))
  })

  it('is sorted with non-decreasing times and has whole, non-negative times only', () => {
    const actions: ScenarioAction[] = [
      click('a', { x: 523, y: 311, durationMs: 777, pauseMs: 3 }),
      drag('b', { x: 523, y: 311, toX: 100, toY: 900, durationMs: 1333, pauseMs: 0 }),
      scroll('c', 7, { x: 100, y: 900, durationMs: 999, modifiers: withMods({ ctrl: true }) }),
      typed('d', 'héllo wörld', { durationMs: 1111, pauseMs: 7 }),
      clickOf('doubleClick', 'e', { x: 1.5, y: 2.25, durationMs: 301, modifiers: withMods({ shift: true, alt: true }) }),
      key('f', { durationMs: 151, pauseMs: 1, modifiers: withMods({ ctrl: true, meta: true }) })
    ]
    const steps = compile(actions, { x: 1919, y: 0 })
    for (let i = 1; i < steps.length; i++) expect(steps[i].t).toBeGreaterThanOrEqual(steps[i - 1].t)
    for (const s of steps) {
      expect(Number.isInteger(s.t)).toBe(true)
      expect(s.t).toBeGreaterThanOrEqual(0)
    }
  })

  it('puts the progress marker of every action on its effect, in order', () => {
    const actions: ScenarioAction[] = [
      click('a', { x: 50, y: 50 }),
      clickOf('doubleClick', 'b', { x: 60, y: 60 }),
      drag('c', { x: 60, y: 60, toX: 200, toY: 200 }),
      scroll('d', 3),
      typed('e', 'hey'),
      key('f')
    ]
    const markers = compile(actions).filter(isMarker)
    expect(markers.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(markers.map((m) => m.t)).toEqual(scenarioSchedule(actions).map((s) => s.effectAt))
  })

  it('emits the marker right before its effect when both are at the same moment', () => {
    const steps = compile([click('a', { x: 50, y: 50 })])
    const marker = steps.findIndex(isMarker)
    const down = steps.findIndex(isButtonOp('down'))
    expect(steps[marker].t).toBe(steps[down].t)
    expect(marker).toBeLessThan(down)
  })

  it('keeps every step of an action inside its own window [start, end]', () => {
    const actions: ScenarioAction[] = [
      click('a', { x: 523, y: 311, durationMs: 777, pauseMs: 3 }),
      drag('b', { x: 523, y: 311, toX: 100, toY: 900, durationMs: 1333, pauseMs: 40 }),
      scroll('c', 7, { x: 100, y: 900, durationMs: 999, deltaX: -2 }),
      typed('d', 'héllo wörld', { durationMs: 1111, pauseMs: 7 }),
      clickOf('doubleClick', 'e', { x: 1.5, y: 2.25, durationMs: 301, modifiers: withMods({ shift: true, alt: true }) }),
      key('f', { durationMs: 151, pauseMs: 1, modifiers: withMods({ ctrl: true, meta: true }) }),
      clickOf('rightClick', 'g', { x: 10, y: 10, durationMs: 200, modifiers: withMods({ ctrl: true }) }),
      clickOf('middleClick', 'h', { x: 20, y: 20, durationMs: 1200 })
    ]
    const steps = compile(actions, { x: 1919, y: 0 })
    const schedule = scenarioSchedule(actions)
    for (const s of steps.filter((x) => !isEnd(x))) {
      expect(schedule.some((w) => s.t >= w.start && s.t <= w.end)).toBe(true)
    }
  })

  it('compiles each action in its own window exactly like that action compiled alone, shifted to its start', () => {
    const modsAll = withMods({ ctrl: true, shift: true })
    const actions: ScenarioAction[] = [
      click('c1', { x: 400, y: 300 }),
      drag('d1', { x: 400, y: 300, toX: 700, toY: 500, modifiers: modsAll }),
      scroll('s1', 4, { x: 700, y: 500, deltaX: 2 }),
      typed('t1', 'héllo 👍🏽', { x: 12, y: 34, durationMs: 1000 }),
      key('k1', { x: 100, y: 100, modifiers: withMods({ ctrl: true }), key: 'Ctrl+S', vk: 83, scan: 31 }),
      clickOf('doubleClick', 'c2', { x: 900, y: 100, durationMs: 1200, modifiers: withMods({ alt: true }) }),
      clickOf('rightClick', 'c3', { x: 50, y: 60, durationMs: 800 }),
      clickOf('middleClick', 'c4', { x: 50, y: 60 })
    ]
    const startPos = { x: 30, y: 40 }
    const steps = compile(actions, startPos)
    const schedule = scenarioSchedule(actions)

    let cursor: ScenarioPoint = startPos // where the previous POINTER action left it (the spec's rule, restated)
    actions.forEach((a, i) => {
      const { start, end } = schedule[i]
      const expected = solo(a, cursor).map((s) => ({ ...s, t: s.t + start }))
      const actual = physical(steps).filter((s) => s.t >= start && s.t <= end)
      expect(actual).toEqual(expected)
      if (a.kind === 'drag') cursor = { x: a.toX, y: a.toY }
      else if (a.kind !== 'type' && a.kind !== 'key') cursor = { x: a.x, y: a.y }
    })
  })

  it('compiles an action with stored garbage timing exactly like its clamped values', () => {
    const asNumber = (v: unknown): number => v as number
    const garbage = [
      click('a', { x: 100, y: 100, durationMs: asNumber(null), pauseMs: asNumber('x') }),
      typed('b', 'hello', { durationMs: -5, pauseMs: -1 }),
      drag('c', { x: 5, y: 5, toX: 90, toY: 90, durationMs: 3, pauseMs: 1e12 })
    ]
    const clean = garbage.map((a) => ({ ...a, durationMs: actionDurationMs(a), pauseMs: actionPauseMs(a) }))
    expect(compile(garbage)).toEqual(compile(clean))
  })
})

describe('compileScenario: cursor motion', () => {
  it('travels in a straight line: every sample is collinear with the from->to segment', () => {
    const from = { x: 0, y: 0 }
    const a = click('c1', { x: 500, y: 300 })
    const moves = compile([a], from).filter(isMove)
    expect(moves.length).toBeGreaterThan(1)
    for (const m of moves) {
      // cross product of (to-from) and (m-from): 0 exactly on the line, whatever the easing
      const cross = (a.x - from.x) * (m.y - from.y) - (a.y - from.y) * (m.x - from.x)
      expect(Math.abs(cross)).toBeLessThan(0.5)
    }
  })

  it('lands exactly on the target 90ms before the button goes down, after moving from the very start', () => {
    const a = click('c1', { x: 500, y: 300, durationMs: 1000 }) // down at 910
    const steps = compile([a])
    const moves = steps.filter(isMove)
    expect(moves[moves.length - 1]).toEqual({ t: 820, op: 'move', x: 500, y: 300 })
    expect(steps.find(isButtonOp('down'))!.t - moves[moves.length - 1].t).toBe(90)
    expect(moves[0].t).toBeGreaterThan(0)
    expect(moves.every((m) => m.t <= 820)).toBe(true)
  })

  it('travel takes the duration the action has: a longer action moves slower, not later', () => {
    const slow = compile([click('c1', { x: 600, y: 0, durationMs: 4000 })]).filter(isMove)
    expect(slow[slow.length - 1].t).toBe(3820)
    expect(slow.length).toBeGreaterThan(compile([click('c1', { x: 600, y: 0, durationMs: 1000 })]).filter(isMove).length)
  })

  it('eases in and out: the middle sample nears the midpoint, the outer quarters cover less distance than the middle half', () => {
    const a = click('c1', { x: 600, y: 0 })
    const moves = compile([a]).filter(isMove)
    const total = moves.length
    const mid = moves[Math.floor(total / 2)]
    expect(mid.x).toBeGreaterThan(600 * 0.35)
    expect(mid.x).toBeLessThan(600 * 0.65)

    const q1 = moves[Math.floor(total / 4)]
    const q3 = moves[Math.floor((3 * total) / 4)]
    const firstQuarterDistance = q1.x - moves[0].x
    const lastQuarterDistance = moves[total - 1].x - q3.x
    const middleHalfDistance = q3.x - q1.x
    expect(firstQuarterDistance).toBeLessThan(middleHalfDistance)
    expect(lastQuarterDistance).toBeLessThan(middleHalfDistance)
  })

  it('samples at roughly 60Hz', () => {
    const moves = compile([click('c1', { x: 600, y: 0, durationMs: 2000 })]).filter(isMove)
    // travel window 1820ms -> about 109 frames
    expect(moves.length).toBeGreaterThan(100)
    expect(moves.length).toBeLessThan(120)
  })

  it('a travel window under one frame is a single move at the window end', () => {
    // the shortest click (200ms) leaves a 20ms window for the travel
    const moves = compile([click('c1', { x: 100, y: 100, durationMs: 200 })]).filter(isMove)
    expect(moves).toEqual([{ t: 20, op: 'move', x: 100, y: 100 }])
  })

  it('a sub-2px distance emits no moves at all', () => {
    const moves = compile([click('c1', { x: 100, y: 100 })], { x: 100, y: 100.5 }).filter(isMove)
    expect(moves).toEqual([])
  })

  it("the first pointer action's travel starts from opts.startPos", () => {
    const a = click('c1', { x: 500, y: 0 })
    const fromOrigin = compile([a], { x: 0, y: 0 }).filter(isMove)
    expect(fromOrigin[0].x).toBeGreaterThan(0)
    expect(fromOrigin[0].x).toBeLessThan(500)

    // startPos already at the action's own point (the documented fallback "no startPoint"
    // behaviour) - no initial move at all
    expect(compile([a], { x: 500, y: 0 }).filter(isMove)).toEqual([])
  })

  it('travels from where the previous pointer action left the cursor, not from the start', () => {
    const steps = compile([click('a', { x: 100, y: 100 }), click('b', { x: 300, y: 100 })], { x: 900, y: 900 })
    const secondWindowStart = 2500
    const second = steps.filter(isMove).filter((m) => m.t > secondWindowStart)
    expect(second.length).toBeGreaterThan(1)
    for (const m of second) {
      expect(m.y).toBeCloseTo(100)
      expect(m.x).toBeGreaterThanOrEqual(100)
      expect(m.x).toBeLessThanOrEqual(300)
    }
    expect(second[second.length - 1]).toMatchObject({ x: 300, y: 100 })
  })

  it('a drag leaves the cursor at its end point, where the next action starts travelling from', () => {
    const steps = compile([
      drag('d', { x: 0, y: 0, toX: 400, toY: 0 }),
      click('c', { x: 400, y: 0 }) // exactly where the drag ended: no travel needed
    ])
    const secondStart = 1500 + 1500
    expect(steps.filter(isMove).filter((m) => m.t >= secondStart)).toEqual([])
  })

  it('keyboard actions never move the cursor and never change where the next travel starts', () => {
    const typeOnly = compile([typed('t', 'hello', { x: 700, y: 700 })], { x: 0, y: 0 })
    expect(typeOnly.filter(isMove)).toEqual([])
    const keyOnly = compile([key('k', { x: 700, y: 700 })], { x: 0, y: 0 })
    expect(keyOnly.filter(isMove)).toEqual([])

    const steps = compile([
      click('a', { x: 100, y: 100 }),
      typed('t', 'hi', { x: 700, y: 700, durationMs: 400 }),
      key('k', { x: 800, y: 800 }),
      click('b', { x: 300, y: 300 })
    ])
    const secondClickStart = starts([click('a'), typed('t', 'hi', { durationMs: 400 }), key('k'), click('b')])[3]
    const travel = steps.filter(isMove).filter((m) => m.t > secondClickStart)
    expect(travel.length).toBeGreaterThan(1)
    for (const m of travel) {
      expect(m.x).toBeCloseTo(m.y) // on the (100,100)->(300,300) diagonal, never near (700,700)
      expect(m.x).toBeGreaterThanOrEqual(100)
      expect(m.x).toBeLessThanOrEqual(300)
    }
  })
})

describe('compileScenario: clicks', () => {
  const at = (x: number, y: number, extra: Partial<ScenarioClickAction> = {}) => ({ x, y, ...extra })

  it('click: button down at end-90 (the effect), up at end-20, travel landing 90ms before the down', () => {
    const a = click('c', at(200, 100, { durationMs: 1200 })) // E = 1200
    const steps = compile([a])
    expect(steps.find(isButtonOp('down'))).toEqual({ t: 1110, op: 'down', button: 'left' })
    expect(steps.find(isButtonOp('up'))).toEqual({ t: 1180, op: 'up', button: 'left' })
    const moves = steps.filter(isMove)
    expect(moves[moves.length - 1].t).toBe(1020)
  })

  it('rightClick and middleClick use their own button with the same timing', () => {
    const right = compile([clickOf('rightClick', 'r', at(10, 10, { durationMs: 1000 }))])
    expect(right.find(isButtonOp('down'))).toEqual({ t: 910, op: 'down', button: 'right' })
    expect(right.find(isButtonOp('up'))).toEqual({ t: 980, op: 'up', button: 'right' })
    const middle = compile([clickOf('middleClick', 'm', at(10, 10, { durationMs: 1000 }))])
    expect(middle.find(isButtonOp('down'))).toEqual({ t: 910, op: 'down', button: 'middle' })
    expect(middle.find(isButtonOp('up'))).toEqual({ t: 980, op: 'up', button: 'middle' })
  })

  it('doubleClick: down end-180 (the effect), up end-110, down end-90, up end-20', () => {
    const steps = compile([clickOf('doubleClick', 'd', at(10, 10, { durationMs: 1000 }))])
    const buttons = steps.filter((s): s is ButtonStep => s.op === 'down' || s.op === 'up')
    expect(buttons).toEqual([
      { t: 820, op: 'down', button: 'left' },
      { t: 890, op: 'up', button: 'left' },
      { t: 910, op: 'down', button: 'left' },
      { t: 980, op: 'up', button: 'left' }
    ])
    const moves = steps.filter(isMove)
    expect(moves[moves.length - 1].t).toBe(730) // 90ms before the first press
  })

  it('brackets the press with its modifiers: down 20ms before, up at the end of the action', () => {
    const a = click('c', at(10, 10, { durationMs: 1000, modifiers: withMods({ ctrl: true, shift: true }) }))
    const steps = compile([a])
    const keys = steps.filter(isKey)
    expect(keys.filter((k) => k.down).map((k) => [k.t, k.vk])).toEqual([[890, 0x11], [890, 0x10]])
    expect(keys.filter((k) => !k.down).map((k) => [k.t, k.vk])).toEqual([[1000, 0x11], [1000, 0x10]])
    expect(Math.max(...keys.filter((k) => k.down).map((k) => k.t))).toBeLessThan(steps.find(isButtonOp('down'))!.t)
    expect(Math.min(...keys.filter((k) => !k.down).map((k) => k.t))).toBeGreaterThan(steps.find(isButtonOp('up'))!.t)
  })

  it('the shortest click of every flavour still goes travel < down < up <= end', () => {
    for (const kind of ['click', 'rightClick', 'middleClick'] as const) {
      const steps = compile([clickOf(kind, 'c', { x: 300, y: 300, durationMs: 0, pauseMs: 0 })])
      const down = steps.find(isButtonOp('down'))!
      const up = steps.find(isButtonOp('up'))!
      const lastMove = steps.filter(isMove).slice(-1)[0]
      expect([lastMove.t, down.t, up.t]).toEqual([20, 110, 180])
      expect(up.t).toBeLessThanOrEqual(200)
    }
    const dbl = compile([clickOf('doubleClick', 'c', { x: 300, y: 300, durationMs: 0, pauseMs: 0 })])
    const presses = dbl.filter((s): s is ButtonStep => s.op === 'down' || s.op === 'up')
    expect(presses.map((s) => s.t)).toEqual([120, 190, 210, 280]) // E = 300
    expect(dbl.filter(isMove).slice(-1)[0].t).toBe(30)
  })
})

describe('compileScenario: drag', () => {
  it('splits the duration: travel, press at 40%, drag motion from +40ms to end-40, release at end-20', () => {
    const d = drag('d', { x: 0, y: 0, toX: 400, toY: 0, durationMs: 1500, dragPath: [{ x: 999, y: 999, dt: 5 }] })
    const steps = compile([d]) // startPos = the drag's own point: no travel
    expect(steps.find(isButtonOp('down'))).toEqual({ t: 600, op: 'down', button: 'left' })
    expect(steps.find(isButtonOp('up'))).toEqual({ t: 1480, op: 'up', button: 'left' })
    const moves = steps.filter(isMove)
    expect(moves.length).toBeGreaterThan(1)
    expect(moves[0].t).toBeGreaterThan(640)
    expect(moves[moves.length - 1]).toEqual({ t: 1460, op: 'move', x: 400, y: 0 })
    for (const m of moves) {
      expect(m.y).toBeCloseTo(0)
      expect(m.x).not.toBe(999) // dragPath's own point is never used
    }
  })

  it('travels to the start point first, landing 90ms before the press', () => {
    const d = drag('d', { x: 0, y: 0, toX: 400, toY: 0, durationMs: 1500 })
    const steps = compile([d], { x: 300, y: 300 })
    const press = steps.find(isButtonOp('down'))!.t
    const travel = steps.filter(isMove).filter((m) => m.t < press)
    expect(travel[travel.length - 1]).toEqual({ t: press - 90, op: 'move', x: 0, y: 0 })
    // then the drag motion, all after the press
    const dragging = steps.filter(isMove).filter((m) => m.t > press)
    expect(dragging[0].t).toBeGreaterThanOrEqual(press + 40)
  })

  it('holds its modifiers from 20ms before the press to the end of the action', () => {
    const d = drag('d', { toX: 50, toY: 50, durationMs: 1500, modifiers: withMods({ alt: true }) })
    const keys = compile([d]).filter(isKey)
    expect(keys).toEqual([
      { t: 580, op: 'key', vk: 0x12, scan: 56, extended: false, down: true },
      { t: 1500, op: 'key', vk: 0x12, scan: 56, extended: false, down: false }
    ])
  })

  it('the shortest drag keeps its phases in order', () => {
    const d = drag('d', { x: 0, y: 0, toX: 400, toY: 0, durationMs: 0, pauseMs: 0 }) // clamps to 500
    const steps = compile([d], { x: 200, y: 200 })
    const down = steps.find(isButtonOp('down'))!
    const up = steps.find(isButtonOp('up'))!
    expect([down.t, up.t]).toEqual([200, 480])
    const moves = steps.filter(isMove)
    const travelEnd = moves.filter((m) => m.t < down.t).slice(-1)[0]
    const dragMoves = moves.filter((m) => m.t > down.t)
    expect(travelEnd.t).toBe(110)
    expect(dragMoves[0].t).toBeGreaterThanOrEqual(240)
    expect(dragMoves.slice(-1)[0]).toEqual({ t: 460, op: 'move', x: 400, y: 0 })
    expect(up.t).toBeGreaterThan(dragMoves.slice(-1)[0].t)
  })

  it('nothing of the next action starts before the drag lets go', () => {
    const steps = compile([drag('d', { durationMs: 500, pauseMs: 0 }), click('c', { x: 500, y: 500 })])
    const up = steps.find(isButtonOp('up'))!
    const downs = steps.filter(isButtonOp('down'))
    expect(downs).toHaveLength(2)
    expect(downs[1].t).toBeGreaterThan(up.t)
    for (const s of steps.filter((x) => x.t >= 500 && !isEnd(x))) expect(s.t).toBeGreaterThanOrEqual(up.t)
  })
})

describe('compileScenario: scroll', () => {
  const wheels = (steps: ReplayStep[]): Array<Extract<ReplayStep, { op: 'wheel' }>> => steps.filter(isWheel)

  it('spreads the notches evenly from 40% of the duration to end-20, the first one being the effect', () => {
    const steps = compile([scroll('s', 3, { durationMs: 1000 })])
    expect(wheels(steps).map((w) => w.t)).toEqual([400, 690, 980])
    expect(steps.find(isMarker)!.t).toBe(400)
  })

  it('one notch happens at the effect, no notch emits no wheel at all', () => {
    expect(wheels(compile([scroll('s', 1, { durationMs: 1000 })])).map((w) => w.t)).toEqual([400])
    expect(wheels(compile([scroll('s', 0, { durationMs: 1000 })]))).toEqual([])
  })

  it('travels to the scroll point first, landing 90ms before the first notch', () => {
    const steps = compile([scroll('s', 3, { x: 300, y: 200, durationMs: 1000 })])
    const moves = steps.filter(isMove)
    expect(moves[moves.length - 1]).toEqual({ t: 310, op: 'move', x: 300, y: 200 })
  })

  it('never puts two notches closer than 40ms, for any notch count at its minimum duration', () => {
    for (let n = 1; n <= 300; n++) {
      const a = scroll('s', n, { durationMs: 0, pauseMs: 0 }) // clamps to the floor
      const end = actionDurationMs(a)
      const effectAt = scenarioSchedule([a])[0].effectAt
      const times = wheels(compile([a], { x: 0, y: 0 })).map((w) => w.t)
      expect(times).toHaveLength(n)
      expect(times[0]).toBe(effectAt)
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(40)
      expect(times[times.length - 1]).toBeLessThanOrEqual(end - 20)
    }
  })

  it('keeps the notches inside [effect, end-20] and 40ms apart at other durations too', () => {
    for (const [n, duration] of [[2, 333], [7, 1999], [40, 5000], [100, 12_345], [12, 700]] as const) {
      const a = scroll('s', n, { durationMs: duration, pauseMs: 0 })
      const times = wheels(compile([a])).map((w) => w.t)
      const effectAt = scenarioSchedule([a])[0].effectAt
      expect(times[0]).toBe(effectAt)
      expect(times[times.length - 1]).toBe(actionDurationMs(a) - 20)
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(40)
    }
  })

  it('replays vertical notches first, then horizontal ones', () => {
    const steps = wheels(compile([scroll('s', 2, { deltaX: -1, durationMs: 1000 })]))
    expect(steps.map((w) => [w.dy, w.dx])).toEqual([[-120, 0], [-120, 0], [0, -120]])
  })

  it('does not hold modifiers for a scroll (as before)', () => {
    const steps = compile([scroll('s', 2, { modifiers: withMods({ ctrl: true }) })])
    expect(steps.filter(isKey)).toEqual([])
  })
})

describe('compileScenario: typing and keys', () => {
  it('spreads the graphemes evenly over the duration, the first one at the very start', () => {
    const steps = compile([typed('t', 'hello', { durationMs: 1000 })])
    expect(steps.filter(isText).map((s) => [s.t, s.text])).toEqual([[0, 'h'], [200, 'e'], [400, 'l'], [600, 'l'], [800, 'o']])
    expect(steps.find(isMarker)!.t).toBe(0)
  })

  it('rounds the character times', () => {
    const times = compile([typed('t', 'abc', { durationMs: 1000 })]).filter(isText).map((s) => s.t)
    expect(times).toEqual([0, 333, 667])
  })

  it('starts typing at the start of its own window, after what came before', () => {
    const steps = compile([click('c'), typed('t', 'hi', { durationMs: 400 })])
    expect(steps.filter(isText).map((s) => s.t)).toEqual([2500, 2700])
  })

  it('emits unicode text one grapheme at a time, not one UTF-16 code unit at a time', () => {
    const emoji = String.fromCodePoint(0x1f44d, 0x1f3fd)
    const textSteps = compile([typed('e', emoji + '!', { durationMs: 400 })]).filter(isText)
    expect(textSteps.map((s) => s.text)).toEqual([emoji, '!'])
  })

  it('types text with no characters as a marker only', () => {
    const steps = compile([typed('t', '')])
    expect(steps.filter(isText)).toEqual([])
    expect(steps.filter(isMarker)).toHaveLength(1)
  })

  it('a key press: down at end-60 (the effect), up at end-20, nothing else when there are no modifiers', () => {
    const steps = compile([key('k', { durationMs: 500, vk: 13, scan: 28 })])
    expect(steps.filter(isKey)).toEqual([
      { t: 440, op: 'key', vk: 13, scan: 28, extended: false, down: true },
      { t: 480, op: 'key', vk: 13, scan: 28, extended: false, down: false }
    ])
    expect(steps.find(isMarker)!.t).toBe(440)
  })

  it('brackets a chord: modifiers down at end-80, up at the end; the key between them', () => {
    const chord = key('k', { durationMs: 500, key: 'Ctrl+S', vk: 83, scan: 31, modifiers: withMods({ ctrl: true }) })
    const keyOps = compile([chord]).filter(isKey)
    const ctrlDown = keyOps.find((s) => s.vk === 0x11 && s.down)!
    const ctrlUp = keyOps.find((s) => s.vk === 0x11 && !s.down)!
    const mainDown = keyOps.find((s) => s.vk === 83 && s.down)!
    const mainUp = keyOps.find((s) => s.vk === 83 && !s.down)!
    expect([ctrlDown.t, mainDown.t, mainUp.t, ctrlUp.t]).toEqual([420, 440, 480, 500])
  })

  it('an extended key keeps its flag', () => {
    const keyOps = compile([key('k', { vk: 0x27, scan: 0x4d, extended: true })]).filter(isKey)
    expect(keyOps.every((s) => s.extended)).toBe(true)
  })

  it('the shortest key and the shortest typing keep their phases in order', () => {
    const k = compile([key('k', { durationMs: 0, pauseMs: 0, modifiers: withMods({ shift: true }) })]).filter(isKey)
    expect(k.map((s) => [s.vk, s.down, s.t])).toEqual([[0x10, true, 70], [13, true, 90], [13, false, 130], [0x10, false, 150]])
    const t = compile([typed('t', 'a', { durationMs: 0, pauseMs: 0 })]).filter(isText)
    expect(t.map((s) => s.t)).toEqual([0])
  })
})

describe('compileScenario: pauses', () => {
  it('leaves a pause as a stretch with no steps, then starts the next action', () => {
    const steps = compile([click('a', { x: 10, y: 10, pauseMs: 4000 }), click('b', { x: 10, y: 10 })])
    const firstEnd = 1000
    const gap = physical(steps).filter((s) => s.t > firstEnd && s.t < 5000)
    expect(gap).toEqual([])
    expect(steps.filter(isButtonOp('down')).map((s) => s.t)).toEqual([910, 5910])
  })

  it('with no pause the next action begins right where the previous ended, in order', () => {
    const steps = compile([
      click('a', { x: 10, y: 10, durationMs: 1000, pauseMs: 0, modifiers: withMods({ ctrl: true }) }),
      typed('t', 'hi', { durationMs: 400, pauseMs: 0 })
    ])
    const ctrlUp = steps.find((s) => isKey(s) && !s.down)!
    const firstChar = steps.find(isText)!
    expect(ctrlUp.t).toBe(1000)
    expect(firstChar.t).toBe(1000)
    // modifiers come off before the next action types: stable order at the same instant
    expect(steps.indexOf(ctrlUp)).toBeLessThan(steps.indexOf(firstChar))
  })
})

describe('compileScenario: minimum durations', () => {
  const everyKind: ScenarioAction[] = [
    click('click', { x: 300, y: 200 }),
    clickOf('doubleClick', 'double', { x: 300, y: 200 }),
    clickOf('rightClick', 'right', { x: 300, y: 200 }),
    clickOf('middleClick', 'middle', { x: 300, y: 200 }),
    drag('drag', { x: 300, y: 200, toX: 500, toY: 400 }),
    scroll('scroll', 9, { x: 300, y: 200, deltaX: 3 }),
    typed('type', 'a longer text to type'),
    key('key', { modifiers: withMods({ ctrl: true, shift: true, alt: true, meta: true }) })
  ]

  it('a minimum-duration action of every kind still compiles in order, inside its window, ending with the pause', () => {
    for (const base of everyKind) {
      const a = { ...base, durationMs: 0, pauseMs: 0 } as ScenarioAction
      const d = actionDurationMs(a)
      expect(d).toBe(minDurationMs(a))
      const steps = compile([a], { x: 1000, y: 900 })
      const inner = physical(steps)
      for (const s of inner) {
        expect(s.t).toBeGreaterThanOrEqual(0)
        expect(s.t).toBeLessThanOrEqual(d)
        expect(Number.isInteger(s.t)).toBe(true)
      }
      for (let i = 1; i < steps.length; i++) expect(steps[i].t).toBeGreaterThanOrEqual(steps[i - 1].t)
      expect(steps[steps.length - 1]).toEqual({ t: d, op: 'end' })
      // every press is released: as many ups as downs, ups never before their down
      const downs = inner.filter(isButtonOp('down')).length
      expect(inner.filter(isButtonOp('up'))).toHaveLength(downs)
      const keyDowns = inner.filter((s) => isKey(s) && s.down).length
      expect(inner.filter((s) => isKey(s) && !s.down)).toHaveLength(keyDowns)
    }
  })

  it('a scenario of minimum-duration actions in a row compiles in order with every press released', () => {
    const chain = everyKind.map((a) => ({ ...a, durationMs: 0, pauseMs: 0 }) as ScenarioAction)
    const steps = compile(chain, { x: 1000, y: 900 })
    for (let i = 1; i < steps.length; i++) expect(steps[i].t).toBeGreaterThanOrEqual(steps[i - 1].t)
    const schedule = scenarioSchedule(chain)
    chain.forEach((_, i) => {
      const window = physical(steps).filter((s) => s.t >= schedule[i].start && s.t <= schedule[i].end)
      expect(window.length).toBeGreaterThan(0)
    })
    // replaying it leaves nothing held: walk the steps tracking what is down
    const held = new Set<string>()
    for (const s of steps) {
      if (s.op === 'down') held.add('btn:' + s.button)
      else if (s.op === 'up') held.delete('btn:' + s.button)
      else if (isKey(s)) {
        if (s.down) held.add(`key:${s.vk}:${s.scan}:${s.extended}`)
        else held.delete(`key:${s.vk}:${s.scan}:${s.extended}`)
      }
    }
    expect([...held]).toEqual([])
  })
})

describe('wheel sign: capture <-> compile round trip', () => {
  // Empirically measured (B1 verification): a physical MOUSEEVENTF_WHEEL notch of
  // mouseData=+120 (rotated forward/away from the user) scrolls a real scrollable element's
  // content UP (scrollTop decreases). The capturer passes uiohook's raw `rotation` straight
  // through (WHEEL_SIGN = 1 in capture.ts), and that same notch is reported by uiohook as
  // rotation = -1. So: capture-domain deltaY < 0 <=> the user scrolled up.
  const CAPTURED_DELTA_FOR_ONE_UP_NOTCH = -1

  it('compiles a captured "scrolled up" action back into a positive (forward) physical notch', () => {
    const wheelSteps = compile([scroll('s1', CAPTURED_DELTA_FOR_ONE_UP_NOTCH)]).filter(isWheel)
    expect(wheelSteps).toHaveLength(1)
    // negative captured delta (scrolled up) must compile to the same +120 physical notch that
    // produced it when captured, not a -120 one (which would scroll the opposite way)
    expect(wheelSteps[0].dy).toBe(120)
  })

  it('compiles a captured "scrolled down" action into a negative (backward) physical notch', () => {
    const wheelSteps = compile([scroll('s1', 1)]).filter(isWheel)
    expect(wheelSteps).toHaveLength(1)
    expect(wheelSteps[0].dy).toBe(-120)
  })

  it('keeps the unflipped sign on the horizontal axis', () => {
    const right = compile([scroll('s1', 0, { deltaX: 1 })]).filter(isWheel)
    const left = compile([scroll('s1', 0, { deltaX: -1 })]).filter(isWheel)
    expect(right.map((w) => w.dx)).toEqual([120])
    expect(left.map((w) => w.dx)).toEqual([-120])
  })
})

describe('compileScenario: a small end-to-end schedule', () => {
  const actions: ScenarioAction[] = [
    click('c1', { x: 100, y: 100, durationMs: 1000, pauseMs: 1500 }),
    key('k1', { x: 100, y: 100, durationMs: 500, pauseMs: 1500, modifiers: withMods({ ctrl: true }), key: 'Ctrl+S', vk: 83, scan: 31 }),
    typed('t1', 'hi', { x: 100, y: 100, durationMs: 400, pauseMs: 1500 }),
    scroll('s1', 3, { x: 100, y: 100, durationMs: 1000, pauseMs: 1500 })
  ]
  const steps = compile(actions)

  it('is sorted with non-decreasing times', () => {
    for (let i = 1; i < steps.length; i++) expect(steps[i].t).toBeGreaterThanOrEqual(steps[i - 1].t)
  })

  it('has the button down before the up, 70ms apart', () => {
    const down = steps.find(isButtonOp('down'))!
    const up = steps.find(isButtonOp('up'))!
    expect(down.t).toBe(910)
    expect(up.t).toBe(980)
    expect(down.t).toBeLessThan(up.t)
  })

  it('brackets the chord with modifier down/up around the key op', () => {
    const keyOps = steps.filter(isKey)
    const ctrlDown = keyOps.find((s) => s.vk === 0x11 && s.down)!
    const ctrlUp = keyOps.find((s) => s.vk === 0x11 && !s.down)!
    const mainDown = keyOps.find((s) => s.vk === 83 && s.down)!
    const mainUp = keyOps.find((s) => s.vk === 83 && !s.down)!
    // the key action starts at 2500 and lasts 500
    expect(ctrlDown.t).toBe(2920)
    expect(mainDown.t).toBe(2940)
    expect(mainUp.t).toBe(2980)
    expect(ctrlUp.t).toBe(3000)
    expect(ctrlDown.t).toBeLessThan(mainDown.t)
    expect(ctrlUp.t).toBeGreaterThan(mainUp.t)
  })

  it('emits one text step per grapheme', () => {
    expect(steps.filter(isText).map((s) => s.text)).toEqual(['h', 'i'])
    expect(steps.filter(isText).map((s) => s.t)).toEqual([4500, 4700])
  })

  it('emits the wheel notches at the right moments and with the physical sign', () => {
    const wheelSteps = steps.filter(isWheel)
    expect(wheelSteps).toHaveLength(3)
    // deltaY: 3 (content scrolls down) compiles to physical mouseData -120 per notch
    expect(wheelSteps.every((s) => s.dy === -120)).toBe(true)
    expect(wheelSteps.map((s) => s.t)).toEqual([6800, 7090, 7380])
  })

  it('emits an action marker per action, in order, at the action\'s effect', () => {
    const markers = steps.filter(isMarker)
    expect(markers.map((s) => s.index)).toEqual([0, 1, 2, 3])
    expect(markers.map((s) => s.t)).toEqual([910, 2940, 4500, 6800])
  })

  it('ends after the last pause', () => {
    expect(steps[steps.length - 1]).toEqual({ t: 6400 + 1000 + 1500, op: 'end' })
  })

  it('never emits a step time before 0 for an action at the very start with the shortest duration', () => {
    const early = [key('k0', { durationMs: 0, modifiers: withMods({ ctrl: true }), key: 'Ctrl+S', vk: 83, scan: 31 })]
    const s = compile(early)
    expect(s.every((step) => step.t >= 0)).toBe(true)
    expect(s.find(isKey)!.t).toBe(70) // the modifier goes down 80ms before the end of the 150ms action
  })
})

describe('Scenario.startPoint', () => {
  const baseScenario: Scenario = {
    version: 2,
    id: 's1',
    name: 'Test',
    createdAt: 0,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: [click('a')],
    durationMs: 1070,
    dir: 'C:/scenarios/s1'
  }

  it('round-trips through JSON (as storage.ts saves/loads it) without loss', () => {
    const scenario: Scenario = { ...baseScenario, startPoint: { x: 123, y: 456 } }
    const roundTripped = JSON.parse(JSON.stringify(scenario)) as Scenario
    expect(roundTripped.startPoint).toEqual({ x: 123, y: 456 })
    expect(roundTripped.actions).toEqual(scenario.actions)
  })

  it('is omitted, rather than present as null, for a scenario captured before the field existed', () => {
    const roundTripped = JSON.parse(JSON.stringify(baseScenario)) as Scenario
    expect(roundTripped.startPoint).toBeUndefined()
    expect('startPoint' in roundTripped).toBe(false)
  })

  it('survives migrateScenario untouched', () => {
    const scenario: Scenario = { ...baseScenario, startPoint: { x: 123, y: 456 } }
    expect(migrateScenario(scenario).startPoint).toEqual({ x: 123, y: 456 })
    expect('startPoint' in migrateScenario(baseScenario)).toBe(false)
  })
})

describe('describeAction', () => {
  it('returns the kind and, for type/key, a plain-text detail', () => {
    expect(describeAction(click('a'))).toEqual({ kindKey: 'click', detail: '' })
    expect(describeAction(key('k', { key: 'Enter' }))).toEqual({ kindKey: 'key', detail: 'Enter' })
    expect(describeAction(typed('t', 'hello'))).toEqual({ kindKey: 'type', detail: 'hello' })
  })
})
