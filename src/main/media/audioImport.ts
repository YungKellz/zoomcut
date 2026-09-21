import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { AudioClipKind } from '@shared/types'
import { exists, exportTempDir, projectDir } from '../storage'
import { getMainWindow } from '../windows'
import { convertAudio, probeAudio } from './ffmpeg'

/** Extensions the renderer can produce itself (voiceover recordings, generated music beds). */
export type AudioImportExt = 'webm' | 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac'
const AUDIO_IMPORT_EXTS: AudioImportExt[] = ['webm', 'wav', 'mp3', 'm4a', 'ogg', 'flac']

export interface AudioImportClipInput {
  kind: AudioClipKind
  name: string
  ext: AudioImportExt
  data: ArrayBuffer
}

export interface AudioImportResult {
  file: string
  durationMs: number
}

export interface AudioFileImportResult extends AudioImportResult {
  name: string
}

// Wider than AudioImportExt: a file the user picks from disk can be anything ffmpeg reads.
const FILE_DIALOG_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm']

function newClipId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

/** `projectId` always becomes a literal path segment (projectDir/exportTempDir joins); reject
 * anything that is not a plain folder-name-shaped string before it ever touches the filesystem. */
function assertProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(projectId) || projectId.includes('..')) {
    throw new Error(`Refusing to use project id '${projectId}': not a plain folder name.`)
  }
}

async function requireProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId)
  if (!(await exists(dir))) {
    throw new Error(`Project '${projectId}' was not found; its folder may have been deleted.`)
  }
  return dir
}

/**
 * Writes a renderer-produced audio blob (voiceover recording, generated music bed) to a temp
 * file, converts it into the project's own AAC .m4a – the format every AudioClip.file points
 * at, see src/shared/audio.ts – and probes its duration. The temp file is always removed,
 * whether or not the conversion succeeds; a failed conversion also removes whatever partial
 * .m4a it may have written, so a rejected importClip never leaves an orphan file behind.
 */
export async function importAudioClip(projectId: string, clip: AudioImportClipInput): Promise<AudioImportResult> {
  assertProjectId(projectId)
  if (!AUDIO_IMPORT_EXTS.includes(clip.ext)) {
    throw new Error(`Refusing to import audio: unsupported extension '${clip.ext}'.`)
  }
  const dir = await requireProjectDir(projectId)
  const clipId = newClipId(clip.kind)
  const tempDir = exportTempDir()
  await fsp.mkdir(tempDir, { recursive: true })
  const tempPath = join(tempDir, `${clipId}-import.${clip.ext}`)
  const outPath = join(dir, `${clipId}.m4a`)
  try {
    await fsp.writeFile(tempPath, Buffer.from(clip.data))
    await convertAudio(tempPath, outPath)
    const probe = await probeAudio(outPath)
    return { file: `${clipId}.m4a`, durationMs: probe.durationMs }
  } catch (err) {
    // convertAudio (or a bad output caught by probeAudio) can leave a partial/corrupt .m4a
    // behind – never keep that around
    await fsp.rm(outPath, { force: true }).catch(() => undefined)
    throw err
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Opens a native file picker with audio filters and imports the chosen file the same way
 * importAudioClip does (convert to .m4a inside the project folder, probe the duration).
 * Resolves to null when the user cancels. The source file itself is never touched or removed.
 */
export async function importAudioFile(projectId: string): Promise<AudioFileImportResult | null> {
  assertProjectId(projectId)
  const dir = await requireProjectDir(projectId)
  const win = getMainWindow()
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Audio files', extensions: FILE_DIALOG_EXTENSIONS }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const sourcePath = result.canceled ? undefined : result.filePaths[0]
  if (!sourcePath) return null

  const clipId = newClipId('file')
  const outPath = join(dir, `${clipId}.m4a`)
  try {
    await convertAudio(sourcePath, outPath)
    const probe = await probeAudio(outPath)
    const name = basename(sourcePath, extname(sourcePath))
    return { file: `${clipId}.m4a`, durationMs: probe.durationMs, name }
  } catch (err) {
    await fsp.rm(outPath, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Deletes every `.m4a` file in the project folder that is not listed in `keepFiles`. Clip
 * removal (removeAudioClip in the store) is undoable, so it must not delete files eagerly –
 * instead the renderer calls this once, when the editor closes, with the final project's own
 * `audio.map(c => c.file)` as `keepFiles` (see main.tsx). Anything else with a `.m4a` extension
 * sitting in the folder at that point is an orphan (a clip added then removed without ever
 * being saved, a failed import's leftover, ...) and is safe to remove for good, since undo
 * history for that project is discarded the moment the editor closes.
 */
export async function sweepAudioFiles(projectId: string, keepFiles: string[]): Promise<void> {
  assertProjectId(projectId)
  const dir = projectDir(projectId)
  if (!(await exists(dir))) return
  const keep = new Set(keepFiles.filter((f) => /^[^\\/]+\.m4a$/i.test(f) && !f.includes('..')))
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return
  }
  const toRemove = entries.filter((f) => /\.m4a$/i.test(f) && !keep.has(f))
  await Promise.all(toRemove.map((f) => fsp.rm(join(dir, f), { force: true }).catch(() => undefined)))
}
