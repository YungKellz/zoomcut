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

type ZoomJson = ProjectJson['zooms'][number] & { easeInMs: number; easeOutMs: number; parts?: Array<{ id: string; start: number; target: { x: number; y: number }; scale: number }> }

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
  await win.click('[data-pick-area="0"]')
  await expect(win.locator('.pick-rect')).toHaveCount(1)
  // the hint and Apply / Cancel cover the whole inspector while picking
  await expect(win.locator('.pick-overlay')).toHaveCount(1)
  const canvas = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.click(canvas.x + canvas.width * 0.22, canvas.y + canvas.height * 0.25)
  await win.keyboard.press('Enter')
  await expect(win.locator('.pick-rect')).toHaveCount(0)
  const first = await waitForProject(h.recordingsDir, ID, (p) => p.zooms.length === 1 && p.zooms[0].mode === 'fixed' && p.zooms[0].target.x < 0.45)
  expect(zoomOf(first).parts).toBeUndefined()
  await expect(win.locator('.zoom-part-divider')).toHaveCount(0)
  await expect(win.locator('.pick-overlay')).toHaveCount(0)
  // the whole zoom is one area: Step 1 only, nothing removable
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(1)
  await expect(win.locator('.zoom-parts .list-item .danger')).toHaveCount(0)
  await expect(win.locator('.zoom-parts .list-item [data-pick-area="0"]')).toHaveCount(1)

  // playhead one more second into the zoom (it spans about 0.4 .. 3.5 s), then add a part there
  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Shift+ArrowRight')
  await win.click('.panel button:has-text("Add step at playhead")')
  await expect(win.locator('.pick-rect')).toHaveCount(1)
  await expect(win.locator('.pick-overlay .pick-overlay-hint')).toContainText('Step 2')
  await expect(win.locator('.preview-controls .hint')).toHaveCount(0)

  // a new spot in the bottom right, applied with the button
  const canvas2 = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.click(canvas2.x + canvas2.width * 0.8, canvas2.y + canvas2.height * 0.8)
  await win.click('.pick-overlay [data-action="apply"]')
  await expect(win.locator('.pick-rect')).toHaveCount(0)

  const withPart = await waitForProject(h.recordingsDir, ID, (p) => (zoomOf(p).parts?.length ?? 0) === 1 && (zoomOf(p).parts?.[0].target.x ?? 0) > 0.5)
  const zoom = zoomOf(withPart)
  const part = zoom.parts![0]
  expect(part.start).toBeGreaterThan(zoom.start + 300)
  expect(part.start).toBeLessThan(zoom.end - 300)
  expect(part.target.x).not.toBeCloseTo(zoom.target.x, 1)
  expect(zoom.target.x).toBeLessThan(0.45) // area 0 is untouched

  await expect(win.locator('.zoom-part-divider')).toHaveCount(1)
  await expect(win.locator('.region.zoom .region-label')).toContainText(/2 (parts|steps)/)
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(2)
  await expect(win.locator('.zoom-parts .list-item .danger')).toHaveCount(2) // every step can be removed, the first one too
  await expect(win.locator('.zoom-parts .list-item').first()).toContainText('Step 1')

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

/** centre and size of the pick rectangle on screen */
async function pickBox(win: Harness['win']): Promise<{ cx: number; cy: number; w: number; h: number; x: number; y: number }> {
  const b = (await win.locator('.pick-rect').boundingBox())!
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height, x: b.x, y: b.y }
}

test('the pick rectangle: centre cross, Shift magnet, Alt resizes from the centre, the inspector is locked', async () => {
  const { win } = h
  // the zoom of the previous test is still selected and fixed
  await win.click('[data-pick-area="0"]')
  await expect(win.locator('.pick-rect')).toHaveCount(1)
  await expect(win.locator('.pick-overlay')).toHaveCount(1)

  // the overlay sits on top of the tab bar and the panel: nothing below it can be clicked
  const covered = await win.evaluate(() => {
    const hit = (sel: string): boolean => {
      const el = document.querySelector(sel)
      if (!el) return false
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!top?.closest('.pick-overlay')
    }
    return { tab: hit('.inspector .tab'), panel: hit('.inspector .panel .seg-btn') }
  })
  expect(covered).toEqual({ tab: true, panel: true })

  // a light cross through the centre of the rectangle
  await expect(win.locator('.pick-rect .pick-grid')).toHaveCount(1)
  const gridBg = await win.locator('.pick-rect .pick-grid').evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(gridBg).toContain('linear-gradient')

  const canvas = (await win.locator('.preview-canvas').boundingBox())!
  const frameCx = canvas.x + canvas.width / 2
  const frameCy = canvas.y + canvas.height / 2
  const dragTo = async (x: number, y: number, hold?: () => Promise<void>): Promise<void> => {
    const from = await pickBox(win)
    await win.mouse.move(from.cx, from.cy)
    await win.mouse.down()
    await win.mouse.move(x, y, { steps: 5 })
    if (hold) await hold()
    await win.mouse.up()
  }

  // without Shift the rectangle goes exactly where it is dragged: a few px off the centre lines
  await dragTo(frameCx + 6, frameCy + 5)
  const loose = await pickBox(win)
  expect(Math.abs(loose.cx - (frameCx + 6))).toBeLessThan(2)
  expect(Math.abs(loose.cy - (frameCy + 5))).toBeLessThan(2)
  await expect(win.locator('.pick-guide')).toHaveCount(0)

  // with Shift its centre is pulled onto the frame's centre lines, which light up meanwhile
  await win.keyboard.down('Shift')
  await dragTo(frameCx + 6, frameCy + 5, async () => {
    await expect(win.locator('.pick-guide-v')).toHaveCount(1)
    await expect(win.locator('.pick-guide-h')).toHaveCount(1)
  })
  await win.keyboard.up('Shift')
  const snapped = await pickBox(win)
  expect(Math.abs(snapped.cx - frameCx)).toBeLessThan(1.5)
  expect(Math.abs(snapped.cy - frameCy)).toBeLessThan(1.5)
  await expect(win.locator('.pick-guide')).toHaveCount(0)

  // Alt on a corner grows the rectangle in every direction, its centre stays
  const innerBefore = await win.evaluate(() => window.innerHeight)
  const se = (await win.locator('.pick-se').boundingBox())!
  await win.keyboard.down('Alt')
  await win.mouse.move(se.x + se.width / 2, se.y + se.height / 2)
  await win.mouse.down()
  await win.mouse.move(se.x + se.width / 2 + 40, se.y + se.height / 2 + 40, { steps: 5 })
  await win.mouse.up()
  await win.keyboard.up('Alt')
  const grown = await pickBox(win)
  expect(grown.w).toBeGreaterThan(snapped.w + 60)
  expect(Math.abs(grown.cx - snapped.cx)).toBeLessThan(1.5)
  expect(Math.abs(grown.cy - snapped.cy)).toBeLessThan(1.5)
  // a bare Alt press must not reveal the hidden menu bar (that would shrink the page)
  expect(await win.evaluate(() => window.innerHeight)).toBe(innerBefore)

  // without Alt the opposite corner stays where it is
  const se2 = (await win.locator('.pick-se').boundingBox())!
  await win.mouse.move(se2.x + se2.width / 2, se2.y + se2.height / 2)
  await win.mouse.down()
  await win.mouse.move(se2.x + se2.width / 2 - 30, se2.y + se2.height / 2 - 30, { steps: 5 })
  await win.mouse.up()
  const shrunk = await pickBox(win)
  expect(shrunk.w).toBeLessThan(grown.w - 20)
  expect(Math.abs(shrunk.x - grown.x)).toBeLessThan(1.5)
  expect(Math.abs(shrunk.y - grown.y)).toBeLessThan(1.5)

  await win.screenshot({ path: join(h.shotsDir, 'pick-overlay.png') })

  // Escape cancels and unlocks the inspector
  await win.keyboard.press('Escape')
  await expect(win.locator('.pick-rect')).toHaveCount(0)
  await expect(win.locator('.pick-overlay')).toHaveCount(0)
  expect(h.errors).toEqual([])
})

test('a zoom added on a fractional playhead has whole milliseconds everywhere', async () => {
  const { win } = h
  // start from an empty timeline: delete the zoom of the previous tests
  await win.click('.panel button:has-text("Delete zoom")')
  await expect(win.locator('.region.zoom')).toHaveCount(0)

  // 13 frame steps of 1000 / 30 ms: the playhead sits at 433.33.. ms, closer to the start than the ease-in
  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Home')
  for (let i = 0; i < 13; i++) await win.keyboard.press('ArrowRight')
  await win.keyboard.press('z')
  // autosave lands a moment later: wait for the new zoom (ends at ~2.9 s), not for the one deleted above (ended at ~3.5 s)
  const saved = await waitForProject(h.recordingsDir, ID, (p) => p.zooms.length === 1 && p.zooms[0].end < 3000)
  const z = zoomOf(saved)
  for (const v of [z.start, z.end, z.easeInMs, z.easeOutMs]) expect(Number.isInteger(v), `${v} is a whole number of ms`).toBe(true)
  expect(z.start).toBe(0)
  expect(z.easeInMs).toBe(433)

  // and the slider prints it without decimals
  await win.click('.panel details.adv summary')
  await win.screenshot({ path: join(h.shotsDir, 'zoom-sections.png') })
  const label = await win.locator('.panel .field', { hasText: 'Ease in' }).locator('.field-value').textContent()
  expect(label?.trim()).toBe('433 ms')
})

test('every step can be deleted, the only one cannot: deleting step 1 promotes step 2', async () => {
  const { win } = h
  await win.click('.seg-btn:has-text("Fixed area")')
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(1)
  await expect(win.locator('[data-remove-area]')).toHaveCount(0)

  // a second step at the playhead (433 ms, inside the zoom), picked in the bottom right
  await win.click('.panel button:has-text("Add step at playhead")')
  await expect(win.locator('.pick-overlay')).toHaveCount(1)
  const canvas = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.click(canvas.x + canvas.width * 0.8, canvas.y + canvas.height * 0.8)
  await win.click('.pick-overlay [data-action="apply"]')
  const two = await waitForProject(h.recordingsDir, ID, (p) => (zoomOf(p).parts?.length ?? 0) === 1 && (zoomOf(p).parts?.[0].target.x ?? 0) > 0.5)
  const partTarget = zoomOf(two).parts![0].target
  expect(Number.isInteger(zoomOf(two).parts![0].start)).toBe(true)
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(2)
  await expect(win.locator('[data-remove-area]')).toHaveCount(2)

  // delete the FIRST step: the second one becomes the zoom itself, nothing is left to delete
  await win.click('[data-remove-area="0"]')
  const one = await waitForProject(h.recordingsDir, ID, (p) => zoomOf(p).parts === undefined)
  expect(zoomOf(one).target.x).toBeCloseTo(partTarget.x, 6)
  expect(zoomOf(one).target.y).toBeCloseTo(partTarget.y, 6)
  expect(zoomOf(one).start).toBe(0)
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(1)
  await expect(win.locator('[data-remove-area]')).toHaveCount(0)

  // undo brings both steps back
  await win.click('.timeline-toolbar .timeline-hint')
  await win.keyboard.press('Control+z')
  await expect(win.locator('.zoom-parts .list-item')).toHaveCount(2)
  expect(h.errors).toEqual([])
})
