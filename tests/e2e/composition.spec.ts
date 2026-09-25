import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { launch, restoreUserSettings, sleep, useEnglish, type Harness } from './adv-helpers'

/**
 * Blur regions, compositions and the MP4 → GIF converter. The recordings are synthesized with
 * ffmpeg (test patterns, no screen capture), so this spec does not record or inject anything.
 */
let h: Harness
const W = 1280
const H = 720

function ffmpeg(args: string[]): string {
  // `ffmpeg -i` without an output exits with 1, so the status is not checked here
  return spawnSync(String(ffmpegStatic), ['-hide_banner', '-y', ...args], { encoding: 'utf8' }).stderr
}

function durationOf(file: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpeg(['-i', file]))
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : 0
}

function sizeOf(file: string): { w: number; h: number } {
  const m = /Video:.*?\s(\d{2,5})x(\d{2,5})[,\s]/.exec(ffmpeg(['-i', file]))
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 }
}

/** One RGB24 frame at `sec`, scaled to W × H. */
function frameAt(file: string, sec: number): Buffer {
  const r = spawnSync(String(ffmpegStatic), ['-hide_banner', '-loglevel', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 64 * 1024 * 1024
  })
  return r.stdout
}

/** Mean horizontal neighbour difference inside a rectangle: high for sharp detail, near 0 once blurred. */
function edgeEnergy(a: Buffer, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let n = 0
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0) + 1; x < Math.round(x1); x++) {
      const i = (y * W + x) * 3
      sum += Math.abs(a[i] - a[i - 3]) + Math.abs(a[i + 1] - a[i - 2]) + Math.abs(a[i + 2] - a[i - 1])
      n++
    }
  }
  return n ? sum / n : 0
}

/** Mean channel value inside a rectangle. */
function brightness(a: Buffer, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let n = 0
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const i = (y * W + x) * 3
      sum += a[i] + a[i + 1] + a[i + 2]
      n += 3
    }
  }
  return n ? sum / n : 0
}
function makeProject(id: string, source: string, width: number, height: number, durationMs: number, vf = 'null'): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `${source}=size=${width}x${height}:rate=30`, '-vf', vf, '-t', String(durationMs / 1000), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', join(dir, 'source.mp4')])
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

interface BlurJson {
  x: number
  y: number
  w: number
  h: number
  style: string
}

function blursOf(id: string): BlurJson[] {
  return (JSON.parse(readFileSync(join(h.recordingsDir, id, 'project.json'), 'utf8')) as { blurs?: BlurJson[] }).blurs ?? []
}

async function exportFromDialog(fileName: string): Promise<string> {
  await h.win.waitForSelector('.modal')
  await h.win.fill('.modal .folder-row input', h.exportDir)
  await h.win.locator('.modal .field input').first().fill(fileName)
  await h.win.click('.modal-foot .btn-primary')
  await h.win.waitForSelector('.export-result, .modal .error-box', { timeout: 180_000 })
  await expect(h.win.locator('.modal .error-box')).toHaveCount(0)
  await h.win.click('.modal-foot .btn:has-text("Close")')
  return join(h.exportDir, `${fileName}.mp4`)
}

test.beforeAll(async () => {
  h = await launch('composition')
  // static fine-grained noise: sharp detail everywhere, which a blur visibly removes
  makeProject('synthA', 'testsrc2', W, H, 4000, 'noise=alls=60:allf=u')
  makeProject('synthB', 'mandelbrot', 800, 600, 2000)
  await h.win.reload()
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app.close()
})

test('a blur region is drawn on the whole cropped frame and burned into the export', async () => {
  const { win } = h
  await win.click('.project-open:has-text("Synthetic synthA")')
  await win.waitForSelector('.preview-canvas')
  await sleep(1200)
  await win.keyboard.press('b')
  await expect(win.locator('.preview-controls .hint')).toContainText('draw a new one')
  const box = (await win.locator('.preview-canvas').boundingBox())!
  await win.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 4 })
  await win.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 4 })
  await win.mouse.up()
  await win.keyboard.press('Escape')
  await expect(win.locator('.preview-controls .hint')).toHaveCount(0)

  await expect.poll(() => blursOf('synthA').length, { timeout: 5000 }).toBe(1)
  const [blur] = blursOf('synthA')
  expect(blur.style).toBe('blur')
  expect(blur.x).toBeCloseTo(0.1, 1)
  expect(blur.y).toBeCloseTo(0.2, 1)
  expect(blur.w).toBeCloseTo(0.4, 1)
  expect(blur.h).toBeCloseTo(0.4, 1)

  await win.click('.editor-top-actions .btn-primary')
  const out = await exportFromDialog('blur-export')
  expect(existsSync(out)).toBe(true)
  const src = frameAt(join(h.recordingsDir, 'synthA', 'source.mp4'), 1)
  const exp = frameAt(out, 1)
  const r = [(blur.x + 0.02) * W, (blur.y + 0.02) * H, (blur.x + blur.w - 0.02) * W, (blur.y + blur.h - 0.02) * H] as const
  // the rectangle loses its sharp edges; the rest of the frame keeps them
  expect(edgeEnergy(exp, ...r)).toBeLessThan(edgeEnergy(src, ...r) * 0.35)
  const rest = [0.6 * W, 0.05 * H, 0.95 * W, 0.95 * H] as const
  expect(edgeEnergy(exp, ...rest)).toBeGreaterThan(edgeEnergy(src, ...rest) * 0.6)

  await win.click('.editor-top .btn-ghost >> nth=0')
  await win.waitForSelector('.home')
})

test('a composition plays and exports its recordings back to back', async () => {
  const { win } = h
  await win.click('button:has-text("New composition")')
  await win.waitForSelector('.composition')
  const add = win.locator('.comp-side select').first()
  await add.selectOption('synthA')
  await add.selectOption('synthB')
  await expect(win.locator('.comp-item')).toHaveCount(2)
  await expect(win.locator('.editor-top-info')).toContainText('1280×720 · 2 recordings · 0:06.0')

  await win.click('.editor-top-actions .btn-primary')
  const out = await exportFromDialog('composition-export')
  expect(Math.abs(durationOf(out) - 6000)).toBeLessThan(150)
  expect(sizeOf(out)).toEqual({ w: W, h: H })
  // the second recording (4:3) sits pillarboxed in the 16:9 frame
  const frame = frameAt(out, 5)
  expect(brightness(frame, 0, 0, 100, H)).toBeLessThan(8)
  expect(brightness(frame, 300, 100, 900, 600)).toBeGreaterThan(40)

  // editing a recording from the composition returns to it
  await win.click('.comp-item >> nth=1 >> button[title^="Edit this recording"]')
  await win.waitForSelector('.editor-main .preview-canvas')
  await win.click('.editor-top .btn-ghost >> nth=0')
  await win.waitForSelector('.composition')
  await win.click('.editor-top .btn-ghost >> nth=0')
  await win.waitForSelector('.home')
  await expect(win.locator('.scenario-row:has-text("2 recordings")')).toHaveCount(1)
  const files = readdirSync(h.compositionsDir).filter((f) => f.endsWith('.json'))
  expect(files).toHaveLength(1)
  const saved = JSON.parse(readFileSync(join(h.compositionsDir, files[0]), 'utf8')) as { items: Array<{ projectId: string }> }
  expect(saved.items.map((i) => i.projectId)).toEqual(['synthA', 'synthB'])
})

test('the MP4 → GIF converter trims, scales and writes a GIF', async () => {
  const { app, win } = h
  const input = join(h.recordingsDir, 'synthA', 'source.mp4')
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, input)
  await win.click('button:has-text("MP4 → GIF")')
  await win.click('.modal button:has-text("Choose a video")')
  await win.waitForSelector('.modal .row2')
  await win.fill('.modal .folder-row input', h.exportDir)
  await win.locator('.modal .field input').first().fill('converted')
  await win.locator('.modal select').first().selectOption('640')
  await win.locator('.modal input[type=number]').nth(0).fill('1')
  await win.locator('.modal input[type=number]').nth(1).fill('3')
  await win.click('.modal-foot .btn-primary')
  await win.waitForSelector('.export-result, .modal .error-box', { timeout: 120_000 })
  await expect(win.locator('.modal .error-box')).toHaveCount(0)
  const out = join(h.exportDir, 'converted.gif')
  expect(existsSync(out)).toBe(true)
  expect(sizeOf(out)).toEqual({ w: 640, h: 360 })
  expect(Math.abs(durationOf(out) - 2000)).toBeLessThan(200)
  await win.click('.modal-foot .btn:has-text("Close")')
  expect(h.errors).toEqual([])
})
