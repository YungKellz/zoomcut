import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scenario, ScenarioAction } from '@shared/types'
import type { ReplaySessionCallbacks, ReplaySessionOptions } from './replay'

// ScenarioPreview only talks to Electron's screen, the main window and ReplaySession. All three are
// stubbed: the real ReplaySession spawns the PowerShell helper and injects real input, which a unit
// test must never do. What is checked here is the preview's own part - that it drives that session
// exactly like a recording's replay does, and that every way out cleans up.
const h = vi.hoisted(() => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } }
  ]
  const win = {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false)
  }
  return { displays, win, create: vi.fn() }
})

vi.mock('electron', () => ({
  screen: { getAllDisplays: () => h.displays, getPrimaryDisplay: () => h.displays[0] }
}))
vi.mock('../windows', () => ({ getMainWindow: () => h.win }))
vi.mock('./replay', () => ({ ReplaySession: { create: h.create } }))

import { PREVIEW_GO_LEAD_MS, ScenarioPreview } from './preview'

const NO_MODS = { ctrl: false, shift: false, alt: false, meta: false }

function click(id: string, extra: Partial<ScenarioAction> = {}): ScenarioAction {
  return { id, kind: 'click', at: 0, x: 10, y: 20, path: [], modifiers: NO_MODS, shot: null, durationMs: 1000, pauseMs: 1500, ...extra } as ScenarioAction
}

function scenario(actions: ScenarioAction[] = [click('a'), click('b', { hoverOnly: true } as Partial<ScenarioAction>)], displayId = 2): Scenario {
  return {
    version: 2,
    id: 'sc',
    name: 'Scenario',
    createdAt: 1,
    displayId,
    displayBounds: { x: 1920, y: 0, width: 1280, height: 1024 },
    scaleFactor: 1,
    actions,
    durationMs: 5000,
    dir: 'C:/scenarios/sc'
  }
}

/** Stands in for ReplaySession: records what the preview does with it and lets a test fire its callbacks. */
class FakeSession {
  go = vi.fn()
  dispose = vi.fn()
  abort = vi.fn(async (reason: string) => {
    this.callbacks.onAbort(reason)
    return true
  })
  constructor(
    readonly display: unknown,
    readonly scenario: Scenario,
    readonly callbacks: ReplaySessionCallbacks,
    readonly options: ReplaySessionOptions | undefined
  ) {}
}

let sessions: FakeSession[] = []

function createResolving(): void {
  h.create.mockImplementation(async (display: unknown, sc: Scenario, callbacks: ReplaySessionCallbacks, options?: ReplaySessionOptions) => {
    const s = new FakeSession(display, sc, callbacks, options)
    sessions.push(s)
    return s
  })
}

/** lets start() get past its awaits */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  sessions = []
  h.create.mockReset()
  createResolving()
  for (const fn of [h.win.hide, h.win.show, h.win.focus, h.win.once, h.win.removeListener]) fn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ScenarioPreview: the same replay as a recording', () => {
  it('creates the replay session for the scenario on its own display, then starts it after the lead', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const preview = new ScenarioPreview()
    const input = scenario()
    void preview.start(input)
    await settle()
    expect(h.create).toHaveBeenCalledTimes(1)
    const [s] = sessions
    // RecordingController.prepare() does ReplaySession.create(display, options.scenario, callbacks):
    // same display choice, the same scenario (a normalized copy that equals it), only flagged as a preview
    expect(s.display).toBe(h.displays[1])
    expect(s.scenario).toEqual(input)
    expect(s.options).toEqual({ preview: true })
    // ... and RecordingController.started() does go(epoch): here the epoch is now + the lead
    expect(s.go).toHaveBeenCalledTimes(1)
    expect(s.go).toHaveBeenCalledWith(1_000_000 + PREVIEW_GO_LEAD_MS)
    expect(preview.isActive()).toBe(true)
    // the main window gets out of the way, like for a recording
    expect(h.win.hide).toHaveBeenCalledTimes(1)
    expect(h.win.show).not.toHaveBeenCalled()
  })

  it('falls back to the primary display when the scenario display is gone', async () => {
    const preview = new ScenarioPreview()
    void preview.start(scenario(undefined, 99))
    await settle()
    expect(sessions[0].display).toBe(h.displays[0])
  })

  it('hands the session a normalized scenario: stored garbage never reaches the replay', async () => {
    const preview = new ScenarioPreview()
    const messy = scenario([click('a', { pauseMs: Number.NaN, hoverOnly: 'yes' } as unknown as Partial<ScenarioAction>)])
    void preview.start(messy)
    await settle()
    const sent = sessions[0].scenario.actions[0]
    expect(sent.pauseMs).toBe(1500)
    expect('hoverOnly' in sent).toBe(false)
  })
})

describe('ScenarioPreview: every way out cleans up', () => {
  async function running(): Promise<{ preview: ScenarioPreview; result: Promise<unknown>; session: FakeSession }> {
    const preview = new ScenarioPreview()
    const result = preview.start(scenario())
    await settle()
    return { preview, result, session: sessions[0] }
  }

  it('finishing: disposes the session, brings the main window back and reports done', async () => {
    const { preview, result, session } = await running()
    session.callbacks.onDone()
    await expect(result).resolves.toEqual({ outcome: 'done' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(h.win.show).toHaveBeenCalledTimes(1)
    expect(h.win.focus).toHaveBeenCalledTimes(1)
    expect(preview.isActive()).toBe(false)
  })

  it('Escape (the session aborts itself): cleaned up the same way, reported as aborted', async () => {
    const { preview, result, session } = await running()
    session.callbacks.onAbort('escape')
    await expect(result).resolves.toEqual({ outcome: 'aborted' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(h.win.show).toHaveBeenCalledTimes(1)
    expect(preview.isActive()).toBe(false)
  })

  it('abort() (Stop on the review screen) goes through the session, like Escape', async () => {
    const { preview, result, session } = await running()
    await preview.abort()
    expect(session.abort).toHaveBeenCalledTimes(1)
    await expect(result).resolves.toEqual({ outcome: 'aborted' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('a helper crash: cleaned up, reported with its message', async () => {
    const { result, session } = await running()
    session.callbacks.onError('The replay helper exited unexpectedly')
    await expect(result).resolves.toEqual({ outcome: 'error', message: 'The replay helper exited unexpectedly' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(h.win.show).toHaveBeenCalledTimes(1)
  })

  it('the main window closing aborts the run', async () => {
    const { result, session } = await running()
    const [event, listener] = h.win.once.mock.calls[0] as [string, () => void]
    expect(event).toBe('closed')
    h.win.isDestroyed.mockReturnValueOnce(true)
    listener()
    await expect(result).resolves.toEqual({ outcome: 'aborted' })
    expect(session.abort).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('app quit: disposes the session and does not show the window again', async () => {
    const { preview, result, session } = await running()
    preview.dispose()
    await expect(result).resolves.toEqual({ outcome: 'aborted' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(h.win.show).not.toHaveBeenCalled()
    await expect(preview.start(scenario())).rejects.toThrow()
  })

  it('ends only once, whatever arrives after the first way out', async () => {
    const { result, session } = await running()
    session.callbacks.onDone()
    session.callbacks.onError('late')
    session.callbacks.onAbort('late')
    await expect(result).resolves.toEqual({ outcome: 'done' })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(h.win.show).toHaveBeenCalledTimes(1)
  })
})

describe('ScenarioPreview: starting', () => {
  it('refuses a second preview while one runs', async () => {
    const preview = new ScenarioPreview()
    void preview.start(scenario())
    await settle()
    await expect(preview.start(scenario())).rejects.toThrow(/already running/)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('refuses while a recording or a capture runs, and they see it as busy while it runs', async () => {
    const preview = new ScenarioPreview()
    preview.setOtherBusyCheck(() => true)
    await expect(preview.start(scenario())).rejects.toThrow(/in progress/)
    expect(h.create).not.toHaveBeenCalled()
    expect(preview.isActive()).toBe(false)

    preview.setOtherBusyCheck(() => false)
    void preview.start(scenario())
    // busy from the very start, before the helper is even ready
    expect(preview.isActive()).toBe(true)
  })

  it('refuses an empty or a too long scenario without starting anything', async () => {
    const preview = new ScenarioPreview()
    await expect(preview.start(scenario([]))).rejects.toThrow(/no actions/)
    await expect(preview.start(scenario([click('a', { pauseMs: 60_000 }), ...Array.from({ length: 10 }, (_, i) => click(`l${i}`, { pauseMs: 60_000 }))]))).rejects.toThrow(
      /longer than 10 minutes/
    )
    expect(h.create).not.toHaveBeenCalled()
    expect(preview.isActive()).toBe(false)
  })

  it('a helper that does not start: rejects, nothing hidden, free for the next attempt', async () => {
    h.create.mockRejectedValueOnce(new Error('replay helper did not become ready in time'))
    const preview = new ScenarioPreview()
    await expect(preview.start(scenario())).rejects.toThrow(/did not become ready/)
    expect(h.win.hide).not.toHaveBeenCalled()
    expect(preview.isActive()).toBe(false)
  })

  it('stopped while the helper is starting: the session is disposed as soon as it exists and never started', async () => {
    let finishCreate: () => void = () => undefined
    h.create.mockImplementationOnce(
      (display: unknown, sc: Scenario, callbacks: ReplaySessionCallbacks, options?: ReplaySessionOptions) =>
        new Promise((resolve) => {
          finishCreate = () => {
            const s = new FakeSession(display, sc, callbacks, options)
            sessions.push(s)
            resolve(s)
          }
        })
    )
    const preview = new ScenarioPreview()
    const result = preview.start(scenario())
    await settle()
    await preview.abort()
    finishCreate()
    await expect(result).resolves.toEqual({ outcome: 'aborted' })
    expect(sessions[0].go).not.toHaveBeenCalled()
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1)
    expect(h.win.hide).not.toHaveBeenCalled()
    expect(preview.isActive()).toBe(false)
  })

  it('a helper that fails right after it was ready: the session is disposed and never started', async () => {
    h.create.mockImplementationOnce(async (display: unknown, sc: Scenario, callbacks: ReplaySessionCallbacks, options?: ReplaySessionOptions) => {
      const s = new FakeSession(display, sc, callbacks, options)
      sessions.push(s)
      callbacks.onError('The replay helper exited unexpectedly')
      return s
    })
    const preview = new ScenarioPreview()
    await expect(preview.start(scenario())).resolves.toEqual({ outcome: 'error', message: 'The replay helper exited unexpectedly' })
    expect(sessions[0].go).not.toHaveBeenCalled()
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1)
    expect(h.win.hide).not.toHaveBeenCalled()
  })
})
