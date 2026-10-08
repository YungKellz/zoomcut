import { expect, test, type Locator } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { acceptConfirm, launch, projectIds, readProject, record, restoreUserSettings, sleep, useEnglish, waitForBar, type Harness } from './adv-helpers'

/**
 * Delete / Record again in the editor and the scenario review, and the unified home list
 * (standalone recordings and scenario blocks). The first two tests record the real screen for a few
 * seconds; the rest works on synthesized projects and scenarios (test patterns, no input injected).
 */
let h: Harness
const dialogs: string[] = []

function makeProject(id: string, scenarioId: string | null, createdAt: number): void {
  const dir = join(h.recordingsDir, id)
  mkdirSync(dir, { recursive: true })
  spawnSync(
    String(ffmpegStatic),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'source.mp4')],
    { encoding: 'utf8' }
  )
  if (!existsSync(join(dir, 'source.mp4'))) throw new Error(`could not synthesize ${id}`)
  const project = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    recording: { id, createdAt, dir, videoPath: '', width: 320, height: 180, durationMs: 1000, fps: 10, displayName: 'Synthetic' },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    audio: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    origin: { displayId: 1, audio: null, scenarioId },
    updatedAt: 0
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
}

function makeScenario(id: string, createdAt: number): void {
  const dir = join(h.scenariosDir, id)
  mkdirSync(join(dir, 'shots'), { recursive: true })
  const scenario = {
    version: 1,
    id,
    name: `Synthetic ${id}`,
    createdAt,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions: [
      { id: 'a1', kind: 'click', at: 1000, x: 100, y: 100, path: [], modifiers: { ctrl: false, shift: false, alt: false, meta: false }, shot: null }
    ],
    durationMs: 2000,
    dir
  }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario), 'utf8')
}

async function reloadHome(): Promise<void> {
  await h.win.reload()
  await useEnglish(h.win)
}

test.beforeAll(async () => {
  h = await launch('lifecycle')
  await useEnglish(h.win)
  h.win.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.accept()
  })
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

test('Delete in the editor removes the recording and returns to Home', async () => {
  await record(h, 3000)
  const [id] = projectIds(h.recordingsDir)
  expect(id).toBeTruthy()
  await h.win.click('.editor-top-file button:has-text("Delete")')
  await acceptConfirm(h.win)
  await h.win.waitForSelector('.home')
  expect(projectIds(h.recordingsDir)).toEqual([])
  await expect(h.win.locator('.project-list > *')).toHaveCount(0)
  await expect(h.win.locator('.home p:has-text("Nothing recorded yet.")')).toHaveCount(1)
})

test('Record again deletes the recording and starts a new one under the same conditions', async () => {
  await record(h, 3000)
  const [oldId] = projectIds(h.recordingsDir)
  const before = readProject(h.recordingsDir, oldId).origin
  expect(before, 'a new recording must remember how it was made').toBeTruthy()
  expect(before!.scenarioId).toBeNull()

  await h.win.click('.editor-top-file button:has-text("Record again")')
  await acceptConfirm(h.win)
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(2500)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.editor', { timeout: 180_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  const ids = projectIds(h.recordingsDir)
  expect(ids).toHaveLength(1)
  expect(ids[0]).not.toBe(oldId)
  expect(existsSync(join(h.recordingsDir, oldId))).toBe(false)
  expect(readProject(h.recordingsDir, ids[0]).origin).toEqual(before)
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  await expect(h.win.locator('.project-list .project-row')).toHaveCount(1)
})

test('a recording of a deleted scenario is a standalone row, and Record again refuses to delete it', async () => {
  makeProject('orphanRec', 'scenario-that-does-not-exist', Date.now() + 1000)
  await reloadHome()
  await expect(h.win.locator('.scenario-block')).toHaveCount(0)
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic orphanRec")')).toHaveCount(1)

  await h.win.click('.project-open:has-text("Synthetic orphanRec")')
  await h.win.waitForSelector('.editor .preview-canvas')
  const before = dialogs.length
  await h.win.click('.editor-top-file button:has-text("Record again")')
  await expect.poll(() => dialogs.length).toBeGreaterThan(before)
  expect(dialogs[dialogs.length - 1]).toContain('no longer exists')
  // nothing was deleted and nothing started: still in the editor, folder intact
  expect(existsSync(join(h.recordingsDir, 'orphanRec', 'project.json'))).toBe(true)
  await expect(h.win.locator('.editor')).toHaveCount(1)
  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
})

test('a scenario block nests its recordings and deleting the scenario keeps them', async () => {
  makeScenario('synthScenario', Date.now() + 2000)
  makeProject('childRec', 'synthScenario', Date.now() + 3000)
  await reloadHome()
  const block = h.win.locator('.scenario-block:has-text("Synthetic synthScenario")')
  await expect(block).toHaveCount(1)
  await expect(block.locator('.project-row')).toHaveCount(1)
  await expect(block.locator('.project-row')).toContainText('Synthetic childRec')
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic childRec")')).toHaveCount(0)

  await block.locator('.scenario-delete').click()
  await acceptConfirm(h.win)
  await expect(h.win.locator('.scenario-block')).toHaveCount(0)
  await expect(h.win.locator('.project-list > .project-row:has-text("Synthetic childRec")')).toHaveCount(1)
  expect(existsSync(join(h.scenariosDir, 'synthScenario'))).toBe(false)
  expect(existsSync(join(h.recordingsDir, 'childRec', 'project.json'))).toBe(true)
})

test('Record again in the scenario review replaces the scenario and starts a new capture', async () => {
  makeScenario('synthScenario2', Date.now() + 4000)
  await reloadHome()
  await h.win.click('.scenario-open:has-text("Synthetic synthScenario2")')
  await h.win.waitForSelector('.scenario-review')
  await h.win.click('.editor-top-file button:has-text("Record again")')
  await acceptConfirm(h.win)
  // Home takes the queued capture over: the bar counts down for a scenario capture
  const bar = await waitForBar(h.app)
  await expect(bar.locator('.bar-label')).toContainText(/actions/i, { timeout: 15_000 })
  expect(existsSync(join(h.scenariosDir, 'synthScenario2'))).toBe(false)
  await bar.click('.bar-cancel')
  await h.win.waitForSelector('.home .btn-scenario:not([disabled])', { timeout: 30_000 })
  await expect(h.win.locator('.scenario-block:has-text("synthScenario2")')).toHaveCount(0)
})

test('Home: equal columns that scroll on their own, a footer row, blocks that read as buttons', async () => {
  const { win } = h
  makeScenario('layoutScenario', Date.now() + 5000)
  makeProject('layoutChild', 'layoutScenario', Date.now() + 6000)
  for (let i = 0; i < 16; i++) makeProject(`layoutRec${i}`, null, Date.now() + 7000 + i)
  await reloadHome()
  // the list loads after the screen itself: wait for the seeded rows before measuring
  await expect(win.locator('.scenario-block:has-text("layoutScenario") .project-row')).toHaveCount(1)
  await expect.poll(() => win.locator('.project-list > .project-row').count()).toBeGreaterThanOrEqual(16)

  const m = await win.evaluate(() => {
    const rect = (sel: string): { y: number; h: number; bottom: number } => {
      const r = document.querySelector(sel)!.getBoundingClientRect()
      return { y: r.y, h: r.height, bottom: r.bottom }
    }
    const home = document.querySelector('.home')!
    const cols = Array.from(document.querySelectorAll('.home-col')).map((c) => ({
      w: c.getBoundingClientRect().width,
      client: c.clientHeight,
      scroll: c.scrollHeight,
      overflowY: getComputedStyle(c).overflowY
    }))
    return {
      page: { client: home.clientHeight, scroll: home.scrollHeight },
      main: rect('.home-main'),
      footer: rect('.home-footer'),
      footerText: document.querySelector('.home-footer')!.textContent ?? '',
      footerHasLanguage: !!document.querySelector('.home-footer .lang-select select'),
      footerHasFolder: !!document.querySelector('.home-footer .folder-link'),
      headerHasLanguage: document.querySelectorAll('.home-header .lang-select').length,
      cols,
      rec: rect('.btn-record'),
      scen: rect('.btn-scenario'),
      recFont: getComputedStyle(document.querySelector('.btn-record')!).fontSize,
      scenFont: getComputedStyle(document.querySelector('.btn-scenario')!).fontSize
    }
  })
  // the page itself never scrolls; the columns split the width evenly and scroll by themselves
  expect(m.page.scroll).toBeLessThanOrEqual(m.page.client)
  expect(m.cols).toHaveLength(2)
  expect(Math.abs(m.cols[0].w - m.cols[1].w)).toBeLessThan(1.5)
  expect(m.cols.map((c) => c.overflowY)).toEqual(['auto', 'auto'])
  expect(m.cols[1].scroll, 'the list column must be taller than its viewport with 18 rows').toBeGreaterThan(m.cols[1].client)
  // language / version / recordings folder live in one footer row under the columns, not in the header
  expect(m.headerHasLanguage).toBe(0)
  expect(m.footerHasLanguage).toBe(true)
  expect(m.footerHasFolder).toBe(true)
  expect(m.footerText).toMatch(/v\d+\.\d+\.\d+/)
  expect(m.footerText).toContain('Recordings:')
  // the path can be ellipsized on a narrow window: the tooltip always carries it in full
  expect(await win.locator('.home-footer .folder-link').getAttribute('title')).toContain(h.recordingsDir)
  expect(m.footer.y).toBeGreaterThanOrEqual(m.main.bottom - 1)
  expect(m.footer.h).toBeLessThan(60)
  // both start buttons have the same size
  expect(Math.abs(m.rec.h - m.scen.h)).toBeLessThan(0.5)
  expect(m.recFont).toBe(m.scenFont)

  // scrolling the list moves neither the header nor the page
  const headerTop = await win.evaluate(() => document.querySelector('.home-header')!.getBoundingClientRect().y)
  await win.evaluate(() => {
    document.querySelectorAll('.home-col')[1].scrollTop = 99999
  })
  expect(await win.evaluate(() => document.querySelector('.home-header')!.getBoundingClientRect().y)).toBe(headerTop)
  expect(await win.evaluate(() => document.querySelector('.home')!.scrollTop)).toBe(0)
  await win.evaluate(() => {
    document.querySelectorAll('.home-col')[1].scrollTop = 0
  })

  // scenario rows and recording cards read as buttons: pointer cursor, a fill that reacts to hover;
  // recordings and scenarios are blocks of different tints
  const bgOf = (loc: Locator): Promise<string> => loc.evaluate((e) => getComputedStyle(e).backgroundColor)
  for (const loc of [win.locator('.scenario-block > .scenario-row').first(), win.locator('.project-list > .project-row').first()]) {
    const before = await bgOf(loc)
    expect(await loc.evaluate((e) => getComputedStyle(e).cursor)).toBe('pointer')
    await loc.hover()
    await expect.poll(() => bgOf(loc)).not.toBe(before)
    await win.mouse.move(2, 2)
  }
  const block = await bgOf(win.locator('.scenario-block').first())
  const card = await bgOf(win.locator('.project-list > .project-row').first())
  expect(block).not.toBe(card)
  expect(await win.locator('.project-list > .project-row').first().evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).not.toBe('0px')
  await expect(win.locator('.scenario-block .scenario-children .project-row')).toHaveCount(1)

  // audio sources: checkbox, icon and text of one chip share a centre line, the mic list sits on it too
  await win.locator('.audio-check input').first().check()
  const chips = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.audio-check')).map((chip) => {
      const c = chip.getBoundingClientRect()
      const mid = c.top + c.height / 2
      const off = (sel: string): number => {
        const r = chip.querySelector(sel)!.getBoundingClientRect()
        return Math.abs(r.top + r.height / 2 - mid)
      }
      return { h: c.height, input: off('input'), icon: off('svg'), text: off('span') }
    })
  )
  expect(chips).toHaveLength(2)
  for (const c of chips) {
    expect(c.h).toBe(chips[0].h)
    expect(Math.max(c.input, c.icon, c.text)).toBeLessThan(1.5)
  }
  const micOff = await win.evaluate(() => {
    const chip = document.querySelector('.audio-check')!.getBoundingClientRect()
    const sel = document.querySelector('.mic-select')!.getBoundingClientRect()
    return Math.abs(sel.top + sel.height / 2 - (chip.top + chip.height / 2))
  })
  expect(micOff).toBeLessThan(1.5)
  await win.locator('.audio-check input').first().uncheck()
})

test('Home: the whole recording card is the click target, not only its text', async () => {
  const { win } = h
  makeProject('wholeCard', null, Date.now() + 9000)
  await reloadHome()
  const row = win.locator('.project-list > .project-row:has-text("Synthetic wholeCard")')
  await expect(row).toHaveCount(1)
  const box = (await row.boundingBox())!
  // 3 px inside the card: its own padding, left of the open button's text
  await win.mouse.click(box.x + 3, box.y + box.height / 2)
  await win.waitForSelector('.editor', { timeout: 60_000 })
  await reloadHome()
})

test('no unexpected renderer errors during the lifecycle flows', async () => {
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  console.log('[console errors]', JSON.stringify(unexpected, null, 1))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
