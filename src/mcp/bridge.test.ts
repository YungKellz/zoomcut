import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENT_DISCOVERY_FILE, AgentError } from '@shared/agent'
import { AgentServer } from '../main/agent/server'

/**
 * The built bridge (out/mcp/zoomcut-mcp.cjs, from `npm run build`) spoken to over real stdio by a
 * real MCP client, with the control server standing in for the app. Skipped while the bridge has
 * not been built (CI runs the unit tests before the build); the e2e suite does the same against the
 * real app.
 */
const bridge = resolve('out/mcp/zoomcut-mcp.cjs')

describe.skipIf(!existsSync(bridge))('the built stdio bridge', () => {
  let dir = ''
  let server: AgentServer
  let client: Client
  const calls: Array<{ method: string; params: unknown }> = []

  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'zoomcut-bridge-test-'))
    server = new AgentServer({
      discoveryPath: join(dir, AGENT_DISCOVERY_FILE),
      version: '9.9.9',
      logError: () => undefined,
      methods: {
        status: (p) => {
          calls.push({ method: 'status', params: p })
          return { version: '9.9.9', screen: 'home', recording: 'idle', scenarioCapture: 'idle', openProjectId: null }
        },
        'displays.list': () => [{ id: 3, name: 'Screen 1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true }],
        'projects.get': () => {
          throw new AgentError('not_found', 'No recording with id "nope"')
        },
        screenshot: () => ({ displayId: 3, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 0.25, mimeType: 'image/png', data: 'iVBORw0KGgo=' })
      }
    })
    await server.start()
    client = new Client({ name: 'bridge-test', version: '1' })
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [bridge], env: { ZOOMCUT_USER_DATA: dir, PATH: process.env['PATH'] ?? '' }, stderr: 'pipe' })
    )
  })

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    await server?.stop()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('introduces itself and lists the tools without the app being asked', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'zoomcut' })
    expect(client.getServerVersion()?.version).toMatch(/^\d+\.\d+\.\d+/)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(18)
    expect(calls).toEqual([])
  })

  it('carries a call to the app and back', async () => {
    const status = await client.callTool({ name: 'get_status', arguments: {} })
    const text = (status.content as Array<{ text: string }>)[0].text
    expect(JSON.parse(text)).toMatchObject({ version: '9.9.9', screen: 'home' })
    const displays = await client.callTool({ name: 'list_displays', arguments: {} })
    expect(JSON.parse((displays.content as Array<{ text: string }>)[0].text)[0]).toMatchObject({ id: 3, primary: true })
  })

  it('names the error code of a failed call', async () => {
    const result = await client.callTool({ name: 'get_project', arguments: { projectId: 'nope' } })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toBe('not_found: No recording with id "nope"')
  })

  it('returns a screenshot as an image', async () => {
    const result = await client.callTool({ name: 'take_screenshot', arguments: { maxWidth: 480 } })
    const blocks = result.content as Array<{ type: string; mimeType?: string; text?: string }>
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text'])
    expect(blocks[0].mimeType).toBe('image/png')
    expect(blocks[1].text).toContain('scale = 0.25')
  })

  it('reaches an app that restarted with a new port and token', async () => {
    await server.stop()
    const again = new AgentServer({
      discoveryPath: join(dir, AGENT_DISCOVERY_FILE),
      version: '9.9.9',
      logError: () => undefined,
      methods: { status: () => ({ version: 'second', screen: 'editor', recording: 'idle', scenarioCapture: 'idle', openProjectId: 'p1' }) }
    })
    server = again
    await again.start()
    const status = await client.callTool({ name: 'get_status', arguments: {} })
    expect(JSON.parse((status.content as Array<{ text: string }>)[0].text)).toMatchObject({ version: 'second', openProjectId: 'p1' })
  })
})
