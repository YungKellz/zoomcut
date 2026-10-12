import { describe, expect, it } from 'vitest'
import { AgentError, type AgentScenarioInput } from './agent'
import { AGENT_SCROLL_MAX_NOTCHES, buildAgentScenario, toAgentScenarioView, type AgentDisplay } from './agentScenario'
import { agentScenarioInputSchema } from './agentSchemas'
import { SCENARIO_MAX_MS } from './defaults'
import {
  DEFAULT_PAUSE_MS,
  DURATION_MAX_MS,
  PAUSE_MAX_MS,
  actionDurationMs,
  compileScenario,
  defaultDurationMs,
  groupRawEvents,
  isHoverOnly,
  migrateScenario,
  minDurationMs,
  scenarioEnd,
  scenarioSchedule,
  setActionHoverOnly,
  type RawInputEvent
} from './scenario'
import type { Scenario, ScenarioAction, ScenarioModifiers } from './types'

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

  it('builds a position-only click that replays as a pointer move and nothing else', () => {
    const s = build({
      name: 'hover',
      actions: [
        { kind: 'click', x: 640, y: 360, hoverOnly: true },
        { kind: 'rightClick', x: 20, y: 30, hoverOnly: true, durationMs: 50 },
        { kind: 'click', x: 50, y: 50, hoverOnly: false },
        { kind: 'click', x: 60, y: 60 }
      ]
    })
    expect(s.actions.map(isHoverOnly)).toEqual([true, true, false, false])
    expect(s.actions[0]).toMatchObject({ kind: 'click', hoverOnly: true, durationMs: 1000 })
    // a hover is held to its own, shorter minimum
    expect(s.actions[1]).toMatchObject({ kind: 'rightClick', hoverOnly: true, durationMs: 150 })
    expect(s.actions[1].durationMs).toBe(minDurationMs(s.actions[1]))
    // only a real true is stored
    expect('hoverOnly' in s.actions[2]).toBe(false)
    expect('hoverOnly' in s.actions[3]).toBe(false)
    const steps = compileScenario(s.actions.slice(0, 2), { startPos: s.startPoint! })
    expect(steps.filter((x) => x.op === 'down' || x.op === 'up' || x.op === 'key')).toEqual([])
    expect(steps.filter((x) => x.op === 'move').length).toBeGreaterThan(0)
  })

  it('builds a drag with modifiers like a captured Shift-drag', () => {
    const s = build({
      name: 'drag',
      actions: [
        { kind: 'drag', x: 10, y: 10, toX: 200, toY: 100, modifiers: ['shift', 'alt'] },
        { kind: 'drag', x: 10, y: 10, toX: 200, toY: 100 }
      ]
    })
    expect(s.actions[0].modifiers).toEqual({ ctrl: false, shift: true, alt: true, meta: false })
    expect(s.actions[1].modifiers).toEqual({ ctrl: false, shift: false, alt: false, meta: false })
    const keys = compileScenario([s.actions[0]], { startPos: s.startPoint! }).filter((x) => x.op === 'key')
    // Shift and Alt go down before the button and up after it
    expect(keys.map((x) => (x.op === 'key' ? [x.vk, x.down] : null))).toEqual([
      [0x10, true],
      [0x12, true],
      [0x10, false],
      [0x12, false]
    ])
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

  it('uses the given timing, raised to the kind minimum, and the defaults otherwise', () => {
    const s = build({
      name: 'timing',
      actions: [
        { kind: 'click', x: 5, y: 5, durationMs: 2000, pauseMs: 250 },
        { kind: 'click', x: 5, y: 5, durationMs: 10, pauseMs: 0 },
        { kind: 'click', x: 5, y: 5, durationMs: 60_000, pauseMs: 60_000 },
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

    it('checks the point that is stored, not the one that was given', () => {
      // 1919.5 rounds to 1920, the first column of the next monitor; -0.4 rounds to 0, the first column of this one
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1919.5, y: 0 }] }))).toContain('outside the display')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 0, y: 1079.5 }] }))).toContain('outside the display')
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'drag', x: 0, y: 0, toX: 1919.5, toY: 1079.49 }] }))).toContain('toX, toY')
      const s = build({
        name: 'x',
        actions: [
          { kind: 'click', x: 1919.49, y: 1079.4 },
          { kind: 'click', x: -0.4, y: -0.49 }
        ]
      })
      expect(s.actions.map((a) => [a.x, a.y])).toEqual([
        [1919, 1079],
        [0, 0]
      ])
      // on a display that is not at the origin the stored point stays inside it too
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'click', x: 1279.5, y: 0 }] }, SECOND))).toContain('1280x720')
      expect(build({ name: 'x', actions: [{ kind: 'click', x: 1279.4, y: 719.4 }] }, SECOND).actions[0]).toMatchObject({ x: 1920 + 1279, y: -200 + 719 })
    })

    it('rejects a duration or pause over the limit instead of shortening it', () => {
      const one = (extra: Record<string, unknown>): AgentScenarioInput => ({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1, ...extra } as never] })
      expect(() => build(one({ durationMs: DURATION_MAX_MS, pauseMs: PAUSE_MAX_MS }))).not.toThrow()
      expect(failure(() => build(one({ durationMs: DURATION_MAX_MS + 1 })))).toMatch(/actions\[0\].*durationMs may be at most 60000 ms/)
      expect(failure(() => build(one({ durationMs: 999_999 })))).toContain('durationMs')
      expect(failure(() => build(one({ pauseMs: PAUSE_MAX_MS + 1 })))).toMatch(/actions\[0\].*pauseMs may be at most 60000 ms/)
      // a long text typed at a slow speed is the case that used to come out 2.5 times faster than asked
      const text = 'x'.repeat(1000)
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'type', text, durationMs: 150_000 }] }))).toContain('durationMs may be at most 60000 ms')
      // while the default for such a text is capped at the limit, as the schema says
      expect(build({ name: 'x', actions: [{ kind: 'type', text }] }).actions[0].durationMs).toBe(DURATION_MAX_MS)
    })

    it('lets a very long scroll take the minimum it needs, and no longer', () => {
      // 1500 notches need over 99 s: replay never goes faster, so that is the limit of such a scroll (not 60 s)
      const input = (durationMs?: number): AgentScenarioInput => ({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaY: 1500, durationMs }] })
      const floor = build(input()).actions[0].durationMs
      expect(floor).toBeGreaterThan(DURATION_MAX_MS)
      expect(build(input(floor)).actions[0].durationMs).toBe(floor)
      expect(build(input(1000)).actions[0].durationMs).toBe(floor)
      expect(failure(() => build(input(floor + 1)))).toMatch(new RegExp(`at most ${floor} ms for a scroll`))
    })

    it('the most notches a scroll takes are the most that replay within the scenario limit', () => {
      const scroll = (n: number) => build({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaY: n, pauseMs: 0 }] })
      const s = scroll(AGENT_SCROLL_MAX_NOTCHES)
      expect(scenarioEnd(s.actions)).toBeLessThanOrEqual(SCENARIO_MAX_MS)
      expect(minDurationMs({ ...s.actions[0], deltaY: AGENT_SCROLL_MAX_NOTCHES + 1 } as ScenarioAction)).toBeGreaterThan(SCENARIO_MAX_MS)
      expect(failure(() => scroll(AGENT_SCROLL_MAX_NOTCHES + 1))).toContain('notches')
    })

    it('rejects a position-only flag that is not a boolean, and modifiers on a hover', () => {
      const click = (extra: Record<string, unknown>): AgentScenarioInput => ({ name: 'x', actions: [{ kind: 'click', x: 1, y: 1, ...extra } as never] })
      expect(failure(() => build(click({ hoverOnly: 'yes' })))).toContain('hoverOnly must be true or false')
      expect(failure(() => build(click({ hoverOnly: 1 })))).toContain('hoverOnly must be true or false')
      expect(failure(() => build(click({ hoverOnly: true, modifiers: ['ctrl'] })))).toMatch(/actions\[0\].*cannot have modifiers/)
      expect(() => build(click({ hoverOnly: true, modifiers: [] }))).not.toThrow()
      expect(() => build(click({ hoverOnly: false, modifiers: ['ctrl'] }))).not.toThrow()
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
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaY: AGENT_SCROLL_MAX_NOTCHES + 1 }] }))).toContain(`at most ${AGENT_SCROLL_MAX_NOTCHES} notches`)
      expect(failure(() => build({ name: 'x', actions: [{ kind: 'scroll', x: 1, y: 1, deltaX: -AGENT_SCROLL_MAX_NOTCHES - 1 }] }))).toContain('deltaX')
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

// ---- a scenario a person captured, through get_scenario and back into create_scenario ----

const NONE: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }
const mods = (over: Partial<ScenarioModifiers>): ScenarioModifiers => ({ ...NONE, ...over })

function down(id: string, t: number, x: number, y: number, m = NONE, button: 'left' | 'right' | 'middle' = 'left'): RawInputEvent {
  return { id, t, type: 'down', button, x, y, mods: m, shot: null }
}
function up(t: number, x: number, y: number, m = NONE, button: 'left' | 'right' | 'middle' = 'left'): RawInputEvent {
  return { t, type: 'up', button, x, y, mods: m }
}
function wheel(id: string, t: number, rotation: number, horizontal = false): RawInputEvent {
  return { id, t, type: 'wheel', rotation, horizontal, x: 700, y: 300, mods: NONE }
}
function keyEvent(id: string, t: number, scan: number, vk: number, over: { extended?: boolean; text?: string | null; mods?: ScenarioModifiers } = {}): RawInputEvent {
  return { id, t, type: 'key', scan, vk, extended: over.extended ?? false, text: over.text ?? null, mods: over.mods ?? NONE, x: 400, y: 300 }
}

/** A stored scenario as a capture leaves it: the raw input grouped, default timing, the hover switched on in the review screen. */
function captured(raw: RawInputEvent[], hoverIds: string[] = []): Scenario {
  let actions = groupRawEvents(raw)
  for (const id of hoverIds) actions = setActionHoverOnly(actions, id, true)
  return {
    version: 2,
    id: 'cap',
    name: 'Captured',
    createdAt: NOW,
    displayId: MAIN.id,
    displayBounds: { ...MAIN.bounds },
    scaleFactor: 1,
    actions,
    startPoint: { x: 960, y: 540 },
    durationMs: 60_000,
    dir: 'C:\scenarios\cap'
  }
}

/** what an agent does: read the view, drop the per-action id (the input schema is strict), send it back */
function viaAgentApi(scenario: Scenario): Scenario {
  const view = toAgentScenarioView(scenario)
  const input = { name: view.name, actions: view.actions.map(({ id: _id, ...action }) => action) }
  return buildAgentScenario(agentScenarioInputSchema.parse(input), MAIN, scenario.id, NOW)
}

function steps(s: Scenario) {
  return compileScenario(s, { startPos: s.startPoint! })
}

describe('a captured scenario through get_scenario and back into create_scenario', () => {
  const raw: RawInputEvent[] = [
    // a Ctrl+click, and a click on a button the review screen then switched to "position only"
    down('c1', 1000, 100, 100, mods({ ctrl: true })),
    up(1050, 100, 100, mods({ ctrl: true })),
    down('h1', 3000, 200, 200, mods({ ctrl: true })),
    up(3050, 200, 200, mods({ ctrl: true })),
    // a Shift+drag
    down('d1', 5000, 300, 300, mods({ shift: true })),
    up(5600, 500, 400, mods({ shift: true })),
    down('r1', 7000, 600, 600, NONE, 'right'),
    up(7040, 600, 600, NONE, 'right'),
    // 150 notches down and 3 to the left, merged into one scroll
    ...Array.from({ length: 150 }, (_, i) => wheel(`w${i}`, 9000 + i * 10, 1)),
    ...Array.from({ length: 3 }, (_, i) => wheel(`x${i}`, 10_600 + i * 10, -1, true)),
    // typed text
    ...[...'hello'].map((ch, i) => keyEvent(`t${i}`, 12_000 + i * 100, 0x23 + i, ch.toUpperCase().charCodeAt(0), { text: ch })),
    // keys a capture has other names for than the chords an agent writes
    keyEvent('k1', 20_000, 28, 0x0d, { extended: true }), // NumpadEnter
    keyEvent('k2', 22_000, 76, 0x65), // Numpad5
    keyEvent('k3', 24_000, 69, 0x90), // NumLock
    keyEvent('k4', 26_000, 70, 0x91), // ScrollLock
    keyEvent('k5', 28_000, 86, 0xe2), // the ISO backslash key: the capture calls it "Key86"
    keyEvent('k6', 30_000, 78, 0x6b, { mods: mods({ ctrl: true }) }), // Ctrl+Numpad+
    keyEvent('k7', 32_000, 93, 0x5d, { extended: true }), // the Menu key, "Key93" in the capture
    keyEvent('k8', 34_000, 31, 0x53, { mods: mods({ ctrl: true }) }), // Ctrl+S
    // media keys: libuiohook's 0xE030 is scancode 0x30 with the extended prefix, which on its own is the B key
    keyEvent('m1', 36_000, 0x30, 0xaf, { extended: true }), // Volume Up, "Key48" in the capture
    keyEvent('m2', 38_000, 0x2e, 0xae, { extended: true, mods: mods({ shift: true }) }), // Shift+Volume Down
    keyEvent('m3', 40_000, 0x20, 0xad, { extended: true }), // Mute
    keyEvent('m4', 42_000, 0x22, 0xb3, { extended: true }), // Play/Pause
    keyEvent('m5', 44_000, 0x19, 0xb0, { extended: true }), // Next track
    keyEvent('m6', 46_000, 0x10, 0xb1, { extended: true }), // Previous track
    keyEvent('m7', 48_000, 0x24, 0xb2, { extended: true }), // Stop
    // a layout where the scancode of Q types "a", the numpad keys as the layout lookup maps them, a lookup that timed out
    keyEvent('l1', 50_000, 0x10, 0x41, { mods: mods({ ctrl: true }) }), // Ctrl+A on AZERTY
    keyEvent('l2', 52_000, 76, 0x0c), // Numpad5 without NumLock: VK_CLEAR
    keyEvent('l3', 54_000, 0x30, 0), // no virtual key: not B
    keyEvent('l4', 56_000, 0x30, 0, { extended: true }) // no virtual key, extended: not Volume Up either
  ]

  it('is described the way the replay treats it', () => {
    const view = toAgentScenarioView(captured(raw, ['h1']))
    const byId = Object.fromEntries(view.actions.map((a) => [a.id, a]))
    // the hover reports itself as one, and no modifiers (replay presses none for it)
    expect(byId['h1']).toMatchObject({ kind: 'click', x: 200, y: 200, hoverOnly: true })
    expect('modifiers' in byId['h1']).toBe(false)
    expect(byId['c1']).toMatchObject({ kind: 'click', modifiers: ['ctrl'] })
    expect('hoverOnly' in byId['c1']).toBe(false)
    expect(byId['d1']).toMatchObject({ kind: 'drag', x: 300, y: 300, toX: 500, toY: 400, modifiers: ['shift'] })
    expect(byId['r1']).toMatchObject({ kind: 'rightClick' })
    expect(byId['w0']).toMatchObject({ kind: 'scroll', deltaY: 150, deltaX: -3 })
    expect(view.actions.filter((a) => a.kind === 'key').map((a) => (a.kind === 'key' ? a.key : ''))).toEqual([
      // the keys of the table by name, every other one by scancode, "e" for the extended ones and "@" its virtual key
      'NumpadEnter', 'Numpad5', 'NumLock', 'ScrollLock', 'IntlBackslash', 'Ctrl+Numpad+', 'Menu', 'Ctrl+S',
      'Key48e@175', 'Shift+Key46e@174', 'Key32e@173', 'Key34e@179', 'Key25e@176', 'Key16e@177', 'Key36e@178',
      'Ctrl+Key16@65', 'Key76@12', 'Key48', 'Key48e'
    ])
  })

  it('is accepted again and replays the same', () => {
    const original = captured(raw, ['h1'])
    const again = viaAgentApi(original)
    expect(again.actions).toHaveLength(original.actions.length)
    expect(steps(again)).toEqual(steps(original))
    expect(scenarioEnd(again.actions)).toBe(scenarioEnd(original.actions))
    // the hover is still a hover, the drag still holds Shift
    expect(again.actions.map(isHoverOnly)).toEqual(original.actions.map(isHoverOnly))
    expect(again.actions.find((a) => a.kind === 'drag')?.modifiers).toEqual(mods({ shift: true }))
  })

  it('gives every key back with the same virtual key, scancode, extended flag and modifiers', () => {
    const original = captured(raw)
    const again = viaAgentApi(original)
    const keys = (s: Scenario) =>
      s.actions.flatMap((a) => (a.kind === 'key' ? [{ vk: a.vk, scan: a.scan, extended: a.extended, modifiers: a.modifiers }] : []))
    expect(keys(original)).toHaveLength(19)
    expect(keys(again)).toEqual(keys(original))
    // the media keys in particular: a replay presses Volume Up, not the B key
    expect(keys(again)).toContainEqual({ vk: 0xaf, scan: 0x30, extended: true, modifiers: NONE })
    expect(keys(again).filter((k) => k.vk === 0x42)).toEqual([])
  })

  it('keeps a scroll of more notches than anyone scripts, with the time it needs', () => {
    const original = captured([
      ...Array.from({ length: 1500 }, (_, i) => wheel(`w${i}`, 1000 + i, 1)),
      ...Array.from({ length: 1000 }, (_, i) => wheel(`v${i}`, 3000 + i, -1))
    ])
    expect(original.actions).toHaveLength(2)
    const [first, second] = original.actions
    expect(first).toMatchObject({ kind: 'scroll', deltaY: 1500 })
    expect(actionDurationMs(first)).toBeGreaterThan(DURATION_MAX_MS)
    expect(second).toMatchObject({ kind: 'scroll', deltaY: -1000 })
    const again = viaAgentApi(original)
    expect(again.actions.map(actionDurationMs)).toEqual(original.actions.map(actionDurationMs))
    expect(steps(again)).toEqual(steps(original))
  })
})
