import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENT_CONTROL_FLAG, AGENT_DISCOVERY_FILE, AgentError } from '@shared/agent'
import { AgentServer, type AgentMethodTable } from '../main/agent/server'
import { BridgeError, discoveryPath, isPidAlive, launcherFor, notRunningMessage, readDiscovery, resolveExe, userDataDir, ZoomCutClient } from './rpc'

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

  it('looks for the shared discovery file name in it', () => {
    expect(AGENT_DISCOVERY_FILE).toBe('agent-control.json')
    expect(discoveryPath({ ZOOMCUT_USER_DATA: 'D:\\data' })).toBe(join('D:\\data', AGENT_DISCOVERY_FILE))
  })
})

let dir = ''
let file = ''
const servers: AgentServer[] = []

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'zoomcut-mcp-test-'))
  file = join(dir, AGENT_DISCOVERY_FILE)
})

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  await fsp.rm(dir, { recursive: true, force: true })
})

async function serve(methods: AgentMethodTable, token?: string, pid?: number): Promise<AgentServer> {
  // the client finds out whether the app is alive by calling `status`, which the real app always has
  const server = new AgentServer({ methods: { status: () => ({}), ...methods }, discoveryPath: file, version: '1.0.0', token, pid, logError: () => undefined })
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
    expect(err.message).toContain(AGENT_CONTROL_FLAG)
    expect(err.message).toContain('ZOOMCUT_EXE')
  })

  it('says that the environment variable only works for a copy that is not open yet, and why a ZOOMCUT_EXE was ignored', async () => {
    const plain = notRunningMessage(file)
    expect(plain).toContain('ZOOMCUT_AGENT_CONTROL=1')
    expect(plain).toContain('not open yet')
    expect(plain).toContain('absolute path')
    const err = await failure(client({ exeProblem: 'ZOOMCUT_EXE ("ZoomCut.exe") is ignored: nope.' }).call('status'))
    expect(err.message).toContain('ZOOMCUT_EXE ("ZoomCut.exe") is ignored: nope.')
  })

  it('treats a leftover file of a dead app as not running', async () => {
    await fsp.writeFile(file, JSON.stringify({ port: 1, token: 'old', pid: 1, version: '0' }))
    expect((await failure(client().call('status'))).code).toBe('unavailable')
  })

  describe('a discovery file left behind by an app that is gone', () => {
    const DEAD = 424242 // the injected check decides, no real process involved

    it('is not trusted even when something answers on its port', async () => {
      // another process now listens where ZoomCut did: it would get every call, token included
      await serve({ ping: () => 'impostor' }, undefined, DEAD)
      const asked: number[] = []
      const c = client({ pidAlive: (pid) => (asked.push(pid), false) })
      const err = await failure(c.call('ping'))
      expect(err.code).toBe('unavailable')
      expect(asked).toEqual([DEAD])
    })

    it('is used while the app that wrote it runs', async () => {
      await serve({ ping: () => 'pong' }, undefined, DEAD)
      expect(await client({ pidAlive: (pid) => pid === DEAD }).call('ping')).toBe('pong')
    })

    it('is replaced by the one of the app that gets started, and the poll ignores it meanwhile', async () => {
      await serve({ ping: () => 'impostor' }, undefined, DEAD)
      const launch = vi.fn(async () => {
        await servers[0].stop() // the impostor stops answering; the real app writes its own file a moment later
        setTimeout(() => void serve({ ping: () => 'real' }, undefined, process.pid), 60)
      })
      const alive = (pid: number): boolean => pid === process.pid
      expect(await client({ launch, pidAlive: alive }).call('ping')).toBe('real')
      expect(launch).toHaveBeenCalledTimes(1)
    })

    it('does not judge a file without a pid', async () => {
      const server = await serve({ ping: () => 'pong' })
      await fsp.writeFile(file, JSON.stringify({ ...readDiscovery(file)!, pid: 0, token: server.token }))
      expect(await client({ pidAlive: () => false }).call('ping')).toBe('pong')
    })
  })

  describe('isPidAlive', () => {
    it('knows this process and a process that ended', () => {
      expect(isPidAlive(process.pid)).toBe(true)
      const ended = spawnSync(process.execPath, ['-e', '0'])
      expect(ended.pid).toBeGreaterThan(0)
      expect(isPidAlive(ended.pid)).toBe(false)
    })
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
  const present = (): boolean => true
  const absent = (): boolean => false
  const portable = resolve('ZoomCut-Portable.exe') // an absolute path on whatever platform the tests run

  it('knows how to start the app only through ZOOMCUT_EXE or when it runs under ZoomCut.exe', () => {
    expect(launcherFor({ env: {}, execPath: 'C:\\Program Files\\nodejs\\node.exe', electronVersion: undefined })).toBeNull()
    expect(launcherFor({ env: {}, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', electronVersion: '44.0.0' })).toBeNull()
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZoomCut\\ZoomCut.exe', electronVersion: undefined })).toBeNull() // a node renamed ZoomCut.exe is not the app
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZoomCut\\ZoomCut.exe', electronVersion: '44.0.0' })).toBeTypeOf('function')
    expect(launcherFor({ env: {}, execPath: 'C:\\Apps\\ZOOMCUT.EXE', electronVersion: '44.0.0' })).toBeTypeOf('function')
    expect(launcherFor({ env: { ZOOMCUT_EXE: portable }, execPath: 'node', electronVersion: undefined, exists: present })).toBeTypeOf('function')
  })

  describe('ZOOMCUT_EXE', () => {
    it('counts only as the absolute path of a file that exists', () => {
      expect(resolveExe({ env: { ZOOMCUT_EXE: portable }, execPath: 'node', electronVersion: undefined, exists: present })).toEqual({ exe: portable, problem: null })
      expect(resolveExe({ env: {}, execPath: 'node', electronVersion: undefined })).toEqual({ exe: null, problem: null })
    })

    it('is ignored when relative, bare or missing - the bridge would resolve it against the working directory of the MCP client', () => {
      for (const value of ['release/win-unpacked/ZoomCut.exe', 'ZoomCut.exe', '.\\ZoomCut.exe']) {
        const r = resolveExe({ env: { ZOOMCUT_EXE: value }, execPath: 'node', electronVersion: undefined, exists: present })
        expect(r.exe, value).toBeNull()
        expect(r.problem, value).toContain(value)
        expect(r.problem, value).toContain('absolute path')
      }
      const missing = resolveExe({ env: { ZOOMCUT_EXE: portable }, execPath: 'node', electronVersion: undefined, exists: absent })
      expect(missing.exe).toBeNull()
      expect(missing.problem).toContain('existing')
    })

    it('falls back to the exe the bridge runs under, and says why on stderr', () => {
      const log = vi.fn()
      const under = { execPath: 'C:\\Apps\\ZoomCut\\ZoomCut.exe', electronVersion: '44.0.0' }
      expect(resolveExe({ env: { ZOOMCUT_EXE: 'ZoomCut.exe' }, ...under, exists: present }).exe).toBe(under.execPath)
      expect(launcherFor({ env: { ZOOMCUT_EXE: 'ZoomCut.exe' }, ...under, exists: present, log })).toBeTypeOf('function')
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ZOOMCUT_EXE ("ZoomCut.exe") is ignored'))
      // nowhere to fall back to: no launcher at all, and still the note
      log.mockClear()
      expect(launcherFor({ env: { ZOOMCUT_EXE: 'ZoomCut.exe' }, execPath: 'node', electronVersion: undefined, exists: present, log })).toBeNull()
      expect(log).toHaveBeenCalledTimes(1)
    })
  })
})
