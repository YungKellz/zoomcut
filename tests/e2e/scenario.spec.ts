import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch, projectIds, readProject, restoreUserSettings, sleep, useEnglish, waitForBar, type Harness } from './adv-helpers'

/**
 * Scenario recorder: capture real input (injected through the app's own test-only helper over a
 * test window the app opens itself), review the actions, replay them while recording, abort a replay.
 * Every injected click lands on the app's e2e target window, which is checked to be where we expect.
 */
let h: Harness
let target: Page
let content = { x: 0, y: 0, width: 0, height: 0 }
let capturedText = ''

type ZcWindow = Window & {
  zc: {
    e2e: { openTarget(b: { x: number; y: number; width: number; height: number }): Promise<void>; injectSteps(steps: unknown[]): Promise<void> }
    scenario: {
      getState(): Promise<{ phase: string; actions: number }>
      stop(): Promise<void>
      list(): Promise<Array<{ id: string; actions: number; durationMs: number }>>
      load(id: string): Promise<{ id: string; actions: Array<{ kind: string; at: number; text?: string }> }>
    }
    displays: { list(): Promise<Array<{ id: number; primary: boolean }>> }
  }
}

async function elementCenter(selector: string): Promise<{ x: number; y: number }> {
  const local = await target.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  return { x: Math.round(content.x + local.x), y: Math.round(content.y + local.y) }
}

function click(t: number, p: { x: number; y: number }): unknown[] {
  return [
    { t: t - 120, op: 'move', x: p.x, y: p.y },
    { t, op: 'down', button: 'left' },
    { t: t + 70, op: 'up', button: 'left' }
  ]
}

/** Types letters through real scancodes so the capture sees ordinary keystrokes. */
function typeKeys(t: number, keys: Array<{ vk: number; scan: number }>): unknown[] {
  const out: unknown[] = []
  keys.forEach((k, i) => {
    out.push({ t: t + i * 160, op: 'key', vk: k.vk, scan: k.scan, extended: false, down: true })
    out.push({ t: t + i * 160 + 60, op: 'key', vk: k.vk, scan: k.scan, extended: false, down: false })
  })
  return out
}

async function waitForCapture(phase: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await h.win.evaluate(() => (window as unknown as ZcWindow).zc.scenario.getState())
    if (state.phase === phase) return
    if (Date.now() > deadline) throw new Error(`scenario capture never reached ${phase}, last ${state.phase}`)
    await sleep(100)
  }
}

test.beforeAll(async () => {
  h = await launch('scenario')
  await useEnglish(h.win)
  await h.win.evaluate(() => (window as unknown as ZcWindow).zc.e2e.openTarget({ x: 60, y: 60, width: 720, height: 520 }))
  for (let i = 0; i < 100 && !target; i++) {
    target = h.app.windows().find((w) => w.url().includes('#target'))!
    if (!target) await sleep(100)
  }
  expect(target, 'the e2e target window must open').toBeTruthy()
  await target.waitForSelector('#hit')
  content = (await h.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#target'))
    return w ? w.getContentBounds() : { x: 0, y: 0, width: 0, height: 0 }
  })) as typeof content
  console.log('[target] content bounds', JSON.stringify(content))
  // never inject input unless the window really sits where we expect it
  expect(content.width).toBeGreaterThan(600)
  expect(content.x).toBeGreaterThanOrEqual(0)
  expect(content.y).toBeGreaterThanOrEqual(0)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

test('captures clicks, typing and scrolling into a reviewable scenario', async () => {
  await h.win.click('.btn-scenario')
  const bar = await waitForBar(h.app)
  await waitForCapture('capturing', 30_000)
  const hit = await elementCenter('#hit')
  const text = await elementCenter('#text')
  const scroll = await elementCenter('#scroll')
  const steps = [
    ...click(300, hit),
    ...click(1400, hit),
    ...click(2400, text),
    ...typeKeys(2900, [
      { vk: 72, scan: 35 }, // h
      { vk: 73, scan: 23 } // i
    ]),
    { t: 3700, op: 'move', x: scroll.x, y: scroll.y },
    { t: 3900, op: 'wheel', dy: -120, dx: 0 },
    { t: 4000, op: 'wheel', dy: -120, dx: 0 }
  ]
  await h.win.evaluate((s) => (window as unknown as ZcWindow).zc.e2e.injectSteps(s), steps)
  await sleep(600)
  const label = await bar.textContent('.bar-label')
  console.log('[capture] bar label:', label)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.scenario-review', { timeout: 30_000 })

  const kinds = await h.win.locator('.scenario-action').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  console.log('[capture] actions:', JSON.stringify(kinds))
  const expected = ['click', 'click', 'click', 'type', 'scroll']
  if (kinds.length !== expected.length) {
    // the capture hooks the whole machine: any real mouse/keyboard activity during these seconds lands in the scenario
    throw new Error(
      `captured ${kinds.length} actions instead of ${expected.length} (${JSON.stringify(kinds)}): ` +
        'someone used the mouse or keyboard while the capture ran – rerun this spec on an idle machine'
    )
  }
  expect(kinds).toEqual(expected)
  await expect(h.win.locator('.scenario-marker')).toHaveCount(5)
  expect(await h.win.locator('.scenario-action img').count()).toBeGreaterThanOrEqual(3)
  await expect(h.win.locator('.scenario-total')).not.toHaveClass(/over/)

  // the target really received the same input the scenario recorded
  expect(await target.textContent('#count')).toBe('2')
  capturedText = await target.inputValue('#text')
  expect(capturedText.length).toBe(2)
  const list = await h.win.evaluate(() => (window as unknown as ZcWindow).zc.scenario.list())
  expect(list).toHaveLength(1)
  const saved = await h.win.evaluate((id) => (window as unknown as ZcWindow).zc.scenario.load(id), list[0].id)
  expect(saved.actions.find((a) => a.kind === 'type')?.text).toBe(capturedText)
  await h.win.screenshot({ path: join(h.shotsDir, 'scenario-review.png') })
})

test('actions can be deleted and retimed within the limit', async () => {
  const gaps = h.win.locator('.scenario-action-gap')
  await gaps.nth(1).fill('2.5')
  await gaps.nth(1).press('Enter')
  const times = await h.win.locator('.scenario-action-time').evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)))
  console.log('[retime] times after gap edit:', JSON.stringify(times))
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(2.4)
  for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])

  await h.win.locator('.scenario-action').last().locator('.scenario-action-delete').click()
  await expect(h.win.locator('.scenario-action')).toHaveCount(4)
  await expect(h.win.locator('.scenario-marker')).toHaveCount(4)
  await sleep(800)
  const list = await h.win.evaluate(() => (window as unknown as ZcWindow).zc.scenario.list())
  expect(list[0].actions).toBe(4)
})

test('replaying the scenario records a project and drives the target window', async () => {
  await target.reload()
  await target.waitForSelector('#hit')
  expect(await target.textContent('#count')).toBe('0')
  await h.win.click('.btn-replay')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await expect(bar.locator('.bar-label')).toContainText(/Replay/i, { timeout: 15_000 })
  await h.win.waitForSelector('.editor', { timeout: 180_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  expect(await target.textContent('#count')).toBe('2')
  expect(await target.inputValue('#text')).toBe(capturedText)
  const ids = projectIds(h.recordingsDir)
  expect(ids).toHaveLength(1)
  const project = readProject(h.recordingsDir, ids[0]) as unknown as { cursorData: { clicks: unknown[] }; recording: { durationMs: number } }
  console.log('[replay] recorded clicks:', project.cursorData.clicks.length, 'duration', project.recording.durationMs)
  expect(project.cursorData.clicks.length).toBeGreaterThanOrEqual(3)
  expect(project.recording.durationMs).toBeGreaterThan(3000)
  await h.win.screenshot({ path: join(h.shotsDir, 'scenario-editor.png') })
})

test('Escape aborts a replay and discards the recording', async () => {
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  // the scenario is a block on Home and the recording its replay made is listed under it
  await expect(h.win.locator('.scenario-block > .scenario-row')).toHaveCount(1)
  await expect(h.win.locator('.scenario-block .project-row')).toHaveCount(1)
  await h.win.click('.scenario-open')
  await h.win.waitForSelector('.scenario-review')
  await h.win.click('.btn-replay')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(1500)
  await h.win.evaluate(() =>
    (window as unknown as ZcWindow).zc.e2e.injectSteps([
      { t: 0, op: 'key', vk: 27, scan: 1, extended: false, down: true },
      { t: 50, op: 'key', vk: 27, scan: 1, extended: false, down: false }
    ])
  )
  await h.win.waitForSelector('.scenario-notice', { timeout: 30_000 })
  await sleep(2000)
  expect(projectIds(h.recordingsDir), 'an aborted replay must not leave a project').toHaveLength(1)
  const visible = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'ZoomCut' && w.isVisible()))
  expect(visible).toBe(true)
  expect(h.app.windows().some((w) => w.url().includes('#overlay')), 'the overlay window must be closed after an abort').toBe(false)
})

test('a saved scenario can be deleted from Home', async () => {
  await h.win.click('.scenario-back')
  await h.win.waitForSelector('.home')
  const recordingIds = projectIds(h.recordingsDir)
  expect(recordingIds).toHaveLength(1)
  h.win.on('dialog', (d) => void d.accept())
  await h.win.click('.scenario-delete')
  await expect(h.win.locator('.scenario-block')).toHaveCount(0)
  await sleep(500)
  expect(await h.win.evaluate(() => (window as unknown as ZcWindow).zc.scenario.list())).toHaveLength(0)
  // deleting a scenario keeps its recording: still on disk, now a top-level row of the list
  expect(existsSync(join(h.recordingsDir, recordingIds[0], 'project.json'))).toBe(true)
  await expect(h.win.locator('.project-list > .project-row')).toHaveCount(1)
  expect(existsSync(join(h.recordingsDir, 'nothing'))).toBe(false)
})

test('no unexpected renderer errors during the scenario flows', async () => {
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  console.log('[console errors]', JSON.stringify(unexpected, null, 1))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
