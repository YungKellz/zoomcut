import { app } from 'electron'
import { promises as fsp, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { Scenario, ScenarioSummary } from '@shared/types'

/** userData/scenarios is already covered by the media protocol's allowed roots (the whole
 * userData tree is registered in src/main/storage.ts's ensureDirs()), so scenario shot PNGs
 * are servable through zc-media:// with no extra setup. */
export function scenariosRoot(): string {
  return join(app.getPath('userData'), 'scenarios')
}

export function scenarioDir(id: string): string {
  return join(scenariosRoot(), id)
}

function scenarioFile(id: string): string {
  return join(scenarioDir(id), 'scenario.json')
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

export async function newScenarioId(): Promise<string> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  let id = base
  let n = 2
  while (await exists(scenarioDir(id))) {
    id = `${base}-${n++}`
  }
  return id
}

export function defaultScenarioName(createdAt: number): string {
  const d = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Scenario ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const saveQueues = new Map<string, Promise<void>>()
/** Guards against a pathological renderer payload; a real scenario (JSON + a few thousand
 * path points) is nowhere near this. */
const MAX_SCENARIO_JSON_BYTES = 20 * 1024 * 1024

/** Writes are serialized per scenario id, same reasoning as project autosave (storage.ts). */
export function saveScenario(scenario: Scenario): Promise<void> {
  const previous = saveQueues.get(scenario.id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => saveScenarioNow(scenario))
  saveQueues.set(scenario.id, next)
  return next
}

async function saveScenarioNow(scenario: Scenario): Promise<void> {
  // Never trust `dir` as sent by the renderer - always recompute it from the (already
  // ID-validated, at the IPC boundary) id, and never mkdir whatever path the caller supplied.
  const dir = scenarioDir(scenario.id)
  const toSave: Scenario = { ...scenario, dir }
  const json = JSON.stringify(toSave)
  if (Buffer.byteLength(json, 'utf8') > MAX_SCENARIO_JSON_BYTES) {
    throw new Error('Scenario is too large to save')
  }
  await fsp.mkdir(dir, { recursive: true })
  const target = scenarioFile(scenario.id)
  const tmp = target + '.tmp'
  await fsp.writeFile(tmp, json, 'utf8')
  await fsp.rename(tmp, target)
}

export async function loadScenario(id: string): Promise<Scenario> {
  const raw = JSON.parse(await fsp.readFile(scenarioFile(id), 'utf8')) as Scenario
  return { ...raw, dir: scenarioDir(id) }
}

export async function listScenarios(): Promise<ScenarioSummary[]> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(scenariosRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const out: ScenarioSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = JSON.parse(await fsp.readFile(join(scenariosRoot(), entry.name, 'scenario.json'), 'utf8')) as Scenario
      // the folder name is the source of truth for the id, not whatever the JSON says inside -
      // a renamed folder must still load by its new name
      out.push({ id: entry.name, name: raw.name, createdAt: raw.createdAt, actions: raw.actions.length, durationMs: raw.durationMs })
    } catch {
      // not a scenario folder, or one that never finished saving - skip
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function deleteScenario(id: string): Promise<void> {
  await fsp.rm(scenarioDir(id), { recursive: true, force: true })
}
