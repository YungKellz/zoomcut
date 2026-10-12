/**
 * Scenarios written by an AI agent: AgentScenarioInput (display-relative DIP coordinates, a key as
 * "Ctrl+S") → a stored Scenario v2 that replays exactly like a captured one, and back
 * (toAgentScenarioView). Pure: ids and the clock come in as arguments, nothing is saved here.
 * Timing, key resolution and validation limits all come from shared/scenario.ts and agentKeys.ts.
 */
import {
  AgentError,
  type AgentModifier,
  type AgentScenarioInput,
  type AgentScenarioView
} from './agent'
import { parseKeyChord } from './agentKeys'
import { SCENARIO_MAX_MS } from './defaults'
import {
  DEFAULT_PAUSE_MS,
  DURATION_MAX_MS,
  PAUSE_MAX_MS,
  SCENARIO_VERSION,
  actionDurationMs,
  actionPauseMs,
  defaultDurationMs,
  graphemes,
  isHoverOnly,
  minDurationMs,
  scenarioEnd,
  scenarioSchedule,
  stripControlChars,
  validateScenario
} from './scenario'
import type { Rect, Scenario, ScenarioAction, ScenarioModifiers, ScenarioPoint } from './types'

export interface AgentDisplay {
  id: number
  /** DIP bounds on the virtual desktop */
  bounds: Rect
  scaleFactor: number
}

export const AGENT_SCENARIO_MAX_ACTIONS = 500
export const AGENT_SCENARIO_NAME_MAX = 120
export const AGENT_TYPE_MAX_CHARS = 1000
/**
 * wheel notches per axis in one scroll action: the most one scroll can replay within SCENARIO_MAX_MS at
 * the 40 ms a notch needs. Far more than anyone scripts, but a capture merges every wheel event less
 * than 400 ms apart into one scroll, and what get_scenario returns for it has to be accepted again.
 */
export const AGENT_SCROLL_MAX_NOTCHES = 9000
/** a scroll without deltas scrolls this many notches down */
export const AGENT_DEFAULT_SCROLL_NOTCHES = 3

const POINTER_KINDS = ['click', 'doubleClick', 'rightClick', 'middleClick'] as const
const ALL_KINDS = [...POINTER_KINDS, 'drag', 'scroll', 'type', 'key'] as const
const MODIFIERS: readonly AgentModifier[] = ['ctrl', 'shift', 'alt', 'meta']
const NO_MODIFIERS: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }

function bad(message: string): never {
  throw new AgentError('bad_params', message)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(where: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${where}: ${field} must be a number`)
  return v
}

/**
 * A display-relative DIP point, checked against the display and moved onto the virtual desktop. The
 * point that is checked is the one that is stored (whole DIP): 1919.5 on a 1920 wide display would
 * round to the first column of the next monitor.
 */
function absolutePoint(where: string, a: Record<string, unknown>, xField: string, yField: string, bounds: Rect): ScenarioPoint {
  const x = finite(where, xField, a[xField])
  const y = finite(where, yField, a[yField])
  const rx = Math.round(x)
  const ry = Math.round(y)
  if (rx < 0 || rx >= bounds.width || ry < 0 || ry >= bounds.height) {
    bad(`${where}: (${xField}, ${yField}) = (${x}, ${y}) is outside the display, which is ${bounds.width}x${bounds.height} DIP (0,0 is its top-left corner)`)
  }
  return { x: bounds.x + rx, y: bounds.y + ry }
}

/** durationMs / pauseMs as given: a number, not negative, and a pause within its limit. A duration is checked once the action is known (durationLimit). */
function timing(where: string, a: Record<string, unknown>, field: 'durationMs' | 'pauseMs'): number | undefined {
  const v = a[field]
  if (v === undefined) return undefined
  const n = finite(where, field, v)
  if (n < 0) bad(`${where}: ${field} must not be negative`)
  if (field === 'pauseMs' && Math.round(n) > PAUSE_MAX_MS) bad(`${where}: pauseMs may be at most ${PAUSE_MAX_MS} ms`)
  return n
}

/**
 * The longest durationMs an action may be given: one minute, or the action's own shortest duration
 * when that is longer (a scroll of over 900 notches). Replay never goes faster than the shortest,
 * so that is what such an action takes and what get_scenario reports for it.
 */
function durationLimit(action: ScenarioAction): number {
  return Math.max(DURATION_MAX_MS, minDurationMs(action))
}

function hoverOnlyOf(where: string, raw: unknown): boolean {
  if (raw === undefined) return false
  if (typeof raw !== 'boolean') bad(`${where}: hoverOnly must be true or false`)
  return raw
}

function modifiersOf(where: string, raw: unknown): ScenarioModifiers {
  if (raw === undefined) return { ...NO_MODIFIERS }
  if (!Array.isArray(raw)) bad(`${where}: modifiers must be an array of ${MODIFIERS.join(', ')}`)
  const out = { ...NO_MODIFIERS }
  for (const m of raw) {
    if (!MODIFIERS.includes(m as AgentModifier)) bad(`${where}: unknown modifier "${String(m)}", use ${MODIFIERS.join(', ')}`)
    out[m as AgentModifier] = true
  }
  return out
}

function notches(where: string, a: Record<string, unknown>, field: 'deltaY' | 'deltaX'): number {
  const v = a[field]
  if (v === undefined) return 0
  const n = Math.round(finite(where, field, v))
  if (Math.abs(n) > AGENT_SCROLL_MAX_NOTCHES) bad(`${where}: ${field} may be at most ${AGENT_SCROLL_MAX_NOTCHES} notches either way`)
  return n
}

/**
 * Builds the stored scenario for `input`, to be replayed on `display`. Coordinates in the input
 * are DIP relative to the display's top-left; they are checked against the display and stored on
 * the virtual desktop like a capture does. Durations and pauses are the given ones or the same
 * defaults a capture gets; a duration below the kind's minimum (shared/scenario.ts minDurationMs)
 * is raised to it, one above the maximum is an error, never a quietly shorter action.
 * `dir` is left empty: the storage layer fills it in. Throws AgentError('bad_params').
 */
export function buildAgentScenario(input: AgentScenarioInput, display: AgentDisplay, id: string, now: number): Scenario {
  if (!isRecord(input)) bad('The scenario must be an object with a name and actions')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') bad('The scenario needs a name')
  if (name.length > AGENT_SCENARIO_NAME_MAX) bad(`The scenario name may be at most ${AGENT_SCENARIO_NAME_MAX} characters`)
  const rawActions: unknown = input.actions
  if (!Array.isArray(rawActions) || rawActions.length === 0) bad('The scenario needs at least one action')
  if (rawActions.length > AGENT_SCENARIO_MAX_ACTIONS) bad(`A scenario may have at most ${AGENT_SCENARIO_MAX_ACTIONS} actions`)

  const bounds = display.bounds
  const start: ScenarioPoint = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  }
  // where the cursor is after the actions so far: type and key never move it, and are drawn there
  let cursor: ScenarioPoint = start

  const actions: ScenarioAction[] = rawActions.map((raw: unknown, i): ScenarioAction => {
    const where = `actions[${i}]`
    if (!isRecord(raw)) bad(`${where} must be an object`)
    const kind = raw['kind']
    if (typeof kind !== 'string' || !(ALL_KINDS as readonly string[]).includes(kind)) {
      bad(`${where}: unknown kind ${JSON.stringify(kind)}, use one of ${ALL_KINDS.join(', ')}`)
    }
    const durationMs = timing(where, raw, 'durationMs')
    const pauseMs = timing(where, raw, 'pauseMs')
    const common = { id: `a${i + 1}`, at: 0, path: [], shot: null, durationMs: 0, pauseMs: 0 }
    let action: ScenarioAction

    switch (kind as (typeof ALL_KINDS)[number]) {
      case 'click':
      case 'doubleClick':
      case 'rightClick':
      case 'middleClick': {
        const p = absolutePoint(where, raw, 'x', 'y', bounds)
        const modifiers = modifiersOf(where, raw['modifiers'])
        const hoverOnly = hoverOnlyOf(where, raw['hoverOnly'])
        if (hoverOnly && MODIFIERS.some((m) => modifiers[m])) {
          bad(`${where}: a hoverOnly click presses nothing, not even a modifier key, so it cannot have modifiers`)
        }
        action = { ...common, kind: kind as (typeof POINTER_KINDS)[number], ...p, modifiers, ...(hoverOnly ? { hoverOnly: true } : {}) }
        cursor = p
        break
      }
      case 'drag': {
        const p = absolutePoint(where, raw, 'x', 'y', bounds)
        const to = absolutePoint(where, raw, 'toX', 'toY', bounds)
        action = { ...common, kind: 'drag', ...p, modifiers: modifiersOf(where, raw['modifiers']), toX: to.x, toY: to.y, dragPath: [] }
        cursor = to
        break
      }
      case 'scroll': {
        const p = absolutePoint(where, raw, 'x', 'y', bounds)
        let deltaY = notches(where, raw, 'deltaY')
        const deltaX = notches(where, raw, 'deltaX')
        if (raw['deltaY'] === undefined && raw['deltaX'] === undefined) deltaY = AGENT_DEFAULT_SCROLL_NOTCHES
        if (deltaY === 0 && deltaX === 0) bad(`${where}: a scroll needs a non-zero deltaY or deltaX (wheel notches, positive = down / right)`)
        action = { ...common, kind: 'scroll', ...p, modifiers: { ...NO_MODIFIERS }, deltaY, deltaX }
        cursor = p
        break
      }
      case 'type': {
        const text = raw['text']
        if (typeof text !== 'string' || text === '') bad(`${where}: text must be a non-empty string`)
        if (stripControlChars(text) !== text) {
          bad(`${where}: text must not contain control characters (newline, tab, ...); use separate key actions "Enter" / "Tab" for those`)
        }
        if (graphemes(text).length > AGENT_TYPE_MAX_CHARS) bad(`${where}: text may be at most ${AGENT_TYPE_MAX_CHARS} characters; split it into several type actions`)
        action = { ...common, kind: 'type', ...cursor, modifiers: { ...NO_MODIFIERS }, text }
        break
      }
      case 'key': {
        const key = raw['key']
        if (typeof key !== 'string') bad(`${where}: key must be a string like "Enter" or "Ctrl+S"`)
        let chord
        try {
          chord = parseKeyChord(key)
        } catch (err) {
          if (err instanceof AgentError) bad(`${where}: ${err.message}`)
          throw err
        }
        action = {
          ...common,
          kind: 'key',
          ...cursor,
          modifiers: chord.modifiers,
          key: chord.key,
          vk: chord.vk,
          scan: chord.scan,
          extended: chord.extended
        }
        break
      }
    }

    // stored as the effective values: the same clamping actionDurationMs / actionPauseMs apply on every read.
    // A duration is raised to the kind's minimum like there, but never lowered: more than the limit is an error
    if (durationMs !== undefined && Math.round(durationMs) > durationLimit(action)) {
      const limit = durationLimit(action)
      bad(`${where}: durationMs may be at most ${limit} ms${limit > DURATION_MAX_MS ? ' for a scroll this long' : ''}`)
    }
    action.durationMs = durationMs === undefined ? defaultDurationMs(action) : actionDurationMs({ ...action, durationMs })
    action.pauseMs = pauseMs === undefined ? DEFAULT_PAUSE_MS : actionPauseMs({ ...action, pauseMs })
    return action
  })

  const problem = validateScenario(actions)
  if (problem === 'tooLong') {
    bad(`The scenario would take ${Math.round(scenarioEnd(actions) / 1000)} s to replay; the limit is ${SCENARIO_MAX_MS / 1000} s. Shorten the pauses or split it`)
  }

  // `at` is the recorded time of a capture and only kept for ordering: use when the action takes effect
  const schedule = scenarioSchedule(actions)
  actions.forEach((a, i) => {
    a.at = schedule[i].effectAt
  })

  return {
    version: SCENARIO_VERSION,
    id,
    name,
    createdAt: now,
    displayId: display.id,
    displayBounds: { ...bounds },
    scaleFactor: display.scaleFactor,
    actions,
    startPoint: start,
    durationMs: scenarioEnd(actions),
    dir: ''
  }
}

function modifierList(m: ScenarioModifiers): AgentModifier[] {
  return MODIFIERS.filter((k) => m[k])
}

/** The agent's view of a stored scenario (captured or built): display-relative coordinates, effective timing, no paths or screenshots. */
export function toAgentScenarioView(scenario: Scenario): AgentScenarioView {
  const { x: ox, y: oy } = scenario.displayBounds
  const actions = scenario.actions.map((a): AgentScenarioView['actions'][number] => {
    const timing = { id: a.id, durationMs: actionDurationMs(a), pauseMs: actionPauseMs(a) }
    switch (a.kind) {
      case 'click':
      case 'doubleClick':
      case 'rightClick':
      case 'middleClick': {
        // a position-only click presses nothing, not even its modifiers (compileScenario), so none are reported
        if (isHoverOnly(a)) return { kind: a.kind, x: a.x - ox, y: a.y - oy, hoverOnly: true, ...timing }
        const modifiers = modifierList(a.modifiers)
        return { kind: a.kind, x: a.x - ox, y: a.y - oy, ...(modifiers.length > 0 ? { modifiers } : {}), ...timing }
      }
      case 'drag': {
        const modifiers = modifierList(a.modifiers)
        return { kind: 'drag', x: a.x - ox, y: a.y - oy, toX: a.toX - ox, toY: a.toY - oy, ...(modifiers.length > 0 ? { modifiers } : {}), ...timing }
      }
      case 'scroll':
        return { kind: 'scroll', x: a.x - ox, y: a.y - oy, deltaY: a.deltaY, deltaX: a.deltaX, ...timing }
      case 'type':
        return { kind: 'type', text: a.text, ...timing }
      case 'key':
        return { kind: 'key', key: a.key, ...timing }
    }
  })
  return {
    id: scenario.id,
    name: scenario.name,
    displayId: scenario.displayId,
    displayBounds: { ...scenario.displayBounds },
    durationMs: scenarioEnd(scenario.actions),
    actions
  }
}
