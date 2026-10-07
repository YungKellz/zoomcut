import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, projectIds, readProject, record, restoreUserSettings, sleep, useEnglish, waitForBar, type Harness } from './adv-helpers'

/**
 * Delete / Record again in the editor and the scenario review, and the unified home list
 * (standalone recordings and scenario blocks). The first two tests record the real screen for a few
 * seconds; the rest works on synthesized projects and scenarios (test patterns, no input injected).
 */
let h: Harness
const dialogs: string[] = []

function makeProject(id: string, scenarioId: string | null, createdAt: number): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  spawnSync(
    String(ffmpegStatic),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'source.mp4')],
    { encoding: 'utf8' }
  )
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt, dir, videoPath: '', width: 320, height: 180, durationMs: 1000, fps: 10, displayName: 'Synthetic' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    audio: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    origin: { displayId: 1, audio: null, scenarioId },
    updatedAt: 0
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
}

function makeScenario(id: string, createdAt: number): void {
  const dir = join(h.scenariosDir, id)
  mkdirSync(join(dir, 'shots'), { recursive: true })
  const scenario = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    createdAt,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: [
      { id: 'a1', kind: 'click', at: 1000, x: 100, y: 100, path: [], modifiers: { ctrl: false, shift: false, alt: false, meta: false }, shot: null }
    ],
    durationMs: 2000,
    dir
  }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario), 'utf8')
}

async function reloadHome(): Promise<void> {
  await h.win.reload()
  await useEnglish(h.win)
}

test.beforeAll(async () => {
  h = await launch('lifecycle')
  await useEnglish(h.win)
  h.win.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.accept()
  })
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

test('Delete in the editor removes the recording and returns to Home', async () => {
  await record(h, 3000)
  const [id] = projectIds(h.recordingsDir)
  expect(id).toBeTruthy()
  await h.win.click('.editor-top-file button:has-text("Delete")')
  await h.win.waitForSelector('.home')
  expect(projectIds(h.recordingsDir)).toEqual([])
  await expect(h.win.locator('.project-list > *')).toHaveCount(0)
  await expect(h.win.locator('.home p:has-text("Nothing recorded yet.")')).toHaveCount(1)
})

test('Record again deletes the recording and starts a new one under the same conditions', async () => {
  await record(h, 3000)
  const [oldId] = projectIds(h.recordingsDir)
  const before = readProject(h.recordingsDir, oldId).origin
  expect(before, 'a new recording must remember how it was made').toBeTruthy()
  expect(before!.scenarioId).toBeNull()

  await h.win.click('.editor-top-file button:has-text("Record again")')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(2500)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.editor', { timeout: 180_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  const ids = projectIds(h.recordingsDir)
  expect(ids).toHaveLength(1)
  expect(ids[0]).not.toBe(oldId)
  expect(existsSync(join(h.recordingsDir, oldId))).toBe(false)
  expect(readProject(h.recordingsDir, ids[0]).origin).toEqual(before)
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  await expect(h.win.locator('.project-list .project-row')).toHaveCount(1)
})

test('a recording of a deleted scenario is a standalone row, and Record again refuses to delete it', async () => {
  makeProject('orphanRec', 'scenario-that-does-not-exist', Date.now() + 1000)
  await reloadHome()
  await expect(h.win.locator('.scenario-block')).toHaveCount(0)
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic orphanRec")')).toHaveCount(1)

  await h.win.click('.project-open:has-text("Synthetic orphanRec")')
  await h.win.waitForSelector('.editor .preview-canvas')
  const before = dialogs.length
  await h.win.click('.editor-top-file button:has-text("Record again")')
  await expect.poll(() => dialogs.length).toBeGreaterThan(before)
  expect(dialogs[dialogs.length - 1]).toContain('no longer exists')
  // nothing was deleted and nothing started: still in the editor, folder intact
  expect(existsSync(join(h.recordingsDir, 'orphanRec', 'project.json'))).toBe(true)
  await expect(h.win.locator('.editor')).toHaveCount(1)
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
})

test('a scenario block nests its recordings and deleting the scenario keeps them', async () => {
  makeScenario('synthScenario', Date.now() + 2000)
  makeProject('childRec', 'synthScenario', Date.now() + 3000)
  await reloadHome()
  const block = h.win.locator('.scenario-block:has-text("Synthetic synthScenario")')
  await expect(block).toHaveCount(1)
  await expect(block.locator('.project-row')).toHaveCount(1)
  await expect(block.locator('.project-row')).toContainText('Synthetic childRec')
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic childRec")')).toHaveCount(0)

  await block.locator('.scenario-delete').click()
  await expect(h.win.locator('.scenario-block')).toHaveCount(0)
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic childRec")')).toHaveCount(1)
  expect(existsSync(join(h.scenariosDir, 'synthScenario'))).toBe(false)
  expect(existsSync(join(h.recordingsDir, 'childRec', 'project.json'))).toBe(true)
})

test('Record again in the scenario review replaces the scenario and starts a new capture', async () => {
  makeScenario('synthScenario2', Date.now() + 4000)
  await reloadHome()
  await h.win.click('.scenario-open:has-text("Synthetic synthScenario2")')
  await h.win.waitForSelector('.scenario-review')
  await h.win.click('.editor-top-file button:has-text("Record again")')
  // Home takes the queued capture over: the bar counts down for a scenario capture
  const bar = await waitForBar(h.app)
  await expect(bar.locator('.bar-label')).toContainText(/actions/i, { timeout: 15_000 })
  expect(existsSync(join(h.scenariosDir, 'synthScenario2'))).toBe(false)
  await bar.click('.bar-cancel')
  await h.win.waitForSelector('.home .btn-scenario:not([disabled])', { timeout: 30_000 })
  await expect(h.win.locator('.scenario-block:has-text("synthScenario2")')).toHaveCount(0)
})

test('no unexpected renderer errors during the lifecycle flows', async () => {
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  console.log('[console errors]', JSON.stringify(unexpected, null, 1))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
