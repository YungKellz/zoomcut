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
  synthesizePath,
  validateScenario,
  type RawDownEvent,
  type RawInputEvent,
  type RawKeyEvent,
  type RawUpEvent,
  type RawWheelEvent,
  type ReplayStep
} from './scenario'
import { SCENARIO_MAX_MS } from './defaults'
import type { ScenarioAction, ScenarioClickAction, ScenarioDragAction, ScenarioModifiers } from './types'

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
    expect(actions[0]).toMatchObject({ id: 'k1', kind: 'type', at: 1000, text: 'hi!', durationMs: 200 })
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

  it('flags an empty or too-long scenario', () => {
    expect(validateScenario([])).toBe('empty')
    expect(validateScenario([clickAction('a', SCENARIO_MAX_MS)])).toBe('tooLong')
    expect(validateScenario([clickAction('a', 0)])).toBeNull()
  })
})

describe('synthesizePath', () => {
  it('is deterministic and lands exactly on the target', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 300, y: 0 }
    const a = synthesizePath(from, to, 300)
    const b = synthesizePath(from, to, 300)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(1)
    const last = a[a.length - 1]
    expect(last.x).toBeCloseTo(300)
    expect(last.y).toBeCloseTo(0)
    expect(a.reduce((sum, p) => sum + p.dt, 0)).toBe(300)
  })

  it('bulges away from the straight line', () => {
    const path = synthesizePath({ x: 0, y: 0 }, { x: 300, y: 0 }, 300)
    const mid = path[Math.floor(path.length / 2)]
    expect(Math.abs(mid.y)).toBeGreaterThan(1)
  })

  it('returns nothing for zero distance or zero duration', () => {
    expect(synthesizePath({ x: 5, y: 5 }, { x: 5, y: 5 }, 300)).toEqual([])
    expect(synthesizePath({ x: 0, y: 0 }, { x: 300, y: 0 }, 0)).toEqual([])
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

describe('compileScenario: path layout', () => {
  const startPos = { x: 0, y: 0 }
  const base: ScenarioClickAction = { id: 'c1', kind: 'click', at: 1000, x: 500, y: 500, path: [], modifiers: NO_MODS, shot: null }

  it('keeps recorded dts when the path already fits in the gap', () => {
    const a: ScenarioClickAction = { ...base, path: [{ x: 100, y: 100, dt: 100 }, { x: 300, y: 300, dt: 100 }] }
    const moves = compileScenario([a], { leadMs: 800, startPos }).filter(isMove)
    // gapStart = max(0, 1000-800) = 200; dts (100,100) sum to 200 <= gap(800), so kept as-is
    expect(moves.slice(0, 2)).toEqual([
      { t: 300, op: 'move', x: 100, y: 100 },
      { t: 400, op: 'move', x: 300, y: 300 }
    ])
    expect(moves[moves.length - 1]).toEqual({ t: 1000, op: 'move', x: 500, y: 500 })
  })

  it('scales recorded dts down when the path is longer than the gap', () => {
    const a: ScenarioClickAction = { ...base, path: [{ x: 100, y: 100, dt: 600 }, { x: 300, y: 300, dt: 600 }] }
    const moves = compileScenario([a], { leadMs: 800, startPos }).filter(isMove)
    // sum(dt) = 1200 > gap(800) -> scale = 800/1200 = 2/3; first point lands at 200 + 400 = 600
    expect(moves[0]).toEqual({ t: 600, op: 'move', x: 100, y: 100 })
  })

  it('synthesizes a curve ending 60ms before `at` when there is no recorded path', () => {
    const a: ScenarioClickAction = { ...base, path: [] }
    const moves = compileScenario([a], { leadMs: 800, startPos }).filter(isMove)
    expect(moves.length).toBeGreaterThan(0)
    const last = moves[moves.length - 1]
    expect(last.t).toBe(1000 - 60)
    expect(last.x).toBe(500)
    expect(last.y).toBe(500)
  })

  it('jumps straight to the target when the gap is under 120ms', () => {
    const a: ScenarioClickAction = { ...base, at: 1000 }
    const b: ScenarioClickAction = { ...base, id: 'c2', at: 1080, x: 520, y: 505 }
    const moves = compileScenario([a, b], { leadMs: 800, startPos }).filter(isMove)
    // the gap between c1's end (1070) and c2's at (1080) is only 10ms
    const jump = moves.find((m) => m.t === 1080)
    expect(jump).toEqual({ t: 1080, op: 'move', x: 520, y: 505 })
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
  const steps = compileScenario(scenario, { leadMs: 800, startPos })

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
    const textSteps = compileScenario(emoji, { leadMs: 800, startPos }).filter(isText)
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
    const s = compileScenario(early, { leadMs: 800, startPos })
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
    const wheelSteps = compileScenario(scrolledUp, { leadMs: 800, startPos: { x: 0, y: 0 } }).filter(
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
    const wheelSteps = compileScenario(scrolledDown, { leadMs: 800, startPos: { x: 0, y: 0 } }).filter(
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
