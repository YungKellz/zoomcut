import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  launch,
  projectIds,
  record,
  restoreUserSettings,
  sleep,
  useEnglish,
  type Harness
} from './adv-helpers'

/** Adversarial export scenarios: file names, folders, cancelling, tiny crops, alpha. */
let h: Harness
let id: string

test.beforeAll(async () => {
  h = await launch('export')
  await useEnglish(h.win)
  await record(h, 4000)
  id = projectIds(h.recordingsDir)[0]
  await sleep(1200)
  console.log('[fixture] recording', id)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

async function openExport(format: 'gif' | 'mp4'): Promise<void> {
  if (!(await h.win.locator('.modal').count())) {
    await h.win.click('.editor-top-actions .btn-primary')
    await h.win.waitForSelector('.modal')
  }
  await h.win.click(format === 'gif' ? '.seg-btn:has-text("GIF animation")' : '.seg-btn:has-text("MP4 video")')
}

async function closeExport(): Promise<void> {
  if (await h.win.locator('.modal').count()) {
    await h.win.click('.modal-foot button:has-text("Close")')
    await h.win.waitForSelector('.modal', { state: 'detached' })
  }
}

function parseBytes(text: string): number {
  const m = /([\d.]+)\s*(B|KB|MB)/.exec(text)
  if (!m) return NaN
  return Number(m[1]) * { B: 1, KB: 1024, MB: 1024 * 1024 }[m[2] as 'B' | 'KB' | 'MB']
}

/** Fill the dialog and run the export; returns the path printed in the result box. */
async function runExport(opts: { fileName: string; folder: string; format: 'gif' | 'mp4'; scale?: string; fps?: string }): Promise<string> {
  await openExport(opts.format)
  await h.win.fill('input[placeholder="Choose a folder…"]', opts.folder)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', opts.fileName)
  if (opts.scale) await h.win.click(`.modal .seg-btn:has-text("${opts.scale}")`)
  if (opts.fps) await h.win.click(`.modal .seg-btn:text-is("${opts.fps}")`)
  let estimate = NaN
  try {
    await h.win.waitForSelector('text=/estimated size/', { timeout: 30_000 })
    estimate = parseBytes(((await h.win.textContent('.modal .muted.small')) ?? '').split('estimated size ≈')[1] ?? '')
  } catch {
    /* the estimate is optional */
  }
  await h.win.click(`button:has-text("Export ${opts.format.toUpperCase()}")`)
  await h.win.waitForSelector('.export-result, .error-box', { timeout: 200_000 })
  if (await h.win.locator('.error-box').count()) {
    return 'ERROR: ' + (await h.win.textContent('.error-box'))
  }
  const text = (await h.win.textContent('.export-result')) ?? ''
  const actual = parseBytes(text)
  console.log(
    `[estimate vs actual] ${opts.format} ${opts.fileName}: estimate ${Math.round(estimate)} B, actual ${Math.round(actual)} B,` +
      ` ratio ${(actual / estimate).toFixed(2)}×`
  )
  return text
}

test('the size estimate shows up and is not zero', async () => {
  await openExport('gif')
  await h.win.waitForSelector('text=/estimated size/', { timeout: 60_000 })
  const line = (await h.win.textContent('.modal .muted.small')) ?? ''
  console.log('[estimate]', line.trim())
  await h.win.screenshot({ path: join(h.shotsDir, 'export-estimate.png') })
  expect(line).toMatch(/estimated size ≈ \d/)
  expect(line).not.toMatch(/estimated size ≈ 0 B/)
})

test('the default file name proposed by the dialog is not the name of the produced file', async () => {
  await openExport('gif')
  const proposed = await h.win.inputValue('.modal input[spellcheck="false"] >> nth=0')
  console.log('[default name] dialog proposes:', JSON.stringify(proposed), '(recording id:', id + ')')
  await h.win.fill('input[placeholder="Choose a folder…"]', h.exportDir)
  await h.win.click('.modal .seg-btn:has-text("50%")')
  await h.win.click('.modal .seg-btn:text-is("10")')
  await h.win.click('button:has-text("Export GIF")')
  await h.win.waitForSelector('.export-result, .error-box', { timeout: 200_000 })
  const result = (await h.win.textContent('.export-result')) ?? ''
  console.log('[default name] result line:', result.trim(), '| files:', JSON.stringify(readdirSync(h.exportDir)))
  await h.win.screenshot({ path: join(h.shotsDir, 'export-default-name.png') })
  expect(existsSync(join(h.exportDir, proposed + '.gif')), `expected ${proposed}.gif on disk`).toBe(true)
  await closeExport()
})

test('a file name with spaces and dashes is silently mangled', async () => {
  const result = await runExport({ fileName: 'zoom demo-1', folder: h.exportDir, format: 'gif', scale: '50%', fps: '10' })
  const files = readdirSync(h.exportDir)
  console.log('[file name] result line:', result.trim(), '| files:', JSON.stringify(files))
  await h.win.screenshot({ path: join(h.shotsDir, 'export-name-mangled.png') })
  expect(files.some((f) => f.endsWith('.gif'))).toBe(true)
  expect(files, 'the exported file keeps the name the user typed').toContain('zoom demo-1.gif')
})

test('a file name with characters that are illegal on Windows is sanitised, not rejected', async () => {
  const result = await runExport({ fileName: 'a/b:c?', folder: h.exportDir, format: 'gif' })
  console.log('[illegal name] result:', result.trim(), '| files:', JSON.stringify(readdirSync(h.exportDir)))
  expect(result).not.toMatch(/^ERROR/)
  expect(readdirSync(h.exportDir).some((f) => f.endsWith('.gif'))).toBe(true)
})

test('an empty file name disables the export button', async () => {
  await closeExport()
  await openExport('gif')
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', '')
  await expect(h.win.locator('button:has-text("Export GIF")')).toBeDisabled()
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', '   ')
  await expect(h.win.locator('button:has-text("Export GIF")')).toBeDisabled()
  await closeExport()
})

test('exporting twice with the same name does not overwrite the first file', async () => {
  const before = readdirSync(h.exportDir).filter((f) => f.startsWith('twice'))
  await runExport({ fileName: 'twice', folder: h.exportDir, format: 'gif' })
  await h.win.click('button:has-text("Export GIF")')
  await h.win.waitForSelector('.export-result:has-text("twice-2"), .error-box', { timeout: 200_000 })
  const after = readdirSync(h.exportDir).filter((f) => f.startsWith('twice'))
  console.log('[unique names] before', JSON.stringify(before), 'after', JSON.stringify(after))
  expect(after).toContain('twice.gif')
  expect(after).toContain('twice-2.gif')
  await closeExport()
})

test('a folder that does not exist yet is created', async () => {
  const deep = join(h.exportDir, 'brand', 'new', 'folder')
  expect(existsSync(deep)).toBe(false)
  const result = await runExport({ fileName: 'deep', folder: deep, format: 'gif' })
  console.log('[new folder]', result.trim())
  expect(result).not.toMatch(/^ERROR/)
  expect(existsSync(join(deep, 'deep.gif'))).toBe(true)
  await closeExport()
})

test('a folder path that is really a file reports an error instead of hanging', async () => {
  const filePath = join(h.exportDir, 'not-a-folder.txt')
  writeFileSync(filePath, 'x')
  await openExport('gif')
  await h.win.fill('input[placeholder="Choose a folder…"]', filePath)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', 'nope')
  await h.win.click('button:has-text("Export GIF")')
  await h.win.waitForSelector('.error-box', { timeout: 120_000 })
  const err = (await h.win.textContent('.error-box')) ?? ''
  console.log('[file as folder] error:', err.trim())
  await h.win.screenshot({ path: join(h.shotsDir, 'export-folder-is-file.png') })
  expect(err.length).toBeGreaterThan(0)
  // and the dialog must recover
  await h.win.fill('input[placeholder="Choose a folder…"]', h.exportDir)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', 'after-error')
  await h.win.click('button:has-text("Export GIF")')
  await h.win.waitForSelector('.export-result:has-text("after-error"), .error-box:has-text("EEXIST")', { timeout: 200_000 })
  expect(existsSync(join(h.exportDir, 'after-error.gif'))).toBe(true)
  await closeExport()
})

test('cancelling an export mid-render leaves nothing behind and the next export works', async () => {
  await openExport('mp4')
  await h.win.fill('input[placeholder="Choose a folder…"]', h.exportDir)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', 'cancelled')
  await h.win.click('.modal .seg-btn:text-is("60")')
  await h.win.click('button:has-text("Export MP4")')
  await h.win.waitForSelector('.progress-bar', { timeout: 60_000 })
  await sleep(900)
  await h.win.click('.modal-foot button:has-text("Cancel")')
  await sleep(2500)
  const files = readdirSync(h.exportDir)
  console.log('[cancel] files after cancelling:', JSON.stringify(files))
  await h.win.screenshot({ path: join(h.shotsDir, 'export-cancelled.png') })
  expect(files, 'a cancelled export must not leave a file').not.toContain('cancelled.mp4')
  expect(await h.win.locator('.error-box').count(), 'cancelling is not an error').toBe(0)

  // the temp folder of the main process must not keep the intermediate either
  const temp = join(process.env['TEMP'] ?? process.env['TMP'] ?? '', 'zoomcut-export')
  if (existsSync(temp)) console.log('[cancel] export temp dir contains:', JSON.stringify(readdirSync(temp)))

  const result = await runExport({ fileName: 'after-cancel', folder: h.exportDir, format: 'mp4', scale: '50%' })
  console.log('[cancel] export after cancelling:', result.trim())
  expect(result).not.toMatch(/^ERROR/)
  expect(existsSync(join(h.exportDir, 'after-cancel.mp4'))).toBe(true)
  await closeExport()
})

test('cancelling while ffmpeg is already encoding must not leave a half-written file', async () => {
  await closeExport()
  await openExport('mp4')
  await h.win.fill('input[placeholder="Choose a folder…"]', h.exportDir)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', 'killed-mid-encode')
  await h.win.click('.modal .seg-btn:has-text("100%")')
  await h.win.click('button:has-text("Export MP4")')
  // the second progress line only appears once the render is done and ffmpeg is running
  await h.win.waitForSelector('.export-status .progress-line >> nth=1', { timeout: 200_000 })
  const phase = await h.win.textContent('.export-status .progress-line >> nth=1')
  console.log('[cancel encode] cancelling during phase:', (phase ?? '').trim())
  await h.win.click('.modal-foot button:has-text("Cancel")')
  await sleep(3000)
  const files = readdirSync(h.exportDir).filter((f) => f.startsWith('killed-mid-encode'))
  const sizes = files.map((f) => `${f}:${statSync(join(h.exportDir, f)).size}`)
  console.log('[cancel encode] leftovers:', JSON.stringify(sizes))
  await h.win.screenshot({ path: join(h.shotsDir, 'export-cancel-encode.png') })
  await closeExport()
  expect(files, 'cancelling during encoding left a partial file: ' + sizes.join(', ')).toEqual([])
})

test('a 5% crop still exports to GIF and MP4', async () => {
  await closeExport()
  await h.win.click('.tab:has-text("Clip")')
  await h.win.click('button:has-text("Edit crop")')
  const stage = (await h.win.locator('.preview-stage').boundingBox())!
  const handle = (await h.win.locator('.crop-se').boundingBox())!
  await h.win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await h.win.mouse.down()
  await h.win.mouse.move(stage.x + 8, stage.y + 8, { steps: 15 })
  await h.win.mouse.up()
  await h.win.keyboard.press('Escape')
  const info = (await h.win.textContent('.panel .muted.small')) ?? ''
  console.log('[tiny crop]', info.trim())
  await h.win.screenshot({ path: join(h.shotsDir, 'tiny-crop.png') })

  const gif = await runExport({ fileName: 'tiny', folder: h.exportDir, format: 'gif' })
  console.log('[tiny crop] gif:', gif.trim())
  expect(gif).not.toMatch(/^ERROR/)
  const mp4 = await runExport({ fileName: 'tiny', folder: h.exportDir, format: 'mp4' })
  console.log('[tiny crop] mp4:', mp4.trim())
  expect(mp4).not.toMatch(/^ERROR/)
  expect(existsSync(join(h.exportDir, 'tiny.gif'))).toBe(true)
  expect(existsSync(join(h.exportDir, 'tiny.mp4'))).toBe(true)
  expect(statSync(join(h.exportDir, 'tiny.gif')).size).toBeGreaterThan(100)
  await closeExport()
  // back to the full frame for the next scenario
  await h.win.click('.tab:has-text("Clip")')
  await h.win.click('.btn-row button:has-text("Reset")')
})

test('transparent background with padding, radius and shadow exports to GIF', async () => {
  await closeExport()
  await h.win.click('.tab:has-text("Style")')
  await h.win.locator('.panel input[type="range"] >> nth=0').fill('0.2') // padding
  await h.win.locator('.panel input[type="range"] >> nth=1').fill('40') // corner radius
  await h.win.click('.panel .field-row input[type="checkbox"]') // shadow
  await h.win.click('.swatch.checker')
  await sleep(400)
  await h.win.screenshot({ path: join(h.shotsDir, 'transparent-padding.png') })
  const result = await runExport({ fileName: 'alpha-pad', folder: h.exportDir, format: 'gif', scale: '50%' })
  console.log('[alpha]', result.trim())
  expect(result).not.toMatch(/^ERROR/)
  const file = join(h.exportDir, 'alpha-pad.gif')
  expect(existsSync(file)).toBe(true)
  expect(statSync(file).size).toBeGreaterThan(1000)

  // MP4 with a transparent background must warn, not silently produce something odd
  await openExport('mp4')
  await expect(h.win.locator('.warn.small')).toBeVisible()
  await closeExport()
})

test('no unexpected renderer errors during the export scenarios', async () => {
  console.log('[console errors]', JSON.stringify(h.errors, null, 1))
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
