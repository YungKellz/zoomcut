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
  /** the page has finished loading */
  isLoaded(): boolean
  /** calls back once, when the window or its renderer process goes away */
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
}

/**
 * Runs the methods only the renderer can do (edits, export, starting a recording from the UI):
 * a command goes over `agent:command` with a request id, the renderer answers once with
 * `agent:reply`. Commands wait until the renderer's executor is up, which it announces with its
 * first `agent:status` push (or, failing that, a moment after the page loaded) – a command sent
 * earlier would reach no listener and never be answered. Also keeps the screen / open project
 * the renderer last reported, for `status`.
 */
export class RendererBridge {
  private pending = new Map<string, Pending>()
  private status: AgentUiStatus | null = null
  private watched = new WeakSet<RendererTarget>()
  private readonly graceMs: number
  private readonly loadTimeoutMs: number

  constructor(
    private readonly getTarget: () => RendererTarget | null,
    opts: RendererBridgeOptions = {}
  ) {
    this.graceMs = opts.graceMs ?? 1500
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 20_000
  }

  getStatus(): AgentUiStatus | null {
    return this.status
  }

  /** `agent:status` from the renderer; the first one also means "the executor is listening". */
  setStatus(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const { screen, openProjectId } = raw as Partial<AgentUiStatus>
    if (typeof screen !== 'string') return
    this.status = { screen, openProjectId: typeof openProjectId === 'string' ? openProjectId : null }
  }

  /** Sends one command and resolves with the renderer's reply (or rejects with its error). */
  async send(method: AgentRendererMethod, params: unknown): Promise<unknown> {
    const target = await this.readyTarget()
    if (!this.watched.has(target)) {
      this.watched.add(target)
      target.onGone(() => {
        this.status = null
        this.rejectAll('no_window', 'The ZoomCut window was closed')
      })
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { method, resolve, reject })
      try {
        target.send({ requestId, method, params })
      } catch (err) {
        this.pending.delete(requestId)
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

  private async readyTarget(): Promise<RendererTarget> {
    const noWindow = (): AgentError => new AgentError('no_window', 'ZoomCut has no open window to do this in')
    const started = Date.now()
    let loadedSince: number | null = null
    for (;;) {
      const target = this.getTarget()
      if (!target) throw noWindow()
      if (this.status !== null) return target
      if (target.isLoaded()) {
        loadedSince ??= Date.now()
        if (Date.now() - loadedSince >= this.graceMs) return target
      }
      if (Date.now() - started > this.loadTimeoutMs) throw new AgentError('no_window', 'The ZoomCut window did not finish loading')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
