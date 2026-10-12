import { describe, expect, it } from 'vitest'
import { AgentError, type AgentScenarioInput } from './agent'
import { buildAgentScenario, toAgentScenarioView, type AgentDisplay } from './agentScenario'
import { SCENARIO_MAX_MS } from './defaults'
import {
  DEFAULT_PAUSE_MS,
  actionDurationMs,
  compileScenario,
  defaultDurationMs,
  migrateScenario,
  scenarioEnd,
  scenarioSchedule
} from './scenario'

const MAIN: AgentDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
// a second monitor to the right: coordinates in the input stay relative to it
const SECOND: AgentDisplay = { id: 2, bounds: { x: 1920, y: -200, width: 1280, height: 720 }, scaleFactor: 1.5 }
const NOW = 1_700_000_000_000

function build(input: AgentScenarioInput, display: AgentDisplay = MAIN) {
  return buildAgentScenario(input, display, '2026-01-02_03-04-05', NOW)
}

function failure(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).code).toBe('bad_params')
    return (err as AgentError).message
  }
  throw new Error('expected buildAgentScenario to throw')
}

describe('buildAgentScenario', () => {
  it('builds a version 2 scenario with ids, defaults and the schedule as recorded time', () => {
    const s = build({
      name: '  Login demo ',
      actions: [
        { kind: 'click', x: 100, y: 200 },
        { kind: 'type', text: 'hello' },
        { kind: 'key', key: 'Enter' }
      ]
    })
    expect(s).toMatchObject({
      version: 2,
      id: '2026-01-02_03-04-05',
      name: 'Login demo',
      createdAt: NOW,
      displayId: 1,
      displayBounds: MAIN.bounds,
      scaleFactor: 1,
      dir: ''
    })
    expect(s.actions.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
    for (const a of s.actions) {
      expect(a.path).toEqual([])
      expect(a.shot).toBeNull()
      expect(a.pauseMs).toBe(DEFAULT_PAUSE_MS)
      expect(a.durationMs).toBe(defaultDurationMs(a))
    }
    const schedule = scenarioSchedule(s.actions)
    expect(s.actions.map((a) => a.at)).toEqual(schedule.map((x) => x.effectAt))
    expect(s.durationMs).toBe(scenarioEnd(s.actions))
    // the cursor starts in the middle of the display
    expect(s.startPoint).toEqual({ x: 960, y: 540 })
  })

  it('puts display-relative coordinates on the virtual desktop', () => {
    const s = build(
      {
        name: 'second monitor',
        actions: [
          { kind: 'click', x: 10, y: 20 },
          { kind: 'drag', x: 100, y: 100, toX: 400, toY: 300 },
          { kind: 'scroll', x: 640, y: 360, deltaY: -2 }
        ]
      },
      SECOND
    )
    expect(s.displayId).toBe(2)
    expect(s.scaleFactor).toBe(1.5)
    expect(s.startPoint).toEqual({ x: 1920 + 640, y: -200 + 360 })
    expect(s.actions[0]).toMatchObject({ kind: 'click', x: 1930, y: -180 })
    expect(s.actions[1]).toMatchObject({ kind: 'drag', x: 2020, y: -100, toX: 2320, toY: 100, dragPath: [] })
    expect(s.actions[2]).toMatchObject({ kind: 'scroll', x: 2560, y: 160, deltaY: -2, deltaX: 0 })
  })

  it('builds every pointer kind with modifiers', () => {
    const s = build({
      name: 'kinds',
      actions: [
        { kind: 'click', x: 1, y: 1, modifiers: ['ctrl', 'shift'] },
        { kind: 'doubleClick', x: 2, y: 2 },
        { kind: 'rightClick', x: 3, y: 3 },
        { kind: 'middleClick', x: 4, y: 4, modifiers: ['alt', 'meta'] }
      ]
    })
    expect(s.actions.map((a) => a.kind)).toEqual(['click', 'doubleClick', 'rightClick', 'middleClick'])
    expect(s.actions[0].modifiers).toEqual({ ctrl: true, shift: true, alt: false, meta: false })
    expect(s.actions[1].modifiers).toEqual({ ctrl: false, shift: false, alt: false, meta: false })
    expect(s.actions[3].modifiers).toEqual({ ctrl: false, shift: false, alt: true, meta: true })
  })

  it('stores a key as the chord a capture would store', () => {
    const s = build({ name: 'keys', actions: [{ kind: 'key', key: 'shift+ctrl+t' }] })
    expect(s.actions[0]).toMatchObject({
      kind: 'key',
      key: 'Ctrl+Shift+T',
      vk: 0x54,
      scan: 0x14,
      extended: false,
      modifiers: { ctrl: true, shift: true, alt: false, meta: false }
    })
  })

  it('draws type and key where the cursor was left', () => {
    const s = build({
      name: 'cursor',
      actions: [
        { kind: 'type', text: 'a' },
        { kind: 'click', x: 300, y: 400 },
        { kind: 'type', text: 'b' },
        { kind: 'drag', x: 10, y: 10, toX: 50, toY: 60 },
        { kind: 'key', key: 'Enter' }
      ]
    })
    expect(s.actions.map((a) => [a.x, a.y])).toEqual([
      [960, 540],
      [300, 400],
      [300, 400],
      [10, 10],
      [50, 60]
    ])
  })

  it('uses the given timing, held within the limits replay applies, and the defaults otherwise', () => {
    const s = build({
      name: 'timing',
      actions: [
        { kind: 'click', x: 5, y: 5, durationMs: 2000, pauseMs: 250 },
        { kind: 'click', x: 5, y: 5, durationMs: 10, pauseMs: 0 },
        { kind: 'click', x: 5, y: 5, durationMs: 999_999, pauseMs: 999_999 },
        { kind: 'type', text: 'abcd' }
      ]
    })
    expect(s.actions.map((a) => [a.durationMs, a.pauseMs])).toEqual([
      [2000, 250],
      [200, 0], // the shortest a click can take
      [60_000, 60_000],
      [320, DEFAULT_PAUSE_MS] // 4 characters at the normal typing speed
    ])
    expect(s.actions.every((a) => a.durationMs === actionDurationMs(a))).toBe(true)
  })

  it('scrolls three notches down when no delta is given', () => {
    const s = build({ name: 'scroll', actions: [{ kind: 'scroll', x: 10, y: 10 }, { kind: 'scroll', x: 10, y: 10, deltaX: 4.4 }] })
    expect(s.actions[0]).toMatchObject({ deltaY: 3, deltaX: 0 })
    expect(s.actions[1]).toMatchObject({ deltaY: 0, deltaX: 4 })
  })

  it('survives a JSON round trip and the migration untouched, and compiles to replay steps', () => {
    const s = build({
      name: 'round trip',
      actions: [
        { kind: 'click', x: 640, y: 360, modifiers: ['ctrl'] },
        { kind: 'drag', x: 100, y: 100, toX: 300, toY: 300 },
        { kind: 'scroll', x: 640, y: 360, deltaY: 5 },
        { kind: 'type', text: 'héllo wörld' },
        { kind: 'key', key: 'Ctrl+A' }
      ]
    })
    s.dir = 'x'
    expect(migrateScenario(JSON.parse(JSON.stringify(s)))).toEqual(s)
    const steps = compileScenario(s, { startPos: s.startPoint! })
    expect(steps.at(-1)).toEqual({ t: scenarioEnd(s.actions), op: 'end' })
    expect(steps.filter((x) => x.op === 'action').map((x) => (x.op === 'action' ? x.index : -1))).toEqual([0, 1, 2, 3, 4])
    expect(steps.filter((x) => x.op === 'text').map((x) => (x.op === 'text' ? x.text : ''))).toEqual('héllo wörld'.split(''))
  })

  describe('validation', () => {
    it('needs a name and at least one action', () => {
      expect(failure(() => build({ name: '  ', actions: [{ kind: 'key', key: 'A' }] }))).toContain('name')
      expect(failure(() => build({ name: 'x'.repeat(121), actions: [{ kind: 'key', key: 'A' }] }))).toContain('name')
      expect(failure(() => build({ name: 'x', actions: [] }))).toContain('at least one action')
      expect(failure(() => build({ name: 'x' } as AgentScenarioInput))).toContain('at least one action')
      expect(failure(() => build(null as unknown as AgentScenarioInput))).toContain('object')
    })

    it('rejects points outside the display and says where', () => {
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1920, y: 0 }] }))).toMatch(/actions\[0\].*outside the display.*1920x1080/)
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 0, y: -1 }] }))).toContain('outside the display')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'key', key: 'A' }, { kind: 'drag', x: 0, y: 0, toX: 5, toY: 1080 }] }))).toMatch(/actions\[1\].*toX, toY/)
      // the same point is fine on a bigger display, and relative coordinates beyond a small one are not
      expect(() => build({ name: 'x', actions: [{ kind: 'click', x: 1500, y: 600 }] }, MAIN)).not.toThrow()
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1500, y: 600 }] }, SECOND))).toContain('1280x720')
    })

    it('rejects non-numbers and unknown kinds', () => {
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 'a', y: 1 } as never] }))).toContain('x must be a number')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: Number.NaN, y: 1 }] }))).toContain('x must be a number')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'hover', x: 1, y: 1 } as never] }))).toContain('unknown kind "hover"')
      expect(failure(() => build({ name: 'x', actions: ['click' as never] }))).toContain('must be an object')
    })

    it('rejects bad modifiers, timing, text and keys', () => {
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1, modifiers: ['hyper' as never] }] }))).toContain('unknown modifier "hyper"')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1, pauseMs: -1 }] }))).toContain('pauseMs must not be negative')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1, durationMs: 'fast' as never }] }))).toContain('durationMs must be a number')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'type', text: '' }] }))).toContain('non-empty')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'type', text: 'a\nb' }] }))).toContain('"Enter"')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'type', text: 'a'.repeat(1001) }] }))).toContain('at most 1000')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaY: 0 }] }))).toContain('non-zero')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaY: 101 }] }))).toContain('at most 100 notches')
      const key = failure(() => build({ name: 'x', actions: [{ kind: 'key', key: 'Ctrl+Banana' }] }))
      expect(key).toContain('actions[0]')
      expect(key).toContain('"Banana"')
    })

    it('refuses too many actions and a replay longer than the limit', () => {
      const click = { kind: 'click', x: 1, y: 1 } as const
      expect(failure(() => build({ name: 'x', actions: Array.from({ length: 501 }, () => click) }))).toContain('at most 500')
      const slow = Array.from({ length: 12 }, () => ({ ...click, durationMs: 60_000, pauseMs: 60_000 }))
      expect(slow.length * 120_000).toBeGreaterThan(SCENARIO_MAX_MS)
      expect(failure(() => build({ name: 'x', actions: slow }))).toContain('limit is 600 s')
    })
  })
})

describe('toAgentScenarioView', () => {
  it('turns a built scenario back into the input, with the effective timing and ids', () => {
    const s = build(
      {
        name: 'view',
        actions: [
          { kind: 'click', x: 10, y: 20, modifiers: ['shift'], durationMs: 1500, pauseMs: 100 },
          { kind: 'drag', x: 1, y: 2, toX: 3, toY: 4 },
          { kind: 'scroll', x: 5, y: 6, deltaY: -3, deltaX: 2 },
          { kind: 'type', text: 'abc' },
          { kind: 'key', key: 'Alt+Tab' }
        ]
      },
      SECOND
    )
    const view = toAgentScenarioView(s)
    expect(view).toMatchObject({ id: s.id, name: 'view', displayId: 2, displayBounds: SECOND.bounds, durationMs: s.durationMs })
    expect(view.actions).toEqual([
      { id: 'a1', kind: 'click', x: 10, y: 20, modifiers: ['shift'], durationMs: 1500, pauseMs: 100 },
      { id: 'a2', kind: 'drag', x: 1, y: 2, toX: 3, toY: 4, durationMs: 1500, pauseMs: DEFAULT_PAUSE_MS },
      { id: 'a3', kind: 'scroll', x: 5, y: 6, deltaY: -3, deltaX: 2, durationMs: 1000, pauseMs: DEFAULT_PAUSE_MS },
      { id: 'a4', kind: 'type', text: 'abc', durationMs: 240, pauseMs: DEFAULT_PAUSE_MS },
      { id: 'a5', kind: 'key', key: 'Alt+Tab', durationMs: 500, pauseMs: DEFAULT_PAUSE_MS }
    ])
  })

  it('feeds a view back into the builder unchanged', () => {
    const s = build({
      name: 'again',
      actions: [
        { kind: 'doubleClick', x: 50, y: 60 },
        { kind: 'type', text: 'x' },
        { kind: 'key', key: 'Ctrl+S' }
      ]
    })
    const view = toAgentScenarioView(s)
    const again = buildAgentScenario({ name: view.name, actions: view.actions }, MAIN, s.id, NOW)
    expect(again.actions).toEqual(s.actions)
  })

  it('reads the timing of a stored scenario through the clamping accessors', () => {
    const s = build({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1 }] })
    s.actions[0].durationMs = 1 // stored garbage below the click minimum
    expect(toAgentScenarioView(s).actions[0]).toMatchObject({ durationMs: 200 })
  })
})
