import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_DISCOVERY_FILE, AgentError, type AgentDiscovery } from '@shared/agent'
import { AgentServer, type AgentMethodTable } from './server'

const TOKEN = 'a'.repeat(64)

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/rpc',
        // a Host header given here replaces the one http.request derives from host:port
        headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...opts.headers }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

async function rpc(port: number, method: string, params?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const reply = await send(port, { headers, body: JSON.stringify(params === undefined ? { method } : { method, params }) })
  return { status: reply.status, json: reply.body ? JSON.parse(reply.body) : null }
}

let dir = ''
let discoveryPath = ''
let server: AgentServer | null = null

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'zoomcut-agent-test-'))
  discoveryPath = join(dir, 'nested', AGENT_DISCOVERY_FILE)
})

afterEach(async () => {
  await server?.stop()
  server = null
  await fsp.rm(dir, { recursive: true, force: true })
})

async function start(methods: AgentMethodTable, extra: Partial<ConstructorParameters<typeof AgentServer>[0]> = {}): Promise<AgentDiscovery> {
  server = new AgentServer({ methods, discoveryPath, version: '9.9.9', token: TOKEN, logError: () => undefined, ...extra })
  return server.start()
}

describe('discovery file', () => {
  it('publishes port, token, pid and version, and removes the file on stop', async () => {
    const info = await start({})
    expect(info).toEqual({ port: expect.any(Number), token: TOKEN, pid: process.pid, version: '9.9.9' })
    expect(info.port).toBeGreaterThan(0)
    expect(JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))).toEqual(info)
    // written through a temp file that is gone again
    expect((await fsp.readdir(join(dir, 'nested'))).sort()).toEqual([AGENT_DISCOVERY_FILE])
    await server!.stop()
    expect(existsSync(discoveryPath)).toBe(false)
    expect(server!.listening).toBe(false)
  })

  it('does not remove a file another instance wrote since', async () => {
    await start({})
    const theirs: AgentDiscovery = { port: 1, token: 'x', pid: process.pid + 1, version: '1' }
    await fsp.writeFile(discoveryPath, JSON.stringify(theirs))
    await server!.stop()
    expect(JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))).toEqual(theirs)
  })

  it('generates a random token and a new port per start', async () => {
    server = new AgentServer({ methods: {}, discoveryPath, version: '1' })
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
    const a = await server.start()
    expect(await server.start()).toEqual(a) // idempotent
    await server.stop()
    const other = new AgentServer({ methods: {}, discoveryPath, version: '1' })
    expect(other.token).not.toBe(server.token)
  })

  it('stop is safe without start and twice', async () => {
    server = new AgentServer({ methods: {}, discoveryPath, version: '1' })
    await server.stop()
    await start({})
    await server!.stop()
    await server!.stop()
  })
})

describe('dispatch', () => {
  it('calls the method with its params and wraps the result', async () => {
    const seen: unknown[] = []
    const { port } = await start({
      echo: (params) => {
        seen.push(params)
        return { you: params }
      }
    })
    expect(await rpc(port, 'echo', { a: 1 })).toEqual({ status: 200, json: { ok: true, result: { you: { a: 1 } } } })
    expect(await rpc(port, 'echo')).toEqual({ status: 200, json: { ok: true, result: { you: {} } } })
    expect(seen).toEqual([{ a: 1 }, {}])
  })

  it('awaits async handlers and turns a missing result into {}', async () => {
    const { port } = await start({
      slow: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return 42
      },
      nothing: async () => undefined
    })
    expect((await rpc(port, 'slow')).json).toEqual({ ok: true, result: 42 })
    expect((await rpc(port, 'nothing')).json).toEqual({ ok: true, result: {} })
  })

  it('reports an AgentError with its code', async () => {
    const { port } = await start({
      boom: () => {
        throw new AgentError('busy', 'A recording is running')
      },
      later: async () => {
        throw new AgentError('not_found', 'No such project')
      }
    })
    expect(await rpc(port, 'boom')).toEqual({ status: 200, json: { ok: false, error: { code: 'busy', message: 'A recording is running' } } })
    expect((await rpc(port, 'later')).json.error).toEqual({ code: 'not_found', message: 'No such project' })
  })

  it('reports any other error as failed and logs it', async () => {
    const logError = vi.fn()
    const { port } = await start(
      {
        crash: () => {
          throw new Error('disk on fire')
        },
        circular: () => {
          const a: Record<string, unknown> = {}
          a['self'] = a
          return a
        }
      },
      { logError }
    )
    expect((await rpc(port, 'crash')).json).toEqual({ ok: false, error: { code: 'failed', message: 'disk on fire' } })
    expect((await rpc(port, 'circular')).json.error.code).toBe('failed')
    expect(logError).toHaveBeenCalledTimes(2)
    // and the server still answers
    expect((await rpc(port, 'crash')).json.ok).toBe(false)
  })

  it('answers unknown methods, never reaching inherited properties', async () => {
    const { port } = await start({ known: () => 1 })
    for (const method of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const reply = await rpc(port, method)
      expect(reply.json, method).toEqual({ ok: false, error: { code: 'unknown_method', message: `Unknown method "${method}"` } })
    }
  })

  it('rejects malformed bodies with 400', async () => {
    const { port } = await start({ known: () => 1 })
    const bodies = ['', 'not json', '[]', '"x"', '{}', '{"method":5}', '{"method":"known","params":[1]}', '{"method":"known","params":null}']
    for (const body of bodies) {
      const reply = await send(port, { body })
      expect(reply.status, body).toBe(400)
      expect(JSON.parse(reply.body).error.code).toBe('bad_params')
    }
  })

  it('serves requests concurrently while a long one is running', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { port } = await start({ hold: () => gate.then(() => 'held'), quick: () => 'quick' })
    const held = rpc(port, 'hold')
    expect((await rpc(port, 'quick')).json.result).toBe('quick')
    release()
    expect((await held).json.result).toBe('held')
  })
})

describe('a client that hangs up', () => {
  /** posts a call and returns the request, so a test can destroy it while the handler still works */
  function post(port: number, method: string): { req: ReturnType<typeof request>; reply: Promise<Reply> } {
    let req!: ReturnType<typeof request>
    const reply = new Promise<Reply>((resolve, reject) => {
      req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/rpc', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ method }))
    })
    reply.catch(() => undefined)
    return { req, reply }
  }

  it('aborts the signal the handler got, and the handler can stop what it started', async () => {
    let signal: AbortSignal | undefined
    let release: () => void = () => undefined
    const finished = new Promise<void>((r) => (release = r))
    const { port } = await start({
      long: async (_params, s) => {
        signal = s
        await finished
        return 'too late'
      }
    })
    const { req } = post(port, 'long')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal!.aborted).toBe(false)
    req.destroy()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    release()
    // the server went on: the next call is served
    expect((await rpc(port, 'long')).json.result).toBe('too late')
  })

  it('leaves the signal alone for a call that was answered', async () => {
    let signal: AbortSignal | undefined
    const { port } = await start({
      quick: (_params, s) => {
        signal = s
        return 'done'
      }
    })
    expect((await rpc(port, 'quick')).json.result).toBe('done')
    await new Promise((r) => setTimeout(r, 50)) // the connection closes after the answer
    expect(signal!.aborted).toBe(false)
  })

  it('tolerates a handler that fails after the client left', async () => {
    let signal: AbortSignal | undefined
    let release: () => void = () => undefined
    const failNow = new Promise<void>((r) => (release = r))
    const logError = vi.fn()
    const { port } = await start(
      {
        long: async (_params, s) => {
          signal = s
          await failNow
          throw new Error('too late to matter')
        }
      },
      { logError }
    )
    const { req } = post(port, 'long')
    await vi.waitFor(() => expect(signal).toBeDefined())
    req.destroy()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true)) // the server noticed the hang-up before the handler fails
    release()
    await new Promise((r) => setTimeout(r, 60))
    expect((await rpc(port, 'long')).json.ok).toBe(false) // and still serving
  })
})

describe('access control', () => {
  it('answers 403 without a body for a missing, wrong or malformed token', async () => {
    const { port } = await start({ known: () => 1 })
    const body = JSON.stringify({ method: 'known' })
    const attempts: Array<Record<string, string>> = [
      { Authorization: '' },
      { Authorization: 'Bearer ' },
      { Authorization: `Bearer ${'b'.repeat(64)}` },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(1)}` },
      { Authorization: TOKEN },
      { Authorization: `bearer ${TOKEN}` },
      { Authorization: `Basic ${TOKEN}` }
    ]
    for (const headers of attempts) {
      const reply = await send(port, { headers, body })
      expect(reply.status, JSON.stringify(headers)).toBe(403)
      expect(reply.body).toBe('')
    }
  })

  it('answers 403 when an Origin header is present, whatever the token', async () => {
    const { port } = await start({ known: () => 1 })
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:' + port, '']) {
      const reply = await send(port, { headers: { Origin: origin }, body: JSON.stringify({ method: 'known' }) })
      expect(reply.status, origin).toBe(403)
      expect(reply.body).toBe('')
    }
  })

  it('answers 403 for a Host that is not 127.0.0.1:<port>', async () => {
    const { port } = await start({ known: () => 1 })
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `[::1]:${port}`]) {
      const reply = await send(port, { headers: { Host: host }, body: JSON.stringify({ method: 'known' }) })
      expect(reply.status, host).toBe(403)
      expect(reply.body).toBe('')
    }
  })

  it('checks Host and Origin before it looks at the path', async () => {
    const { port } = await start({})
    expect((await send(port, { path: '/anything', headers: { Origin: 'http://evil.example' } })).status).toBe(403)
    expect((await send(port, { method: 'GET', headers: { Host: 'evil.example' } })).status).toBe(403)
  })

  it('answers 404 for other paths and 405 for other verbs', async () => {
    const { port } = await start({ known: () => 1 })
    for (const path of ['/', '/rpc/', '/rpc/status', '/other', '/RPC']) {
      expect((await send(port, { path, body: '{}' })).status, path).toBe(404)
    }
    expect((await send(port, { path: '/rpc?x=1', body: JSON.stringify({ method: 'known' }) })).status).toBe(200)
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const reply = await send(port, { method })
      expect(reply.status, method).toBe(405)
      expect(reply.headers['allow']).toBe('POST')
    }
  })

  it('does not treat a wrong verb on a wrong path as anything but 404', async () => {
    const { port } = await start({})
    expect((await send(port, { method: 'GET', path: '/nope' })).status).toBe(404)
  })
})

describe('body size', () => {
  it('answers 413 above the limit and 200 at it', async () => {
    const { port } = await start({ size: (params) => String(params['pad']).length }, { maxBodyBytes: 200 })
    const envelope = (pad: string): string => JSON.stringify({ method: 'size', params: { pad } })
    const overhead = Buffer.byteLength(envelope(''))
    expect((await send(port, { body: envelope('x'.repeat(200 - overhead)) })).status).toBe(200)
    const big = await send(port, { body: envelope('x'.repeat(200 - overhead + 1)) })
    expect(big.status).toBe(413)
    expect(JSON.parse(big.body).ok).toBe(false)
  })

  it('answers 413 for a 1.5 MB body with the default limit and keeps serving', async () => {
    const { port } = await start({ known: () => 'fine' })
    const big = await send(port, { body: JSON.stringify({ method: 'known', params: { pad: 'x'.repeat(1_500_000) } }) })
    expect(big.status).toBe(413)
    expect((await rpc(port, 'known')).json.result).toBe('fine')
  })

  it('checks the token before reading a huge body', async () => {
    const { port } = await start({}, { maxBodyBytes: 100 })
    const reply = await send(port, { headers: { Authorization: 'Bearer nope' }, body: 'x'.repeat(1000) })
    expect(reply.status).toBe(403)
  })
})
