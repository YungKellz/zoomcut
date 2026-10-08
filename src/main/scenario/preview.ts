import { screen, type BrowserWindow } from 'electron'
import type { Scenario, ScenarioPreviewResult } from '@shared/types'
import { migrateScenario, validateScenario } from '@shared/scenario'
import { getMainWindow } from '../windows'
import { ReplaySession } from './replay'

/** From the helper being ready to the first step: the main window gets out of the way and the
 * overlay shows up before anything moves (a recording's replay gets the same 800ms after its
 * first frame, see RecordingController.started()). */
export const PREVIEW_GO_LEAD_MS = 800

interface PreviewRun {
  /** null while ReplaySession.create() is still starting the helper */
  session: ReplaySession | null
  /** settles the promise start() returned; only end() calls it, once */
  resolve: (result: ScenarioPreviewResult) => void
  ended: boolean
  /** abort() came before the session existed: it is ended as soon as it does */
  abortRequested: boolean
  /** the main window this run hid, to show again at the end */
  hidden: BrowserWindow | null
  onWindowClosed: () => void
}

/**
 * Dry run of a scenario ("Preview" on the review screen): the very ReplaySession a recording
 * drives (replay.ts: the same compiled steps, helper, overlay and Escape abort) without any
 * RecordingController around it - nothing is captured and no project is made. The main window
 * hides for the run, like for a recording, and comes back afterwards. One at a time, and never next
 * to a recording or a scenario capture: main/index.ts wires the three busy checks together.
 *
 * Every way out goes through end(): the schedule finished, Escape or abort(), the helper failed,
 * the main window closed, the app quits (dispose()). ReplaySession.dispose() then releases input
 * by the helper's own rules (exactly what it pressed, or after a hard kill only what Windows reports
 * as held - never an up for something that is not down), closes the overlay and releases the shared
 * hook.
 */
export class ScenarioPreview {
  private run: PreviewRun | null = null
  private disposed = false
  private otherBusyCheck: (() => boolean) | null = null

  setOtherBusyCheck(fn: () => boolean): void {
    this.otherBusyCheck = fn
  }

  isActive(): boolean {
    return this.run !== null
  }

  /** Runs the scenario; resolves once the run is over, rejects when it cannot start. */
  async start(input: Scenario): Promise<ScenarioPreviewResult> {
    if (this.disposed) throw new Error('The app is quitting')
    if (this.run) throw new Error('A scenario preview is already running')
    if (this.otherBusyCheck?.()) throw new Error('A recording or a scenario capture is in progress')
    // the review screen's copy, possibly with edits not saved yet: normalized like a saved one
    const scenario = migrateScenario(input)
    const invalid = validateScenario(scenario.actions)
    if (invalid === 'empty') throw new Error('The scenario has no actions')
    if (invalid === 'tooLong') throw new Error('The scenario is longer than 10 minutes')
    // the display it was captured on, else the primary one - what the review screen picks for a recording too
    const display = screen.getAllDisplays().find((d) => d.id === scenario.displayId) ?? screen.getPrimaryDisplay()

    const run: PreviewRun = {
      session: null,
      resolve: () => undefined,
      ended: false,
      abortRequested: false,
      hidden: null,
      onWindowClosed: () => void this.abortRun(run, 'window closed')
    }
    const result = new Promise<ScenarioPreviewResult>((resolve) => {
      run.resolve = resolve
    })
    this.run = run

    let session: ReplaySession
    try {
      session = await ReplaySession.create(
        display,
        scenario,
        {
          // the overlay HUD and the main window's preview-state events already carry the progress
          onProgress: () => undefined,
          onDone: () => this.end(run, { outcome: 'done' }),
          onAbort: () => this.end(run, { outcome: 'aborted' }),
          onError: (message) => this.end(run, { outcome: 'error', message })
        },
        { preview: true }
      )
    } catch (err) {
      // nothing ran: the session already disposed itself and the main window was never hidden
      run.ended = true
      if (this.run === run) this.run = null
      throw err
    }
    run.session = session
    // it failed while starting (or the app began quitting): end() has run, only the session is left
    if (run.ended) {
      session.dispose()
      return result
    }
    if (run.abortRequested) {
      this.end(run, { outcome: 'aborted' })
      return result
    }

    const win = getMainWindow()
    if (win) {
      run.hidden = win
      win.once('closed', run.onWindowClosed)
      win.hide()
    }
    session.go(Date.now() + PREVIEW_GO_LEAD_MS)
    return result
  }

  /** Stop from the review screen: the same as Escape. A no-op when no preview runs. */
  async abort(): Promise<void> {
    const run = this.run
    if (run) await this.abortRun(run, 'stop')
  }

  /** App quit: ends a running preview (input released, overlay closed) without showing the window again. */
  dispose(): void {
    this.disposed = true
    const run = this.run
    if (run) this.end(run, { outcome: 'aborted' })
  }

  private async abortRun(run: PreviewRun, reason: string): Promise<void> {
    if (run.ended) return
    if (!run.session) {
      run.abortRequested = true
      return
    }
    // releases what the helper holds and closes the overlay, then onAbort -> end(); false when the
    // session is already finishing on its own (done / failed), whose own callback then ends the run
    await run.session.abort(reason)
  }

  private end(run: PreviewRun, result: ScenarioPreviewResult): void {
    if (run.ended) return
    run.ended = true
    if (this.run === run) this.run = null
    run.session?.dispose()
    const win = run.hidden
    run.hidden = null
    if (win && !win.isDestroyed()) {
      win.removeListener('closed', run.onWindowClosed)
      // back from behind the replay, like after a recording - but not while the app quits
      if (!this.disposed) {
        win.show()
        win.focus()
      }
    }
    run.resolve(result)
  }
}
