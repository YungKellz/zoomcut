import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  launch,
  projectIds,
  restoreUserSettings,
  sleep,
  useEnglish,
  waitForBar,
  type Harness
} from './adv-helpers'

/** Recording lifecycle: cancelling, very short takes, two in a row, deleting, language. */
let h: Harness

test.beforeAll(async () => {
  h = await launch('recording')
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

async function backHome(): Promise<void> {
  if (await h.win.locator('.editor').count()) {
    await h.win.click('.editor-top button:has-text("Recordings")')
  }
  await h.win.waitForSelector('.home')
  await sleep(500)
}

test('language switches back and forth without losing labels', async () => {
  await h.win.selectOption('.lang-select select', 'ru')
  await h.win.waitForSelector('button:has-text("Начать запись")')
  const ruLabels = await h.win.locator('.card-head h2').allTextContents()
  await h.win.screenshot({ path: join(h.shotsDir, 'home-ru.png') })
  await h.win.selectOption('.lang-select select', 'en')
  await h.win.waitForSelector('button:has-text("Start recording")')
  const enLabels = await h.win.locator('.card-head h2').allTextContents()
  console.log('[i18n] ru:', JSON.stringify(ruLabels), 'en:', JSON.stringify(enLabels))
  expect(ruLabels.join()).not.toBe(enLabels.join())
  // nothing must fall back to a raw key
  expect(enLabels.join()).not.toMatch(/\w+\.\w+/)
  expect(ruLabels.join()).not.toMatch(/\w+\.\w+/)
})

/** Stops / discards whatever is still running and wipes the recordings folder. */
async function recover(_bar: import('@playwright/test').Page): Promise<void> {
  const alive = (): boolean => h.app.windows().some((w) => w.url().includes('#bar'))
  if (alive()) {
    await h.win.evaluate(() => (window as unknown as { zc: { bar: { cancel(): Promise<void> } } }).zc.bar.cancel()).catch(() => undefined)
    await sleep(3000)
  }
  if (alive()) {
    await h.win.evaluate(() => (window as unknown as { zc: { bar: { stop(): Promise<void> } } }).zc.bar.stop()).catch(() => undefined)
    const editor = await h.win
      .waitForSelector('.editor', { timeout: 180_000 })
      .then(() => true)
      .catch(() => false)
    if (editor) await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 }).catch(() => undefined)
  }
  await backHome().catch(() => undefined)
  for (const d of projectIds(h.recordingsDir)) {
    try {
      rmSync(join(h.recordingsDir, d), { recursive: true, force: true })
    } catch {
      /* still held by the app */
    }
  }
  await sleep(300)
}

async function barReport(bar: import('@playwright/test').Page, tag: string): Promise<{ label: string; live: boolean; stopDisabled: boolean }> {
  const alive = h.app.windows().some((w) => w.url().includes('#bar'))
  if (!alive) {
    console.log(`[${tag}] the bar window is gone`)
    return { label: '(closed)', live: false, stopDisabled: false }
  }
  const label = (await bar.textContent('.bar-label').catch(() => '')) ?? ''
  const live = (await bar.locator('.bar-dot-live').count().catch(() => 0)) > 0
  const stopDisabled = await bar.locator('.bar-stop').isDisabled().catch(() => false)
  console.log(`[${tag}] bar label ${JSON.stringify(label)} live=${live} stopDisabled=${stopDisabled}`)
  return { label, live, stopDisabled }
}

test('discarding from the bar during the countdown leaves no project', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-cancel')
  await bar.click('.bar-cancel') // the earliest moment a user can hit Discard
  await sleep(6000) // the countdown is 3.2 s – by now the capture would be running
  const state = await barReport(bar, 'cancel countdown')
  const ids = projectIds(h.recordingsDir)
  const overlay = await h.win.evaluate(() => document.querySelector('.overlay-card p')?.textContent ?? '(no overlay)')
  const windowVisible = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  console.log('[cancel countdown] project dirs:', JSON.stringify(ids), '| main window says:', overlay, '| visible:', windowVisible)
  await recover(bar)
  expect(state.live, 'Discard during the countdown must not leave the app recording').toBe(false)
  expect(ids, 'a discarded recording must not leave a folder behind').toEqual([])
  expect(windowVisible, 'the main window must come back after discarding').toBe(true)
})

test('pressing Stop 700 ms into the countdown actually stops', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-stop')
  await sleep(700) // how wide is the dead window at the start of the countdown?
  await bar.click('.bar-stop')
  await sleep(6000)
  const state = await barReport(bar, 'stop countdown +700ms')
  console.log('[stop countdown +700ms] project dirs:', JSON.stringify(projectIds(h.recordingsDir)))
  await recover(bar)
  expect(state.live, 'Stop was ignored and the capture kept running').toBe(false)
})

test('pressing Stop 2.5 s into the countdown (just before capture starts) stops', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-stop')
  await sleep(2500) // still inside the 3.2 s countdown, long after the session exists
  const before = await barReport(bar, 'stop countdown +2.5s (before click)')
  await bar.click('.bar-stop')
  await sleep(500)
  await barReport(bar, 'stop countdown +2.5s (300 ms after click)')
  await sleep(6000)
  const state = await barReport(bar, 'stop countdown +2.5s (6 s after click)')
  console.log('[stop countdown +2.5s] project dirs:', JSON.stringify(projectIds(h.recordingsDir)))
  await recover(bar)
  expect(before.live, 'sanity: the countdown was still running when Stop was pressed').toBe(false)
  expect(state.live, 'Stop was ignored and the capture kept running').toBe(false)
})

test('discarding from the bar while recording leaves no project', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(2000)
  await bar.click('.bar-cancel')
  await sleep(5000)
  const ids = projectIds(h.recordingsDir)
  console.log('[cancel recording] project dirs:', JSON.stringify(ids))
  await h.win.waitForSelector('.home', { timeout: 30_000 })
  await h.win.screenshot({ path: join(h.shotsDir, 'after-cancel-recording.png') })
  expect(ids, 'a discarded recording must not leave a folder behind').toEqual([])
  await expect(h.win.locator('.project-list .project-row')).toHaveCount(0)
})

test('a sub-second recording still produces a usable project', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await bar.click('.bar-stop')

  const opened = await h.win
    .waitForSelector('.editor', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  if (!opened) {
    const err = await h.win.locator('.error-box').textContent().catch(() => null)
    await h.win.screenshot({ path: join(h.shotsDir, 'short-recording-failed.png') })
    console.log('[short recording] editor never opened; error box:', err)
  }
  expect(opened, 'a recording stopped immediately must not break the app').toBe(true)
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  const info = (await h.win.textContent('.editor-top-info')) ?? ''
  console.log('[short recording] editor info:', info.trim())
  await h.win.screenshot({ path: join(h.shotsDir, 'short-recording-editor.png') })

  const ids = projectIds(h.recordingsDir)
  expect(ids).toHaveLength(1)
  expect(existsSync(join(h.recordingsDir, ids[0], 'source.mp4'))).toBe(true)
  expect(existsSync(join(h.recordingsDir, ids[0], 'raw.webm'))).toBe(false)
  expect(existsSync(join(h.recordingsDir, ids[0], 'raw.mp4'))).toBe(false)

  // the editor must survive the usual actions on a tiny clip
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('z')
  await h.win.keyboard.press('t')
  await expect(h.win.locator('.region.zoom')).toHaveCount(1)
  await expect(h.win.locator('.region.text')).toHaveCount(1)
  await h.win.click('.preview-controls .btn >> nth=1')
  await sleep(2500)
  expect(h.errors.join(' | ')).not.toMatch(/Uncaught|TypeError/)
  await backHome()
})

test('two recordings in a row both show up on Home', async () => {
  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(3000)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.editor', { timeout: 120_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  await backHome()

  const ids = projectIds(h.recordingsDir)
  console.log('[two recordings] dirs:', JSON.stringify(ids))
  expect(ids).toHaveLength(2)
  await expect(h.win.locator('.project-list .project-row')).toHaveCount(2)
  const names = await h.win.locator('.project-name').allTextContents()
  console.log('[two recordings] names:', JSON.stringify(names))
  await h.win.screenshot({ path: join(h.shotsDir, 'home-two-projects.png') })
})

test('deleting a project from Home removes it from the list and from disk', async () => {
  const before = projectIds(h.recordingsDir)
  expect(before.length).toBeGreaterThan(0)
  h.win.on('dialog', (d) => void d.accept())
  await h.win.locator('.project-row .btn-ghost.danger').first().click()
  await h.win.waitForFunction((n) => document.querySelectorAll('.project-row').length === n, before.length - 1, {
    timeout: 20_000
  })
  await sleep(1500)
  const after = projectIds(h.recordingsDir)
  console.log('[delete] before', JSON.stringify(before), 'after', JSON.stringify(after))
  await h.win.screenshot({ path: join(h.shotsDir, 'after-delete.png') })
  expect(after.length).toBe(before.length - 1)
})

test('deleting a project right after an edit does not resurrect it', async () => {
  const ids = projectIds(h.recordingsDir)
  expect(ids.length).toBeGreaterThan(0)
  const victim = ids[0]
  await h.win.click('.project-open')
  await h.win.waitForSelector('.editor', { timeout: 60_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })
  // an edit schedules an autosave 700 ms later; leave and delete before it fires
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('z')
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  await h.win.evaluate(
    (pid) => (window as unknown as { zc: { projects: { remove(id: string): Promise<void> } } }).zc.projects.remove(pid),
    victim
  )
  await sleep(3000)
  const left = projectIds(h.recordingsDir)
  const files = existsSync(join(h.recordingsDir, victim)) ? readdirSync(join(h.recordingsDir, victim)) : []
  console.log('[delete race] dirs left:', JSON.stringify(left), '| contents of the deleted one:', JSON.stringify(files))

  if (left.includes(victim)) {
    // what does the leftover look like to the user?
    const listed = await h.win.evaluate(() =>
      (window as unknown as { zc: { projects: { list(): Promise<Array<{ id: string }>> } } }).zc.projects.list()
    )
    console.log('[delete race] Home still lists:', JSON.stringify(listed.map((p) => p.id)))
    await h.win.click('.project-open')
    const opened = await h.win
      .waitForSelector('.editor', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    await sleep(5000)
    const stuck = (await h.win.locator('.preview-loading').count()) > 0
    console.log('[delete race] the leftover opens:', opened, '| preview stuck on "Loading video…" after 5 s:', stuck)
    await h.win.screenshot({ path: join(h.shotsDir, 'zombie-project.png') }).catch(() => undefined)
  }
  expect(left, 'a deleted project came back because a queued autosave rewrote it').not.toContain(victim)
})

test('no unexpected renderer errors during the recording scenarios', async () => {
  console.log('[console errors]', JSON.stringify(h.errors, null, 1))
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
