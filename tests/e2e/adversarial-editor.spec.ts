import { expect, test } from '@playwright/test'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  flushedProject,
  launch,
  projectIds,
  readProject,
  record,
  restoreUserSettings,
  sleep,
  useEnglish,
  type Harness
} from './adv-helpers'

/**
 * Adversarial editor scenarios. One short recording is made in beforeAll and every
 * scenario starts from a pristine copy of its project.json, so the tests are
 * independent without paying for a new screen capture each time.
 */
let h: Harness
let id: string
let duration: number
let pristinePath: string
let pristineCopy: string

test.beforeAll(async () => {
  h = await launch('editor')
  await useEnglish(h.win)
  await record(h, 8000)
  const ids = projectIds(h.recordingsDir)
  expect(ids.length).toBe(1)
  id = ids[0]
  await sleep(1200)
  pristinePath = join(h.recordingsDir, id, 'project.json')
  pristineCopy = join(h.recordingsDir, id, 'pristine.json.bak')
  copyFileSync(pristinePath, pristineCopy)
  duration = readProject(h.recordingsDir, id).recording.durationMs
  console.log('[fixture] recording', id, 'duration', duration, 'ms')
  expect(duration).toBeGreaterThan(6500)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

/** Back to Home, restore the untouched project.json and open it again. */
async function reset(): Promise<void> {
  if (await h.win.locator('.modal').count()) {
    await h.win.click('.modal-head .btn-ghost').catch(() => undefined)
    await h.win.waitForSelector('.modal', { state: 'detached' }).catch(() => undefined)
  }
  if (await h.win.locator('.editor').count()) {
    await h.win.click('.editor-top button:has-text("Recordings")')
    await h.win.waitForSelector('.home')
  }
  await sleep(1300) // let any pending autosave land before overwriting the file
  writeFileSync(pristinePath, readFileSync(pristineCopy))
  await h.win.click('.project-open')
  await h.win.waitForSelector('.editor')
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  await h.win.click('.tab:has-text("Clip")')
}

async function timecode(): Promise<string> {
  return (await h.win.textContent('.preview-controls .timecode')) ?? ''
}

async function outTotal(): Promise<string> {
  const txt = (await h.win.textContent('.preview-controls .muted')) ?? ''
  return txt.replace('/', '').trim()
}

/** Home + n presses of Shift+Right puts the playhead at exactly n * 1000 ms. */
async function playheadAt(seconds: number): Promise<void> {
  await h.win.click('.timeline-toolbar .timeline-hint') // move focus out of any input
  await h.win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await h.win.keyboard.press('Shift+ArrowRight')
}

async function cutSeconds(from: number, to: number): Promise<void> {
  await playheadAt(from)
  await h.win.keyboard.press('i')
  for (let i = from; i < to; i++) await h.win.keyboard.press('Shift+ArrowRight')
  await h.win.keyboard.press('o')
  await h.win.keyboard.press('c')
}

// ---------------------------------------------------------------------------

test('cut the whole recording: export is blocked, nothing crashes, undo restores', async () => {
  await reset()
  await playheadAt(0)
  await h.win.keyboard.press('i') // range = 0 .. duration
  await h.win.keyboard.press('c')

  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(1)
  await expect(h.win.locator('.track-video .clip')).toHaveCount(0)
  expect(await outTotal()).toBe('00:00.00')
  const saved = await flushedProject(h.recordingsDir, id)
  expect(saved.cuts).toHaveLength(1)
  expect(saved.cuts[0].start).toBe(0)
  expect(saved.cuts[0].end).toBe(duration)

  await h.win.click('.editor-top-actions .btn-primary')
  await h.win.waitForSelector('.modal')
  await expect(h.win.locator('.modal-foot button:has-text("Export MP4")')).toBeDisabled()
  await h.win.screenshot({ path: join(h.shotsDir, 'cut-all-export.png') })
  await h.win.click('.modal-foot button:has-text("Close")')

  await h.win.keyboard.press('Control+z')
  await expect(h.win.locator('.track-video .clip')).toHaveCount(1)
  expect(await outTotal()).not.toBe('00:00.00')
})

test('cuts at the edges, adjacent and overlapping cuts merge; no seam UI in the timeline', async () => {
  await reset()
  // trim the first second and the last second through the Clip panel buttons
  await playheadAt(1)
  await h.win.click('button:has-text("Trim start")')
  await playheadAt(Math.floor(duration / 1000) - 1)
  await h.win.click('button:has-text("Trim playhead")')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(2)

  // a cut adjacent to the first one must merge into it
  await cutSeconds(1, 2)
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(2)

  // an overlapping cut must merge as well
  await cutSeconds(1, 3)
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(2)

  const saved = await flushedProject(h.recordingsDir, id)
  expect(saved.cuts).toHaveLength(2)
  expect(saved.cuts[0].start).toBe(0)
  expect(saved.cuts[0].end).toBe(3000)
  for (let i = 1; i < saved.cuts.length; i++) {
    expect(saved.cuts[i].start).toBeGreaterThan(saved.cuts[i - 1].end)
  }

  // README: "removed pieces disappear and leave a thin red seam (click it and press Delete
  // to restore)". Look for anything seam-like on the video track.
  const seamCount = await h.win.locator('.track-video [class*="seam"], .timeline [class*="seam"]').count()
  const videoTrackChildren = await h.win.evaluate(() =>
    Array.from(document.querySelectorAll('.track-video > *')).map((el) => el.className)
  )
  console.log('[seam probe] seam-like elements:', seamCount, 'video track children:', JSON.stringify(videoTrackChildren))
  await h.win.screenshot({ path: join(h.shotsDir, 'cuts-merged.png') })
  expect(seamCount, 'no seam element exists in the timeline although README documents one').toBe(0)
})

interface VideoState {
  duration: number
  currentTime: number
  paused: boolean
  ended: boolean
}

async function videoStates(): Promise<VideoState[]> {
  return h.win.evaluate(() =>
    Array.from(document.querySelectorAll('video.hidden-video')).map((v) => {
      const el = v as HTMLVideoElement
      return { duration: el.duration, currentTime: el.currentTime, paused: el.paused, ended: el.ended }
    })
  )
}

/** Plays from the start and samples the timecode until it settles or the budget runs out. */
async function playAndSample(budgetMs: number): Promise<{ samples: string[]; last: string }> {
  await h.win.click('.preview-controls .btn >> nth=1') // play from start
  const samples: string[] = []
  const total = await outTotal()
  let stable = 0
  let last = ''
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const tc = await timecode()
    samples.push(tc)
    stable = tc === last ? stable + 1 : 0
    last = tc
    if (stable >= 5) break
    await sleep(200)
  }
  return { samples, last }
}

function restarted(samples: string[]): boolean {
  // a timecode that jumps back to (near) zero after having advanced means playback looped
  let advanced = false
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] > '00:01.00') advanced = true
    if (advanced && samples[i] < '00:00.60' && samples[i] < samples[i - 1]) return true
  }
  return false
}

test('playback without cuts stops at the end instead of looping', async () => {
  await reset()
  const total = await outTotal()
  const before = await videoStates()
  console.log('[playback plain] project duration', duration, 'total', total, 'videos', JSON.stringify(before))

  const { samples, last } = await playAndSample(duration + 12_000)
  const after = await videoStates()
  console.log('[playback plain] timecodes', samples.join(' '))
  console.log('[playback plain] videos after', JSON.stringify(after))
  await h.win.screenshot({ path: join(h.shotsDir, 'playback-plain-end.png') })
  expect(restarted(samples), 'playback restarted from the beginning instead of stopping').toBe(false)
  expect(last, 'playback finished at the end of the output').toBe(total)
})

test('many cuts: playback runs to the end and stops, the playhead never gets stuck', async () => {
  await reset()
  await cutSeconds(1, 2)
  await cutSeconds(3, 4)
  await cutSeconds(5, 6)
  const total = await outTotal()
  console.log('[playback cuts] output duration', total)

  const { samples, last } = await playAndSample(40_000)
  console.log('[playback cuts] timecodes', samples.join(' '))
  console.log('[playback cuts] videos after', JSON.stringify(await videoStates()))
  const distinct = samples.filter((v, i) => i === 0 || v !== samples[i - 1]).length
  expect(distinct, 'playhead advanced').toBeGreaterThan(4)
  expect(restarted(samples), 'playback restarted from the beginning instead of stopping').toBe(false)
  expect(last, 'playback finished at the end of the output').toBe(total)

  // and it must stay there: no restart, no drift
  await sleep(1500)
  expect(await timecode()).toBe(total)
})

test('a zoom added in a small gap overlaps its neighbour', async () => {
  await reset()
  // zoom A around 1 s, then pin its end to exactly 3.00 s
  await playheadAt(1)
  await h.win.keyboard.press('z')
  await h.win.click('.tab:has-text("Zoom")')
  await h.win.fill('.panel input[type="number"] >> nth=1', '3')
  await h.win.locator('.panel input[type="number"] >> nth=1').blur()

  // zoom B around 5 s, start pinned to 3.15 s → a 150 ms gap between A and B
  await playheadAt(5)
  await h.win.keyboard.press('z')
  await h.win.fill('.panel input[type="number"] >> nth=0', '3.15')
  await h.win.locator('.panel input[type="number"] >> nth=0').blur()

  // a third zoom dropped into the 150 ms gap
  await playheadAt(3)
  await h.win.keyboard.press('z')

  const saved = await flushedProject(h.recordingsDir, id)
  const zooms = [...saved.zooms].sort((a, b) => a.start - b.start)
  console.log('[zoom overlap] zooms:', JSON.stringify(zooms.map((z) => [z.start, z.end])))
  await h.win.screenshot({ path: join(h.shotsDir, 'zoom-overlap.png') })

  // the timeline draws them on one lane – measure the real boxes too
  const boxes = await h.win.locator('.region.zoom').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right) }
    })
  )
  boxes.sort((a, b) => a.left - b.left)
  console.log('[zoom overlap] boxes', JSON.stringify(boxes))

  const overlaps: string[] = []
  for (let i = 1; i < zooms.length; i++) {
    if (zooms[i].start < zooms[i - 1].end) {
      overlaps.push(`[${zooms[i - 1].start},${zooms[i - 1].end}] vs [${zooms[i].start},${zooms[i].end}]`)
    }
  }
  expect(overlaps, 'zoom segments must never overlap: ' + overlaps.join(' ; ')).toHaveLength(0)
})

test('zoom at the very end and dragging a region past the end stay inside the timeline', async () => {
  await reset()
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('End')
  await h.win.keyboard.press('z')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)

  const region = h.win.locator('.region.zoom').first()
  const box = (await region.boundingBox())!
  // drag the body of the region far to the right, past the end of the timeline
  await h.win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await h.win.mouse.down()
  await h.win.mouse.move(box.x + box.width / 2 + 900, box.y + box.height / 2, { steps: 12 })
  await h.win.mouse.up()

  const saved = await flushedProject(h.recordingsDir, id)
  console.log('[end zoom]', JSON.stringify(saved.zooms.map((z) => [z.start, z.end])), 'duration', duration)
  await h.win.screenshot({ path: join(h.shotsDir, 'zoom-at-end.png') })
  expect(saved.zooms).toHaveLength(1)
  expect(saved.zooms[0].end).toBeLessThanOrEqual(duration)
  expect(saved.zooms[0].start).toBeGreaterThanOrEqual(0)
  expect(saved.zooms[0].end - saved.zooms[0].start).toBeGreaterThan(100)

  const endLeft = await h.win.locator('.timeline-end').evaluate((el) => el.getBoundingClientRect().left)
  const regionRight = await region.evaluate((el) => el.getBoundingClientRect().right)
  expect(regionRight, 'region stays left of the "end" marker').toBeLessThanOrEqual(endLeft + 2)
})

test('texts: empty, very long, multi-line and six overlapping lanes', async () => {
  await reset()
  await playheadAt(2)
  for (let i = 0; i < 6; i++) await h.win.keyboard.press('t')
  await expect(h.win.locator('.region.text')).toHaveCount(6)
  await expect(h.win.locator('.track-text .lane')).toHaveCount(6)
  await h.win.click('.tab:has-text("Text")')
  await h.win.screenshot({ path: join(h.shotsDir, 'text-lanes.png') })

  const lanes = await h.win.locator('.track-text .lane').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.top))
  console.log('[texts] lane offsets', JSON.stringify(lanes))
  expect(new Set(lanes).size, 'each overlapping text gets its own lane').toBe(6)

  // the timeline must not eat the whole editor
  const toolbarVisible = await h.win.locator('.timeline-toolbar').isVisible()
  const previewBox = await h.win.locator('.preview-canvas').boundingBox()
  expect(toolbarVisible).toBe(true)
  expect(previewBox!.height).toBeGreaterThan(50)

  // empty text
  await h.win.fill('.panel textarea', '')
  await sleep(300)
  await expect(h.win.locator('.region.text')).toHaveCount(6)
  const emptyLabel = await h.win.locator('.region.text .region-label').first().textContent()
  console.log('[texts] label of an empty text:', JSON.stringify(emptyLabel))

  // very long single line
  const long = 'Lorem ipsum dolor sit amet '.repeat(20)
  await h.win.fill('.panel textarea', long)
  await sleep(400)
  await h.win.screenshot({ path: join(h.shotsDir, 'text-very-long.png') })

  // multi-line
  await h.win.fill('.panel textarea', 'line one\nline two\nline three')
  await sleep(400)
  await h.win.screenshot({ path: join(h.shotsDir, 'text-multiline.png') })

  const saved = await flushedProject(h.recordingsDir, id)
  expect(saved.texts).toHaveLength(6)
  expect(saved.texts.some((t) => t.text.includes('\n'))).toBe(true)
  expect(h.errors.join('\n')).not.toMatch(/layoutText|measureText/)
})

test('undo / redo after a cut brings the zoom and the text back', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('z')
  await h.win.keyboard.press('t')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  const before = await flushedProject(h.recordingsDir, id)

  await cutSeconds(1, 5) // swallows both
  await expect(h.win.locator('.region.zoom')).toHaveCount(0)
  await expect(h.win.locator('.region.text')).toHaveCount(0)

  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Control+z')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  await h.win.click('.tab:has-text("Clip")')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(0)
  const undone = await flushedProject(h.recordingsDir, id)
  expect(undone.zooms[0].start).toBe(before.zooms[0].start)
  expect(undone.zooms[0].end).toBe(before.zooms[0].end)
  expect(undone.texts[0].start).toBe(before.texts[0].start)

  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Control+y')
  await expect(h.win.locator('.region.zoom')).toHaveCount(0)
  await h.win.click('.tab:has-text("Clip")')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(1)
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Control+z')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
})

test('pick area mode: click, Escape, Enter and Apply', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('z')
  await h.win.click('.tab:has-text("Zoom")')
  await h.win.click('.seg-btn:has-text("Fixed area")')
  const targetBefore = (await flushedProject(h.recordingsDir, id)).zooms[0].target
  console.log('[pick] target before', JSON.stringify(targetBefore))

  // Escape leaves pick mode without changing anything
  await h.win.click('button:has-text("Pick area")')
  await expect(h.win.locator('.pick-rect')).toHaveCount(1)
  await expect(h.win.locator('.preview-controls .btn >> nth=2')).toBeDisabled()
  await h.win.keyboard.press('Escape')
  await expect(h.win.locator('.pick-rect')).toHaveCount(0)
  expect((await flushedProject(h.recordingsDir, id)).zooms[0].target).toEqual(targetBefore)

  // click on the frame moves the rectangle, Enter applies
  await h.win.click('button:has-text("Pick area")')
  await expect(h.win.locator('.pick-rect')).toHaveCount(1)
  const canvas = (await h.win.locator('.preview-canvas').boundingBox())!
  await h.win.mouse.click(canvas.x + canvas.width * 0.22, canvas.y + canvas.height * 0.25)
  await h.win.screenshot({ path: join(h.shotsDir, 'pick-rect.png') })
  await h.win.keyboard.press('Enter')
  await expect(h.win.locator('.pick-rect')).toHaveCount(0)
  const afterEnter = (await flushedProject(h.recordingsDir, id)).zooms[0]
  console.log('[pick] target after Enter', JSON.stringify(afterEnter.target), 'scale', afterEnter.scale)
  expect(afterEnter.target.x).toBeLessThan(0.45)
  expect(afterEnter.target.y).toBeLessThan(0.45)

  // and once more with the Apply button
  await h.win.click('button:has-text("Pick area")')
  const canvas2 = (await h.win.locator('.preview-canvas').boundingBox())!
  await h.win.mouse.click(canvas2.x + canvas2.width * 0.8, canvas2.y + canvas2.height * 0.8)
  await h.win.click('.preview-controls button:has-text("Apply")')
  await expect(h.win.locator('.pick-rect')).toHaveCount(0)
  const afterApply = (await flushedProject(h.recordingsDir, id)).zooms[0]
  console.log('[pick] target after Apply', JSON.stringify(afterApply.target))
  expect(afterApply.target.x).toBeGreaterThan(0.5)
})

test('shortcuts must not fire while typing in an input or a textarea', async () => {
  await reset()
  await h.win.click('.name-input')
  await h.win.type('.name-input', 'zztt ccc iii ooo', { delay: 20 })
  await h.win.keyboard.press('Delete')
  await h.win.keyboard.press('Space')
  await expect(h.win.locator('.region.zoom')).toHaveCount(0)
  await expect(h.win.locator('.region.text')).toHaveCount(0)
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(0)

  // …and in the text textarea
  await playheadAt(2)
  await h.win.keyboard.press('t')
  await h.win.click('.tab:has-text("Text")')
  await h.win.fill('.panel textarea', '')
  await h.win.type('.panel textarea', 'zoom z text t cut c', { delay: 15 })
  await expect(h.win.locator('.region.zoom')).toHaveCount(0)
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  const saved = await flushedProject(h.recordingsDir, id)
  expect(saved.name).toContain('zztt ccc iii ooo')
  expect(saved.texts[0].text).toBe('zoom z text t cut c')
})

test('timeline zoom extremes and Ctrl+wheel stay usable', async () => {
  await reset()
  const slider = h.win.locator('.timeline-zoom input[type="range"]')
  await slider.fill('0.005')
  await sleep(200)
  const minWidth = await h.win.locator('.timeline-content').evaluate((el) => el.getBoundingClientRect().width)
  await h.win.screenshot({ path: join(h.shotsDir, 'timeline-zoom-min.png') })
  await slider.fill('1')
  await sleep(200)
  const maxWidth = await h.win.locator('.timeline-content').evaluate((el) => el.getBoundingClientRect().width)
  await h.win.screenshot({ path: join(h.shotsDir, 'timeline-zoom-max.png') })
  console.log('[timeline zoom] widths', minWidth, maxWidth)
  expect(maxWidth).toBeGreaterThan(minWidth)
  expect(minWidth).toBeGreaterThan(10)

  const track = (await h.win.locator('.track-video').boundingBox())!
  const zoomBefore = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  await h.win.keyboard.down('Control')
  for (let i = 0; i < 8; i++) {
    await h.win.mouse.move(track.x + 50, track.y + 8)
    await h.win.mouse.wheel(0, -120)
    await sleep(60)
  }
  for (let i = 0; i < 16; i++) {
    await h.win.mouse.move(track.x + 50, track.y + 8)
    await h.win.mouse.wheel(0, 120)
    await sleep(60)
  }
  await h.win.keyboard.up('Control')
  const afterWheel = await h.win.locator('.timeline-content').evaluate((el) => el.getBoundingClientRect().width)
  const zoomAfter = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  console.log('[timeline zoom] width after ctrl+wheel', afterWheel, 'page zoom level', zoomBefore, '→', zoomAfter)
  await h.win.screenshot({ path: join(h.shotsDir, 'timeline-ctrl-wheel.png') })
  // put the page zoom back whatever happened, so the other scenarios keep sane coordinates
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0))
  expect(afterWheel).toBeGreaterThan(10)
  expect(zoomAfter, 'Ctrl+wheel over the timeline must not zoom the whole app page').toBe(zoomBefore)
  await h.win.click('.timeline-zoom .btn-ghost') // fit
  await sleep(200)
  const fitted = await h.win.locator('.timeline-content').evaluate((el) => el.getBoundingClientRect().width)
  const viewport = await h.win.locator('.timeline-scroll').evaluate((el) => el.clientWidth)
  console.log('[timeline zoom] fitted', fitted, 'viewport', viewport)
  expect(Math.abs(fitted - viewport)).toBeLessThan(40)
})

test('small window: the editor stays operable', async () => {
  await reset()
  const original = await h.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return w.getSize()
  })
  // the app refuses to go below its minimum size – show what that minimum really is
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 560))
  await sleep(500)
  const clamped = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  console.log('[resize] asked for 800x560, got', JSON.stringify(clamped))

  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(200, 200))
  for (const [w, hgt] of [[1040, 680], [820, 560], [640, 460]] as const) {
    await h.app.evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(size[0], size[1])
    }, [w, hgt])
    await sleep(700)
    await h.win.screenshot({ path: join(h.shotsDir, `small-${w}x${hgt}.png`) })
    const canvas = await h.win.locator('.preview-canvas').boundingBox()
    const exportBtn = h.win.locator('.editor-top-actions .btn-primary')
    const toolbar = await h.win.locator('.timeline-toolbar').isVisible()
    console.log(
      `[resize ${w}x${hgt}] canvas`,
      JSON.stringify(canvas),
      'export visible',
      await exportBtn.isVisible(),
      'timeline toolbar visible',
      toolbar
    )
    if (w >= 1040) {
      // the supported minimum: everything must still work
      expect(canvas!.width, `preview has a usable width at ${w}x${hgt}`).toBeGreaterThan(20)
      expect(canvas!.height, `preview has a usable height at ${w}x${hgt}`).toBeGreaterThan(20)
      expect(await exportBtn.isVisible()).toBe(true)
      expect(toolbar).toBe(true)
    }
  }
  await h.app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(1040, 680)
    win.setSize(size[0], size[1])
  }, original)
  await sleep(500)
})

test('edits survive closing and reopening the project', async () => {
  await reset()
  await cutSeconds(1, 2)
  await playheadAt(4)
  await h.win.keyboard.press('z')
  await h.win.keyboard.press('t')
  await h.win.click('.tab:has-text("Style")')
  await h.win.click('.swatch.checker')
  await h.win.click('.tab:has-text("Clip")')
  const windowsCount = await h.win.locator('.windows-list .list-item').count()
  if (windowsCount > 0) await h.win.locator('.windows-list .list-main').first().click()
  const beforeClose = await flushedProject(h.recordingsDir, id)

  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  await sleep(600)
  await h.win.click('.project-open')
  await h.win.waitForSelector('.editor')
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  await h.win.click('.tab:has-text("Clip")')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(1)
  await h.win.click('.tab:has-text("Style")')
  await expect(h.win.locator('.swatch.checker.active')).toHaveCount(1)
  const reopened = readProject(h.recordingsDir, id)
  expect(reopened.crop).toEqual(beforeClose.crop)
  expect(reopened.frame.background).toBe('transparent')
  console.log('[persist] crop', JSON.stringify(reopened.crop), 'cuts', reopened.cuts.length)
})

test('no unexpected renderer errors during the editor scenarios', async () => {
  const counts = new Map<string, number>()
  for (const e of h.errors) counts.set(e, (counts.get(e) ?? 0) + 1)
  const unique = [...counts.entries()].map(([msg, n]) => `${n}× ${msg}`)
  console.log('[console errors]\n' + unique.join('\n'))
  const unexpected = unique.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  expect(unexpected, 'renderer console errors:\n' + unexpected.join('\n')).toEqual([])
})
