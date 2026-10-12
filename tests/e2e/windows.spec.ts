import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, restoreUserSettings, useEnglish, waitForProject, type Harness, type ProjectJson } from './adv-helpers'

/**
 * Clip tab windows: only the windows that were visible, a browser's "Page only" crop, and picking a
 * window or a page on the preview in crop mode. The recording is synthesized with ffmpeg and its window
 * snapshots are written by hand (the layout of a project recorded before 0.4.1: every window listed,
 * hidden ones too); nothing is recorded and nothing is injected outside the app window.
 */
let h: Harness
const ID = 'winlist'

const CHROME = { x: 0.05, y: 0.05, w: 0.5, h: 0.6 }
const PAGE = { x: 0.05, y: 0.15, w: 0.5, h: 0.5 }
const NOTES = { x: 0.6, y: 0.2, w: 0.35, h: 0.5 }

function makeProject(id: string, width: number, height: number, durationMs: number): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  const args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`, '-t', String(durationMs / 1000), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', join(dir, 'source.mp4')]
  spawnSync(String(ffmpegStatic), args, { encoding: 'utf8' })
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const windows = [
    { title: 'Docs - Google Chrome', ...CHROME, app: 'chrome.exe', content: PAGE },
    { title: 'Notes', ...NOTES },
    // completely behind the browser: must not be listed
    { title: 'Hidden dialog', x: 0.1, y: 0.2, w: 0.3, h: 0.3 }
  ]
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt: Date.now(), dir, videoPath: '', width, height, durationMs, fps: 30, displayName: 'Synthetic' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [
      { t: 0, windows },
      { t: durationMs, windows }
    ],
    cuts: [],
    texts: [],
    zooms: [],
    audio: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    updatedAt: 0
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
}

const near = (a: ProjectJson['crop'], b: { x: number; y: number; w: number; h: number }): boolean =>
  Math.abs(a.x - b.x) < 0.003 && Math.abs(a.y - b.y) < 0.003 && Math.abs(a.w - b.w) < 0.003 && Math.abs(a.h - b.h) < 0.003

test.beforeAll(async () => {
  h = await launch('windows')
  makeProject(ID, 1280, 720, 4000)
  await h.win.reload()
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app.close()
})

test('the Clip tab lists only visible windows, and a browser crops to its page', async () => {
  const { win } = h
  await win.click(`.project-open:has-text("Synthetic ${ID}")`)
  await win.waitForSelector('.preview-canvas')
  await win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  // the Clip tab is the one open after opening a project
  await win.waitForSelector('.clip-panel')

  // the panel is split into blocks; no removed pieces yet, so no block for them
  await expect(win.locator('.clip-panel .section-title')).toHaveText(['Trim & cut', 'Crop', 'Windows on the recording'])

  const rows = win.locator('.windows-list .list-item')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Docs - Google Chrome')
  await expect(rows.nth(1)).toContainText('Notes')
  await expect(win.locator('.windows-list .window-page')).toHaveCount(1) // only the browser has a page

  await rows.nth(0).locator('.window-page').click()
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, PAGE))
  await expect(rows.nth(0)).toHaveClass(/active/)
  await expect(rows.nth(0).locator('.window-page')).toHaveClass(/active/)
  await win.screenshot({ path: join(h.shotsDir, 'clip-windows.png') })

  await rows.nth(1).locator('.list-main').click()
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, NOTES))
  await expect(rows.nth(1)).toHaveClass(/active/)
  await expect(rows.nth(0)).not.toHaveClass(/active/)

  await rows.nth(0).locator('.list-main').click()
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, CHROME))
})

test('in crop mode a click on a window or a browser page crops to it, also inside the crop rectangle', async () => {
  const { win } = h
  await win.click('.clip-panel button:has-text("Reset")')
  await waitForProject(h.recordingsDir, ID, (p) => p.crop.w === 1 && p.crop.h === 1)
  await win.click('button:has-text("Edit crop")')
  await expect(win.locator('.win-outline')).toHaveCount(2)
  await expect(win.locator('.win-page')).toHaveCount(1)
  await expect(win.locator('.preview-controls .hint')).toContainText('browser page')

  const stage = (await win.locator('.preview-stage').boundingBox())!
  const at = (x: number, y: number): [number, number] => [stage.x + stage.width * x, stage.y + stage.height * y]

  // the crop is the whole frame, so these clicks land on the crop rectangle: a click (no drag) still picks
  await win.mouse.move(...at(0.3, 0.4))
  await expect(win.locator('.win-page.hover')).toHaveCount(1)
  await win.screenshot({ path: join(h.shotsDir, 'crop-mode-windows.png') })
  await win.mouse.click(...at(0.3, 0.4))
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, PAGE))

  // outside the crop rectangle now: the notes window, then the browser's tab strip (the whole window)
  await win.mouse.click(...at(0.8, 0.5))
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, NOTES))
  await win.mouse.move(...at(0.3, 0.1))
  await expect(win.locator('.win-outline.hover')).toHaveCount(1)
  await win.mouse.click(...at(0.3, 0.1))
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, CHROME))

  // inside the window's crop: a tap that jitters by a pixel or two still picks the page, without
  // moving the rectangle first, so one undo step brings back exactly the window's crop
  const [tx, ty] = at(0.3, 0.4)
  await win.mouse.move(tx, ty)
  await win.mouse.down()
  await win.mouse.move(tx + 2, ty + 1)
  await win.mouse.up()
  await waitForProject(h.recordingsDir, ID, (p) => near(p.crop, PAGE))
  await win.keyboard.press('Control+z')
  await waitForProject(h.recordingsDir, ID, (p) => p.crop.x === CHROME.x && p.crop.y === CHROME.y && p.crop.w === CHROME.w && p.crop.h === CHROME.h)

  // a drag inside the crop rectangle still moves it
  await win.mouse.move(...at(0.3, 0.4))
  await win.mouse.down()
  await win.mouse.move(...at(0.35, 0.45), { steps: 6 })
  await win.mouse.up()
  await waitForProject(h.recordingsDir, ID, (p) => p.crop.x > CHROME.x + 0.02 && Math.abs(p.crop.w - CHROME.w) < 0.003)

  // a crop adjusted by hand: a click inside it (over the page) neither highlights nor picks anything
  const cropInfo = win.locator('.clip-panel .section', { has: win.locator('.section-title', { hasText: /^Crop$/ }) }).locator('p')
  const before = await cropInfo.textContent()
  await win.mouse.move(...at(0.4, 0.5))
  await expect(win.locator('.win-page.hover, .win-outline.hover')).toHaveCount(0)
  await win.mouse.click(...at(0.4, 0.5))
  await win.waitForTimeout(300)
  expect(await cropInfo.textContent()).toBe(before)

  await win.click('.preview-controls .hint button:has-text("Done")')
  await expect(win.locator('.win-outline')).toHaveCount(0)
})
