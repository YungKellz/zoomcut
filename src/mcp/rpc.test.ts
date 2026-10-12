import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentError } from '@shared/agent'
import { AgentServer, type AgentMethodTable } from '../main/agent/server'
import { BridgeError, DISCOVERY_FILE, discoveryPath, launcherFor, readDiscovery, userDataDir, ZoomCutClient } from './rpc'

describe('userDataDir', () => {
  it('prefers ZOOMCUT_USER_DATA', () => {
    expect(userDataDir({ ZOOMCUT_USER_DATA: 'D:\\data', APPDATA: 'C:\\x' }, 'win32', 'C:\\Users\\me')).toBe('D:\\data')
  })

  it('is %APPDATA%\\zoomcut on Windows, with a fallback under the home folder', () => {
    expect(userDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'zoomcut'))
    expect(userDataDir({}, 'win32', 'C:\\Users\\me')).toBe(join('C:\\Users\\me', 'AppData', 'Roaming', 'zoomcut'))
  })

  it('follows the platform conventions elsewhere', () => {
    expect(userDataDir({}, 'darwin', '/Users/me')).toBe(join('/Users/me', 'Library', 'Application Support', 'zoomcut'))
    expect(userDataDir({}, 'linux', '/home/me')).toBe(join('/home/me', '.config', 'zoomcut'))
    expect(userDataDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me')).toBe(join('/cfg', 'zoomcut'))
  })

  it('looks for agent-control.json in it', () => {
    expect(discoveryPath({ ZOOMCUT_USER_DATA: 'D:\\data' })).toBe(join('D:\\data', DISCOVERY_FILE))
  })
})

let dir = ''
let file = ''
const servers: AgentServer[] = []

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'zoomcut-mcp-test-'))
  file = join(dir, DISCOVERY_FILE)
})

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  await fsp.rm(dir, { recursive: true, force: true })
})

async function serve(methods: AgentMethodTable, token?: string): Promise<AgentServer> {
  // the client finds out whether the app is alive by calling `status`, which the real app always has
  const server = new AgentServer({ methods: { status: () => ({}), ...methods }, discoveryPath: file, version: '1.0.0', token, logError: () => undefined })
  servers.push(server)
  await server.start()
  return server
}

function client(extra: Partial<ConstructorParameters<typeof ZoomCutClient>[0]> = {}): ZoomCutClient {
  return new ZoomCutClient({ discoveryPath: file, launch: null, pollMs: 20, launchTimeoutMs: 1000, ...extra })
}

async function failure(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError)
    return err as BridgeError
  }
  throw new Error('expected the call to fail')
}

describe('readDiscovery', () => {
  it('reads a good file and ignores a missing, broken or incomplete one', async () => {
    expect(readDiscovery(file)).toBeNull()
    await fsp.writeFile(file, '{ nope')
    expect(readDiscovery(file)).toBeNull()
    await fsp.writeFile(file, JSON.stringify({ port: 'x', token: 't' }))
    expect(readDiscovery(file)).toBeNull()
    await fsp.writeFile(file, JSON.stringify({ port: 4000, token: '' }))
    expect(readDiscovery(file)).toBeNull()
    await fsp.writeFile(file, JSON.stringify({ port: 4000, token: 'abc', pid: 12, version: '0.4.1' }))
    expect(readDiscovery(file)).toEqual({ port: 4000, token: 'abc', pid: 12, version: '0.4.1' })
  })
})

describe('ZoomCutClient', () => {
  it('calls a method and returns its result', async () => {
    await serve({ echo: (p) => ({ got: p }) })
    expect(await client().call('echo', { a: 1 })).toEqual({ got: { a: 1 } })
  })

  it('turns an RPC error into a BridgeError with the same code', async () => {
    await serve({
      boom: () => {
        throw new AgentError('busy', 'A recording is already in progress')
      }
    })
    const err = await failure(client().call('boom'))
    expect(err.code).toBe('busy')
    expect(err.message).toBe('A recording is already in progress')
    expect((await failure(client().call('missing'))).code).toBe('unknown_method')
  })

  it('has no time limit of its own on a slow call', async () => {
    await serve({ slow: async () => new Promise((r) => setTimeout(() => r('late'), 400)) })
    expect(await client().call('slow')).toBe('late')
  })

  it('says how to start ZoomCut when it is not running and it cannot start it', async () => {
    const err = await failure(client().call('status'))
    expect(err.code).toBe('unavailable')
    expect(err.message).toContain(file)
    expect(err.message).toContain('--agent-control')
    expect(err.message).toContain('ZOOMCUT_EXE')
  })

  it('treats a leftover file of a dead app as not running', async () => {
    await fsp.writeFile(file, JSON.stringify({ port: 1, token: 'old', pid: 1, version: '0' }))
    expect((await failure(client().call('status'))).code).toBe('unavailable')
  })

  it('reads the discovery file again after a wrong token, so a restarted app is found', async () => {
    await serve({ ping: () => 'pong' }, 'a'.repeat(64))
    const c = client()
    expect(await c.call('ping')).toBe('pong')
    // the app restarts with a new token and port; the client still holds the old ones
    await servers[0].stop()
    await serve({ ping: () => 'pong again' }, 'b'.repeat(64))
    expect(await c.call('ping')).toBe('pong again')
  })

  it('does not trust a file whose token the app refuses', async () => {
    const server = await serve({ ping: () => 'pong' }, 'a'.repeat(64))
    const info = readDiscovery(file)!
    await fsp.writeFile(file, JSON.stringify({ ...info, token: 'wrong' }))
    expect((await failure(client().call('ping'))).code).toBe('unavailable')
    await fsp.writeFile(file, JSON.stringify({ ...info, token: server.token }))
    expect(await client().call('ping')).toBe('pong')
  })

  it('starts the app when it is not running, waits for it to publish itself, and starts it once for concurrent calls', async () => {
    const launch = vi.fn(async () => {
      // the app takes a moment to come up and write the file
      setTimeout(() => void serve({ ping: () => 'pong' }), 100)
    })
    const c = client({ launch })
    const [a, b] = await Promise.all([c.call('ping'), c.call('ping')])
    expect([a, b]).toEqual(['pong', 'pong'])
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('replaces a stale file when it starts the app', async () => {
    await fsp.writeFile(file, JSON.stringify({ port: 1, token: 'old', pid: 1, version: '0' }))
    const launch = vi.fn(async () => {
      setTimeout(() => void serve({ ping: () => 'fresh' }), 50)
    })
    expect(await client({ launch }).call('ping')).toBe('fresh')
  })

  it('starts the app again when it has gone away since the last call', async () => {
    await serve({ ping: () => 'first' })
    const launch = vi.fn(async () => {
      setTimeout(() => void serve({ ping: () => 'second' }), 50)
    })
    const c = client({ launch })
    expect(await c.call('ping')).toBe('first')
    await servers[0].stop() // quits (and removes the file)
    expect(await c.call('ping')).toBe('second')
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('reports a launch that fails or never produces a server', async () => {
    const failing = await failure(client({ launch: async () => Promise.reject(new Error('spawn ENOENT')) }).call('status'))
    expect(failing.code).toBe('unavailable')
    expect(failing.message).toContain('Could not start ZoomCut: spawn ENOENT')
    const silent = await failure(client({ launch: async () => undefined, launchTimeoutMs: 150 }).call('status'))
    expect(silent.message).toContain('did not become ready')
  })

  it('stops a call whose signal is aborted', async () => {
    await serve({ slow: () => new Promise((r) => setTimeout(r, 2000)) })
    const controller = new AbortController()
    const call = client().call('slow', {}, controller.signal)
    setTimeout(() => controller.abort(), 100)
    expect((await failure(call)).code).toBe('cancelled')
  })
})

describe('launcherFor', () => {
  it('knows how to start the app only through ZOOMCUT_EXE or when it runs under ZoomCut.exe', () => {
    expect(launcherFor({ env: {}, execPath: 'C:\\Program Files\\nodejs\\node.exe', electronVersion: undefined })).toBeNull()
    expect(launcherFor({ env: {}, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', electronVersion: '44.0.0' })).toBeNull()
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZoomCut\\ZoomCut.exe', electronVersion: undefined })).toBeNull() // a node renamed ZoomCut.exe is not the app
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZoomCut\\ZoomCut.exe', electronVersion: '44.0.0' })).toBeTypeOf('function')
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZOOMCUT.EXE', electronVersion: '44.0.0' })).toBeTypeOf('function')
    expect(launcherFor({ env: { ZOOMCUT_EXE: 'D:\\ZoomCut-Portable.exe' }, execPath: 'node', electronVersion: undefined })).toBeTypeOf('function')
  })
})
