import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, restoreUserSettings, sleep, useEnglish, type Harness } from './adv-helpers'

/**
 * Playback in the editor: it stops at the end and stays stopped, Play at the end starts over, and the
 * frame step buttons. The recordings are synthesized with ffmpeg (test patterns, no screen capture),
 * nothing is injected outside the app window.
 */
let h: Harness

const PLAY = '.preview-controls [data-action="play"]'
const STEP_BACK = '.preview-controls [data-action="step-back"]'
const STEP_FORWARD = '.preview-controls [data-action="step-forward"]'
const PLAY_FROM_START = '.preview-controls [data-action="play-from-start"]'

interface Spec {
  /** length of the synthesized video */
  mediaMs: number
  /** the duration the project claims (ffmpeg's probe rounds, so it can differ a little from the file) */
  durationMs?: number
  fps?: number
  cuts?: Array<{ id: string; start: number; end: number }>
}

function makeProject(id: string, spec: Spec): void {
  const { mediaMs, durationMs = mediaMs, fps = 30, cuts = [] } = spec
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  const args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${fps}`, '-t', String(mediaMs / 1000), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '15', join(dir, 'source.mp4')]
  spawnSync(String(ffmpegStatic), args, { encoding: 'utf8' })
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt: Date.now(), dir, videoPath: '', width: 640, height: 360, durationMs, fps, displayName: 'Synthetic' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts,
    texts: [],
    zooms: [],
    audio: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    updatedAt: 0
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
}

async function openProject(id: string): Promise<void> {
  const { win } = h
  if ((await win.locator('.editor').count()) > 0) {
    await win.click('.editor-top button:has-text("Recordings")')
    await win.waitForSelector('.home')
  }
  await win.click(`.project-open:has-text("Synthetic ${id}")`)
  await win.waitForSelector('.preview-canvas')
  await win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  // keyboard focus on the page, not on a field
  await win.click('.timeline-toolbar .timeline-hint')
}

async function isPlaying(): Promise<boolean> {
  return (await h.win.getAttribute(PLAY, 'data-playing')) === 'true'
}

async function timecode(): Promise<string> {
  return (await h.win.textContent('.preview-controls .timecode')) ?? ''
}

/** The output length shown next to the timecode, e.g. "00:03.00". */
async function outTotal(): Promise<string> {
  return ((await h.win.textContent('.preview-controls .muted')) ?? '').replace('/', '').trim()
}

function ms(tc: string): number {
  const m = /^(\d+):(\d+)\.(\d+)$/.exec(tc)
  if (!m) throw new Error(`not a timecode: ${tc}`)
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 10
}

interface VideoState {
  currentTime: number
  paused: boolean
}

async function videoStates(): Promise<VideoState[]> {
  return h.win.evaluate(() =>
    Array.from(document.querySelectorAll('video.hidden-video')).map((v) => ({ currentTime: (v as HTMLVideoElement).currentTime, paused: (v as HTMLVideoElement).paused }))
  )
}

/** A cheap checksum of the picture on the preview canvas: every frame of the test pattern differs. */
async function frameHash(): Promise<string> {
  return h.win.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.preview-canvas')!
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let a = 2166136261
    for (let i = 0; i < d.length; i += 7) a = Math.imul(a ^ d[i], 16777619)
    return String(a >>> 0)
  })
}

async function waitForStop(budgetMs = 15_000): Promise<void> {
  await expect.poll(isPlaying, { timeout: budgetMs, intervals: [100] }).toBe(false)
}

/** `playing` stays false, the timecode stays on `expected` and no video moves for `forMs`. */
async function expectStopped(expected: string, forMs = 2000): Promise<void> {
  await sleep(300) // the seek to the resting frame is still settling
  const before = await videoStates()
  const deadline = Date.now() + forMs
  while (Date.now() < deadline) {
    expect(await isPlaying(), 'playback must stay stopped').toBe(false)
    expect(await timecode()).toBe(expected)
    await sleep(100)
  }
  const after = await videoStates()
  expect(
    after.every((v) => v.paused),
    'no video may play on'
  ).toBe(true)
  expect(after.map((v) => v.currentTime)).toEqual(before.map((v) => v.currentTime))
}

test.beforeAll(async () => {
  h = await launch('playback')
  makeProject('pb_plain', { mediaMs: 3000 })
  // output = 0..500 + 1000..2200 = 1.7 s: a removed piece in the middle and one at the end
  makeProject('pb_cuts', {
    mediaMs: 3000,
    cuts: [
      { id: 'c1', start: 500, end: 1000 },
      { id: 'c2', start: 2200, end: 3000 }
    ]
  })
  // the project claims 40 ms more than the file has
  makeProject('pb_short', { mediaMs: 3000, durationMs: 3040 })
  makeProject('pb_steps30', { mediaMs: 3000 })
  makeProject('pb_steps60', { mediaMs: 2000, fps: 60 })
  makeProject('pb_stepcut', { mediaMs: 3000, cuts: [{ id: 'c1', start: 1000, end: 1500 }] })
  await h.win.reload()
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app.close()
})

test('playback stops at the end, stays stopped, and Play at the end starts over', async () => {
  const { win } = h
  await openProject('pb_plain')
  expect(await outTotal()).toBe('00:03.00')

  await win.click(PLAY_FROM_START)
  await expect.poll(isPlaying).toBe(true)
  await waitForStop()
  expect(await timecode()).toBe('00:03.00')
  await expectStopped('00:03.00')

  // Play at the end: from the first frame, not a no-op and not a loop
  await win.click(PLAY)
  await expect.poll(isPlaying).toBe(true)
  await expect.poll(async () => ms(await timecode()), { timeout: 3000 }).toBeLessThan(1500)
  await expect.poll(async () => ms(await timecode()), { timeout: 3000 }).toBeGreaterThan(100)
  await waitForStop()
  expect(await timecode()).toBe('00:03.00')
  await expectStopped('00:03.00')

  // the Space bar does the same
  await win.keyboard.press('Space')
  await expect.poll(isPlaying).toBe(true)
  await expect.poll(async () => ms(await timecode()), { timeout: 3000 }).toBeLessThan(1500)
  await win.keyboard.press('Space')
  await expect.poll(isPlaying).toBe(false)
  expect(h.errors).toEqual([])
})

test('with cuts it stops at the end of the last kept piece on the last kept frame', async () => {
  const { win } = h
  await openProject('pb_cuts')
  expect(await outTotal()).toBe('00:01.70')

  await win.click(PLAY_FROM_START)
  await expect.poll(isPlaying).toBe(true)
  await waitForStop()
  expect(await timecode()).toBe('00:01.70')
  await expectStopped('00:01.70')

  // the player rests on the last frame of the output (source 2.167 s), not on the removed piece after it
  const states = await videoStates()
  expect(
    states.some((v) => v.currentTime > 2.14 && v.currentTime < 2.2),
    'a player shows the last kept frame: ' + JSON.stringify(states)
  ).toBe(true)

  await win.click(PLAY)
  await expect.poll(isPlaying).toBe(true)
  await expect.poll(async () => ms(await timecode()), { timeout: 3000 }).toBeLessThan(1000)
  await waitForStop()
  await expectStopped('00:01.70')
})

test('a file shorter than the project duration: Play near the end does not start over from 0', async () => {
  const { win } = h
  await openProject('pb_short')
  expect(await outTotal()).toBe('00:03.04')

  await win.click(PLAY_FROM_START)
  await waitForStop()
  expect(await timecode()).toBe('00:03.04')

  // one frame back puts the playhead (3.007 s) past the end of the file (3.000 s); Play must not rewind the video to its start
  await win.click(STEP_BACK)
  await expect.poll(timecode).toBe('00:03.00')
  await win.click(PLAY)
  await sleep(1500)
  expect(await isPlaying()).toBe(false)
  expect(await timecode()).toBe('00:03.00')
  expect((await videoStates()).every((v) => v.paused)).toBe(true)
  expect(h.errors).toEqual([])
})

for (const [id, fps] of [
  ['pb_steps30', 30],
  ['pb_steps60', 60]
] as const) {
  test(`frame buttons and arrow keys step exactly one frame at ${fps} fps`, async () => {
    const { win } = h
    await openProject(id)
    await win.keyboard.press('Home')
    await sleep(300)
    expect(await timecode()).toBe('00:00.00')

    // forward: every step shows a new picture and moves the timecode by a frame
    const seen = [await frameHash()]
    for (let i = 1; i <= 12; i++) {
      await win.click(STEP_FORWARD)
      await sleep(250)
      seen.push(await frameHash())
      expect(Math.abs(ms(await timecode()) - (i * 1000) / fps), `timecode after ${i} steps: ${await timecode()}`).toBeLessThanOrEqual(10)
    }
    expect(new Set(seen).size, 'each step must show a different frame').toBe(seen.length)

    // back: the very same pictures in reverse order
    for (let i = 11; i >= 0; i--) {
      await win.click(STEP_BACK)
      await sleep(250)
      expect(await frameHash(), `picture after stepping back to frame ${i}`).toBe(seen[i])
    }
    expect(await timecode()).toBe('00:00.00')
    // the first frame has nothing before it
    await win.click(STEP_BACK)
    await sleep(250)
    expect(await timecode()).toBe('00:00.00')
    expect(await frameHash()).toBe(seen[0])

    // the arrow keys are the same action
    await win.keyboard.press('ArrowRight')
    await sleep(250)
    expect(await frameHash()).toBe(seen[1])
    await win.keyboard.press('ArrowLeft')
    await sleep(250)
    expect(await frameHash()).toBe(seen[0])
    expect(h.errors).toEqual([])
  })
}

test('a step while playing stops playback first; the end is a limit in both directions', async () => {
  const { win } = h
  await openProject('pb_steps30')
  await win.keyboard.press('Home')
  await win.click(PLAY)
  await expect.poll(isPlaying).toBe(true)
  await expect.poll(async () => ms(await timecode())).toBeGreaterThan(300)
  await win.click(STEP_FORWARD)
  await expect.poll(isPlaying).toBe(false)
  const held = await timecode()
  await sleep(600)
  expect(await timecode()).toBe(held)
  expect(ms(held)).toBeGreaterThan(300)

  await win.click(PLAY)
  await expect.poll(isPlaying).toBe(true)
  await win.click(STEP_BACK)
  await expect.poll(isPlaying).toBe(false)

  // the end: forward does nothing, back goes to the last frame
  await win.keyboard.press('End')
  await sleep(300)
  expect(await timecode()).toBe('00:03.00')
  const endPicture = await frameHash()
  await win.click(STEP_FORWARD)
  await sleep(300)
  expect(await timecode()).toBe('00:03.00')
  expect(await frameHash()).toBe(endPicture)
  await win.click(STEP_BACK)
  await sleep(300)
  expect(ms(await timecode())).toBeGreaterThanOrEqual(2950)
  expect(ms(await timecode())).toBeLessThanOrEqual(2980)
  await win.click(STEP_FORWARD)
  await sleep(300)
  expect(await timecode()).toBe('00:03.00')
  expect(await frameHash(), 'the end shows the last frame').toBe(endPicture)
})

test('steps skip removed pieces', async () => {
  const { win } = h
  await openProject('pb_stepcut')
  await win.keyboard.press('Home')
  await win.keyboard.press('Shift+ArrowRight') // source 1000 ms: where the removed piece begins
  await sleep(300)
  expect(await timecode()).toBe('00:01.00')
  await win.click(STEP_FORWARD)
  await sleep(300)
  // one frame into the piece after the cut (source 1533 ms), not into the cut
  const after = (await videoStates()).map((v) => v.currentTime)
  expect(
    after.some((t) => t > 1.5 && t < 1.58),
    JSON.stringify(after)
  ).toBe(true)
  expect(ms(await timecode())).toBeLessThan(1060)
  await win.click(STEP_BACK)
  await win.click(STEP_BACK)
  await sleep(300)
  const before = (await videoStates()).map((v) => v.currentTime)
  expect(
    before.some((t) => t > 0.94 && t < 1.0),
    JSON.stringify(before)
  ).toBe(true)
})

test('the step buttons are off while an area is being edited', async () => {
  const { win } = h
  await openProject('pb_steps30')
  await expect(win.locator(STEP_BACK)).toBeEnabled()
  await win.keyboard.press('b') // a blur region: the player switches to its editing mode
  await expect(win.locator('.preview-controls .hint')).toBeVisible()
  await expect(win.locator(STEP_BACK)).toBeDisabled()
  await expect(win.locator(STEP_FORWARD)).toBeDisabled()
  await expect(win.locator(PLAY)).toBeDisabled()
  await win.keyboard.press('Escape')
  await expect(win.locator(STEP_FORWARD)).toBeEnabled()
})

test('the top bar and the inspector tabs fit the smallest window, in English and in Russian', async () => {
  const { app, win } = h
  const tabs = ['clip', 'zoom', 'text', 'blur', 'audio', 'cursor', 'style']
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  const minimum = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
  try {
    for (const lang of ['en', 'ru'] as const) {
      if ((await win.locator('.editor').count()) > 0) {
        await win.click('.editor-top > button')
        await win.waitForSelector('.home')
      }
      await win.selectOption('.lang-select select', lang)
      await win.click('.project-open:has-text("Synthetic pb_plain")')
      await win.waitForSelector('.preview-canvas')
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), minimum)
      await sleep(700)

      for (const id of tabs) {
        await win.click(`.tab[data-tab="${id}"]`)
        const state = await win.evaluate((active) => {
          const bar = document.querySelector('.tabs') as HTMLElement
          const top = document.querySelector('.editor-top') as HTMLElement
          const buttons = Array.from(bar.querySelectorAll<HTMLElement>('.tab'))
          const exportBtn = document.querySelector('.editor-top-actions .btn-primary') as HTMLElement
          return {
            barOverflow: bar.scrollWidth - bar.clientWidth,
            topOverflow: top.scrollWidth - top.clientWidth,
            exportRight: exportBtn.getBoundingClientRect().right,
            innerWidth: window.innerWidth,
            tabsInside: buttons.every((b) => b.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5 && b.getBoundingClientRect().width >= 16),
            texts: buttons.map((b) => [b.dataset.tab, (b.textContent ?? '').trim(), b.getAttribute('aria-label'), b.title, b.classList.contains('active')])
          }
        }, id)
        expect(state.barOverflow, `${lang}/${id}: the tab bar must not overflow`).toBeLessThanOrEqual(0)
        expect(state.tabsInside, `${lang}/${id}: every tab stays inside the bar`).toBe(true)
        expect(state.topOverflow, `${lang}/${id}: the top bar must not overflow`).toBeLessThanOrEqual(0)
        expect(state.exportRight, `${lang}/${id}: Export is inside the window`).toBeLessThanOrEqual(state.innerWidth)
        for (const [tab, text, label, title, active] of state.texts) {
          expect(label, `${lang}: aria-label of ${tab}`).toBeTruthy()
          expect(title).toBe(label)
          // only the open tab carries its name next to the icon
          expect(text === label, `${lang}: tab ${tab} text "${text}" (active ${active})`).toBe(active === true)
          if (!active) expect(text).toBe('')
        }
      }
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), original)
    await win.click('.editor-top > button')
    await win.waitForSelector('.home')
    await win.selectOption('.lang-select select', 'en')
  }
})
