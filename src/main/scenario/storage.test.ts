import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Scenario, ScenarioAction } from '@shared/types'

// storage.ts only asks Electron's `app` for the default userData folder. These tests point
// ZOOMCUT_SCENARIOS_DIR at a temp folder instead, so a stub is enough - the real module needs the
// Electron binary, which a unit test must not depend on.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { deleteScenario, listScenarios, loadScenario, saveScenario, scenarioDir } from './storage'

const NO_MODS = { ctrl: false, shift: false, alt: false, meta: false }

function click(id: string): ScenarioAction {
  return { id, kind: 'click', at: 1, x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null, durationMs: 1000, pauseMs: 1500 }
}

function scenario(id: string, actions: ScenarioAction[] = [click('a')]): Scenario {
  return {
    version: 2,
    id,
    name: `Scenario ${id}`,
    createdAt: 100,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    actions,
    durationMs: 12_345,
    dir: scenarioDir(id)
  }
}

let root = ''

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'zoomcut-scenarios-test-'))
  process.env['ZOOMCUT_SCENARIOS_DIR'] = root
})

afterEach(async () => {
  delete process.env['ZOOMCUT_SCENARIOS_DIR']
  await fsp.rm(root, { recursive: true, force: true })
})

async function writeRaw(id: string, json: unknown): Promise<void> {
  await fsp.mkdir(scenarioDir(id), { recursive: true })
  await fsp.writeFile(join(scenarioDir(id), 'scenario.json'), JSON.stringify(json), 'utf8')
}

async function exists(path: string): Promise<boolean> {
  return fsp.access(path).then(
    () => true,
    () => false
  )
}

// what a build before sequential timing wrote: version 1, absolute `at`, per-kind durations
function version1File(): Record<string, unknown> {
  const base = { x: 1, y: 2, path: [], modifiers: NO_MODS, shot: null }
  return {
    version: 1,
    id: 'old',
    name: 'Old one',
    createdAt: 5,
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    durationMs: 9999,
    dir: 'C:/somewhere/else',
    actions: [
      { ...base, id: 'd', kind: 'drag', at: 4000, toX: 9, toY: 9, dragPath: [], durationMs: 300 },
      { ...base, id: 'c', kind: 'click', at: 9000 }
    ]
  }
}

describe('scenario storage: version migration', () => {
  it('loads a version 1 file as version 2 with the default timing', async () => {
    await writeRaw('old', version1File())
    const loaded = await loadScenario('old')
    expect(loaded.version).toBe(2)
    expect(loaded.dir).toBe(scenarioDir('old'))
    expect(loaded.name).toBe('Old one')
    expect(loaded.actions.map((a) => [a.durationMs, a.pauseMs])).toEqual([
      [1500, 1500],
      [1000, 1500]
    ])
    expect(loaded.actions.map((a) => a.at)).toEqual([4000, 9000])
  })

  it('lists a version 1 file with its replay length: the sum of the default durations and pauses', async () => {
    await writeRaw('old', version1File())
    await writeRaw('new', scenario('new', [click('a'), click('b')]))
    const list = await listScenarios()
    expect(list.find((s) => s.id === 'old')).toMatchObject({ name: 'Old one', actions: 2, durationMs: 1500 + 1500 + 1000 + 1500 })
    expect(list.find((s) => s.id === 'new')).toMatchObject({ actions: 2, durationMs: 2 * (1000 + 1500) })
  })

  it('skips folders that are not scenarios and files that are not scenarios', async () => {
    await fsp.mkdir(join(root, 'empty-folder'), { recursive: true })
    await writeRaw('garbage', { hello: 'world' })
    await writeRaw('good', scenario('good'))
    expect((await listScenarios()).map((s) => s.id)).toEqual(['good'])
  })

  it('saves in the current format, with unusable timing replaced and `dir` recomputed from the id', async () => {
    await fsp.mkdir(scenarioDir('s1'), { recursive: true })
    const messy = { ...scenario('s1', [{ ...click('a'), pauseMs: Number.NaN }]), dir: 'C:/not/my/folder' }
    await saveScenario(messy)
    const onDisk = JSON.parse(await fsp.readFile(join(scenarioDir('s1'), 'scenario.json'), 'utf8')) as Scenario
    expect(onDisk.version).toBe(2)
    expect(onDisk.dir).toBe(scenarioDir('s1'))
    expect(onDisk.actions[0].pauseMs).toBe(1500)
    expect(onDisk.durationMs).toBe(12_345) // the recorded capture length is carried along untouched
  })

  it('round-trips a saved scenario', async () => {
    await fsp.mkdir(scenarioDir('s2'), { recursive: true })
    const original = scenario('s2', [{ ...click('a'), durationMs: 2000, pauseMs: 250 }])
    await saveScenario(original)
    expect(await loadScenario('s2')).toEqual(original)
  })
})

describe('scenario storage: save and delete share one queue per scenario', () => {
  it('does not resurrect a scenario whose folder is gone', async () => {
    await saveScenario(scenario('ghost'))
    expect(await exists(scenarioDir('ghost'))).toBe(false)
  })

  it('lets an in-flight save finish, then deletes, and a save queued after the delete does not bring it back', async () => {
    await fsp.mkdir(scenarioDir('s3'), { recursive: true })
    const first = saveScenario(scenario('s3'))
    const removal = deleteScenario('s3')
    const late = saveScenario({ ...scenario('s3'), name: 'late autosave' })
    await expect(Promise.all([first, removal, late])).resolves.toBeDefined()
    expect(await exists(scenarioDir('s3'))).toBe(false)
  })

  it('deletes the whole folder, shots included', async () => {
    await fsp.mkdir(join(scenarioDir('s4'), 'shots'), { recursive: true })
    await fsp.writeFile(join(scenarioDir('s4'), 'shots', 'shot_0.png'), 'x')
    await saveScenario(scenario('s4'))
    await deleteScenario('s4')
    expect(await exists(scenarioDir('s4'))).toBe(false)
  })

  it('treats deleting something that is not there as success', async () => {
    await expect(deleteScenario('never-existed')).resolves.toBeUndefined()
  })

  it('keeps working for the same id after a delete (a new scenario may reuse the queue)', async () => {
    await fsp.mkdir(scenarioDir('s5'), { recursive: true })
    await saveScenario(scenario('s5'))
    await deleteScenario('s5')
    await fsp.mkdir(scenarioDir('s5'), { recursive: true })
    await saveScenario({ ...scenario('s5'), name: 'again' })
    expect((await loadScenario('s5')).name).toBe('again')
  })
})
