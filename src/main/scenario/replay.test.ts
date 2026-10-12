import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Display } from 'electron'
import type { Scenario, ScenarioAction } from '@shared/types'

// ReplaySession with everything that touches the machine stubbed: no PowerShell helper (a fake
// process that says `R`), no input hook, no real windows. What is checked is the session's own
// bookkeeping - the busy count the preview relies on and the overlay's ready handshake.
const h = vi.hoisted(() => ({
  startHelper: vi.fn(),
  overlays: [] as unknown[],
  mainSend: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  screen: { dipToScreenPoint: (p: { x: number; y: number }) => p }
}))
vi.mock('../windows', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    getMainWindow: () => ({ webContents: { send: h.mainSend } }),
    createOverlayWindow: () => {
      const win = Object.assign(new Emitter(), {
        destroyed: false,
        webContents: { send: vi.fn(), ipc: new Emitter() },
        isDestroyed(): boolean {
          return win.destroyed
        },
        close(): void {
          win.destroyed = true
          win.emit('closed')
        }
      })
      h.overlays.push(win)
      return win
    }
  }
})
vi.mock('./hook', () => ({ acquireHook: async () => null, releaseHook: vi.fn() }))
vi.mock('./inputHelper', () => ({ startReplayHelper: h.startHelper, releaseAllInputs: vi.fn(async () => undefined) }))

import { ReplaySession } from './replay'

interface FakeOverlay extends EventEmitter {
  webContents: { send: ReturnType<typeof vi.fn>; ipc: EventEmitter }
}

/** a helper process that is ready at once and exits when killed */
function fakeHelper(): EventEmitter {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: { write: vi.fn() },
    exitCode: null as number | null,
    killed: false,
    kill(): boolean {
      proc.killed = true
      proc.exitCode = 1
      proc.emit('exit')
      return true
    }
  })
  proc.stdout.write('R\n')
  return proc
}

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as unknown as Display
const NO_MODS = { ctrl: false, shift: false, alt: false, meta: false }

function scenario(): Scenario {
  const click = { id: 'a', kind: 'click', at: 0, x: 10, y: 20, path: [], modifiers: NO_MODS, shot: null, durationMs: 1000, pauseMs: 1500 } as ScenarioAction
  return {
    version: 2,
    id: 'sc',
    name: 'Scenario',
    createdAt: 1,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: [click],
    durationMs: 2500,
    dir: 'C:/scenarios/sc'
  }
}

const callbacks = { onProgress: vi.fn(), onDone: vi.fn(), onAbort: vi.fn(), onError: vi.fn() }

beforeEach(() => {
  h.overlays.length = 0
  h.mainSend.mockClear()
  h.startHelper.mockReset()
  h.startHelper.mockImplementation(async () => fakeHelper())
})

describe('ReplaySession: busy from the start of create() until dispose()', () => {
  it('counts while the helper starts and while the session lives, never twice down', async () => {
    expect(ReplaySession.isAnyActive()).toBe(false)
    const created = ReplaySession.create(DISPLAY, scenario(), callbacks)
    // before the steps are even written: a recording's prepare() is busy from here on
    expect(ReplaySession.isAnyActive()).toBe(true)
    const session = await created
    expect(ReplaySession.isAnyActive()).toBe(true)
    session.dispose()
    expect(ReplaySession.isAnyActive()).toBe(false)
    session.dispose()
    // a second dispose() gave nothing back twice: the next session still counts
    const next = await ReplaySession.create(DISPLAY, scenario(), callbacks)
    expect(ReplaySession.isAnyActive()).toBe(true)
    next.dispose()
    expect(ReplaySession.isAnyActive()).toBe(false)
  })

  it('a helper that does not start gives the count back', async () => {
    h.startHelper.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(ReplaySession.create(DISPLAY, scenario(), callbacks)).rejects.toThrow('spawn failed')
    expect(ReplaySession.isAnyActive()).toBe(false)
    // its overlay was never opened
    expect(h.overlays).toHaveLength(0)
  })
})

describe('ReplaySession: the overlay asks for the state once its page is subscribed', () => {
  it('answers with the current state, and whenOverlayReady() resolves', async () => {
    const session = await ReplaySession.create(DISPLAY, scenario(), callbacks, { preview: true })
    const overlay = h.overlays[0] as FakeOverlay
    // sent right after the window was created, i.e. before its page could listen
    expect(overlay.webContents.send).toHaveBeenCalledWith('recording:replay-state', { phase: 'ready', index: 0, total: 1, preview: true })
    overlay.webContents.send.mockClear()
    let ready = false
    void session.whenOverlayReady(60_000).then(() => (ready = true))
    await Promise.resolve()
    expect(ready).toBe(false)

    overlay.webContents.ipc.emit('overlay:ready', {})
    expect(overlay.webContents.send).toHaveBeenCalledTimes(1)
    expect(overlay.webContents.send).toHaveBeenCalledWith('recording:replay-state', { phase: 'ready', index: 0, total: 1, preview: true })
    await vi.waitFor(() => expect(ready).toBe(true))
    // the main window hears about a preview on its own channel
    expect(h.mainSend).toHaveBeenCalledWith('scenario:preview-state', { phase: 'ready', index: 0, total: 1, preview: true })
    session.dispose()
  })

  it('never holds the replay up: resolves after the timeout, or when the overlay is gone', async () => {
    const session = await ReplaySession.create(DISPLAY, scenario(), callbacks)
    await expect(session.whenOverlayReady(10)).resolves.toBeUndefined()
    const overlay = h.overlays[0] as FakeOverlay & { close(): void }
    const waiting = session.whenOverlayReady(60_000)
    overlay.close()
    await expect(waiting).resolves.toBeUndefined()
    session.dispose()
    await expect(session.whenOverlayReady(60_000)).resolves.toBeUndefined()
  })
})
