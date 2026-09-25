import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Composition, CompositionSummary } from '@shared/types'
import { COMPOSITION_BACKGROUND, DEFAULT_EXPORT_SETTINGS, DEFAULT_GIF_SETTINGS } from '@shared/defaults'

/** ZOOMCUT_COMPOSITIONS_DIR keeps test compositions out of the real userData folder, same
 * pattern as ZOOMCUT_SCENARIOS_DIR. Each composition is one `<id>.json` file: it only
 * references projects by id, so it owns no media of its own. */
export function compositionsRoot(): string {
  return process.env['ZOOMCUT_COMPOSITIONS_DIR'] || join(app.getPath('userData'), 'compositions')
}

// ids come from newCompositionId() (a timestamp, optionally "-N"): never accept anything else
// from the renderer, so a crafted id cannot walk join() outside the compositions folder
const COMPOSITION_ID_RE = /^[0-9A-Za-z_-]+$/
export function assertValidCompositionId(id: string): void {
  if (typeof id !== 'string' || !COMPOSITION_ID_RE.test(id)) throw new Error('Invalid composition id')
}

function compositionFile(id: string): string {
  return join(compositionsRoot(), `${id}.json`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

async function newCompositionId(): Promise<string> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  let id = base
  let n = 2
  while (await exists(compositionFile(id))) id = `${base}-${n++}`
  return id
}

function withDefaults(raw: Composition): Composition {
  return {
    ...raw,
    items: raw.items ?? [],
    size: raw.size ?? null,
    background: raw.background || COMPOSITION_BACKGROUND,
    export: {
      ...DEFAULT_EXPORT_SETTINGS,
      ...(raw.export ?? {}),
      gif: { ...DEFAULT_GIF_SETTINGS, ...(raw.export?.gif ?? {}) }
    }
  }
}

export async function createComposition(name: string, folder: string): Promise<Composition> {
  await fsp.mkdir(compositionsRoot(), { recursive: true })
  const id = await newCompositionId()
  const now = Date.now()
  const composition: Composition = {
    version: 1,
    id,
    name: name.trim() || id,
    createdAt: now,
    updatedAt: now,
    items: [],
    size: null,
    background: COMPOSITION_BACKGROUND,
    export: { ...DEFAULT_EXPORT_SETTINGS, gif: { ...DEFAULT_GIF_SETTINGS }, fileName: '', folder }
  }
  await fsp.writeFile(compositionFile(id), JSON.stringify(composition), 'utf8')
  return composition
}

const saveQueues = new Map<string, Promise<void>>()

/** Writes are serialized per id, same reasoning as project autosave (../storage.ts). */
export function saveComposition(composition: Composition): Promise<void> {
  const previous = saveQueues.get(composition.id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => saveCompositionNow(composition))
  saveQueues.set(composition.id, next)
  return next
}

async function saveCompositionNow(composition: Composition): Promise<void> {
  const target = compositionFile(composition.id)
  // a composition whose file is gone was deleted: a late autosave must not resurrect it
  if (!(await exists(target))) return
  const tmp = target + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ ...composition, updatedAt: Date.now() }), 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fsp.rename(tmp, target)
      return
    } catch {
      if (!(await exists(target))) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => undefined)
}

export async function loadComposition(id: string): Promise<Composition> {
  const raw = JSON.parse(await fsp.readFile(compositionFile(id), 'utf8')) as Composition
  return withDefaults({ ...raw, id })
}

export async function listCompositions(): Promise<CompositionSummary[]> {
  let names: string[]
  try {
    names = await fsp.readdir(compositionsRoot())
  } catch {
    return []
  }
  const out: CompositionSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!COMPOSITION_ID_RE.test(id)) continue
    try {
      const raw = JSON.parse(await fsp.readFile(compositionFile(id), 'utf8')) as Composition
      out.push({ id, name: raw.name, createdAt: raw.createdAt, updatedAt: raw.updatedAt, items: raw.items?.length ?? 0 })
    } catch {
      // unreadable or half-written file - skip
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function deleteComposition(id: string): Promise<void> {
  await fsp.rm(compositionFile(id), { force: true })
}
