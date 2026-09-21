import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/**
 * Project-folder path helpers, in their own leaf module: nothing here imports another
 * project-local module, so both `audio/musicLibrary.ts` and `media/audioImport.ts` can depend on
 * it without recreating the cycle `storage.ts -> audio/musicLibrary.ts -> media/audioImport.ts ->
 * storage.ts` that existed when these lived in `audioImport.ts` (imported from `storage.ts`).
 * `storage.ts` itself imports and re-exports `recordingsRoot`/`projectDir`/`exists` from here, so
 * every other existing `import { projectDir } from '../storage'` (controller.ts, ipc.ts,
 * exportManager.ts, ...) keeps working unchanged.
 */

export function recordingsRoot(): string {
  // ZOOMCUT_RECORDINGS_DIR lets tests keep their recordings out of the user's Videos folder.
  return process.env['ZOOMCUT_RECORDINGS_DIR'] || join(app.getPath('videos'), 'ZoomCut')
}

export function projectDir(id: string): string {
  return join(recordingsRoot(), id)
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/** `projectId` always becomes a literal path segment (projectDir/exportTempDir joins); reject
 * anything that is not a plain folder-name-shaped string before it ever touches the filesystem.
 * Used by media/audioImport.ts and audio/musicLibrary.ts, which import a bundled track the same way. */
export function assertProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(projectId) || projectId.includes('..')) {
    throw new Error(`Refusing to use project id '${projectId}': not a plain folder name.`)
  }
}

export async function requireProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId)
  if (!(await exists(dir))) {
    throw new Error(`Project '${projectId}' was not found; its folder may have been deleted.`)
  }
  return dir
}
