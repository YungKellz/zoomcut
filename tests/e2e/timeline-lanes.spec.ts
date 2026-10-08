import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, restoreUserSettings, sleep, useEnglish, type Harness } from './adv-helpers'

/**
 * Timeline lanes and input tags: only lanes with something on them are drawn, and the input
 * tags (clicks, typing, drags, scrolls, key combinations) sit on the Video lane in output time.
 * The recordings are synthesized with ffmpeg (a test pattern, no screen capture) with hand-made
 * cursor data; nothing is injected outside the app window.
 */
let h: Harness

const DURATION = 8000

function makeProject(id: string, cursorData: unknown, cuts: unknown[]): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  const args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', String(DURATION / 1000), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', join(dir, 'source.mp4')]
  spawnSync(String(ffmpegStatic), args, { encoding: 'utf8' })
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt: Date.now(), dir, videoPath: '', width: 1280, height: 720, durationMs: DURATION, fps: 30, displayName: 'Synthetic' },
    cursorData,
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

async function open(win: Page, id: string): Promise<void> {
  if (await win.locator('.editor').count()) {
    await win.click('.editor-top button:has-text("Recordings")')
    await win.waitForSelector('.home')
  }
  await win.click(`.project-open:has-text("Synthetic ${id}")`)
  await win.waitForSelector('.preview-canvas')
  await win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
}

async function labels(win: Page): Promise<string[]> {
  return win.locator('.track-labels .track-label').allTextContents()
}

/** Each lane label must sit exactly beside its lane (same top, same height). */
async function expectAligned(win: Page, pairs: [string, string][]): Promise<void> {
  for (const [label, track] of pairs) {
    const a = (await win.locator(label).boundingBox())!
    const b = (await win.locator(track).boundingBox())!
    expect(Math.abs(a.y - b.y), `${label} beside ${track}`).toBeLessThanOrEqual(1)
    expect(Math.abs(a.height - b.height), `${label} as tall as ${track}`).toBeLessThanOrEqual(1)
  }
}

test.beforeAll(async () => {
  h = await launch('timelinelanes')
  makeProject(
    'tlanes',
    {
      samples: [],
      clicks: [{ t: 500, x: 0.5, y: 0.5, button: 'left' }],
      source: 'uiohook',
      input: [
        { t: 500, end: 500, kind: 'click' },
        { t: 1000, end: 2500, kind: 'type' }, // half of it is cut away below
        { t: 2400, end: 2400, kind: 'rightClick' }, // inside the cut: gone
        { t: 3000, end: 3100, kind: 'key', label: 'Ctrl+C' },
        { t: 3500, end: 4200, kind: 'drag' },
        { t: 5000, end: 5600, kind: 'scroll' },
        { t: 6200, end: 6200, kind: 'doubleClick' }
      ]
    },
    [{ id: 'cut1', start: 2000, end: 2800 }]
  )
  makeProject(
    'tlegacy',
    {
      samples: [],
      clicks: [
        { t: 1000, x: 0.5, y: 0.5, button: 'left' },
        { t: 1200, x: 0.501, y: 0.5, button: 'left' },
        { t: 3000, x: 0.2, y: 0.2, button: 'right' },
        { t: 4000, x: 0.2, y: 0.2, button: 'middle' },
        { t: 6000, x: 0.7, y: 0.7, button: 'left' }
      ],
      source: 'uiohook'
    },
    []
  )
  await h.win.reload()
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app.close()
})

test('a fresh recording shows only the Video lane; the first zoom / text / blur brings its lane in', async () => {
  const { win } = h
  await open(win, 'tlanes')
  expect(await labels(win)).toEqual(['Time', 'Video'])
  await expect(win.locator('.timeline .track')).toHaveCount(1)
  await expectAligned(win, [['.ruler-label', '.ruler'], ['.video-label', '.track-video']])
  // the initial fit uses the timeline's real width: the kept video fills it up to the end pad (56 + 8 px)
  const fill = await win.locator('.timeline-scroll').evaluate((el) => ({
    video: Array.from(el.querySelectorAll('.track-video .clip')).reduce((w, c) => w + c.getBoundingClientRect().width, 0),
    viewport: el.clientWidth
  }))
  expect(Math.abs(fill.video - (fill.viewport - 64))).toBeLessThanOrEqual(2)

  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Home')
  await win.keyboard.press('z')
  await expect(win.locator('.track-zoom .region.zoom')).toHaveCount(1)
  expect(await labels(win)).toEqual(['Time', 'Video', 'Zoom'])

  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('t')
  await expect(win.locator('.track-text .region.text')).toHaveCount(1)
  await win.click('.timeline-toolbar button:has-text("Blur")')
  await expect(win.locator('.track-blur .region.blur')).toHaveCount(1)
  expect(await labels(win)).toEqual(['Time', 'Video', 'Zoom', 'Text', 'Blur'])
  await expectAligned(win, [
    ['.ruler-label', '.ruler'],
    ['.video-label', '.track-video'],
    ['.zoom-label', '.track-zoom'],
    ['.text-label', '.track-text'],
    ['.blur-label', '.track-blur']
  ])
  await win.screenshot({ path: join(h.shotsDir, 'timeline-lanes.png') })

  // undo all three: the lanes go away again
  await win.click('.timeline-toolbar .timeline-hint')
  for (let i = 0; i < 3; i++) await win.keyboard.press('Control+z')
  await expect(win.locator('.timeline .track')).toHaveCount(1)
  expect(await labels(win)).toEqual(['Time', 'Video'])
  expect(h.errors).toEqual([])
})

test('input tags sit on the Video lane in output time, clipped by the cuts', async () => {
  const { win } = h
  await open(win, 'tlanes')
  const marks = win.locator('.track-video .input-mark')
  expect(await marks.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).toEqual(['click', 'type', 'key', 'drag', 'scroll', 'doubleClick'])
  // spans get a bar, instants do not
  await expect(win.locator('.track-video .input-mark .input-mark-span')).toHaveCount(4)
  await expect(win.locator('.input-mark[data-kind="key"]')).toHaveAttribute('title', 'Shortcut Ctrl+C 00:02.20 – 00:02.30')
  await expect(win.locator('.input-mark[data-kind="type"]')).toHaveAttribute('title', 'Typing 00:01.00 – 00:02.00')
  await expect(win.locator('.input-mark[data-kind="click"]')).toHaveAttribute('title', 'Click at 00:00.50')

  // the typing burst (1.0 .. 2.5 s) is clipped by the cut to 1.0 .. 2.0 s: half as wide as the
  // first kept piece of the video (0 .. 2 s), and it starts at the middle of that piece
  const clip = (await win.locator('.track-video .clip').first().boundingBox())!
  const type = (await win.locator('.input-mark[data-kind="type"]').boundingBox())!
  expect(Math.abs(type.width - clip.width / 2)).toBeLessThanOrEqual(2)
  expect(Math.abs(type.x - (clip.x + clip.width / 2))).toBeLessThanOrEqual(2)
  const lane = (await win.locator('.track-video').boundingBox())!
  for (const box of await marks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.top).toBeGreaterThanOrEqual(lane.y - 1)
    expect(box.bottom).toBeLessThanOrEqual(lane.y + lane.height + 1)
  }
  await win.screenshot({ path: join(h.shotsDir, 'input-tags.png') })
  expect(h.errors).toEqual([])
})

test('a recording without input data still tells clicks, double clicks and right / middle clicks apart', async () => {
  const { win } = h
  await open(win, 'tlegacy')
  await sleep(200)
  const kinds = await win.locator('.track-video .input-mark').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  expect(kinds).toEqual(['doubleClick', 'rightClick', 'middleClick', 'click'])
  await expect(win.locator('.input-mark[data-kind="doubleClick"] .input-mark-badge')).toHaveText('2')
  expect(h.errors).toEqual([])
})
