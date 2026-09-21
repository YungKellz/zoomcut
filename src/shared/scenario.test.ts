import { describe, expect, it } from 'vitest'
import {
  actionDuration,
  actionEnd,
  compileScenario,
  deleteAction,
  describeAction,
  groupRawEvents,
  normalizeLeadIn,
  retimeAction,
  scenarioEnd,
  validateScenario,
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
function clickAction(id: string, at: number, x = 0, y = 0): ScenarioClickAction {
  return { id, kind: 'click', at, x, y, path: [], modifiers: NO_MODS, shot: null }
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
    expect(drag.durationMs).toBe(60)
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

  it('produces rightClick / middleClick for the other buttons', () => {
    const actions = groupRawEvents([
      downEvt('r1', 1000, 10, 10, { button: 'right' }), upEvt(1030, 10, 10, { button: 'right' }),
      downEvt('m1', 2000, 20, 20, { button: 'middle' }), upEvt(2030, 20, 20, { button: 'middle' })
    ])
    expect(actions.map((a) => a.kind)).toEqual(['rightClick', 'middleClick'])
  })

  it('merges wheel events closer than 400ms into one scroll and starts a new one after a gap', () => {
    const actions = groupRawEvents([
      wheelEvt('w1', 1000, 120),
      wheelEvt('w2', 1100, 120),
      wheelEvt('w3', 1900, 120)
    ])
    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({ id: 'w1', kind: 'scroll', at: 1000, deltaY: 240, deltaX: 0, durationMs: 100 })
    expect(actions[1]).toMatchObject({ id: 'w3', kind: 'scroll', at: 1900, deltaY: 120, durationMs: 0 })
  })

  it('sums horizontal and vertical wheel notches separately', () => {
    const actions = groupRawEvents([
      wheelEvt('w1', 1000, 120, { horizontal: true }),
      wheelEvt('w2', 1100, -120)
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ deltaX: 120, deltaY: -120 })
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
    // recorded lastT-at = 200ms, but 3 chars ('hi!') * MIN_TYPE_MS_PER_CHAR (150) = 450 wins
    expect(actions[0]).toMatchObject({ id: 'k1', kind: 'type', at: 1000, text: 'hi!', durationMs: 450 })
  })

  it('gives a typed action at least 150ms per character, even when the keystrokes themselves were faster', () => {
    const actions = groupRawEvents([
      keyEvt('k1', 1000, 35, 72, 'h'),
      keyEvt('k2', 1020, 23, 73, 'i')
    ])
    expect(actions).toHaveLength(1)
    // recorded lastT-at = 20ms, far under 150 * 2 chars = 300ms
    expect(actions[0]).toMatchObject({ kind: 'type', text: 'hi', durationMs: 300 })
  })

  it('keeps the recorded typing duration when it already exceeds the per-character minimum', () => {
    const actions = groupRawEvents([
      keyEvt('k1', 1000, 35, 72, 'h'),
      keyEvt('k2', 2000, 23, 73, 'i')
    ])
    // recorded lastT-at = 1000ms, comfortably over 150 * 2 chars = 300ms
    expect(actions[0]).toMatchObject({ kind: 'type', text: 'hi', durationMs: 1000 })
  })

  it('clamps an inflated type duration so it never overlaps the action right after it (e.g. "hello world" typed quickly, Enter right after)', () => {
    const chars = Array.from('hello world') // 11 graphemes, including the space
    const typeEvents = chars.map((ch, i) => keyEvt(`t${i}`, i * 100, 100 + i, 100 + i, ch))
    const enter = keyEvt('enter', 1150, 28, 13, null) // scan 28 -> 'Enter', not text
    const actions = groupRawEvents([...typeEvents, enter])
    expect(actions.map((a) => a.kind)).toEqual(['type', 'key'])
    const typeAction = actions[0] as ScenarioTypeAction
    const enterAction = actions[1] as ScenarioKeyAction
    expect(typeAction.text).toBe('hello world')
    // recorded = 1000ms (last char at t=1000, first at t=0); naive inflation (150*11=1650) would
    // run past Enter at 1150 - the clamp must pull it back to leave >= MIN_GAP_MS(50) before it
    expect(typeAction.durationMs).toBe(1100)
    expect(actionEnd(typeAction)).toBeLessThanOrEqual(enterAction.at)
    expect(enterAction.at - actionEnd(typeAction)).toBeGreaterThanOrEqual(50)
  })

  it('compiles the clamped type action so every text step fires before the next action\'s own marker', () => {
    const chars = Array.from('hello world')
    const typeEvents = chars.map((ch, i) => keyEvt(`t${i}`, i * 100, 100 + i, 100 + i, ch))
    const enter = keyEvt('enter', 1150, 28, 13, null)
    const actions = groupRawEvents([...typeEvents, enter])
    const steps = compileScenario(actions, { startPos: { x: 0, y: 0 } })
    const enterMarker = steps.find((s) => s.op === 'action' && s.index === 1)!
    const textSteps = steps.filter(isText)
    expect(textSteps).toHaveLength(11)
    expect(textSteps.every((s) => s.t < enterMarker.t)).toBe(true)
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
})

describe('retimeAction', () => {
  const base = () => [clickAction('a', 1000), clickAction('b', 2000), clickAction('c', 3000)]

  it('moves a single action within its neighbours, without touching the others', () => {
    const result = retimeAction(base(), 'b', 2500, false)
    expect(result.map((a) => a.at)).toEqual([1000, 2500, 3000])
  })

  it('clamps to a 50ms gap after the previous action', () => {
    const result = retimeAction(base(), 'b', 0, false)
    expect(result.find((a) => a.id === 'b')!.at).toBe(1000 + 70 + 50) // actionEnd(a) + 50
  })

  it('clamps to a 50ms gap before the next action', () => {
    const result = retimeAction(base(), 'b', 9999, false)
    expect(result.find((a) => a.id === 'b')!.at).toBe(3000 - 50 - 70) // next.at - 50 - own duration
  })

  it('ripples the following actions by the same delta, leaving their mutual gaps intact', () => {
    const result = retimeAction(base(), 'b', 2200, true)
    expect(result.map((a) => a.at)).toEqual([1000, 2200, 3200])
  })

  it('clamps a ripple move so nothing crosses the 10-minute limit', () => {
    const scenario = [clickAction('a', 599_000), clickAction('b', 599_200)]
    const result = retimeAction(scenario, 'a', 700_000, true)
    expect(scenarioEnd(result)).toBe(SCENARIO_MAX_MS)
    expect(result.map((a) => a.at)).toEqual([599_730, 599_930])
  })

  it('clamps a non-ripple move of the last action to the 10-minute limit', () => {
    const result = retimeAction([clickAction('only', 100)], 'only', 700_000, false)
    expect(result[0].at).toBe(SCENARIO_MAX_MS - 70)
  })

  it('is a no-op for an unknown id', () => {
    const scenario = base()
    expect(retimeAction(scenario, 'nope', 1234, false)).toBe(scenario)
  })

  it('leaves the action unchanged (no overlap) when neighbours leave no room to move, non-ripple', () => {
    const scenario = [clickAction('a', 500_000), clickAction('b', 500_080), clickAction('c', 500_125)]
    // minAt(b) = actionEnd(a)+50 = 500070+50 = 500120; maxAt(b) = c.at-50-70 = 500005 < minAt
    const result = retimeAction(scenario, 'b', 500_090, false)
    expect(result).toEqual(scenario)
  })

  it('leaves everything unchanged when a ripple move has no room (packed against the 10-minute cap)', () => {
    const scenario = [clickAction('a', 500_000), clickAction('b', 500_080), clickAction('c', 599_920)]
    // minDelta(b) = (actionEnd(a)+50) - b.at = 500120-500080 = 40; maxDelta = MAX - actionEnd(c) = 10
    const result = retimeAction(scenario, 'b', 500_080, true)
    expect(result).toEqual(scenario)
  })
})

describe('deleteAction', () => {
  it('removes the action and clears the following action\'s recorded path', () => {
    const scenario: ScenarioAction[] = [
      clickAction('a', 1000),
      { ...clickAction('b', 2000), path: [{ x: 1, y: 1, dt: 5 }] },
      clickAction('c', 3000)
    ]
    const result = deleteAction(scenario, 'a')
    expect(result.map((a) => a.id)).toEqual(['b', 'c'])
    expect(result[0].path).toEqual([])
  })

  it('is a no-op for an unknown id', () => {
    const scenario = [clickAction('a', 1000)]
    expect(deleteAction(scenario, 'nope')).toBe(scenario)
  })

  it('handles deleting the last action', () => {
    const scenario = [clickAction('a', 1000), clickAction('b', 2000)]
    expect(deleteAction(scenario, 'b').map((a) => a.id)).toEqual(['a'])
  })
})

describe('normalizeLeadIn', () => {
  it('shifts every action left so the first sits at 1000ms when it started much later', () => {
    const scenario = [clickAction('a', 30_000), clickAction('b', 31_500)]
    const result = normalizeLeadIn(scenario)
    expect(result.map((a) => a.at)).toEqual([1000, 2500])
  })

  it('leaves the scenario unchanged when the first action is already at or before 1000ms', () => {
    const scenario = [clickAction('a', 300), clickAction('b', 1800)]
    expect(normalizeLeadIn(scenario)).toBe(scenario)
  })

  it('is a no-op on an empty scenario', () => {
    expect(normalizeLeadIn([])).toEqual([])
  })
})

describe('actionDuration / actionEnd / scenarioEnd / validateScenario', () => {
  it('has the documented fixed durations', () => {
    expect(actionDuration(clickAction('a', 0))).toBe(70)
    expect(actionDuration({ ...clickAction('a', 0), kind: 'doubleClick' })).toBe(250)
    expect(actionDuration({ ...clickAction('a', 0), kind: 'rightClick' })).toBe(70)
    expect(actionDuration({ ...clickAction('a', 0), kind: 'middleClick' })).toBe(70)
  })

  it('computes actionEnd and scenarioEnd', () => {
    const a = clickAction('a', 1000)
    expect(actionEnd(a)).toBe(1070)
    expect(scenarioEnd([a, clickAction('b', 2000)])).toBe(2070)
  })

  it("reports a drag's true (floor-clamped) duration, not its raw recorded one", () => {
    const drag: ScenarioDragAction = {
      id: 'd', kind: 'drag', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
      toX: 10, toY: 10, dragPath: [], durationMs: 40
    }
    expect(actionDuration(drag)).toBe(200) // DRAG_MIN_MS, not the raw 40
    expect(actionEnd(drag)).toBe(200)
  })

  it("reports a multi-notch scroll's true (40ms/notch-floor) duration, not its raw recorded one", () => {
    const scroll: ScenarioScrollAction = {
      id: 's', kind: 'scroll', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
      deltaY: 5, deltaX: 0, durationMs: 10
    }
    // 5 notches need >= 4 * 40 = 160ms to space out, far more than the recorded 10ms
    expect(actionDuration(scroll)).toBe(160)
  })

  it('flags an empty or too-long scenario', () => {
    expect(validateScenario([])).toBe('empty')
    expect(validateScenario([clickAction('a', SCENARIO_MAX_MS)])).toBe('tooLong')
    expect(validateScenario([clickAction('a', 0)])).toBeNull()
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
type ButtonStep = { t: number; op: 'down' | 'up'; button: 'left' | 'right' | 'middle' }
function isButtonOp(op: 'down' | 'up') {
  return (s: ReplayStep): s is ButtonStep => s.op === op
}

describe('compileScenario: cursor motion', () => {
  it('moves in a straight line: every sample is collinear with the from->to segment', () => {
    const from = { x: 0, y: 0 }
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 2000, x: 500, y: 300, path: [], modifiers: NO_MODS, shot: null }
    const moves = compileScenario([a], { startPos: from }).filter(isMove)
    expect(moves.length).toBeGreaterThan(1)
    for (const m of moves) {
      // cross product of (to-from) and (m-from): 0 exactly on the line, whatever the easing
      const cross = (a.x - from.x) * (m.y - from.y) - (a.y - from.y) * (m.x - from.x)
      expect(Math.abs(cross)).toBeLessThan(0.5)
    }
  })

  it('the last move lands exactly on the target, settleMs (90ms) before `at`', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 2000, x: 500, y: 300, path: [], modifiers: NO_MODS, shot: null }
    const moves = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
    expect(moves[moves.length - 1]).toEqual({ t: 1910, op: 'move', x: 500, y: 300 })
  })

  it('eases in and out: the middle sample nears the midpoint, the outer quarters cover less distance than the middle half', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 2000, x: 600, y: 0, path: [], modifiers: NO_MODS, shot: null }
    const moves = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
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

  it('caps the leading move duration at 80% of the available gap, even when distance alone would call for more', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1000, x: 2000, y: 0, path: [], modifiers: NO_MODS, shot: null }
    // distance=2000 alone wants clamp(220+2000*0.45, 260, 900) = 900ms, but gap=1000ms caps the
    // move at 0.8*1000 = 800ms - an 800ms move starts at end-800=110, a 900ms one at end-900=10
    const moves = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
    expect(moves[0].t).toBeGreaterThan(60)
    expect(moves[moves.length - 1]).toEqual({ t: 910, op: 'move', x: 2000, y: 0 })
  })

  it('clamps the leading move duration at 900ms even for a very long, unhurried move', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 100_000, x: 5000, y: 0, path: [], modifiers: NO_MODS, shot: null }
    // distance=5000 alone wants clamp(220+5000*0.45, 260, 900) = 2470 -> clamped to 900; the gap
    // (100000ms) is nowhere near tight enough to be the binding constraint (0.8*gap=80000)
    const moves = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
    const end = 100_000 - 90 // MOVE_SETTLE_MS
    expect(moves[0].t).toBeGreaterThan(end - 900) // an uncapped ~2470ms move would start far earlier
    expect(moves[moves.length - 1]).toEqual({ t: end, op: 'move', x: 5000, y: 0 })
  })

  it('a gap under 120ms collapses to a single move, 10ms before `at`', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1000, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null }
    const b: ScenarioClickAction = { id: 'c2', kind: 'click', at: 1080, x: 150, y: 100, path: [], modifiers: NO_MODS, shot: null }
    // startPos === a's own point, so a itself has no leading move; gap for b = 1080 - actionEnd(a)(1070) = 10ms
    const moves = compileScenario([a, b], { startPos: { x: 100, y: 100 } }).filter(isMove)
    expect(moves).toEqual([{ t: 1070, op: 'move', x: 150, y: 100 }])
  })

  it('never emits a negative move time, even for a first action retimed to a tiny `at`', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 5, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null }
    // prevEnd = 0 (first action), gap = 5 - 0 = 5ms: the tiny-gap branch would naturally land at
    // at - 10 = -5 without the clamp
    const moves = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
    expect(moves).toEqual([{ t: 0, op: 'move', x: 100, y: 100 }])
  })

  it('a sub-2px distance emits no moves at all', () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1000, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null }
    const moves = compileScenario([a], { startPos: { x: 100, y: 100.5 } }).filter(isMove)
    expect(moves).toEqual([])
  })

  it('a drag moves in a straight line over durationMs, `down` at `at` and `up` at `at + durationMs`; dragPath is ignored', () => {
    const drag: ScenarioDragAction = {
      id: 'd1', kind: 'drag', at: 1000, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
      toX: 400, toY: 0, dragPath: [{ x: 999, y: 999, dt: 5 }], durationMs: 300
    }
    const steps = compileScenario([drag], { startPos: { x: 0, y: 0 } })
    expect(steps.find(isButtonOp('down'))).toEqual({ t: 1000, op: 'down', button: 'left' })
    expect(steps.find(isButtonOp('up'))).toEqual({ t: 1300, op: 'up', button: 'left' })
    const moves = steps.filter(isMove)
    expect(moves.length).toBeGreaterThan(1)
    expect(moves[moves.length - 1]).toEqual({ t: 1300, op: 'move', x: 400, y: 0 })
    for (const m of moves) {
      expect(m.y).toBeCloseTo(0)
      expect(m.x).not.toBe(999) // dragPath's own point is never used
    }
  })

  it('a fast drag is still animated over at least 200ms, with `up` following the animation', () => {
    const drag: ScenarioDragAction = {
      id: 'd1', kind: 'drag', at: 1000, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
      toX: 100, toY: 0, dragPath: [], durationMs: 40
    }
    const steps = compileScenario([drag], { startPos: { x: 0, y: 0 } })
    expect(steps.find(isButtonOp('up'))!.t).toBe(1200) // at + max(40, 200)
  })

  it("the first action's leading move starts from opts.startPos (fed from the captured Scenario.startPoint by the caller)", () => {
    const a: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1000, x: 500, y: 0, path: [], modifiers: NO_MODS, shot: null }
    const fromOrigin = compileScenario([a], { startPos: { x: 0, y: 0 } }).filter(isMove)
    expect(fromOrigin[0].x).toBeGreaterThan(0)
    expect(fromOrigin[0].x).toBeLessThan(500)

    // startPos already at the action's own point (the documented fallback "no startPoint"
    // behaviour) - no initial move at all
    const fromOwnPoint = compileScenario([a], { startPos: { x: 500, y: 0 } }).filter(isMove)
    expect(fromOwnPoint).toEqual([])
  })
})

describe('drag effective duration: nothing after it starts before the button lifts', () => {
  it("retimeAction and compileScenario agree on where a fast drag really ends, so a next action packed right after it never starts before the drag's up", () => {
    const drag: ScenarioDragAction = {
      id: 'd1', kind: 'drag', at: 1000, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
      toX: 100, toY: 0, dragPath: [], durationMs: 40
    }
    const rough: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1050, x: 500, y: 500, path: [], modifiers: NO_MODS, shot: null }
    // pack the click as tight as retimeAction allows right after the drag
    const packed = retimeAction([drag, rough], 'c1', 0, false)
    const next = packed[1] as ScenarioClickAction
    // actionEnd(drag) + MIN_GAP_MS(50): with the bug (raw durationMs=40) this would be 1000+40+50
    // = 1090; with the fix (effectiveDuration=200) it is 1000+200+50 = 1250
    expect(next.at).toBe(1250)

    const steps = compileScenario(packed, { startPos: { x: 0, y: 0 } })
    const up = steps.find(isButtonOp('up'))!
    const downs = steps.filter(isButtonOp('down'))
    expect(up.t).toBe(1200) // the drag's own up: at + effectiveDuration
    expect(downs).toHaveLength(2)
    // the click's own down (the drag's is the first) must not fire before the drag's real up
    expect(downs[1].t).toBeGreaterThanOrEqual(up.t)
  })
})

describe('Scenario.startPoint', () => {
  const baseScenario: Scenario = {
    version: 1,
    id: 's1',
    name: 'Test',
    createdAt: 0,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: [clickAction('a', 1000)],
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
})

describe('compileScenario: step ordering', () => {
  const startPos = { x: 0, y: 0 }
  const scenario: ScenarioAction[] = [
    { id: 'c1', kind: 'click', at: 1000, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null },
    {
      id: 'k1', kind: 'key', at: 1500, x: 100, y: 100, path: [], modifiers: withMods({ ctrl: true }), shot: null,
      key: 'Ctrl+S', vk: 83, scan: 31, extended: false
    },
    { id: 't1', kind: 'type', at: 2000, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null, text: 'hi', durationMs: 100 },
    { id: 's1', kind: 'scroll', at: 2500, x: 100, y: 100, path: [], modifiers: NO_MODS, shot: null, deltaY: 3, deltaX: 0, durationMs: 150 }
  ]
  const steps = compileScenario(scenario, { startPos })

  it('is sorted with non-decreasing times', () => {
    for (let i = 1; i < steps.length; i++) expect(steps[i].t).toBeGreaterThanOrEqual(steps[i - 1].t)
  })

  it('emits down strictly before up, 70ms apart', () => {
    const down = steps.find(isButtonOp('down'))!
    const up = steps.find(isButtonOp('up'))!
    expect(down.t).toBe(1000)
    expect(up.t).toBe(1070)
    expect(down.t).toBeLessThan(up.t)
  })

  it('brackets a chord with modifier down/up around the key op', () => {
    const keyOps = steps.filter(isKey)
    const ctrlDown = keyOps.find((s) => s.vk === 0x11 && s.down)!
    const ctrlUp = keyOps.find((s) => s.vk === 0x11 && !s.down)!
    const mainDown = keyOps.find((s) => s.vk === 83 && s.down)!
    const mainUp = keyOps.find((s) => s.vk === 83 && !s.down)!
    expect(mainDown.t).toBe(1500)
    expect(mainUp.t).toBe(1540)
    expect(ctrlDown.t).toBe(1480)
    expect(ctrlUp.t).toBe(1560)
    expect(ctrlDown.t).toBeLessThan(mainDown.t)
    expect(ctrlUp.t).toBeGreaterThan(mainUp.t)
  })

  it('emits one text step per grapheme', () => {
    expect(steps.filter(isText).map((s) => s.text)).toEqual(['h', 'i'])
  })

  it('emits an action marker per action, in order, at the action\'s `at`', () => {
    const markers = steps.filter(isMarker)
    expect(markers.map((s) => s.index)).toEqual([0, 1, 2, 3])
    expect(markers.map((s) => s.t)).toEqual([1000, 1500, 2000, 2500])
  })

  it('emits unicode text one grapheme at a time, not one UTF-16 code unit at a time', () => {
    const emoji: ScenarioAction[] = [
      { id: 'e1', kind: 'type', at: 500, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, text: '👍🏽!', durationMs: 100 }
    ]
    const textSteps = compileScenario(emoji, { startPos }).filter(isText)
    expect(textSteps.map((s) => s.text)).toEqual(['👍🏽', '!'])
  })

  it('spreads scroll notches at least 40ms apart', () => {
    const wheelSteps = steps.filter((s): s is Extract<ReplayStep, { op: 'wheel' }> => s.op === 'wheel')
    expect(wheelSteps).toHaveLength(3) // ceil(|3|) notches
    // deltaY: 3 (content scrolls down) compiles to physical mouseData -120 per notch - see the
    // wheel-sign round trip test below for why.
    expect(wheelSteps.every((s) => s.dy === -120)).toBe(true)
    for (let i = 1; i < wheelSteps.length; i++) {
      expect(wheelSteps[i].t - wheelSteps[i - 1].t).toBeGreaterThanOrEqual(40)
    }
  })

  it('never emits a step time before 0, even for an action at the very start', () => {
    const early: ScenarioAction[] = [
      { id: 'k0', kind: 'key', at: 10, x: 0, y: 0, path: [], modifiers: withMods({ ctrl: true }), shot: null, key: 'Ctrl+S', vk: 83, scan: 31, extended: false }
    ]
    const s = compileScenario(early, { startPos })
    expect(s.every((step) => step.t >= 0)).toBe(true)
    // the modifier-down would naturally land at at-20 = -10; it must be clamped to 0
    const ctrlDown = s.find(isKey)!.t
    expect(ctrlDown).toBe(0)
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
    const scrolledUp: ScenarioAction[] = [
      {
        id: 's1', kind: 'scroll', at: 500, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null,
        deltaY: CAPTURED_DELTA_FOR_ONE_UP_NOTCH, deltaX: 0, durationMs: 0
      }
    ]
    const wheelSteps = compileScenario(scrolledUp, { startPos: { x: 0, y: 0 } }).filter(
      (s): s is Extract<ReplayStep, { op: 'wheel' }> => s.op === 'wheel'
    )
    expect(wheelSteps).toHaveLength(1)
    // negative captured delta (scrolled up) must compile to the same +120 physical notch that
    // produced it when captured, not a -120 one (which would scroll the opposite way)
    expect(wheelSteps[0].dy).toBe(120)
  })

  it('compiles a captured "scrolled down" action into a negative (backward) physical notch', () => {
    const scrolledDown: ScenarioAction[] = [
      { id: 's1', kind: 'scroll', at: 500, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, deltaY: 1, deltaX: 0, durationMs: 0 }
    ]
    const wheelSteps = compileScenario(scrolledDown, { startPos: { x: 0, y: 0 } }).filter(
      (s): s is Extract<ReplayStep, { op: 'wheel' }> => s.op === 'wheel'
    )
    expect(wheelSteps).toHaveLength(1)
    expect(wheelSteps[0].dy).toBe(-120)
  })
})

describe('describeAction', () => {
  it('returns the kind and, for type/key, a plain-text detail', () => {
    expect(describeAction(clickAction('a', 0))).toEqual({ kindKey: 'click', detail: '' })
    expect(
      describeAction({ id: 'k', kind: 'key', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, key: 'Enter', vk: 13, scan: 28, extended: false })
    ).toEqual({ kindKey: 'key', detail: 'Enter' })
    expect(
      describeAction({ id: 't', kind: 'type', at: 0, x: 0, y: 0, path: [], modifiers: NO_MODS, shot: null, text: 'hello', durationMs: 50 })
    ).toEqual({ kindKey: 'type', detail: 'hello' })
  })
})
