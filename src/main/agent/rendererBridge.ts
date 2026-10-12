import { randomUUID } from 'node:crypto'
import {
  AgentError,
  type AgentCommand,
  type AgentErrorCode,
  type AgentRendererMethod,
  type AgentReply,
  type AgentUiStatus
} from '@shared/agent'

/** The window commands go to; the Electron adapter wraps the main window's webContents (see index.ts). */
export interface RendererTarget {
  send(command: AgentCommand): void
  /** the page has finished loading (and its renderer process is alive) */
  isLoaded(): boolean
  /** calls back every time the page the commands go to is lost: the window closes, the page reloads or its renderer process dies */
  onGone(cb: () => void): void
}

interface Pending {
  method: AgentRendererMethod
  resolve: (result: unknown) => void
  reject: (err: AgentError) => void
}

const ERROR_CODES: readonly AgentErrorCode[] = ['bad_params', 'not_found', 'busy', 'cancelled', 'failed', 'no_window', 'unknown_method']

export interface RendererBridgeOptions {
  /** how long after the page loaded commands wait for the executor's first status push; default 1500 */
  graceMs?: number
  /** give up waiting for the window to load after this long; default 20000 */
  loadTimeoutMs?: number
  /** a command the renderer has not answered after this long fails (a reply lost to a reload or a hung page); default 60000. Exports have no limit. */
  commandTimeoutMs?: number
}

export interface SendOptions {
  /** the caller gave up: the command is rejected `cancelled` and, once it reached the renderer, the renderer is told to stop it */
  signal?: AbortSignal
}

function cancelled(): AgentError {
  return new AgentError('cancelled', 'The request was cancelled')
}

/** Exports take as long as the video is long; everything else only hands something over or edits the open project. */
const UNLIMITED: ReadonlySet<AgentRendererMethod> = new Set(['projects.export'])

/**
 * Runs the methods only the renderer can do (edits, export, starting a recording from the UI):
 * a command goes over `agent:command` with a request id, the renderer answers once with
 * `agent:reply`. Commands wait until the renderer's executor is up, which it announces with its
 * first `agent:status` push (or, failing that, a moment after the page loaded) – a command sent
 * earlier would reach no listener and never be answered. A page that goes away (window closed,
 * reload, crashed renderer) forgets the status and fails every command still waiting for it.
 * Also keeps the screen / open project the renderer last reported, for `status`.
 */
export class RendererBridge {
  private pending = new Map<string, Pending>()
  private status: AgentUiStatus | null = null
  private watched = new WeakSet<RendererTarget>()
  private readonly graceMs: number
  private readonly loadTimeoutMs: number
  private readonly commandTimeoutMs: number

  constructor(
    private readonly getTarget: () => RendererTarget | null,
    opts: RendererBridgeOptions = {}
  ) {
    this.graceMs = opts.graceMs ?? 1500
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 20_000
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 60_000
  }

  getStatus(): AgentUiStatus | null {
    return this.status
  }

  /** `agent:status` from the renderer; the first one also means "the executor is listening". */
  setStatus(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const { screen, openProjectId, openScenarioId, compositionProjectIds } = raw as Partial<AgentUiStatus>
    if (typeof screen !== 'string') return
    this.status = {
      screen,
      openProjectId: typeof openProjectId === 'string' ? openProjectId : null,
      openScenarioId: typeof openScenarioId === 'string' ? openScenarioId : null,
      compositionProjectIds: Array.isArray(compositionProjectIds) ? compositionProjectIds.filter((id): id is string => typeof id === 'string') : []
    }
    // a status the bridge holds must be one it notices going stale: watch the page as soon as it reports
    const target = this.getTarget()
    if (target) this.watch(target)
  }

  /** Sends one command and resolves with the renderer's reply (or rejects with its error). */
  async send(method: AgentRendererMethod, params: unknown, opts: SendOptions = {}): Promise<unknown> {
    const { signal } = opts
    if (signal?.aborted) throw cancelled()
    const target = await this.readyTarget(signal)
    if (signal?.aborted) throw cancelled()
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const onAbort = (): void => {
        if (!this.pending.delete(requestId)) return
        cleanup()
        reject(cancelled())
        // the renderer stops what it was doing for that command (an export); it answers the command itself `cancelled`, which is ignored by now
        try {
          target.send({ requestId: randomUUID(), method: 'cancel', params: { requestId } })
        } catch {
          // the window is gone, and so is the command
        }
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, {
        method,
        resolve: (result) => {
          cleanup()
          resolve(result)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        }
      })
      if (!UNLIMITED.has(method)) {
        timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return
          cleanup()
          reject(new AgentError('failed', `ZoomCut did not answer ${method} within ${Math.round(this.commandTimeoutMs / 1000)} s (its window may be hung or was reloaded)`))
        }, this.commandTimeoutMs)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        target.send({ requestId, method, params })
      } catch (err) {
        this.pending.delete(requestId)
        cleanup()
        reject(new AgentError('no_window', `Could not reach the ZoomCut window: ${err instanceof Error ? err.message : String(err)}`))
      }
    })
  }

  /** `agent:reply`: settles the matching request. Unknown or repeated ids are ignored. */
  reply(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const reply = raw as Partial<AgentReply> & { error?: { code?: unknown; message?: unknown } }
    if (typeof reply.requestId !== 'string') return
    const pending = this.pending.get(reply.requestId)
    if (!pending) return
    this.pending.delete(reply.requestId)
    if (reply.ok === true) {
      pending.resolve((reply as { result?: unknown }).result)
      return
    }
    const code = ERROR_CODES.find((c) => c === reply.error?.code) ?? 'failed'
    const message = typeof reply.error?.message === 'string' && reply.error.message ? reply.error.message : `${pending.method} failed`
    pending.reject(new AgentError(code, message))
  }

  rejectAll(code: AgentErrorCode, message: string): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(new AgentError(code, message))
  }

  /**
   * Hears about the page going away (window closed, reload, crashed renderer): the status is
   * forgotten and every command in flight fails. The listener stays for good and is added once
   * per target - from setStatus() and the first readiness check, so it is there before any
   * command is sent and a page lost in between cannot leave a stale status behind.
   */
  private watch(target: RendererTarget): void {
    if (this.watched.has(target)) return
    this.watched.add(target)
    target.onGone(() => {
      this.status = null
      this.rejectAll('no_window', 'The ZoomCut window was closed, reloaded or crashed')
    })
  }

  /** Waits for a page that can take the command; a caller that gives up meanwhile is not kept waiting. */
  private async readyTarget(signal?: AbortSignal): Promise<RendererTarget> {
    const noWindow = (): AgentError => new AgentError('no_window', 'ZoomCut has no open window to do this in')
    const started = Date.now()
    let loadedSince: number | null = null
    for (;;) {
      if (signal?.aborted) throw cancelled()
      const target = this.getTarget()
      if (!target) throw noWindow()
      this.watch(target)
      // a status is only good for a page that is up: one that crashed or is reloading holds commands back like a new one
      if (target.isLoaded()) {
        if (this.status !== null) return target
        loadedSince ??= Date.now()
        if (Date.now() - loadedSince >= this.graceMs) return target
      } else {
        loadedSince = null // the page reloaded while we waited: the grace starts over
      }
      if (Date.now() - started > this.loadTimeoutMs) throw new AgentError('no_window', 'The ZoomCut window did not finish loading')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
