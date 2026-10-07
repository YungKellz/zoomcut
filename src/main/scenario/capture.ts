import { BrowserWindow, type Display, desktopCapturer, globalShortcut, screen } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import type { UiohookKeyboardEvent, UiohookMouseEvent, UiohookWheelEvent } from 'uiohook-napi'
import type { RecorderBarState, Scenario, ScenarioCaptureState, ScenarioModifiers, ScenarioPoint, ScenarioShot } from '@shared/types'
import { SCENARIO_MAX_MS } from '@shared/defaults'
import { SCENARIO_VERSION, groupRawEvents, isModifierKey, type RawDownEvent, type RawInputEvent, type RawKeyEvent, type RawUpEvent, type RawWheelEvent } from '@shared/scenario'
import { createBarWindow, getMainWindow } from '../windows'
import { acquireHook, releaseHook, type UioHook } from './hook'
import { startKeytextHelper } from './inputHelper'
import { defaultScenarioName, newScenarioId, saveScenario, scenarioDir } from './storage'

export const SCENARIO_STOP_SHORTCUT = 'CommandOrControl+Alt+R'

// uiohook-napi's WheelDirection.HORIZONTAL. Not imported as a value: any runtime import from
// 'uiohook-napi' loads the native addon eagerly, which is exactly what hook.ts's lazy
// acquireHook() exists to avoid.
const WHEEL_HORIZONTAL = 4
// Sign of uiohook's wheel `rotation` relative to "positive = content scrolls down / right"
// (the ScenarioScrollAction.deltaY/deltaX convention). Verified empirically (B1 verification
// script): injecting a Win32 MOUSEEVENTF_WHEEL notch with mouseData=+120 (rotated forward,
// away from the user - the physical "scroll up" gesture) is reported by uiohook as
// rotation=-1, i.e. uiohook's sign already matches "positive = down" with no flip needed.
const WHEEL_SIGN = 1

// uiohook-napi's `keycode` is NOT `scan | (extended ? 0xE000 : 0)` uniformly: verified live
// (uiohook-napi 1.5.5, Windows 11) that arrows use +0xE000 but Insert/Delete/Home/End/PageUp/
// PageDown/NumpadEnter/CtrlRight/AltRight/the Windows keys use +0xE00 instead. Rather than
// guess at an offset, known extended keys are looked up literally; anything else falls back
// to a best-effort low-byte extraction (still correct for the vast majority: every ordinary,
// non-extended key reports its real PC/AT scan code directly as `keycode`, keycode < 256).
const EXTENDED_KEYCODES: Record<number, number> = {
  57419: 0x4b, // ArrowLeft
  57416: 0x48, // ArrowUp
  57421: 0x4d, // ArrowRight
  57424: 0x50, // ArrowDown
  3657: 0x49, // PageUp
  3665: 0x51, // PageDown
  3663: 0x4f, // End
  3655: 0x47, // Home
  3666: 0x52, // Insert
  3667: 0x53, // Delete
  3637: 0x35, // NumpadDivide
  3612: 0x1c, // NumpadEnter
  3613: 0x1d, // CtrlRight
  3640: 0x38, // AltRight
  3675: 0x5b, // Meta (LWin)
  3676: 0x5c, // MetaRight (RWin)
  3639: 0x37 // PrintScreen
}

function decodeKeycode(keycode: number): { scan: number; extended: boolean } {
  const known = EXTENDED_KEYCODES[keycode]
  if (known !== undefined) return { scan: known, extended: true }
  if (keycode < 256) return { scan: keycode, extended: false }
  return { scan: keycode & 0xff, extended: true }
}

/** One in-flight (or 300ms-fresh) screenshot; several close-in-time actions may share it. */
interface ShotCache {
  at: number
  promise: Promise<ScenarioShot | null>
  settled: boolean
}

interface DownState {
  id: string
  t: number
  x: number
  y: number
}

/**
 * Captures one scenario: a 3.2s countdown on the floating bar, then every click/drag/scroll/
 * keystroke until Stop or the 10-minute cap. Only one capture (and no recording) may run at a
 * time – see setOtherBusyCheck(). Mouse/keyboard events come from the shared global hook
 * (scenario/hook.ts); a long-running keytext.ps1 resolves each keystroke's real character
 * asynchronously, so raw events are buffered and only grouped into actions at stop().
 */
export class ScenarioCapture {
  private state: ScenarioCaptureState = { phase: 'idle', actions: 0, startedAt: null }
  private barState: RecorderBarState = { phase: 'idle', startedAt: null, countdownEndsAt: null }
  private bar: BrowserWindow | null = null
  private display: Display | null = null
  private id: string | null = null
  private dir: string | null = null
  private startedAt: number | null = null
  /** cursor position at the moment capture began (end of the countdown), DIP; stored on the
   * saved Scenario so the compiler can start the first action's leading move from here. */
  private startPoint: ScenarioPoint | null = null
  private stopRequestedAt: number | null = null
  private countdownTimer: NodeJS.Timeout | null = null
  private capTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private lastMove: { t: number; x: number; y: number } | null = null
  private hookInstance: UioHook | null = null
  private keytextProc: ChildProcess | null = null
  private keytextRl: Interface | null = null
  private nextKeytextSeq = 1
  private pendingKeytext = new Map<number, (vk: number, text: string | null) => void>()
  private raw: RawInputEvent[] = []
  private pending: Promise<void>[] = []
  private rawIdCounter = 0
  private shotCounter = 0
  private shotCache: ShotCache | null = null
  private rightAltHeld = false
  private actionsApprox = 0
  private downs: Record<'left' | 'right' | 'middle', DownState | null> = { left: null, right: null, middle: null }
  private otherBusyCheck: (() => boolean) | null = null

  setOtherBusyCheck(fn: () => boolean): void {
    this.otherBusyCheck = fn
  }

  getState(): ScenarioCaptureState {
    return this.state
  }

  getBarState(): RecorderBarState {
    return this.barState
  }

  isActive(): boolean {
    return this.state.phase !== 'idle'
  }

  async start(displayId: number): Promise<void> {
    if (this.state.phase !== 'idle') throw new Error('A scenario capture is already in progress')
    if (this.otherBusyCheck?.()) throw new Error('A recording is already in progress')

    const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
    const id = await newScenarioId()
    const dir = scenarioDir(id)
    await fsp.mkdir(join(dir, 'shots'), { recursive: true })

    const hook = await acquireHook()
    if (!hook) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('The global input hook is unavailable, so a scenario cannot be captured')
    }

    try {
      this.display = display
      this.id = id
      this.dir = dir
      this.hookInstance = hook
      this.hookInstance.on('mousedown', this.onMouseDown)
      this.hookInstance.on('mouseup', this.onMouseUp)
      this.hookInstance.on('wheel', this.onWheel)
      this.hookInstance.on('keydown', this.onKeyDown)
      this.hookInstance.on('keyup', this.onKeyUp)

      this.keytextProc = await startKeytextHelper()
      // if the helper dies (powershell missing, Add-Type failed, ...) any keystroke already
      // waiting on an answer must resolve now, not wait out its own 500ms timeout for nothing
      this.keytextProc.on('exit', () => this.flushPendingKeytext())
      this.keytextProc.on('error', () => this.flushPendingKeytext())
      this.keytextRl = createInterface({ input: this.keytextProc.stdout! })
      this.keytextRl.on('line', (line) => this.onKeytextLine(line))

      getMainWindow()?.hide()
      this.bar = createBarWindow(display.bounds)
      this.bar.on('closed', () => {
        this.bar = null
      })

      const countdownEndsAt = Date.now() + 3200
      this.setState({ phase: 'countdown', actions: 0, startedAt: null })
      this.setBarState({ phase: 'countdown', startedAt: null, countdownEndsAt, mode: 'scenario' })

      globalShortcut.unregister(SCENARIO_STOP_SHORTCUT)
      globalShortcut.register(SCENARIO_STOP_SHORTCUT, () => this.requestStop())

      this.countdownTimer = setTimeout(() => this.onCountdownEnd(), 3200)
    } catch (err) {
      this.teardownCapture()
      this.hardReset()
      // the main window may already be hidden (it is hidden before the bar is created) - make
      // sure a failure partway through does not leave it hidden with nothing else on screen
      const win = getMainWindow()
      if (win) {
        win.show()
        win.focus()
      }
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  /** Bar Stop / Ctrl+Alt+R / the 10-minute cap: finalize and save what was captured. */
  requestStop(): void {
    if (this.state.phase === 'countdown') {
      void this.finish(true)
      return
    }
    if (this.state.phase !== 'capturing') return
    this.stopRequestedAt = Date.now()
    void this.finish(false)
  }

  /** Bar X: discard, nothing saved. */
  requestCancel(): void {
    if (this.state.phase === 'idle' || this.state.phase === 'saving') return
    void this.finish(true)
  }

  /** app.will-quit: no time for the normal save dance, just stop pressing/listening. */
  dispose(): void {
    this.teardownCapture()
    const dir = this.dir
    this.hardReset()
    if (dir) void fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  private onCountdownEnd(): void {
    this.countdownTimer = null
    if (this.state.phase !== 'countdown') return
    this.startedAt = Date.now()
    this.startPoint = screen.getCursorScreenPoint()
    this.setState({ phase: 'capturing', actions: 0, startedAt: this.startedAt })
    this.setBarState({ phase: 'scenario', startedAt: this.startedAt, countdownEndsAt: null, mode: 'scenario', actions: 0 })
    this.startPolling()
    this.capTimer = setTimeout(() => this.requestStop(), SCENARIO_MAX_MS)
  }

  private async finish(discard: boolean): Promise<void> {
    if (this.state.phase === 'saving' || this.state.phase === 'idle') return
    const startedAt = this.startedAt
    this.setState({ phase: 'saving', actions: this.actionsApprox, startedAt })
    // Stop timers/hook/bar right away, but keep the keytext helper alive a little longer: each
    // pending keystroke's own promise is internally bounded to ~500ms (see onKeyDown), so
    // killing the helper only after awaiting them gives it a real chance to answer instead of
    // guaranteeing every single one hits its timeout.
    this.stopTimers()
    this.stopHook()
    this.closeBar()

    let scenario: Scenario | null = null
    if (!discard && startedAt !== null) {
      await Promise.all(this.pending)
      this.stopKeytext()
      const cutoffMs = this.stopRequestedAt !== null ? this.stopRequestedAt - startedAt - 80 : undefined
      // already default-timed (durationMs / pauseMs): the replay is sequential, so the long dead
      // time before the first action - or between actions - is not carried over from the capture
      const actions = groupRawEvents(this.raw, { cutoffMs })
      if (actions.length > 0 && this.display && this.id && this.dir) {
        const candidate: Scenario = {
          version: SCENARIO_VERSION,
          id: this.id,
          name: defaultScenarioName(startedAt),
          createdAt: startedAt,
          displayId: this.display.id,
          displayBounds: this.display.bounds,
          scaleFactor: this.display.scaleFactor,
          actions,
          startPoint: this.startPoint ?? undefined,
          // the recorded capture length, kept for the record only - the replay length is scenarioEnd(actions)
          durationMs: Date.now() - startedAt,
          dir: this.dir
        }
        try {
          await saveScenario(candidate)
          scenario = candidate
        } catch (err) {
          console.error('[scenario] failed to save', err)
        }
      }
    } else {
      // discarded, or the countdown never got as far as starting a clock: nothing depends on
      // the keytext helper's answers, so it can go immediately
      this.stopKeytext()
    }
    if (!scenario && this.dir) {
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
    }

    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
    }
    this.hardReset()
    getMainWindow()?.webContents.send('scenario:done', scenario)
  }

  /** Full, immediate teardown - used by dispose() and start()'s own failure path, where there
   * is no reason to wait for the keytext helper to answer anything. finish() instead calls the
   * pieces below individually, with stopKeytext() deferred until after its pending answers
   * (each internally time-bounded) have been awaited. */
  private teardownCapture(): void {
    this.stopTimers()
    this.stopHook()
    this.stopKeytext()
    this.closeBar()
  }

  private stopTimers(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer)
      this.countdownTimer = null
    }
    if (this.capTimer) {
      clearTimeout(this.capTimer)
      this.capTimer = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private stopHook(): void {
    globalShortcut.unregister(SCENARIO_STOP_SHORTCUT)
    if (this.hookInstance) {
      this.hookInstance.removeListener('mousedown', this.onMouseDown)
      this.hookInstance.removeListener('mouseup', this.onMouseUp)
      this.hookInstance.removeListener('wheel', this.onWheel)
      this.hookInstance.removeListener('keydown', this.onKeyDown)
      this.hookInstance.removeListener('keyup', this.onKeyUp)
      this.hookInstance = null
      releaseHook()
    }
  }

  private stopKeytext(): void {
    this.keytextRl?.close()
    this.keytextRl = null
    if (this.keytextProc) {
      this.keytextProc.removeAllListeners('exit')
      this.keytextProc.removeAllListeners('error')
      // keytext.ps1 never presses a real key or button, so an immediate kill is safe (unlike
      // replay.ps1, which needs its finally block / -Release to run).
      try {
        this.keytextProc.kill()
      } catch {
        /* already gone */
      }
      this.keytextProc = null
    }
    this.flushPendingKeytext()
  }

  private closeBar(): void {
    if (this.bar && !this.bar.isDestroyed()) this.bar.close()
    this.bar = null
  }

  /** Resolves every keystroke still waiting on a keytext answer with "not text", immediately
   * (rather than each waiting out its own ~500ms timeout) - used when the helper dies and
   * whenever it is deliberately stopped. */
  private flushPendingKeytext(): void {
    if (this.pendingKeytext.size === 0) return
    const resolvers = Array.from(this.pendingKeytext.values())
    this.pendingKeytext.clear()
    for (const resolve of resolvers) resolve(0, null)
  }

  private hardReset(): void {
    this.display = null
    this.id = null
    this.dir = null
    this.startedAt = null
    this.startPoint = null
    this.stopRequestedAt = null
    this.lastMove = null
    this.raw = []
    this.pending = []
    this.pendingKeytext.clear()
    this.nextKeytextSeq = 1
    this.rawIdCounter = 0
    this.shotCounter = 0
    this.shotCache = null
    this.rightAltHeld = false
    this.actionsApprox = 0
    this.downs = { left: null, right: null, middle: null }
    this.setState({ phase: 'idle', actions: 0, startedAt: null })
    this.setBarState({ phase: 'idle', startedAt: null, countdownEndsAt: null })
  }

  private setState(state: ScenarioCaptureState): void {
    this.state = state
    getMainWindow()?.webContents.send('scenario:state', state)
  }

  private setBarState(state: RecorderBarState): void {
    this.barState = state
    if (this.bar && !this.bar.isDestroyed()) this.bar.webContents.send('bar:state', state)
  }

  private pushBarActions(): void {
    if (this.state.phase !== 'capturing') return
    this.setState({ phase: 'capturing', actions: this.actionsApprox, startedAt: this.startedAt })
    this.setBarState({ phase: 'scenario', startedAt: this.startedAt, countdownEndsAt: null, mode: 'scenario', actions: this.actionsApprox })
  }

  private isCapturing(): boolean {
    return this.state.phase === 'capturing'
  }

  private relativeT(): number | null {
    return this.startedAt === null ? null : Date.now() - this.startedAt
  }

  private isOverBar(p: { x: number; y: number }): boolean {
    if (!this.bar || this.bar.isDestroyed()) return false
    const b = this.bar.getBounds()
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
  }

  private nextRawId(): string {
    return `e${this.rawIdCounter++}`
  }

  private startPolling(): void {
    const poll = (): void => {
      if (!this.isCapturing()) return
      const p = screen.getCursorScreenPoint()
      const t = this.relativeT()
      if (t === null) return
      const last = this.lastMove
      if (!last || last.x !== p.x || last.y !== p.y || t - last.t > 250) {
        this.lastMove = { t, x: p.x, y: p.y }
        this.raw.push({ t, type: 'move', x: p.x, y: p.y })
      }
    }
    poll()
    this.pollTimer = setInterval(poll, Math.round(1000 / 60))
  }

  // ---- hook listeners ----
  // Bound as instance properties (not prototype methods) so removeListener() in
  // teardownCapture() can find the exact same function reference.

  private onMouseDown = (e: UiohookMouseEvent): void => {
    if (!this.isCapturing()) return
    const p = screen.getCursorScreenPoint()
    if (this.isOverBar(p)) return
    const t = this.relativeT()
    if (t === null) return
    const button = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left'
    const id = this.nextRawId()
    const mods: ScenarioModifiers = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    const event: RawDownEvent = { id, t, type: 'down', button, x: p.x, y: p.y, mods, clicks: e.clicks, shot: null }
    this.raw.push(event)
    this.downs[button] = { id, t, x: p.x, y: p.y }
    this.actionsApprox++
    this.pushBarActions()

    const display = this.display
    if (display) {
      const promise = this.captureShot(display, p).then((shot) => {
        event.shot = shot
      })
      this.pending.push(promise)
    }
  }

  private onMouseUp = (e: UiohookMouseEvent): void => {
    if (!this.isCapturing()) return
    const p = screen.getCursorScreenPoint()
    const t = this.relativeT()
    if (t === null) return
    const button = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left'
    this.downs[button] = null
    const mods: ScenarioModifiers = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    const event: RawUpEvent = { t, type: 'up', button, x: p.x, y: p.y, mods, clicks: e.clicks }
    this.raw.push(event)
  }

  private onWheel = (e: UiohookWheelEvent): void => {
    if (!this.isCapturing()) return
    const p = screen.getCursorScreenPoint()
    if (this.isOverBar(p)) return
    const t = this.relativeT()
    if (t === null) return
    const mods: ScenarioModifiers = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    const event: RawWheelEvent = {
      id: this.nextRawId(),
      t,
      type: 'wheel',
      rotation: e.rotation * WHEEL_SIGN,
      horizontal: e.direction === WHEEL_HORIZONTAL,
      x: p.x,
      y: p.y,
      mods
    }
    this.raw.push(event)
  }

  private onKeyDown = (e: UiohookKeyboardEvent): void => {
    if (!this.isCapturing()) return
    const { scan, extended } = decodeKeycode(e.keycode)
    if (scan === 56 && extended) this.rightAltHeld = true
    if (isModifierKey(scan, extended)) return
    const t = this.relativeT()
    if (t === null) return
    // Keyboard input is not gated on pointer position (unlike mouse/wheel events, which are
    // dropped over the bar): a keystroke has nothing to do with where the cursor happens to
    // rest, and typing while it sits over the bar was being silently swallowed.
    const p = screen.getCursorScreenPoint()

    // AltGr shows up as Ctrl+Alt both held; that is not a shortcut, it is how many layouts
    // type accented/special characters, so it must not be forced into a `key` chord action.
    const altgr = e.ctrlKey && e.altKey && this.rightAltHeld
    const mods: ScenarioModifiers = {
      ctrl: altgr ? false : e.ctrlKey,
      alt: altgr ? false : e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey
    }
    const event: RawKeyEvent = { id: this.nextRawId(), t, type: 'key', scan, vk: 0, extended, text: null, mods, x: p.x, y: p.y }
    this.raw.push(event)
    this.actionsApprox++
    this.pushBarActions()

    const seq = this.nextKeytextSeq++
    const resolved = new Promise<void>((resolve) => {
      let settled = false
      this.pendingKeytext.set(seq, (vk, text) => {
        if (settled) return
        settled = true
        event.vk = vk
        event.text = text
        resolve()
      })
      // The helper (or the whole process) can die without ever answering (Add-Type failed,
      // powershell.exe missing, killed mid-line); without a bound, finish() would await this
      // forever - flushPendingKeytext() also resolves it early and immediately if that happens.
      setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingKeytext.delete(seq)
        event.vk = 0
        event.text = null
        resolve()
      }, 500)
    })
    this.pending.push(resolved)
    // keytext.ps1 needs the extended marker folded into the scan it passes to both
    // MapVirtualKeyEx and ToUnicodeEx, or an extended key (Numpad/, PrintScreen, ...) resolves
    // as if it were its non-extended twin (e.g. Numpad/ as "/", PrintScreen as "*").
    const scanForKeytext = extended ? scan | 0xe000 : scan
    const line = `K ${seq} ${scanForKeytext} ${e.shiftKey ? 1 : 0} ${e.ctrlKey ? 1 : 0} ${e.altKey ? 1 : 0} ${altgr ? 1 : 0}\r\n`
    this.keytextProc?.stdin?.write(line, () => undefined)
  }

  private onKeyUp = (e: UiohookKeyboardEvent): void => {
    const { scan, extended } = decodeKeycode(e.keycode)
    if (scan === 56 && extended) this.rightAltHeld = false
  }

  private onKeytextLine(line: string): void {
    const parts = line.trim().split(' ')
    if (parts.length < 4 || parts[0] !== 'T') return
    const seq = Number(parts[1])
    const vk = Number(parts[2]) || 0
    const raw = parts[3]
    const text = raw === '-' ? null : Buffer.from(raw, 'base64').toString('utf8')
    const resolve = this.pendingKeytext.get(seq)
    if (resolve) {
      this.pendingKeytext.delete(seq)
      resolve(vk, text)
    }
  }

  /**
   * Never more than one screenshot in flight: reuses the last one while it is still running
   * (settled === false), no matter how long that takes, and for 300ms after it settles.
   * Gating purely on the start timestamp would let two captures overlap if the first one ever
   * took longer than 300ms to resolve.
   */
  private captureShot(display: Display, point: { x: number; y: number }): Promise<ScenarioShot | null> {
    const cached = this.shotCache
    if (cached && (!cached.settled || Date.now() - cached.at < 300)) return cached.promise
    const entry = { at: Date.now(), settled: false } as ShotCache
    entry.promise = this.doCaptureShot(display, point).finally(() => {
      entry.settled = true
    })
    this.shotCache = entry
    return entry.promise
  }

  private async doCaptureShot(display: Display, point: { x: number; y: number }): Promise<ScenarioShot | null> {
    const dir = this.dir
    if (!dir) return null
    try {
      const scale = display.scaleFactor || 1
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
      })
      const displays = screen.getAllDisplays()
      const index = displays.findIndex((d) => d.id === display.id)
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[index] ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) return null

      const img = source.thumbnail
      const size = img.getSize()
      const wPx = Math.min(size.width, Math.round(360 * scale))
      const hPx = Math.min(size.height, Math.round(220 * scale))
      const cxPx = Math.round((point.x - display.bounds.x) * scale)
      const cyPx = Math.round((point.y - display.bounds.y) * scale)
      const x = Math.max(0, Math.min(Math.round(cxPx - wPx / 2), size.width - wPx))
      const y = Math.max(0, Math.min(Math.round(cyPx - hPx / 2), size.height - hPx))
      const cropped = img.crop({ x, y, width: wPx, height: hPx })

      const fileName = `shot_${this.shotCounter++}.png`
      await fsp.writeFile(join(dir, 'shots', fileName), cropped.toPNG())
      return {
        file: `shots/${fileName}`,
        x: x / scale + display.bounds.x,
        y: y / scale + display.bounds.y,
        w: wPx / scale,
        h: hPx / scale
      }
    } catch (err) {
      console.warn('[scenario] screenshot capture failed', err)
      return null
    }
  }
}
