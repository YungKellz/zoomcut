import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { agentParamSchemas } from '@shared/agentSchemas'
import { BridgeError } from './rpc'
import { registerTools, SERVER_INSTRUCTIONS, TOOLS, type RpcCaller } from './tools'

interface Call {
  method: string
  params: unknown
}

let client: Client | null = null

afterEach(async () => {
  await client?.close()
  client = null
})

async function connect(rpc: RpcCaller, heartbeatMs?: number): Promise<Client> {
  const server = new McpServer({ name: 'zoomcut', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS })
  registerTools(server, rpc, { heartbeatMs })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

function recording(result: unknown = {}): { rpc: RpcCaller; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    rpc: {
      call: async (method, params) => {
        calls.push({ method, params })
        return typeof result === 'function' ? (result as () => unknown)() : result
      }
    }
  }
}

function textOf(result: unknown): string {
  const block = ((result as { content?: unknown }).content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
  return block?.text ?? ''
}

describe('the tool list', () => {
  it('has the 18 tools of the design, each with a real description', async () => {
    const c = await connect(recording().rpc)
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'cancel_recording', 'create_scenario', 'delete_project', 'delete_scenario', 'edit_project', 'export_project', 'get_project', 'get_scenario',
        'get_status', 'list_displays', 'list_projects', 'list_scenarios', 'record_scenario', 'start_recording', 'start_scenario_capture',
        'stop_recording', 'stop_scenario_capture', 'take_screenshot'
      ].sort()
    )
    for (const t of tools) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(60)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('explains the units and the dangerous tools', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]))
    expect(by['edit_project']).toContain('SOURCE milliseconds')
    expect(by['edit_project']).toContain('undo step')
    expect(by['edit_project']).toContain('whatever the order of the operations')
    expect(by['create_scenario']).toContain('DIP')
    expect(by['create_scenario']).toContain('take_screenshot')
    expect(by['record_scenario']).toContain('REAL mouse')
    expect(by['start_recording']).toContain('REAL screen')
    expect(by['take_screenshot']).toContain('scale')
    expect(SERVER_INSTRUCTIONS).toContain('REAL')
  })

  it('tells the agent what a cancelled call does in the app, and which deletes are refused', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]))
    for (const name of ['start_recording', 'record_scenario', 'start_scenario_capture', 'export_project']) expect(by[name], name).toContain('cancelled')
    expect(by['stop_recording']).toContain('does not stop the saving')
    expect(by['edit_project']).toContain('does not take back edits')
    expect(by['delete_project']).toContain('composition')
    expect(by['delete_scenario']).toContain('scenario review')
    expect(by['stop_scenario_capture']).toContain('already ended')
  })

  it('lists what a start is refused for, and what an export is', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]))
    for (const name of ['start_recording', 'record_scenario', 'start_scenario_capture']) {
      expect(by[name], name).toContain('`busy`')
      for (const refusal of ['an export is running', 'export dialog', 'composition export', 'export_project', 'voiceover', 'GIF conversion', 'scenario Preview', 'recording', 'scenario capture']) {
        expect(by[name], `${name}: ${refusal}`).toContain(refusal)
      }
    }
    expect(by['export_project']).toMatch(/`busy` while a recording.*scenario replay.*scenario capture/)
    expect(by['delete_project']).toContain('exported')
  })

  it('documents what a scenario action can hold, and what get_scenario hands back', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]))
    const create = by['create_scenario']
    expect(create).toMatch(/hoverOnly: true.*only move the cursor.*press nothing/)
    expect(create).toMatch(/only on these click kinds, and not together with modifiers/)
    expect(create).toMatch(/drag \(x, y to toX, toY, optional `modifiers`/)
    expect(create).toContain('`id` is ignored')
    expect(create).toContain('rejected as outside the display')
    const get = by['get_scenario']
    expect(get).toContain('hoverOnly: true')
    expect(get).toContain('passed back as they are')
    expect(get).toContain('`id`')
    expect(get).toContain('rejects it as outside the display')
  })

  it('marks reads as read-only and deletes as destructive', async () => {
    const c = await connect(recording().rpc)
    const { tools } = await c.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
    for (const name of ['get_status', 'list_displays', 'take_screenshot', 'list_projects', 'get_project', 'list_scenarios', 'get_scenario']) {
      expect(by[name]?.readOnlyHint, name).toBe(true)
    }
    for (const name of ['delete_project', 'delete_scenario', 'cancel_recording']) expect(by[name]?.destructiveHint, name).toBe(true)
    expect(by['edit_project']?.destructiveHint).toBe(false)
    expect(by['record_scenario']?.openWorldHint).toBe(true)
  })

  it('publishes the documented edit operations', async () => {
    const c = await connect(recording().rpc)
    const edit = (await c.listTools()).tools.find((t) => t.name === 'edit_project')!
    const schema = JSON.stringify(edit.inputSchema)
    for (const op of ['rename', 'addCut', 'removeCut', 'addZoom', 'updateZoom', 'removeZoom', 'addText', 'updateText', 'removeText', 'addBlur', 'removeBlur', 'setCrop', 'setFrame', 'setCursor']) {
      expect(schema, op).toContain(`"${op}"`)
    }
    expect(schema).toContain('SOURCE milliseconds')
    expect((edit.inputSchema as { required?: string[] }).required).toEqual(['projectId', 'operations'])
  })
})

describe('calling tools', () => {
  it('sends every tool to its RPC method with the arguments, and returns the result as JSON text', async () => {
    const samples: Record<string, Record<string, unknown>> = {
      get_status: {},
      list_displays: {},
      take_screenshot: { displayId: 1, maxWidth: 800 },
      start_recording: { mic: false },
      stop_recording: {},
      cancel_recording: {},
      list_projects: {},
      get_project: { projectId: 'p1' },
      edit_project: { projectId: 'p1', operations: [{ op: 'addCut', start: 0, end: 500 }] },
      export_project: { projectId: 'p1', format: 'gif', fps: 15 },
      delete_project: { projectId: 'p1' },
      list_scenarios: {},
      get_scenario: { scenarioId: 's1' },
      create_scenario: { name: 'n', actions: [{ kind: 'key', key: 'Enter' }] },
      delete_scenario: { scenarioId: 's1' },
      record_scenario: { scenarioId: 's1', systemAudio: true },
      start_scenario_capture: {},
      stop_scenario_capture: {}
    }
    for (const tool of TOOLS) {
      const shot = { displayId: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 0.5, mimeType: 'image/png', data: 'QUJD' }
      const { rpc, calls } = recording(tool.name === 'take_screenshot' ? shot : { answer: tool.name })
      const c = await connect(rpc)
      const args = samples[tool.name]
      const result = await c.callTool({ name: tool.name, arguments: args })
      expect(result.isError, tool.name).toBeFalsy()
      expect(calls, tool.name).toEqual([{ method: tool.method, params: args }])
      if (tool.name !== 'take_screenshot') expect(JSON.parse(textOf(result)), tool.name).toEqual({ answer: tool.name })
      await c.close()
      client = null
    }
    // every sample is accepted by the schema the app validates against, and every method has a tool
    for (const tool of TOOLS) expect(agentParamSchemas[tool.method].safeParse(samples[tool.name]).success, tool.name).toBe(true)
    expect(new Set(TOOLS.map((t) => t.method)).size).toBe(Object.keys(agentParamSchemas).length)
  })

  it('accepts a call without arguments for a tool that has none', async () => {
    const { rpc, calls } = recording({ screen: 'home' })
    const c = await connect(rpc)
    const result = await c.callTool({ name: 'get_status' })
    expect(JSON.parse(textOf(result))).toEqual({ screen: 'home' })
    expect(calls).toEqual([{ method: 'status', params: {} }])
  })

  it('shows a screenshot as an image followed by how to turn its pixels into DIP', async () => {
    const { rpc } = recording({ displayId: 7, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scale: 0.5, mimeType: 'image/png', data: 'QUJD' })
    const c = await connect(rpc)
    const result = await c.callTool({ name: 'take_screenshot', arguments: { displayId: 7, maxWidth: 960 } })
    const blocks = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>
    expect(blocks[0]).toMatchObject({ type: 'image', data: 'QUJD', mimeType: 'image/png' })
    const info = textOf(result)
    expect(info).toContain('display 7')
    expect(info).toContain('960x540 px')
    expect(info).toContain('scale = 0.5')
    expect(info).toContain('x = px / 0.5')
  })

  it('reports an error from the app as "<code>: <message>"', async () => {
    const rpc: RpcCaller = {
      call: async () => {
        throw new BridgeError('not_found', 'No recording with id "x"')
      }
    }
    const c = await connect(rpc)
    const result = await c.callTool({ name: 'get_project', arguments: { projectId: 'x' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('not_found: No recording with id "x"')
  })

  it('reports an unexpected failure as failed', async () => {
    const c = await connect({
      call: async () => {
        throw new Error('socket exploded')
      }
    })
    const result = await c.callTool({ name: 'get_status' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('failed: socket exploded')
  })

  it('refuses invalid arguments before they reach the app', async () => {
    const { rpc, calls } = recording()
    const c = await connect(rpc)
    const traversal = await c.callTool({ name: 'get_project', arguments: { projectId: '../x' } })
    expect(traversal.isError).toBe(true)
    expect(textOf(traversal)).toContain('projectId')
    const reversed = await c.callTool({ name: 'edit_project', arguments: { projectId: 'p1', operations: [{ op: 'addCut', start: 3000, end: 2000 }] } })
    expect(reversed.isError).toBe(true)
    expect(textOf(reversed)).toMatch(/Invalid|start/)
    const typo = await c.callTool({ name: 'edit_project', arguments: { projectId: 'p1', operations: [{ op: 'addCut', start: 0, end_ms: 100 }] } })
    expect(typo.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('lets a client that asked for progress know a long call is alive', async () => {
    const rpc: RpcCaller = { call: () => new Promise((resolve) => setTimeout(() => resolve({ projectId: 'p' }), 250)) }
    const c = await connect(rpc, 40)
    const progress: Array<{ progress: number; message?: string }> = []
    const result = await c.callTool({ name: 'stop_recording' }, undefined, { onprogress: (p) => progress.push(p) })
    expect(JSON.parse(textOf(result))).toEqual({ projectId: 'p' })
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.map((p) => p.progress)).toEqual([...progress.map((p) => p.progress)].sort((a, b) => a - b))
    expect(progress[0].message).toContain('stop_recording')
  })

  it('sends no progress to a client that did not ask', async () => {
    const rpc: RpcCaller = { call: () => new Promise((resolve) => setTimeout(() => resolve({}), 120)) }
    const c = await connect(rpc, 20)
    const result = await c.callTool({ name: 'stop_recording' })
    expect(result.isError).toBeFalsy()
  })
})
