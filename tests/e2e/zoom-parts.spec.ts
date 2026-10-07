import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, readProject, restoreUserSettings, sleep, useEnglish, waitForProject, type Harness, type ProjectJson } from './adv-helpers'

/**
 * Zoom parts: several areas inside one fixed-area zoom. The recording is synthesized with ffmpeg
 * (a test pattern, no screen capture) and nothing is injected outside the app window.
 */
let h: Harness
const ID = 'zparts'

type ZoomJson = ProjectJson['zooms'][number] & { parts?: Array<{ id: string; start: number; target: { x: number; y: number }; scale: number }> }

function makeProject(id: string, width: number, height: number, durationMs: number): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  const args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`, '-t', String(durationMs / 1000), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', join(dir, 'source.mp4')]
  spawnSync(String(ffmpegStatic), args, { encoding: 'utf8' })
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt: Date.now(), dir, videoPath: '', width, height, durationMs, fps: 30, displayName: 'Synthetic' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    audio: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    updatedAt: 0
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
}

function zoomOf(p: ProjectJson): ZoomJson {
  return p.zooms[0] as ZoomJson
}

test.beforeAll(async () => {
  h = await launch('zoomparts')
  makeProject(ID, 1280, 720, 8000)
  await h.win.reload()
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app.close()
})

test('a second area is added inside a fixed zoom, shows as a divider, and undo removes it', async () => {
  const { win } = h
  await win.click(`.project-open:has-text("Synthetic ${ID}")`)
  await win.waitForSelector('.preview-canvas')
  await win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  // a zoom around 1 s, switched to a fixed area picked in the top left
  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Home')
  await win.keyboard.press('Shift+ArrowRight')
  await win.keyboard.press('z')
  await win.click('.seg-btn:has-text("Fixed area")')
  await win.click('button:has-text("Pick area")')
  await expect(win.locator('.pick-rect')).toHaveCount(1)
  const canvas = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.click(canvas.x + canvas.width * 0.22, canvas.y + canvas.height * 0.25)
  await win.keyboard.press('Enter')
  await expect(win.locator('.pick-rect')).toHaveCount(0)
  const first = await waitForProject(h.recordingsDir, ID, (p) => p.zooms.length === 1 && p.zooms[0].mode === 'fixed' && p.zooms[0].target.x < 0.45)
  expect(zoomOf(first).parts).toBeUndefined()
  await expect(win.locator('.zoom-part-divider')).toHaveCount(0)
  // the whole zoom is one area: Part 1 only, nothing removable
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(1)

  // playhead one more second into the zoom (it spans about 0.4 .. 3.5 s), then add a part there
  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Shift+ArrowRight')
  await win.click('.panel button:has-text("Add part at playhead")')
  await expect(win.locator('.pick-rect')).toHaveCount(1)
  await expect(win.locator('.preview-controls .hint')).toContainText('Part 2')

  // a new spot in the bottom right, applied with the button
  const canvas2 = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.click(canvas2.x + canvas2.width * 0.8, canvas2.y + canvas2.height * 0.8)
  await win.click('.preview-controls button:has-text("Apply")')
  await expect(win.locator('.pick-rect')).toHaveCount(0)

  const withPart = await waitForProject(h.recordingsDir, ID, (p) => (zoomOf(p).parts?.length ?? 0) === 1 && (zoomOf(p).parts?.[0].target.x ?? 0) > 0.5)
  const zoom = zoomOf(withPart)
  const part = zoom.parts![0]
  expect(part.start).toBeGreaterThan(zoom.start + 300)
  expect(part.start).toBeLessThan(zoom.end - 300)
  expect(part.target.x).not.toBeCloseTo(zoom.target.x, 1)
  expect(zoom.target.x).toBeLessThan(0.45) // area 0 is untouched

  await expect(win.locator('.zoom-part-divider')).toHaveCount(1)
  await expect(win.locator('.region.zoom .region-label')).toContainText('2 parts')
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(2)
  await expect(win.locator('.zoom-parts .list-item .danger')).toHaveCount(1) // only Part 2 can be removed

  // dragging the divider moves the boundary
  const divider = win.locator('.zoom-part-divider')
  const box = (await divider.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 6 })
  await win.mouse.up()
  const moved = await waitForProject(h.recordingsDir, ID, (p) => (zoomOf(p).parts?.[0].start ?? 0) > part.start + 100)
  expect(zoomOf(moved).parts).toHaveLength(1)
  expect(zoomOf(moved).start).toBe(zoom.start) // the zoom itself did not move

  // undo: the drag, then the picked area, then the part itself
  await win.click('.timeline-toolbar .timeline-hint')
  for (let i = 0; i < 3; i++) await win.keyboard.press('Control+z')
  await expect(win.locator('.zoom-part-divider')).toHaveCount(0)
  const undone = await waitForProject(h.recordingsDir, ID, (p) => p.zooms.length === 1 && zoomOf(p).parts === undefined)
  expect(zoomOf(undone).target.x).toBeLessThan(0.45)
  await sleep(300)
  expect(readProject(h.recordingsDir, ID).zooms).toHaveLength(1)
  expect(h.errors).toEqual([])
})
