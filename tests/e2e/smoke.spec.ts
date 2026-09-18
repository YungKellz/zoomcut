import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * End-to-end smoke test on a real display: records the screen for a few seconds,
 * opens the editor, adds a zoom and a text overlay and exports a GIF and an MP4.
 * Requires `npm run build` first and a machine with a display (not headless).
 */
const tmpRoot = resolve('tests/e2e/.tmp')
const recordingsDir = join(tmpRoot, 'recordings')
const exportDir = join(tmpRoot, 'exports')

let app: ElectronApplication
let win: Page

async function waitForBar(): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const bar = app.windows().find((w) => w.url().includes('#bar'))
    if (bar) return bar
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('recorder bar window did not appear')
}

test.beforeAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(recordingsDir, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ZOOMCUT_RECORDINGS_DIR: recordingsDir, ZOOMCUT_E2E: '1' }
  })
  win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer error]', msg.text())
  })
})

test.afterAll(async () => {
  await app?.close()
})

test('record → edit → export GIF and MP4', async () => {
  await win.waitForSelector('.btn-record:not([disabled])', { timeout: 30_000 })
  await win.click('.btn-record')

  const bar = await waitForBar()
  await bar.waitForSelector('.bar-dot-live', { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 3500))
  await bar.click('.bar-stop')

  await win.waitForSelector('.editor', { timeout: 120_000 })
  await win.waitForSelector('.preview-canvas')
  await win.waitForSelector('.preview-loading', { state: 'detached', timeout: 30_000 })

  const recordings = readdirSync(recordingsDir)
  expect(recordings.length).toBe(1)
  expect(existsSync(join(recordingsDir, recordings[0], 'source.mp4'))).toBe(true)
  expect(existsSync(join(recordingsDir, recordings[0], 'project.json'))).toBe(true)

  // add a zoom and a text overlay through the shortcuts
  await win.click('.preview-canvas')
  await win.keyboard.press('z')
  await win.keyboard.press('t')
  await expect(win.locator('.region.zoom')).toHaveCount(1)
  await expect(win.locator('.region.text')).toHaveCount(1)

  // cut the first 500 ms
  await win.keyboard.press('Home')
  await win.keyboard.press('Shift+ArrowRight')
  await win.click('.tab:has-text("Clip")')
  await win.click('button:has-text("Trim start")')
  await expect(win.locator('.region.cut')).toHaveCount(1)

  // export GIF
  await win.click('button:has-text("Export")')
  await win.click('.seg-btn:has-text("GIF animation")')
  await win.fill('input[placeholder="Choose a folder…"]', exportDir)
  await win.fill('.modal input[spellcheck="false"] >> nth=0', 'smoke')
  await win.click('button:has-text("Export GIF")')
  await win.waitForSelector('.export-result', { timeout: 180_000 })
  const gif = join(exportDir, 'smoke.gif')
  expect(existsSync(gif)).toBe(true)
  expect(statSync(gif).size).toBeGreaterThan(1000)

  // export MP4
  await win.click('.seg-btn:has-text("MP4 video")')
  await win.click('button:has-text("Export MP4")')
  await win.waitForSelector('.export-result:has-text(".mp4")', { timeout: 180_000 })
  const mp4 = join(exportDir, 'smoke.mp4')
  expect(existsSync(mp4)).toBe(true)
  expect(statSync(mp4).size).toBeGreaterThan(1000)
})
