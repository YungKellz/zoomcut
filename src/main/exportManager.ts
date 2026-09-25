import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type {
  AudioExportPlan,
  ExportBeginRequest,
  ExportBeginResult,
  ExportFinishResult,
  ExportProgress,
  ExportSettings
} from '@shared/types'
import { encodeGif, finalizeMp4, startRawIntermediate, type FfmpegProcess } from './media/ffmpeg'
import { exists, exportTempDir, updateSettings } from './storage'

interface ExportSession {
  id: string
  fh: FileHandle | null
  raw: FfmpegProcess | null
  tempPath: string
  /** final file, known once ffmpeg starts writing it; removed again if the export does not finish */
  outputPath: string | null
  folder: string
  fileName: string
  format: ExportBeginRequest['format']
  abort: AbortController
  sender: WebContents
}

// characters Windows refuses in file names, plus control characters
const INVALID_FILE_CHARS = new RegExp('[<>:"/' + String.fromCharCode(92, 92) + '|?*' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g')

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(INVALID_FILE_CHARS, '_').trim()
  return cleaned.length > 0 ? cleaned : 'zoomcut-export'
}

export async function uniquePath(folder: string, base: string, ext: string): Promise<string> {
  let candidate = join(folder, `${base}.${ext}`)
  let n = 2
  while (await exists(candidate)) {
    candidate = join(folder, `${base}-${n++}.${ext}`)
  }
  return candidate
}

/**
 * Receives the intermediate video from the renderer – either an MP4 written by
 * Mediabunny (WebCodecs) as positioned chunks, or raw RGBA frames piped into a
 * lossless ffv1 file – and then runs ffmpeg to produce the final MP4 or GIF.
 */
export class ExportManager {
  private sessions = new Map<string, ExportSession>()

  async begin(req: ExportBeginRequest, sender: WebContents): Promise<ExportBeginResult> {
    const id = randomUUID()
    const tempDir = exportTempDir()
    await fsp.mkdir(tempDir, { recursive: true })
    await fsp.mkdir(req.folder, { recursive: true })
    const abort = new AbortController()
    const session: ExportSession = {
      id,
      fh: null,
      raw: null,
      tempPath: '',
      outputPath: null,
      folder: req.folder,
      fileName: sanitizeFileName(req.fileName),
      format: req.format,
      abort,
      sender
    }
    if (req.raw) {
      session.tempPath = join(tempDir, `${id}.mkv`)
      session.raw = startRawIntermediate(session.tempPath, req.raw.width, req.raw.height, req.raw.fps, abort.signal)
    } else {
      session.tempPath = join(tempDir, `${id}.mp4`)
      session.fh = await fsp.open(session.tempPath, 'w')
    }
    this.sessions.set(id, session)
    return { exportId: id, tempPath: session.tempPath }
  }

  async write(exportId: string, position: number, data: ArrayBuffer): Promise<void> {
    const s = this.require(exportId)
    if (!s.fh) throw new Error('Export file is closed')
    const buf = Buffer.from(data)
    await s.fh.write(buf, 0, buf.byteLength, position)
  }

  async writeRaw(exportId: string, data: ArrayBuffer): Promise<void> {
    const s = this.require(exportId)
    const stdin = s.raw?.proc.stdin
    if (!s.raw || !stdin || stdin.destroyed) throw new Error('ffmpeg is not accepting frames')
    const ok = stdin.write(Buffer.from(data))
    if (!ok) {
      // wait for ffmpeg to drain; if it dies meanwhile, surface its error instead of hanging
      await Promise.race([once(stdin, 'drain'), s.raw.done.then(() => { throw new Error('ffmpeg exited early') })])
    }
  }

  async finish(exportId: string, settings: ExportSettings, meta: { durationMs: number; alpha?: boolean; audio?: AudioExportPlan }): Promise<ExportFinishResult> {
    const s = this.require(exportId)
    const progress = (p: Omit<ExportProgress, 'exportId'>): void => {
      if (!s.sender.isDestroyed()) s.sender.send('export:progress', { exportId, ...p })
    }
    let done = false
    try {
      if (s.raw) {
        s.raw.proc.stdin?.end()
        await s.raw.done
        s.raw = null
      }
      await s.fh?.close()
      s.fh = null

      const outputPath = await uniquePath(s.folder, s.fileName, s.format)
      s.outputPath = outputPath
      if (s.format === 'mp4') {
        await finalizeMp4(s.tempPath, outputPath, settings.mp4Quality, meta.durationMs,
          (percent) => progress({ phase: 'encode', percent }), s.abort.signal, meta.audio)
      } else {
        // GIF ignores audio entirely
        const perFrame = settings.gif.paletteMode === 'perframe'
        const palettePath = join(exportTempDir(), `${exportId}-palette.${perFrame ? 'nut' : 'png'}`)
        try {
          await encodeGif(s.tempPath, palettePath, outputPath, settings.gif, Boolean(meta.alpha), meta.durationMs,
            (phase, percent) => progress({ phase, percent }), s.abort.signal)
        } finally {
          await fsp.rm(palettePath, { force: true })
        }
      }
      done = true
      const stat = await fsp.stat(outputPath)
      await updateSettings({ lastExportFolder: s.folder })
      progress({ phase: 'done', percent: 100 })
      return { outputPath, bytes: stat.size }
    } catch (err) {
      progress({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      // a cancelled or failed ffmpeg run must not leave a half-written file behind
      if (!done && s.outputPath) await fsp.rm(s.outputPath, { force: true }).catch(() => undefined)
      await fsp.rm(s.tempPath, { force: true })
      this.sessions.delete(exportId)
    }
  }

  async cancel(exportId: string): Promise<void> {
    const s = this.sessions.get(exportId)
    if (!s) return
    s.abort.abort()
    if (s.raw) {
      s.raw.proc.stdin?.destroy()
      s.raw.proc.kill('SIGKILL')
      await s.raw.done.catch(() => undefined)
      s.raw = null
    }
    await s.fh?.close().catch(() => undefined)
    s.fh = null
    await fsp.rm(s.tempPath, { force: true }).catch(() => undefined)
    if (s.outputPath) await fsp.rm(s.outputPath, { force: true }).catch(() => undefined)
    this.sessions.delete(exportId)
  }

  private require(exportId: string): ExportSession {
    const s = this.sessions.get(exportId)
    if (!s) throw new Error('Unknown export ' + exportId)
    return s
  }
}
