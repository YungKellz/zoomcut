import { app, BrowserWindow, screen, type Display } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import type { UiohookKeyboardEvent } from 'uiohook-napi'
import type { OverlayEffect, ReplayState, Scenario, ScenarioPoint } from '@shared/types'
import { compileScenario, describeAction, type ReplayStep } from '@shared/scenario'
import { createOverlayWindow, getMainWindow } from '../windows'
import { acquireHook, releaseHook, type UioHook } from './hook'
import { releaseAllInputs, startReplayHelper } from './inputHelper'

export interface ReplaySessionCallbacks {
  /** a `P i` marker arrived; the controller merges { replay: { index: index+1, total } } into the bar state */
  onProgress: (index: number, total: number) => void
  /** the schedule finished (script printed `D`); the controller stops the recording 1200ms later */
  onDone: () => void
  /** Escape or the bar X aborted the replay; the controller discards the recording */
  onAbort: (reason: string) => void
  /** the helper failed; surfaced like a recording error */
  onError: (message: string) => void
}

export function toPhysicalStep(step: ReplayStep): ReplayStep {
  if (step.op !== 'move') return step
  const p = screen.dipToScreenPoint({ x: Math.round(step.x), y: Math.round(step.y) })
  return { ...step, x: p.x, y: p.y }
}

/**
 * One-shot, no-overlay run of a bare step list through the same replay.ps1 helper, with no
 * abort file, no Escape watcher and no bar/overlay wiring. Used only by the ZOOMCUT_E2E
 * `e2e:inject-steps` test hook, so the e2e suite can drive the real capture path with real
 * input through the exact mechanism the recorder uses, without needing a full Scenario.
 */
export async function runStepsOnce(steps: ReplayStep[], convertDipToPhysical: boolean): Promise<void> {
  const physicalSteps = convertDipToPhysical ? steps.map(toPhysicalStep) : steps
  const stamp = Date.now()
  const stepsPath = join(app.getPath('temp'), `zoomcut-e2e-steps-${stamp}.json`)
  const abortPath = join(app.getPath('temp'), `zoomcut-e2e-abort-${stamp}`)
  await fsp.writeFile(stepsPath, '﻿' + JSON.stringify(physicalSteps), 'utf8')

  const proc = await startReplayHelper(stepsPath, abortPath)
  let rl: Interface | null = null
  let readyTimer: NodeJS.Timeout | null = null
  try {
    rl = createInterface({ input: proc.stdout! })
    const rlRef = rl
    await new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('replay helper did not become ready in time')), 15_000)
      let ready = false
      rlRef.on('line', (line) => {
        const t = line.trim()
        if (!ready && t === 'R') {
          ready = true
          if (readyTimer) clearTimeout(readyTimer)
          proc.stdin?.write(`GO ${Date.now() + 50}\r\n`)
          return
        }
        if (t === 'D' || t === 'A') {
          resolve()
        } else if (t.startsWith('E ')) {
          reject(new Error(t.slice(2)))
        }
      })
      proc.on('exit', () => {
        if (readyTimer) clearTimeout(readyTimer)
        resolve()
      })
      proc.on('error', (err) => {
        if (readyTimer) clearTimeout(readyTimer)
        reject(err)
      })
    })
  } finally {
    if (readyTimer) clearTimeout(readyTimer)
    rl?.close()
    if (proc.exitCode === null) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
    await fsp.rm(stepsPath, { force: true }).catch(() => undefined)
    await fsp.rm(abortPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Drives one replay: compiles the scenario, spawns replay.ps1, pre-positions the cursor
 * during the recording countdown, then (once told `go()`) lets the schedule run while
 * forwarding progress to the bar, the overlay window and the main window's HUD. Escape (real,
 * not one we just injected) or an explicit abort() stop input injection immediately, release
 * every key/button, and tell the recording to discard itself.
 */
export class ReplaySession {
  readonly total: number
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private overlay: BrowserWindow | null = null
  private hookInstance: UioHook | null = null
  private state: ReplayState
  private goEpoch: number | null = null
  private escapeStepTimes: number[] = []
  private disposed = false
  /** true from the top of release() onward: an intentional stop, so onProcessExit() must not
   * treat the helper's exit as a failure (that used to fire onError -> cancel even for a
   * plain "Stop and keep the recording"). */
  private releasing = false
  private doneTimer: NodeJS.Timeout | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null

  private constructor(
    private display: Display,
    private scenario: Scenario,
    private callbacks: ReplaySessionCallbacks,
    private stepsPath: string,
    private abortPath: string
  ) {
    this.total = scenario.actions.length
    this.state = { phase: 'preparing', index: 0, total: this.total }
  }

  static async create(display: Display, scenario: Scenario, callbacks: ReplaySessionCallbacks): Promise<ReplaySession> {
    const first = scenario.actions[0]
    const startPos: ScenarioPoint = first ? (first.path[0] ?? { x: first.x, y: first.y }) : { x: display.bounds.x, y: display.bounds.y }
    const dipSteps = compileScenario(scenario, { leadMs: 800, startPos })
    const steps = dipSteps.map(toPhysicalStep)

    const stamp = Date.now()
    const stepsPath = join(app.getPath('temp'), `zoomcut-steps-${scenario.id}-${stamp}.json`)
    const abortPath = join(app.getPath('temp'), `zoomcut-abort-${scenario.id}-${stamp}`)
    // a leading BOM plus explicit -Encoding UTF8 on the PowerShell side keeps non-ASCII typed
    // text intact regardless of Windows PowerShell 5.1's encoding auto-detection quirks
    await fsp.writeFile(stepsPath, '﻿' + JSON.stringify(steps), 'utf8')

    const session = new ReplaySession(display, scenario, callbacks, stepsPath, abortPath)
    session.escapeStepTimes = dipSteps.filter((s) => s.op === 'key' && s.down && s.vk === 27).map((s) => s.t)
    try {
      await session.spawnAndWaitReady(startPos)
      return session
    } catch (err) {
      session.dispose()
      throw err
    }
  }

  private async spawnAndWaitReady(startPos: ScenarioPoint): Promise<void> {
    this.proc = await startReplayHelper(this.stepsPath, this.abortPath)
    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => this.onLine(line))
    this.proc.on('exit', () => this.onProcessExit())
    this.proc.on('error', (err) => this.onError(err.message))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replay helper did not become ready in time')), 15_000)
      this.readyResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      this.readyReject = (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })

    const p = screen.dipToScreenPoint({ x: Math.round(startPos.x), y: Math.round(startPos.y) })
    this.proc.stdin?.write(`PRE ${p.x} ${p.y}\r\n`)

    this.overlay = createOverlayWindow(this.display.bounds)
    this.setState({ phase: 'ready', index: 0, total: this.total })

    // Escape aborts the replay; a real hook (shared/ref-counted with the capture/tracker) is
    // needed here too, independent of whatever cursorTracker is doing for the recording.
    const hook = await acquireHook()
    if (hook) {
      this.hookInstance = hook
      this.hookInstance.on('keydown', this.onRealKeyDown)
    }
  }

  /** `meta.startedAt + 800`: the epoch the helper's Stopwatch is anchored to. */
  go(epochMs: number): void {
    if (this.disposed || !this.proc) return
    this.goEpoch = epochMs
    this.setState({ phase: 'running', index: 0, total: this.total })
    this.proc.stdin?.write(`GO ${Math.round(epochMs)}\r\n`)
  }

  /** Escape / bar X: stop injecting input, release everything, tell the recording to discard. */
  async abort(reason: string): Promise<void> {
    if (this.disposed || this.state.phase === 'aborted' || this.state.phase === 'done') return
    // Set the terminal state *before* release() so that if the helper's exit races in during
    // release() and reaches onProcessExit(), the phase guard there already reads 'aborted' -
    // belt and suspenders alongside the `releasing` flag onProcessExit() also checks.
    this.setState({ phase: 'aborted', index: this.state.index, total: this.total, message: reason })
    await this.release()
    this.callbacks.onAbort(reason)
  }

  /** Bar Stop / Ctrl+Alt+R: stop injecting input (same release), but keep the recording. */
  async stopReplay(): Promise<void> {
    if (this.disposed) return
    await this.release()
  }

  /** Always safe to call more than once; the controller calls this from finish()/cancel(). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.doneTimer) {
      clearTimeout(this.doneTimer)
      this.doneTimer = null
    }
    this.rl?.close()
    this.rl = null
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      void releaseAllInputs()
    }
    this.closeOverlay()
    if (this.hookInstance) {
      this.hookInstance.removeListener('keydown', this.onRealKeyDown)
      this.hookInstance = null
      releaseHook()
    }
    void fsp.rm(this.stepsPath, { force: true }).catch(() => undefined)
    void fsp.rm(this.abortPath, { force: true }).catch(() => undefined)
  }

  private async release(): Promise<void> {
    this.releasing = true
    try {
      await fsp.writeFile(this.abortPath, '1', 'utf8')
    } catch {
      /* best effort */
    }
    const proc = this.proc
    if (proc && proc.exitCode === null && !proc.killed) {
      let timer: NodeJS.Timeout | null = null
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 500)
        })
      ])
      if (timer) clearTimeout(timer)
      if (!exited) {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
        await releaseAllInputs()
      }
    }
    this.closeOverlay()
    if (this.hookInstance) {
      this.hookInstance.removeListener('keydown', this.onRealKeyDown)
      this.hookInstance = null
      releaseHook()
    }
  }

  private closeOverlay(): void {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.close()
    this.overlay = null
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === 'R') {
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      return
    }
    if (trimmed.startsWith('P ')) {
      this.onActionMarker(Number(trimmed.slice(2)))
      return
    }
    if (trimmed === 'D') {
      this.onScriptDone()
      return
    }
    if (trimmed === 'A') {
      // the script noticed the abort file on its own; abort()/stopReplay() already drives
      // the JS-side state and cleanup, this line needs no separate handling
      return
    }
    if (trimmed.startsWith('E ')) {
      this.onError(trimmed.slice(2))
    }
  }

  private onActionMarker(index: number): void {
    const action = this.scenario.actions[index]
    if (!action) return
    this.setState({ phase: 'running', index, total: this.total })
    this.callbacks.onProgress(index, this.total)
    const desc = describeAction(action)
    const effect: OverlayEffect = {
      kind: action.kind,
      x: action.x - this.display.bounds.x,
      y: action.y - this.display.bounds.y,
      label: desc.detail || undefined,
      index,
      total: this.total
    }
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('overlay:effect', effect)
  }

  private onScriptDone(): void {
    if (this.state.phase === 'done' || this.state.phase === 'aborted' || this.state.phase === 'error') return
    this.setState({ phase: 'done', index: this.total, total: this.total })
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null
      this.callbacks.onDone()
    }, 1200)
  }

  private onError(message: string): void {
    if (this.state.phase === 'done' || this.state.phase === 'aborted' || this.state.phase === 'error') return
    this.setState({ phase: 'error', index: this.state.index, total: this.total, message })
    this.readyReject?.(new Error(message))
    this.readyResolve = null
    this.readyReject = null
    this.callbacks.onError(message)
  }

  private onProcessExit(): void {
    // `releasing` covers the whole abort()/stopReplay() -> release() window: the helper's own
    // exit (triggered by the abort file we just wrote) is expected here and must never be
    // reported as a failure - that used to fire onError() -> the controller's cancel path even
    // for a plain "Stop and keep the recording".
    if (this.disposed || this.releasing) return
    if (this.state.phase === 'done' || this.state.phase === 'aborted' || this.state.phase === 'error') return
    this.onError('The replay helper exited unexpectedly')
  }

  private onRealKeyDown = (e: UiohookKeyboardEvent): void => {
    if (e.keycode !== 1) return // Escape: scan 1, not extended
    if (this.goEpoch !== null) {
      const elapsed = Date.now() - this.goEpoch
      // ignore our own injected Escape (an `Esc` key step in the scenario itself)
      if (this.escapeStepTimes.some((t) => Math.abs(t - elapsed) <= 250)) return
    }
    void this.abort('escape')
  }

  private setState(state: ReplayState): void {
    this.state = state
    getMainWindow()?.webContents.send('recording:replay-state', state)
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('recording:replay-state', state)
  }
}
