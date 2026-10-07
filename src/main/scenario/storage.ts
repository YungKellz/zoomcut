import { app } from 'electron'
import { promises as fsp, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { Scenario, ScenarioSummary } from '@shared/types'
import { migrateScenario, scenarioEnd } from '@shared/scenario'

/** ZOOMCUT_SCENARIOS_DIR lets tests keep scenario captures (scenario.json + shot PNGs) out of
 * the developer's real userData folder - same pattern as ZOOMCUT_RECORDINGS_DIR in ../storage.ts.
 * Either way, ensureDirs() (../storage.ts) creates this directory and registers it as an allowed
 * media root on startup, so scenario shot PNGs are servable through zc-media://. */
export function scenariosRoot(): string {
  return process.env['ZOOMCUT_SCENARIOS_DIR'] || join(app.getPath('userData'), 'scenarios')
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

/** Runs `task` after everything already queued for this scenario id has settled (a failed
 * predecessor does not block it). Saves and the delete share this one queue per id. */
function enqueue(id: string, task: () => Promise<void>): Promise<void> {
  const previous = saveQueues.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  saveQueues.set(id, next)
  // a settled tail is dropped so the map does not collect every id ever touched; a newer tail stays
  const drop = (): void => {
    if (saveQueues.get(id) === next) saveQueues.delete(id)
  }
  next.then(drop, drop)
  return next
}

/** Writes are serialized per scenario id, same reasoning as project autosave (storage.ts). */
export function saveScenario(scenario: Scenario): Promise<void> {
  return enqueue(scenario.id, () => saveScenarioNow(scenario))
}

async function saveScenarioNow(scenario: Scenario): Promise<void> {
  // Never trust `dir` as sent by the renderer - always recompute it from the (already
  // ID-validated, at the IPC boundary) id, and never mkdir whatever path the caller supplied.
  const dir = scenarioDir(scenario.id)
  // a scenario whose folder is gone was deleted: a late autosave must not resurrect it
  // (same rule as saveProjectNow in ../storage.ts)
  if (!(await exists(dir))) return
  // always written in the current format, with unusable timing replaced by defaults
  const toSave: Scenario = { ...migrateScenario(scenario), dir }
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
  // an older file (version 1, absolute timing) comes back already migrated to the sequential model
  const migrated = migrateScenario(JSON.parse(await fsp.readFile(scenarioFile(id), 'utf8')))
  return { ...migrated, dir: scenarioDir(id) }
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
      const raw = migrateScenario(JSON.parse(await fsp.readFile(join(scenariosRoot(), entry.name, 'scenario.json'), 'utf8')))
      // the folder name is the source of truth for the id, not whatever the JSON says inside -
      // a renamed folder must still load by its new name. durationMs here is the replay length
      // of the (migrated, possibly edited) actions, not the frozen recorded capture length -
      // matches what the review screen itself shows for "length" (see Scenario.durationMs's own
      // doc comment).
      out.push({ id: entry.name, name: raw.name, createdAt: raw.createdAt, actions: raw.actions.length, durationMs: scenarioEnd(raw.actions) })
    } catch {
      // not a scenario folder, or one that never finished saving - skip
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** Runs on the same per-id queue as the saves: a save already in flight finishes first, and one
 * queued after the delete finds the folder gone and skips - no ENOENT, no resurrection. */
export function deleteScenario(id: string): Promise<void> {
  return enqueue(id, () => fsp.rm(scenarioDir(id), { recursive: true, force: true }))
}
