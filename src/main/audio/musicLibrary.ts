import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { MusicMood, MusicTrack } from '@shared/types'
import { assertProjectId, requireProjectDir } from '../media/projectPaths'
import { probeAudio } from '../media/ffmpeg'

const MOODS: MusicMood[] = ['upbeat', 'corporate', 'bright', 'lofi', 'calm', 'minimal']

/** A track's id becomes a literal path segment (`music-<id>.m4a`, joined under the project
 * folder in importMusicTrack) – same shape restriction as assertProjectId, so a hand-edited
 * manifest.json can never walk `join()` outside the project directory. */
const TRACK_ID_RE = /^[A-Za-z0-9_.-]+$/

interface ManifestEntry {
  id: string
  title: string
  artist: string
  mood: MusicMood
  file: string
  durationMs: number
}

function isValidEntry(x: unknown): x is ManifestEntry {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    TRACK_ID_RE.test(e.id) &&
    !e.id.includes('..') &&
    typeof e.title === 'string' &&
    e.title.length > 0 &&
    typeof e.artist === 'string' &&
    typeof e.mood === 'string' &&
    MOODS.includes(e.mood as MusicMood) &&
    typeof e.file === 'string' &&
    e.file.length > 0 &&
    !e.file.includes('..') &&
    typeof e.durationMs === 'number' &&
    e.durationMs > 0
  )
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * resources/music, bundled with the app: electron-builder copies it next to the installed app
 * as `resources/music` (electron-builder.yml `extraResources`, `to: music`), unpacked outside
 * app.asar; in development (or a `npm run build` / e2e run, neither of which is "packaged") it
 * is simply the repo's own `resources/music` folder.
 */
export function musicDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'music') : join(app.getAppPath(), 'resources', 'music')
}

/**
 * Reads manifest.json next to the bundled tracks and returns one MusicTrack per valid, present
 * entry. An entry that fails validation (bad shape, unknown mood) or whose file does not exist
 * on disk is skipped rather than thrown – a partial install or a hand-edited manifest must not
 * break the whole "Add music" picker, just quietly offer fewer tracks.
 */
export async function listMusic(): Promise<MusicTrack[]> {
  const dir = musicDir()
  let raw: unknown
  try {
    raw = JSON.parse(await fsp.readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (err) {
    console.error('[music] could not read manifest.json', err)
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: MusicTrack[] = []
  for (const entry of raw) {
    if (!isValidEntry(entry)) continue
    const path = join(dir, entry.file)
    if (!(await pathExists(path))) continue
    out.push({ id: entry.id, title: entry.title, artist: entry.artist, mood: entry.mood, durationMs: entry.durationMs, path })
  }
  return out
}

export interface MusicImportResult {
  file: string
  durationMs: number
}

/**
 * Copies a bundled track's `.m4a` into the project folder as `music-<id>.m4a`, unchanged (the
 * bundled files are already the project's own clip format – stereo AAC – so no ffmpeg transcode
 * runs here, unlike importAudioClip/importAudioFile). The copy's own duration is probed rather
 * than trusting manifest.json, in case the bundled file and the manifest ever drift apart.
 */
export async function importMusicTrack(projectId: string, id: string): Promise<MusicImportResult> {
  assertProjectId(projectId)
  const dir = await requireProjectDir(projectId)
  const tracks = await listMusic()
  const track = tracks.find((tr) => tr.id === id)
  if (!track) throw new Error(`Unknown music track '${id}'.`)
  const file = `music-${track.id}.m4a`
  const outPath = join(dir, file)
  await fsp.copyFile(track.path, outPath)
  const probe = await probeAudio(outPath)
  return { file, durationMs: probe.durationMs }
}
