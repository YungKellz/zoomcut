import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fsp, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { AgentError, type AgentDiscovery, type AgentRpcResponse } from '@shared/agent'

/** An RPC method: gets the call's `params` object, returns the `result` (or throws an AgentError). */
export type AgentMethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
export type AgentMethodTable = Record<string, AgentMethodHandler>

export interface AgentServerOptions {
  methods: AgentMethodTable
  /** where agent-control.json (port, token, pid, version) is written while the server listens */
  discoveryPath: string
  version: string
  /** requests with a bigger body get a 413; default 1 MB */
  maxBodyBytes?: number
  /** fixed bearer token, for tests; default 32 random bytes as hex */
  token?: string
  pid?: number
  /** unexpected handler failures; default console.error */
  logError?: (message: string, err: unknown) => void
}

const DEFAULT_MAX_BODY = 1024 * 1024

/**
 * The loopback RPC endpoint an MCP bridge talks to (see src/mcp): `POST /rpc` on 127.0.0.1 with a
 * random port and a random bearer token, both published in the discovery file. A browser page
 * or another host cannot reach it: requests with an Origin header, the wrong Host (DNS
 * rebinding) or the wrong token are answered 403 and nothing else. No request timeout on
 * purpose – an export or a scenario recording takes minutes. Knows nothing about Electron: the
 * method table, the file path and the version are handed in, which keeps it unit-testable.
 */
export class AgentServer {
  readonly token: string
  private server: Server | null = null
  private port = 0
  private readonly tokenDigest: Buffer
  private readonly maxBody: number
  private readonly pid: number

  constructor(private readonly opts: AgentServerOptions) {
    this.token = opts.token ?? randomBytes(32).toString('hex')
    this.tokenDigest = digest(this.token)
    this.maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY
    this.pid = opts.pid ?? process.pid
  }

  get listening(): boolean {
    return this.server !== null
  }

  /** Starts listening and publishes the discovery file. Resolves with what the file contains. */
  async start(): Promise<AgentDiscovery> {
    if (this.server) return this.discovery()
    const server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
    try {
      await this.writeDiscovery()
    } catch (err) {
      await this.stop()
      throw err
    }
    return this.discovery()
  }

  /** Closes the listener and removes the discovery file – synchronously first, so it also works while the app is quitting. */
  async stop(): Promise<void> {
    this.removeDiscovery()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** Deletes the discovery file if it is still ours (another instance may have overwritten it). */
  removeDiscovery(): void {
    try {
      const current = JSON.parse(readFileSync(this.opts.discoveryPath, 'utf8')) as Partial<AgentDiscovery>
      if (current.pid === this.pid) unlinkSync(this.opts.discoveryPath)
    } catch {
      // missing, unreadable or not ours – nothing to remove
    }
  }

  private discovery(): AgentDiscovery {
    return { port: this.port, token: this.token, pid: this.pid, version: this.opts.version }
  }

  private async writeDiscovery(): Promise<void> {
    const path = this.opts.discoveryPath
    await fsp.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${this.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.discovery()), { encoding: 'utf8', mode: 0o600 })
    // a reader (the bridge, antivirus) can hold the target for a moment: retry the rename
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, path)
        return
      } catch (err) {
        if (attempt >= 4) {
          await fsp.rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => undefined)
    // browsers always send Origin on cross-site requests, and a rebound DNS name arrives with its own Host
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${this.port}`) return deny(res)
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/rpc') return plain(res, 404)
    if (req.method !== 'POST') return plain(res, 405, { Allow: 'POST' })
    if (!this.authorized(req.headers.authorization)) return deny(res)

    // read the body, keeping at most maxBody of it: an oversized request is drained (up to a
    // hard cap) so the client gets its 413 instead of a reset connection
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > this.maxBody) {
        tooLarge = true
        chunks.length = 0
        if (size > this.maxBody * 16) req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return send(res, 413, JSON.stringify(fail('bad_params', `Request body is larger than ${this.maxBody} bytes`)))
      void this.dispatch(Buffer.concat(chunks).toString('utf8'), res)
    })
  }

  private authorized(header: string | undefined): boolean {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    return timingSafeEqual(digest(header.slice('Bearer '.length)), this.tokenDigest)
  }

  private async dispatch(body: string, res: ServerResponse): Promise<void> {
    let call: unknown
    try {
      call = JSON.parse(body)
    } catch {
      return send(res, 400, JSON.stringify(fail('bad_params', 'Request body is not valid JSON')))
    }
    if (typeof call !== 'object' || call === null || Array.isArray(call) || typeof (call as { method?: unknown }).method !== 'string') {
      return send(res, 400, JSON.stringify(fail('bad_params', 'Request body must be { "method": string, "params": object }')))
    }
    const { method, params = {} } = call as { method: string; params?: unknown }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return send(res, 400, JSON.stringify(fail('bad_params', '"params" must be an object')))
    }
    const handler = Object.hasOwn(this.opts.methods, method) ? this.opts.methods[method] : undefined
    if (!handler) return send(res, 200, JSON.stringify(fail('unknown_method', `Unknown method "${method}"`)))

    let text: string
    try {
      const result = await handler(params as Record<string, unknown>)
      // serialized here, once: a result that cannot be (circular, BigInt) is a failed call, not a crashed server
      text = JSON.stringify({ ok: true, result: result === undefined ? {} : result } satisfies AgentRpcResponse)
    } catch (err) {
      if (err instanceof AgentError) {
        text = JSON.stringify(fail(err.code, err.message))
      } else {
        ;(this.opts.logError ?? ((m, e) => console.error(m, e)))(`[agent] ${method} failed`, err)
        text = JSON.stringify(fail('failed', err instanceof Error ? err.message : String(err)))
      }
    }
    send(res, 200, text)
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function fail(code: AgentError['code'], message: string): AgentRpcResponse {
  return { ok: false, error: { code, message } }
}

function plain(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Length': '0', Connection: 'close', ...headers })
  res.end()
}

/** 403 without any detail: a wrong token, a foreign Origin and a wrong Host look the same from outside */
function deny(res: ServerResponse): void {
  plain(res, 403)
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    Connection: 'close'
  })
  res.end(text)
}
