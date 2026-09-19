import { screen, type Display } from 'electron'
import type { CursorData, MouseButton } from '@shared/types'

interface RawSample {
  t: number
  x: number
  y: number
}

interface RawClick extends RawSample {
  button: MouseButton
}

type UioModule = typeof import('uiohook-napi')
type UioHook = UioModule['uIOhook']

const POLL_HZ = 60

/**
 * Records the mouse while a recording is running.
 *
 * Positions come from polling `screen.getCursorScreenPoint()` at 60 Hz (device-independent
 * pixels, no DPI calibration needed). Clicks come from a global mouse hook (uiohook-napi);
 * when the hook cannot be loaded the recording simply has no click ripples.
 */
export class CursorTracker {
  private samples: RawSample[] = []
  private clicks: RawClick[] = []
  private timer: NodeJS.Timeout | null = null
  private hook: UioHook | null = null
  private hookStarted = false
  private onMouseDown: ((e: { button: unknown }) => void) | null = null
  private display: Display | null = null
  private source: CursorData['source'] = 'none'

  async start(display: Display): Promise<void> {
    this.stopInternal()
    this.display = display
    this.samples = []
    this.clicks = []
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

    try {
      const mod = (await import('uiohook-napi')) as UioModule
      this.hook = mod.uIOhook
      this.onMouseDown = (e) => {
        const p = screen.getCursorScreenPoint()
        const button: MouseButton = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left'
        this.clicks.push({ t: Date.now(), x: p.x, y: p.y, button })
      }
      this.hook.on('mousedown', this.onMouseDown)
      this.hook.start()
      this.hookStarted = true
      this.source = 'uiohook'
    } catch (err) {
      console.warn('[cursor] global mouse hook unavailable, clicks will not be recorded:', err)
      this.hook = null
    }
  }

  /**
   * Stops tracking and converts the raw data into recording-relative, normalized samples.
   * Clicks from `stopRequestedAt` on (the click on the Stop button itself) are dropped.
   */
  stop(startedAt: number | null, stopRequestedAt: number | null = null): CursorData {
    const display = this.display
    const rawSamples = this.samples
    const rawClicks = this.clicks
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

    return { samples, clicks, source }
  }

  dispose(): void {
    this.stopInternal()
  }

  private stopInternal(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.hook) {
      try {
        if (this.onMouseDown) this.hook.removeListener('mousedown', this.onMouseDown)
        if (this.hookStarted) this.hook.stop()
      } catch (err) {
        console.warn('[cursor] failed to stop mouse hook', err)
      }
      this.hookStarted = false
      this.onMouseDown = null
      this.hook = null
    }
  }
}
