import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, Project, ProjectSummary } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE, DEFAULT_GIF_SETTINGS } from '@shared/defaults'
import { allowMediaRoot } from './mediaProtocol'
import { scenariosRoot } from './scenario/storage'
import { musicDir } from './audio/musicLibrary'
// recordingsRoot/projectDir/exists live in the leaf module media/projectPaths.ts (not defined
// here) so audio/musicLibrary.ts and media/audioImport.ts can both depend on them without
// recreating storage.ts -> musicLibrary.ts -> audioImport.ts -> storage.ts. Re-exported below so
// every existing `import { projectDir } from '../storage'` elsewhere keeps working unchanged.
import { exists, projectDir, recordingsRoot } from './media/projectPaths'

export { exists, projectDir, recordingsRoot }

const DEFAULT_SETTINGS: AppSettings = {
  lastExportFolder: null,
  lastDisplayId: null,
  language: 'system',
  cursorDefaults: null,
  frameDefaults: null,
  audioDefaults: null
}

export function exportTempDir(): string {
  return join(app.getPath('temp'), 'zoomcut-export')
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function ensureDirs(): Promise<void> {
  await fsp.mkdir(recordingsRoot(), { recursive: true })
  await fsp.mkdir(exportTempDir(), { recursive: true })
  await fsp.mkdir(scenariosRoot(), { recursive: true })
  allowMediaRoot(recordingsRoot())
  // registered explicitly (not just via the userData root below): ZOOMCUT_SCENARIOS_DIR can
  // point scenariosRoot() outside userData entirely, same reasoning as recordingsRoot() above
  allowMediaRoot(scenariosRoot())
  allowMediaRoot(app.getPath('userData'))
  allowMediaRoot(app.getPath('temp'))
  // bundled read-only resource dir (dev: repo's resources/music, packaged: extraResources) –
  // lets the "Add music" picker preview a track through zc-media:// before it is imported
  allowMediaRoot(musicDir())
}

export async function getSettings(): Promise<AppSettings> {
  let settings: AppSettings
  try {
    const raw = JSON.parse(await fsp.readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    settings = { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  // a remembered export folder that no longer exists must not be offered again
  if (settings.lastExportFolder && !(await exists(settings.lastExportFolder))) settings.lastExportFolder = null
  return settings
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch }
  await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function projectFile(id: string): string {
  return join(projectDir(id), 'project.json')
}

export async function newRecordingId(): Promise<string> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  let id = base
  let n = 2
  while (await exists(projectDir(id))) {
    id = `${base}-${n++}`
  }
  return id
}

const saveQueues = new Map<string, Promise<void>>()

export function saveProject(project: Project): Promise<void> {
  // saves of the same project are serialized: two concurrent tmp→json renames collide on Windows
  const previous = saveQueues.get(project.id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => saveProjectNow(project))
  saveQueues.set(project.id, next)
  return next
}

async function saveProjectNow(project: Project): Promise<void> {
  // a project whose folder is gone was deleted: a late autosave must not recreate it
  if (!(await exists(projectDir(project.id)))) return
  project.updatedAt = Date.now()
  const target = projectFile(project.id)
  const tmp = target + '.tmp'
  const json = JSON.stringify(project)
  await fsp.writeFile(tmp, json, 'utf8')
  // a reader (project list, antivirus) can hold the target for a moment: retry, then write directly
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fsp.rename(tmp, target)
      return
    } catch {
      // the project was deleted while the save was in flight: give up quietly, never recreate it
      if (!(await exists(projectDir(project.id)))) return
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
  if (!(await exists(projectDir(project.id)))) return
  await fsp.writeFile(target, json, 'utf8')
  await fsp.rm(tmp, { force: true }).catch(() => undefined)
}

/** Loads a project and fills in defaults for fields added in later versions. */
export async function loadProject(id: string): Promise<Project> {
  const raw = JSON.parse(await fsp.readFile(projectFile(id), 'utf8')) as Project
  const dir = projectDir(id)
  return {
    ...raw,
    recording: { ...raw.recording, dir, videoPath: join(dir, 'source.mp4') },
    cursorData: raw.cursorData ?? { samples: [], clicks: [], source: 'none' },
    windows: raw.windows ?? [],
    cuts: raw.cuts ?? [],
    texts: raw.texts ?? [],
    zooms: raw.zooms ?? [],
    audio: raw.audio ?? [],
    cursor: { ...DEFAULT_CURSOR_SETTINGS, ...(raw.cursor ?? {}) },
    crop: raw.crop ?? { x: 0, y: 0, w: 1, h: 1 },
    frame: { ...DEFAULT_FRAME_STYLE, ...(raw.frame ?? {}) },
    export: {
      ...DEFAULT_EXPORT_SETTINGS,
      ...(raw.export ?? {}),
      gif: { ...DEFAULT_GIF_SETTINGS, ...(raw.export?.gif ?? {}) }
    }
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = recordingsRoot()
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const out: ProjectSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = JSON.parse(await fsp.readFile(projectFile(entry.name), 'utf8')) as Project
      out.push({
        id: raw.id,
        name: raw.name,
        createdAt: raw.recording.createdAt,
        updatedAt: raw.updatedAt,
        durationMs: raw.recording.durationMs,
        width: raw.recording.width,
        height: raw.recording.height,
        dir: projectDir(entry.name)
      })
    } catch {
      // not a project folder (or a recording that never finished) – skip
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function deleteProject(id: string): Promise<void> {
  // Windows refuses to remove files that are being written (a save in flight): retry briefly
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rm(projectDir(id), { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 5) throw err
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}
