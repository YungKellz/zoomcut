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

/** Smaller editor details: restoring cuts, undo noise, dialogs, edge values. */
let h: Harness
let id: string
let duration: number
let pristinePath: string
let pristineCopy: string

test.beforeAll(async () => {
  h = await launch('misc')
  await useEnglish(h.win)
  await record(h, 6000)
  id = projectIds(h.recordingsDir)[0]
  await sleep(1200)
  pristinePath = join(h.recordingsDir, id, 'project.json')
  pristineCopy = join(h.recordingsDir, id, 'pristine.json.bak')
  copyFileSync(pristinePath, pristineCopy)
  const p = readProject(h.recordingsDir, id)
  duration = p.recording.durationMs
  console.log('[fixture]', id, 'duration', duration, 'name', JSON.stringify(p.name), 'export.fileName', JSON.stringify(p.export.fileName))
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

async function reset(): Promise<void> {
  if (await h.win.locator('.modal').count()) {
    await h.win.click('.modal-head .btn-ghost').catch(() => undefined)
  }
  if (await h.win.locator('.editor').count()) {
    await h.win.click('.editor-top button:has-text("Recordings")')
    await h.win.waitForSelector('.home')
  }
  await sleep(1300)
  writeFileSync(pristinePath, readFileSync(pristineCopy))
  await h.win.click('.project-open')
  await h.win.waitForSelector('.editor')
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  await h.win.click('.tab:has-text("Clip")')
}

async function playheadAt(seconds: number): Promise<void> {
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await h.win.keyboard.press('Shift+ArrowRight')
}

test('a removed piece can be restored from the Clip list and with Delete', async () => {
  await reset()
  await playheadAt(1)
  await h.win.keyboard.press('i')
  await h.win.keyboard.press('Shift+ArrowRight')
  await h.win.keyboard.press('o')
  await h.win.keyboard.press('c')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(1)

  // the round-arrow button restores it
  await h.win.click('.cuts-list .list-item .btn-ghost')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(0)

  // and selecting it + Delete restores it too (README: "click the seam and press Delete")
  await playheadAt(1)
  await h.win.keyboard.press('i')
  await h.win.keyboard.press('Shift+ArrowRight')
  await h.win.keyboard.press('o')
  await h.win.keyboard.press('c')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(1)
  await h.win.click('.cuts-list .list-item .list-main')
  await h.win.keyboard.press('Delete')
  await expect(h.win.locator('.cuts-list .list-item')).toHaveCount(0)
  const saved = await flushedProject(h.recordingsDir, id)
  expect(saved.cuts).toHaveLength(0)
})

test('clicking into the text field costs one undo step that does nothing', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('t')
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  await h.win.click('.tab:has-text("Text")')
  await h.win.click('.panel textarea') // focus only – no edit at all
  await h.win.click('.timeline-toolbar .timeline-hint')
  await expect(h.win.locator('.editor-top-actions .btn-ghost').first()).toBeEnabled()
  await h.win.keyboard.press('Control+z')
  await sleep(300)
  const count = await h.win.locator('.region.text').count()
  console.log('[undo noise] texts after one Ctrl+Z (expected 0):', count)
  await h.win.screenshot({ path: join(h.shotsDir, 'undo-noop.png') })
  expect(count, 'Ctrl+Z after only focusing the text field did nothing').toBe(0)
})

test('merely selecting a block on the timeline costs one undo step that does nothing', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('z')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
  await h.win.click('.region.zoom') // a plain click to select – no drag
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Control+z')
  await sleep(300)
  const count = await h.win.locator('.region.zoom').count()
  console.log('[undo noise] zooms after one Ctrl+Z (expected 0):', count)
  expect(count, 'Ctrl+Z after only clicking the zoom block did nothing').toBe(0)
})

test('Trim start is disabled at the very beginning and O at 0 does not build a negative range', async () => {
  await reset()
  await playheadAt(0)
  await expect(h.win.locator('button:has-text("Trim start")')).toBeDisabled()
  await h.win.keyboard.press('o')
  await h.win.keyboard.press('c')
  const saved = await flushedProject(h.recordingsDir, id)
  console.log('[edge range] cuts after pressing O then C at time 0:', JSON.stringify(saved.cuts))
  for (const c of saved.cuts) {
    expect(c.start).toBeGreaterThanOrEqual(0)
    expect(c.end).toBeGreaterThan(c.start)
  }
})

test('auto-zoom without recorded clicks explains itself instead of doing nothing', async () => {
  await reset()
  const p = readProject(h.recordingsDir, id) as unknown as { cursorData: { samples: unknown[]; clicks: unknown[]; source: string } }
  console.log('[cursor data] samples', p.cursorData.samples.length, 'clicks', p.cursorData.clicks.length, 'source', p.cursorData.source)
  await h.win.click('.tab:has-text("Cursor")')
  const recorded = (await h.win.textContent('.panel .muted.small')) ?? ''
  console.log('[cursor data] panel says:', recorded.trim())

  let dialogText = ''
  h.win.once('dialog', (d) => {
    dialogText = d.message()
    void d.accept()
  })
  await h.win.click('.tab:has-text("Zoom")')
  await h.win.click('button:has-text("Auto-zoom from clicks")')
  await sleep(1200)
  console.log('[auto zoom] dialog:', JSON.stringify(dialogText), '| zooms:', await h.win.locator('.region.zoom').count())
  if (p.cursorData.clicks.length === 0) {
    expect(dialogText, 'the user must be told why nothing happened').not.toBe('')
  } else {
    expect(await h.win.locator('.region.zoom').count()).toBeGreaterThan(0)
  }
})

test('Escape closes the export dialog', async () => {
  await reset()
  await h.win.click('.editor-top-actions .btn-primary')
  await h.win.waitForSelector('.modal')
  await h.win.keyboard.press('Escape')
  await sleep(500)
  const stillOpen = await h.win.locator('.modal').count()
  console.log('[export dialog] still open after Escape:', stillOpen === 1)
  await h.win.screenshot({ path: join(h.shotsDir, 'export-escape.png') })
  if (stillOpen) await h.win.click('.modal-foot button:has-text("Close")')
  expect(stillOpen, 'Escape should close the export dialog').toBe(0)
})

test('the zoom scale slider covers its whole documented range', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('z')
  await h.win.click('.tab:has-text("Zoom")')
  const slider = h.win.locator('.panel input[type="range"]').first()
  await slider.fill('5')
  await sleep(200)
  await slider.fill('1.2')
  await sleep(200)
  const label = await h.win.locator('.panel .field-value').first().textContent()
  const saved = await flushedProject(h.recordingsDir, id)
  console.log('[zoom scale] label', label, 'saved scale', saved.zooms[0]?.scale)
  expect(saved.zooms[0].scale).toBe(1.2)
  await slider.fill('5')
  await sleep(600)
  expect((await flushedProject(h.recordingsDir, id)).zooms[0].scale).toBe(5)
})

/**
 * A text shorter than its fade time is drawn with an alpha that never approaches 1
 * (zoomProgress clamps the ease to half the segment, drawText does not). Measured by
 * comparing the pixels of the text box against the same area without the text.
 */
test('a short text with a long fade is still readable', async () => {
  await reset()
  await playheadAt(2)
  await h.win.keyboard.press('t')
  await h.win.click('.tab:has-text("Text")')
  // 200 ms long text
  await h.win.fill('.panel input[type="number"] >> nth=0', '2')
  await h.win.fill('.panel input[type="number"] >> nth=1', '2.2')
  const animSlider = h.win.locator('.panel .field', { hasText: 'Anim. time' }).locator('input[type="range"]')
  await animSlider.fill('800')
  await h.win.locator('.list .list-main').first().click() // playhead = start + 50 ms
  await sleep(600)
  await expect(h.win.locator('.text-box')).toHaveCount(1)

  const rect = await h.win.evaluate(() => {
    const box = document.querySelector('.text-box') as HTMLElement
    const canvas = document.querySelector('.preview-canvas') as HTMLCanvasElement
    const b = box.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    const r = {
      x: Math.max(0, Math.round(b.left - c.left)),
      y: Math.max(0, Math.round(b.top - c.top)),
      w: Math.round(b.width),
      h: Math.round(b.height)
    }
    r.w = Math.max(1, Math.min(canvas.width - r.x, r.w))
    r.h = Math.max(1, Math.min(canvas.height - r.y, r.h))
    ;(window as unknown as { __rect: typeof r }).__rect = r
    return r
  })
  const capture = (key: string): Promise<number> =>
    h.win.evaluate((k) => {
      const w = window as unknown as Record<string, unknown> & { __rect: { x: number; y: number; w: number; h: number } }
      const canvas = document.querySelector('.preview-canvas') as HTMLCanvasElement
      const data = canvas.getContext('2d')!.getImageData(w.__rect.x, w.__rect.y, w.__rect.w, w.__rect.h).data
      w[k] = Array.from(data)
      return data.length
    }, key)
  const diff = (a: string, b: string): Promise<number> =>
    h.win.evaluate(([x, y]) => {
      const w = window as unknown as Record<string, number[]>
      let s = 0
      let n = 0
      for (let i = 0; i < w[x].length; i += 4) {
        s += Math.abs(w[x][i] - w[y][i]) + Math.abs(w[x][i + 1] - w[y][i + 1]) + Math.abs(w[x][i + 2] - w[y][i + 2])
        n += 3
      }
      return s / n
    }, [a, b])

  await capture('__fadeLong')
  await animSlider.fill('0')
  await sleep(500)
  await capture('__fadeOff')
  // move the text out of the way to get the untouched video underneath
  await h.win.fill('.panel input[type="number"] >> nth=0', '3')
  await sleep(500)
  await expect(h.win.locator('.text-box')).toHaveCount(0)
  await capture('__noText')

  const visibleWithLongFade = await diff('__fadeLong', '__noText')
  const visibleWithoutFade = await diff('__fadeOff', '__noText')
  const ratio = visibleWithLongFade / Math.max(1e-6, visibleWithoutFade)
  console.log(
    `[text fade] box ${JSON.stringify(rect)} | 800 ms fade on a 200 ms text: ${visibleWithLongFade.toFixed(1)},` +
      ` no fade: ${visibleWithoutFade.toFixed(1)}, ratio ${(ratio * 100).toFixed(1)}%`
  )
  await h.win.screenshot({ path: join(h.shotsDir, 'text-short-long-fade.png') })
  expect(visibleWithoutFade, 'sanity: the text is visible without a fade').toBeGreaterThan(5)
  expect(ratio, 'a 200 ms text with a 800 ms fade is practically invisible').toBeGreaterThan(0.3)
})

test('no unexpected renderer errors during the misc scenarios', async () => {
  const counts = new Map<string, number>()
  for (const e of h.errors) counts.set(e, (counts.get(e) ?? 0) + 1)
  const unique = [...counts.entries()].map(([msg, n]) => `${n}× ${msg}`)
  console.log('[console errors]\n' + unique.join('\n'))
  const unexpected = unique.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  expect(unexpected, 'renderer console errors:\n' + unexpected.join('\n')).toEqual([])
})
