import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Shared plumbing for the adversarial end-to-end scenarios. Everything lands under
 * tests/e2e/.tmp/<name> so a run can be wiped completely (recordings contain the
 * real screen of the machine).
 */
export const tmpRoot = resolve('tests/e2e/.tmp')

export interface Harness {
  app: ElectronApplication
  win: Page
  recordingsDir: string
  exportDir: string
  shotsDir: string
  /** every renderer console error seen since launch */
  errors: string[]
}

export async function launch(name: string): Promise<Harness> {
  const base = join(tmpRoot, name)
  const recordingsDir = join(base, 'recordings')
  const exportDir = join(base, 'exports')
  const shotsDir = join(base, 'shots')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(recordingsDir, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  mkdirSync(shotsDir, { recursive: true })

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ZOOMCUT_RECORDINGS_DIR: recordingsDir, ZOOMCUT_E2E: '1' }
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text())
      console.log('[renderer error]', msg.text())
    }
  })
  win.on('pageerror', (err) => {
    errors.push('pageerror: ' + err.message)
    console.log('[pageerror]', err.message)
  })
  return { app, win, recordingsDir, exportDir, shotsDir, errors }
}

/** Restores the app settings this machine's user had before the test touched them. */
export async function restoreUserSettings(win: Page): Promise<void> {
  await win
    .evaluate(() =>
      (window as unknown as { zc: { app: { setSettings: (p: unknown) => Promise<unknown> } } }).zc.app.setSettings({
        language: 'system',
        cursorDefaults: null,
        frameDefaults: null
      })
    )
    .catch(() => undefined)
}

export async function useEnglish(win: Page): Promise<void> {
  await win.waitForSelector('.btn-record:not([disabled])', { timeout: 60_000 })
  await win.selectOption('.lang-select select', 'en')
  await win.waitForSelector('button:has-text("Start recording")')
}

export async function waitForBar(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 200; i++) {
    const bar = app.windows().find((w) => w.url().includes('#bar'))
    if (bar) return bar
    await sleep(100)
  }
  throw new Error('recorder bar window did not appear')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Records the screen for `ms` and waits until the editor is ready. */
export async function record(h: Harness, ms = 6000): Promise<void> {
  await h.win.waitForSelector('.btn-record:not([disabled])', { timeout: 60_000 })
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(ms)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.editor', { timeout: 180_000 })
  await h.win.waitForSelector('.preview-canvas')
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
}

export function projectIds(recordingsDir: string): string[] {
  try {
    return readdirSync(recordingsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface ProjectJson {
  id: string
  name: string
  recording: { durationMs: number; width: number; height: number; fps: number }
  cuts: Array<{ id: string; start: number; end: number }>
  zooms: Array<{ id: string; start: number; end: number; scale: number; mode: string; target: { x: number; y: number } }>
  texts: Array<{ id: string; start: number; end: number; text: string; x: number; y: number }>
  crop: { x: number; y: number; w: number; h: number }
  frame: { padding: number; cornerRadius: number; background: string; shadow: boolean }
  export: { fileName: string; folder: string; format: string }
}

export function readProject(recordingsDir: string, id: string): ProjectJson {
  return JSON.parse(readFileSync(join(recordingsDir, id, 'project.json'), 'utf8')) as ProjectJson
}

/** Polls project.json (autosave lands ~700 ms after the last change) until `pred` holds. */
export async function waitForProject(
  recordingsDir: string,
  id: string,
  pred: (p: ProjectJson) => boolean,
  timeoutMs = 8000
): Promise<ProjectJson> {
  const deadline = Date.now() + timeoutMs
  let last: ProjectJson | null = null
  for (;;) {
    try {
      last = readProject(recordingsDir, id)
      if (pred(last)) return last
    } catch {
      /* mid-write */
    }
    if (Date.now() > deadline) {
      throw new Error('project.json never matched; last seen: ' + JSON.stringify(last, null, 1).slice(0, 2000))
    }
    await sleep(150)
  }
}

/** Waits for the autosave of the current editor state and returns it. */
export async function flushedProject(recordingsDir: string, id: string): Promise<ProjectJson> {
  await sleep(1100)
  return readProject(recordingsDir, id)
}
