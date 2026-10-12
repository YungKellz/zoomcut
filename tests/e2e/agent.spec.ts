import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { projectIds, readProject, sleep, tmpRoot, useEnglish } from './adv-helpers'

/**
 * Agent control end to end: the app runs with --agent-control, a real MCP client talks to the
 * built stdio bridge (out/mcp/zoomcut-mcp.cjs, run with node) which finds the app through the
 * discovery file in an isolated userData. Records the real screen for a few seconds and exports
 * one MP4; nothing here injects input except the last test, which only runs with
 * ZOOMCUT_E2E_REPLAY=1 (it replays a scenario - presses Shift - while recording).
 */
const base = join(tmpRoot, 'agent')
const userData = join(base, 'userData')
const recordingsDir = join(base, 'recordings')
const scenariosDir = join(base, 'scenarios')
const compositionsDir = join(base, 'compositions')
const exportDir = join(base, 'exports')
const bridge = resolve('out/mcp/zoomcut-mcp.cjs')

let app: ElectronApplication
let win: Page
let client: Client
const errors: string[] = []

interface ToolResult {
  isError?: boolean
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
}

async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true })) as ToolResult
}

/** Calls a tool and returns its JSON result; a tool error fails the test with its text. */
async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await callRaw(name, args)
  const text = r.content.find((c) => c.type === 'text')?.text ?? ''
  if (r.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

/** Calls a tool that must fail and returns its error text. */
async function callError(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await callRaw(name, args)
  expect(r.isError, `${name} should fail`).toBe(true)
  return r.content.find((c) => c.type === 'text')?.text ?? ''
}

function discovery(): { port: number; token: string; pid: number } {
  return JSON.parse(readFileSync(join(userData, 'agent-control.json'), 'utf8'))
}

function rawPost(port: number, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolvePost, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume()
      res.on('end', () => resolvePost(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!existsSync(bridge)) throw new Error('build first: npm run build (out/mcp/zoomcut-mcp.cjs is missing)')
  rmSync(base, { recursive: true, force: true })
  for (const d of [userData, recordingsDir, scenariosDir, compositionsDir, exportDir]) mkdirSync(d, { recursive: true })
  const exe = process.env['ZOOMCUT_EXE']
  app = await electron.launch({
    ...(exe ? { executablePath: resolve(exe), args: ['--agent-control'] } : { args: ['.', '--agent-control'] }),
    env: {
      ...process.env,
      ZOOMCUT_E2E: '1',
      ZOOMCUT_USER_DATA: userData,
      ZOOMCUT_RECORDINGS_DIR: recordingsDir,
      ZOOMCUT_SCENARIOS_DIR: scenariosDir,
      ZOOMCUT_COMPOSITIONS_DIR: compositionsDir
    }
  })
  win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  win.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
  await useEnglish(win)

  for (let i = 0; i < 100 && !existsSync(join(userData, 'agent-control.json')); i++) await sleep(100)
  expect(existsSync(join(userData, 'agent-control.json')), 'discovery file').toBe(true)

  client = new Client({ name: 'zoomcut-e2e', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [bridge], env: { ZOOMCUT_USER_DATA: userData }, stderr: 'inherit' })
  )
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  // the discovery file goes away with the app
  expect(existsSync(join(userData, 'agent-control.json'))).toBe(false)
  expect(errors.filter((e) => !e.includes('net::ERR_ABORTED'))).toEqual([])
})

test('lists every tool and reports the app status', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  expect(names).toEqual(
    [
      'cancel_recording',
      'create_scenario',
      'delete_project',
      'delete_scenario',
      'edit_project',
      'export_project',
      'get_project',
      'get_scenario',
      'get_status',
      'list_displays',
      'list_projects',
      'list_scenarios',
      'record_scenario',
      'start_recording',
      'start_scenario_capture',
      'stop_recording',
      'stop_scenario_capture',
      'take_screenshot'
    ].sort()
  )
  for (const t of tools) expect(t.description?.length ?? 0, t.name).toBeGreaterThan(30)

  const status = await call<{ version: string; screen: string; recording: string }>('get_status')
  expect(status.screen).toBe('home')
  expect(status.recording).toBe('idle')
  expect(status.version).toMatch(/^\d+\.\d+\.\d+/)
})

test('the control server only answers its own token, without an Origin', async () => {
  const { port, token, pid } = discovery()
  expect(pid).toBe(await app.evaluate(() => process.pid))
  const body = JSON.stringify({ method: 'status', params: {} })
  expect(await rawPost(port, { authorization: `Bearer ${token}` }, body)).toBe(200)
  expect(await rawPost(port, { authorization: 'Bearer nope' }, body)).toBe(403)
  expect(await rawPost(port, {}, body)).toBe(403)
  expect(await rawPost(port, { authorization: `Bearer ${token}`, origin: 'http://evil.example' }, body)).toBe(403)
})

test('displays and a screenshot in DIP', async () => {
  const displays = await call<Array<{ id: number; primary: boolean; bounds: { width: number; height: number } }>>('list_displays')
  expect(displays.length).toBeGreaterThan(0)
  const primary = displays.find((d) => d.primary) ?? displays[0]
  const shot = await callRaw('take_screenshot', { displayId: primary.id, maxWidth: 800 })
  expect(shot.isError).toBeFalsy()
  const image = shot.content.find((c) => c.type === 'image')
  expect(image?.mimeType).toBe('image/png')
  expect((image?.data ?? '').length).toBeGreaterThan(1000)
  const info = shot.content.find((c) => c.type === 'text')?.text ?? ''
  expect(info).toContain(String(primary.id))
})

let projectId = ''

test('records, edits and exports through the agent', async () => {
  test.setTimeout(400_000)
  expect(await callError('stop_recording')).toContain('not_found')

  await call('start_recording', { mic: false, systemAudio: false })
  expect((await call<{ recording: string }>('get_status')).recording).toBe('recording')
  // a second start while recording is refused
  expect(await callError('start_recording', {})).toContain('busy')
  await sleep(5000)
  const stopped = await call<{ projectId: string; durationMs: number }>('stop_recording')
  projectId = stopped.projectId
  expect(projectIds(recordingsDir)).toContain(projectId)
  expect(stopped.durationMs).toBeGreaterThan(3000)
  // the finished recording opens in the editor like a manual one
  await win.waitForSelector('.editor', { timeout: 60_000 })
  expect((await call<{ openProjectId: string | null }>('get_status')).openProjectId).toBe(projectId)

  const listed = await call<Array<{ id: string }>>('list_projects')
  expect(listed.map((p) => p.id)).toContain(projectId)

  const before = await call<{ sourceDurationMs: number; outputDurationMs: number; cuts: unknown[] }>('get_project', { projectId })
  expect(before.cuts).toEqual([])
  const edited = await call<{
    outputDurationMs: number
    cuts: Array<{ id: string; start: number; end: number }>
    zooms: Array<{ id: string; mode: string; scale: number }>
    texts: Array<{ id: string; text: string }>
    name: string
  }>('edit_project', {
    projectId,
    operations: [
      { op: 'rename', name: 'Agent demo' },
      { op: 'addCut', start: 1000, end: 2000 },
      { op: 'addZoom', start: 2500, end: 4000, mode: 'fixed', scale: 2, target: { x: 0.3, y: 0.3 } },
      { op: 'addText', start: 200, end: 1500, text: 'Made by an agent' }
    ]
  })
  expect(edited.name).toBe('Agent demo')
  expect(edited.cuts).toHaveLength(1)
  expect(edited.zooms).toMatchObject([{ mode: 'fixed', scale: 2 }])
  expect(edited.texts).toMatchObject([{ text: 'Made by an agent' }])
  expect(edited.outputDurationMs).toBeLessThan(before.outputDurationMs)
  // saved before the reply, and visible in the open editor
  expect(readProject(recordingsDir, projectId).name).toBe('Agent demo')
  await expect(win.locator('.editor .name-input')).toHaveValue('Agent demo')
  await expect(win.locator('.editor')).toContainText('Made by an agent')

  // one undo step in the editor
  await win.keyboard.press('Control+z')
  await expect.poll(() => readProject(recordingsDir, projectId).cuts.length, { timeout: 5000 }).toBe(0)
  await win.keyboard.press('Control+y')
  await expect.poll(() => readProject(recordingsDir, projectId).cuts.length, { timeout: 5000 }).toBe(1)

  // errors name the problem
  expect(await callError('edit_project', { projectId, operations: [{ op: 'removeCut', id: 'nope' }] })).toContain('not_found')
  expect(await callError('edit_project', { projectId, operations: [{ op: 'addCut', start: 3000, end: 2000 }] })).toMatch(/bad_params|Invalid|start/i)
  expect(await callError('get_project', { projectId: 'missing-project' })).toContain('not_found')

  const exported = await call<{ outputPath: string; bytes: number }>('export_project', { projectId, format: 'mp4', folder: exportDir, fileName: 'agent-demo' })
  expect(isAbsolute(exported.outputPath)).toBe(true)
  expect(exported.outputPath.startsWith(exportDir)).toBe(true)
  expect(statSync(exported.outputPath).size).toBe(exported.bytes)
  expect(exported.bytes).toBeGreaterThan(10_000)
})

test('scenarios: create, read back, list, delete', async () => {
  const displays = await call<Array<{ id: number; primary: boolean }>>('list_displays')
  const displayId = (displays.find((d) => d.primary) ?? displays[0]).id
  const created = await call<{ scenarioId: string }>('create_scenario', {
    name: 'Agent scenario',
    displayId,
    actions: [
      { kind: 'click', x: 100, y: 120 },
      { kind: 'type', text: 'hello', pauseMs: 500 },
      { kind: 'key', key: 'Ctrl+S' },
      { kind: 'scroll', x: 300, y: 300, deltaY: 3 },
      { kind: 'drag', x: 10, y: 10, toX: 60, toY: 40 }
    ]
  })
  const scenario = await call<{ id: string; name: string; displayId: number; actions: Array<Record<string, unknown>> }>('get_scenario', {
    scenarioId: created.scenarioId
  })
  expect(scenario.name).toBe('Agent scenario')
  expect(scenario.displayId).toBe(displayId)
  expect(scenario.actions.map((a) => a.kind)).toEqual(['click', 'type', 'key', 'scroll', 'drag'])
  expect(scenario.actions[0]).toMatchObject({ x: 100, y: 120 })
  expect(scenario.actions[1]).toMatchObject({ text: 'hello', pauseMs: 500 })
  expect(scenario.actions[2]).toMatchObject({ key: 'Ctrl+S' })
  expect(existsSync(join(scenariosDir, created.scenarioId, 'scenario.json'))).toBe(true)

  expect(await callError('create_scenario', { name: 'bad', displayId, actions: [{ kind: 'key', key: 'NoSuchKey' }] })).toMatch(/bad_params|NoSuchKey/)
  expect(await callError('create_scenario', { name: 'off screen', displayId, actions: [{ kind: 'click', x: -5, y: 10 }] })).toMatch(/bad_params|outside|display/i)

  const list = await call<Array<{ id: string }>>('list_scenarios')
  expect(list.map((s) => s.id)).toContain(created.scenarioId)

  // Home picks up agent changes without a reload
  await win.locator('.editor-top > button').first().click()
  await win.waitForSelector('.home')
  await expect(win.locator('.scenario-block:has-text("Agent scenario")')).toHaveCount(1)
  await call('delete_scenario', { scenarioId: created.scenarioId })
  await expect(win.locator('.scenario-block:has-text("Agent scenario")')).toHaveCount(0)
  expect(existsSync(join(scenariosDir, created.scenarioId))).toBe(false)
})

test('deleting a project: refused while open, then gone from disk and Home', async () => {
  // open it in the editor again through an edit, which does not navigate - so open it from Home
  await win.locator(`.project-row:has-text("Agent demo")`).first().click()
  await win.waitForSelector('.editor')
  expect(await callError('delete_project', { projectId })).toContain('busy')
  await win.locator('.editor-top > button').first().click()
  await win.waitForSelector('.home')
  await call('delete_project', { projectId })
  expect(projectIds(recordingsDir)).not.toContain(projectId)
  await expect(win.locator('.project-row:has-text("Agent demo")')).toHaveCount(0)
})

test('the MCP config dialog shows a ready-to-paste config', async () => {
  await win.locator('button:has-text("AI agents")').click()
  const dialog = win.locator('.modal')
  await expect(dialog).toContainText('mcpServers')
  await expect(dialog).toContainText('zoomcut-mcp.cjs')
  await expect(dialog).toContainText('claude mcp add')
  await win.keyboard.press('Escape')
  await expect(win.locator('.modal')).toHaveCount(0)
})

// Moves nothing but presses Shift on the real keyboard while recording: run only on an idle machine.
test('record_scenario replays an agent-written scenario into a new recording', async () => {
  test.skip(process.env['ZOOMCUT_E2E_REPLAY'] !== '1', 'set ZOOMCUT_E2E_REPLAY=1 on an idle machine')
  test.setTimeout(300_000)
  const displays = await call<Array<{ id: number; primary: boolean }>>('list_displays')
  const displayId = (displays.find((d) => d.primary) ?? displays[0]).id
  const { scenarioId } = await call<{ scenarioId: string }>('create_scenario', {
    name: 'Shift only',
    displayId,
    actions: [
      { kind: 'key', key: 'Shift', pauseMs: 1000 },
      { kind: 'key', key: 'Shift', pauseMs: 1000 }
    ]
  })
  const before = projectIds(recordingsDir)
  const recorded = await call<{ projectId: string; durationMs: number }>('record_scenario', { scenarioId, mic: false, systemAudio: false })
  expect(before).not.toContain(recorded.projectId)
  expect(projectIds(recordingsDir)).toContain(recorded.projectId)
  const project = readProject(recordingsDir, recorded.projectId)
  expect(project.origin?.scenarioId).toBe(scenarioId)
  expect(recorded.durationMs).toBeGreaterThan(1500)
})
