/**
 * The bridge's link to the ZoomCut app: finds the running app through its discovery file
 * (`agent-control.json` in the app's userData folder), makes sure it is running - starting it when
 * the bridge knows how - and sends it RPC calls over the loopback HTTP endpoint. Plain
 * node:http on purpose: global fetch times out after five minutes, and an export can take longer.
 * Never writes to stdout, which belongs to the MCP protocol.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDiscovery, AgentErrorCode, AgentRpcResponse } from '@shared/agent'

export const DISCOVERY_FILE = 'agent-control.json'

/** An error to show the agent: an RPC error from ZoomCut keeps its code, trouble reaching ZoomCut is `unavailable`. */
export class BridgeError extends Error {
  constructor(
    readonly code: AgentErrorCode | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** The folder Electron calls userData for this app: ZOOMCUT_USER_DATA, else the platform default for the app name "zoomcut". */
export function userDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env['ZOOMCUT_USER_DATA']) return env['ZOOMCUT_USER_DATA']
  if (platform === 'win32') return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'zoomcut')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'zoomcut')
  return join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'zoomcut')
}

export function discoveryPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return join(userDataDir(env, platform, home), DISCOVERY_FILE)
}

export function readDiscovery(path: string): AgentDiscovery | null {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentDiscovery>
    if (typeof d.port === 'number' && typeof d.token === 'string' && d.port > 0 && d.token) {
      return { port: d.port, token: d.token, pid: Number(d.pid) || 0, version: String(d.version ?? '') }
    }
  } catch {
    // no file, or half written: the app is not (yet) listening
  }
  return null
}

interface HttpReply {
  status: number
  text: string
}

function post(d: AgentDiscovery, method: string, params: unknown, signal?: AbortSignal): Promise<HttpReply> {
  const body = Buffer.from(JSON.stringify({ method, params }), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: d.port,
        method: 'POST',
        path: '/rpc',
        agent: false,
        signal,
        headers: {
          Authorization: `Bearer ${d.token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          Connection: 'close'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined
}

export interface ClientOptions {
  discoveryPath: string
  /** starts ZoomCut with agent control; null when the bridge does not know where the app is */
  launch: (() => Promise<void>) | null
  /** how long to wait for a launched ZoomCut to publish itself; default 30 s */
  launchTimeoutMs?: number
  pollMs?: number
  log?: (message: string) => void
}

export function notRunningMessage(path: string): string {
  return (
    `ZoomCut is not running with agent control (no usable ${path}). Start ZoomCut with the --agent-control flag ` +
    '(ZoomCut.exe --agent-control, or ZOOMCUT_AGENT_CONTROL=1 in its environment), or put the path of ZoomCut.exe in the ' +
    'ZOOMCUT_EXE environment variable of this MCP server so it can be started automatically.'
  )
}

/** Calls ZoomCut's RPC methods, finding or starting the app as needed. */
export class ZoomCutClient {
  private cached: AgentDiscovery | null = null
  private connecting: Promise<AgentDiscovery> | null = null

  constructor(private readonly opts: ClientOptions) {}

  /** Returns the method's result, or throws a BridgeError carrying ZoomCut's error code. */
  async call(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    let reconnected = false
    for (;;) {
      const d = await this.connect()
      let reply: HttpReply
      try {
        reply = await post(d, method, params, signal)
      } catch (err) {
        if (signal?.aborted) throw new BridgeError('cancelled', 'The request was cancelled')
        this.cached = null
        // nothing listens any more: the request never arrived, so it is safe to find (or start) the app and send it again
        if (errorCode(err) === 'ECONNREFUSED' && !reconnected) {
          reconnected = true
          continue
        }
        throw new BridgeError('unavailable', `Lost the connection to ZoomCut (${(err as Error).message}). If the app quit or crashed, call again to start it.`)
      }
      if (reply.status === 403 && !reconnected) {
        // the app restarted and wrote a new token (or this file is stale): read it again
        reconnected = true
        this.cached = null
        continue
      }
      let parsed: AgentRpcResponse
      try {
        parsed = JSON.parse(reply.text) as AgentRpcResponse
      } catch {
        throw new BridgeError('unavailable', `ZoomCut answered HTTP ${reply.status} without a usable body`)
      }
      if (parsed.ok) return parsed.result
      throw new BridgeError(parsed.error.code, parsed.error.message)
    }
  }

  private connect(): Promise<AgentDiscovery> {
    if (this.cached) return Promise.resolve(this.cached)
    this.connecting ??= this.findOrStart().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async alive(d: AgentDiscovery): Promise<boolean> {
    try {
      const reply = await post(d, 'status', {})
      return reply.status === 200 && (JSON.parse(reply.text) as AgentRpcResponse).ok === true
    } catch {
      return false
    }
  }

  private async findOrStart(): Promise<AgentDiscovery> {
    const { discoveryPath: path, launch, log } = this.opts
    const found = readDiscovery(path)
    if (found && (await this.alive(found))) return (this.cached = found)
    if (!launch) throw new BridgeError('unavailable', notRunningMessage(path))

    log?.('ZoomCut is not reachable; starting it with --agent-control')
    try {
      await launch()
    } catch (err) {
      throw new BridgeError('unavailable', `Could not start ZoomCut: ${(err as Error).message}`)
    }
    const timeout = this.opts.launchTimeoutMs ?? 30_000
    const poll = this.opts.pollMs ?? 250
    const started = Date.now()
    while (Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, poll))
      // read again every time: the app writes the file once its server is up, replacing a stale one
      const d = readDiscovery(path)
      if (d && (await this.alive(d))) return (this.cached = d)
    }
    throw new BridgeError('unavailable', `ZoomCut was started but did not become ready within ${Math.round(timeout / 1000)} s`)
  }
}

/**
 * How this bridge can start ZoomCut: through ZOOMCUT_EXE, or - when the bridge itself runs under
 * ZoomCut.exe in Node mode - through that same exe. Null otherwise (a plain `node` run).
 */
export function launcherFor(opts: {
  env: NodeJS.ProcessEnv
  execPath: string
  electronVersion: string | undefined
}): (() => Promise<void>) | null {
  const exe = opts.env['ZOOMCUT_EXE'] || (opts.electronVersion && /zoomcut\.exe$/i.test(opts.execPath) ? opts.execPath : '')
  if (!exe) return null
  return () =>
    new Promise<void>((resolve, reject) => {
      // the app must start as an app, not as a Node runtime like this process
      const env = { ...opts.env }
      delete env['ELECTRON_RUN_AS_NODE']
      const child = spawn(exe, ['--agent-control'], { detached: true, stdio: 'ignore', env })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
}
