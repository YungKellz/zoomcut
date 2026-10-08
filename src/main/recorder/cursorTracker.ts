import { screen, type Display } from 'electron'
import type { UiohookKeyboardEvent, UiohookMouseEvent, UiohookWheelEvent } from 'uiohook-napi'
import type { CursorData, MouseButton } from '@shared/types'
import { buildInputMarks, type RawHookEvent } from '@shared/inputMarks'
import { acquireHook, releaseHook, type UioHook } from '../scenario/hook'

interface RawSample {
  t: number
  x: number
  y: number
}

interface RawClick extends RawSample {
  button: MouseButton
}

const POLL_HZ = 60

function buttonOf(e: UiohookMouseEvent): MouseButton {
  return e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left'
}

/**
 * Records the mouse while a recording is running.
 *
 * Positions come from polling `screen.getCursorScreenPoint()` at 60 Hz (device-independent
 * pixels, no DPI calibration needed). Clicks come from the shared global hook (scenario/hook.ts,
 * ref-counted since the scenario capture/replay may also want it live); when the hook cannot be
 * loaded the recording simply has no click ripples. The same hook's button / wheel / key events
 * are kept in memory (`input`, wall-clock times) and turned into the timeline's input tags at
 * stop() (shared/inputMarks.ts) - which keys were pressed is never stored, nor logged.
 */
export class CursorTracker {
  private samples: RawSample[] = []
  private clicks: RawClick[] = []
  private input: RawHookEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private hook: UioHook | null = null
  private onMouseDown: ((e: UiohookMouseEvent) => void) | null = null
  private onMouseUp: ((e: UiohookMouseEvent) => void) | null = null
  private onWheel: ((e: UiohookWheelEvent) => void) | null = null
  private onKeyDown: ((e: UiohookKeyboardEvent) => void) | null = null
  private onKeyUp: ((e: UiohookKeyboardEvent) => void) | null = null
  private display: Display | null = null
  private source: CursorData['source'] = 'none'

  async start(display: Display): Promise<void> {
    this.stopInternal()
    this.display = display
    this.samples = []
    this.clicks = []
    this.input = []
    this.source = 'polling'

    const poll = (): void => {
      const p = screen.getCursorScreenPoint()
      const last = this.samples[this.samples.length - 1]
      const t = Date.now()
      if (!last || last.x !== p.x || last.y !== p.y || t - last.t > 250) {
        this.samples.push({ t, x: p.x, y: p.y })
      }
    }
    poll()
    this.timer = setInterval(poll, Math.round(1000 / POLL_HZ))

    const hook = await acquireHook()
    if (hook) {
      this.hook = hook
      this.onMouseDown = (e) => {
        const p = screen.getCursorScreenPoint()
        const t = Date.now()
        const button = buttonOf(e)
        this.clicks.push({ t, x: p.x, y: p.y, button })
        this.input.push({ t, type: 'down', button, x: p.x, y: p.y, clicks: e.clicks })
      }
      this.onMouseUp = (e) => {
        const p = screen.getCursorScreenPoint()
        this.input.push({ t: Date.now(), type: 'up', button: buttonOf(e), x: p.x, y: p.y })
      }
      this.onWheel = () => {
        this.input.push({ t: Date.now(), type: 'wheel' })
      }
      this.onKeyDown = (e) => {
        this.input.push({ t: Date.now(), type: 'keydown', keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
      }
      this.onKeyUp = (e) => {
        this.input.push({ t: Date.now(), type: 'keyup', keycode: e.keycode })
      }
      this.hook.on('mousedown', this.onMouseDown)
      this.hook.on('mouseup', this.onMouseUp)
      this.hook.on('wheel', this.onWheel)
      this.hook.on('keydown', this.onKeyDown)
      this.hook.on('keyup', this.onKeyUp)
      this.source = 'uiohook'
    }
  }

  /**
   * Stops tracking and converts the raw data into recording-relative, normalized samples.
   * Clicks and other input from `stopRequestedAt` on (the click on the Stop button itself) are dropped.
   */
  stop(startedAt: number | null, stopRequestedAt: number | null = null): CursorData {
    const display = this.display
    const rawSamples = this.samples
    const rawClicks = this.clicks
    const rawInput = this.input
    const source = this.source
    this.stopInternal()
    if (!display || startedAt === null) return { samples: [], clicks: [], source: 'none' }

    const { x: bx, y: by, width: bw, height: bh } = display.bounds
    const norm = (s: RawSample): { t: number; x: number; y: number } => ({
      t: Math.max(0, s.t - startedAt),
      x: (s.x - bx) / bw,
      y: (s.y - by) / bh
    })

    // keep one sample from before the start so the cursor has a position at t=0
    const firstIdx = Math.max(0, rawSamples.findIndex((s) => s.t >= startedAt) - 1)
    const samples = rawSamples.slice(firstIdx === -1 ? 0 : firstIdx).map(norm)
    const clickCutoff = stopRequestedAt !== null ? stopRequestedAt - 80 : Number.POSITIVE_INFINITY
    const clicks = rawClicks
      .filter((c) => c.t >= startedAt && c.t < clickCutoff)
      .map((c) => ({ ...norm(c), button: c.button }))
    if (source !== 'uiohook') return { samples, clicks, source }

    // same time base and cutoff as the clicks (buildInputMarks drops t < 0 and t >= cutoffMs)
    const input = buildInputMarks(
      rawInput.map((e) => ({ ...e, t: e.t - startedAt })),
      { cutoffMs: clickCutoff - startedAt }
    )
    return { samples, clicks, source, input }
  }

  dispose(): void {
    this.stopInternal()
  }

  private stopInternal(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // raw key events live only as long as the recording (stop() has taken its own reference)
    this.input = []
    if (this.hook) {
      try {
        if (this.onMouseDown) this.hook.removeListener('mousedown', this.onMouseDown)
        if (this.onMouseUp) this.hook.removeListener('mouseup', this.onMouseUp)
        if (this.onWheel) this.hook.removeListener('wheel', this.onWheel)
        if (this.onKeyDown) this.hook.removeListener('keydown', this.onKeyDown)
        if (this.onKeyUp) this.hook.removeListener('keyup', this.onKeyUp)
      } catch (err) {
        console.warn('[cursor] failed to remove input hook listeners', err)
      }
      this.onMouseDown = null
      this.onMouseUp = null
      this.onWheel = null
      this.onKeyDown = null
      this.onKeyUp = null
      this.hook = null
      releaseHook()
    }
  }
}
