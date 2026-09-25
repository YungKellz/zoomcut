import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { dialog, type WebContents } from 'electron'
import type { ExportFinishResult, GifConvertProgress, GifConvertRequest, VideoFileInfo } from '@shared/types'
import { encodeGif, gifConvertInputArgs, gifConvertPrefilter, probeVideo } from './ffmpeg'
import { exportTempDir, updateSettings } from '../storage'
import { sanitizeFileName, uniquePath } from '../exportManager'
import { allowMediaRoot } from '../mediaProtocol'
import { getMainWindow } from '../windows'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']

/**
 * The standalone "MP4 → GIF" converter: any video file the user picks is run through the same
 * two-pass palette encode as a GIF export (media/ffmpeg.ts encodeGif), with fps/scale/trim
 * applied by ffmpeg itself - nothing is rendered in the renderer. One conversion at a time.
 */
export class GifConverter {
  private abort: AbortController | null = null

  async chooseVideo(): Promise<VideoFileInfo | null> {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0]
    if (!path) return null
    const probe = await probeVideo(path)
    // only this one file becomes servable through zc-media:// (for the preview player)
    allowMediaRoot(path)
    return { path, name: basename(path, extname(path)), ...probe }
  }

  async toGif(req: GifConvertRequest, sender: WebContents): Promise<ExportFinishResult> {
    if (this.abort) throw new Error('A conversion is already running')
    const abort = new AbortController()
    this.abort = abort
    const progress = (p: GifConvertProgress): void => {
      if (!sender.isDestroyed()) sender.send('converter:progress', p)
    }
    const probe = await probeVideo(req.input)
    const inputArgs = gifConvertInputArgs(req.startMs, req.endMs, probe.durationMs)
    const durationMs = Math.max(1, Math.min(req.endMs, probe.durationMs) - Math.max(0, req.startMs))
    const tempDir = exportTempDir()
    await fsp.mkdir(tempDir, { recursive: true })
    await fsp.mkdir(req.folder, { recursive: true })
    const perFrame = req.gif.paletteMode === 'perframe'
    const palettePath = join(tempDir, `${randomUUID()}-palette.${perFrame ? 'nut' : 'png'}`)
    const outputPath = await uniquePath(req.folder, sanitizeFileName(req.fileName), 'gif')
    let done = false
    try {
      await encodeGif(req.input, palettePath, outputPath, req.gif, false, durationMs,
        (phase, percent) => progress({ phase, percent }), abort.signal,
        { inputArgs, prefilter: gifConvertPrefilter(req.fps, req.width) })
      done = true
      const stat = await fsp.stat(outputPath)
      await updateSettings({ lastExportFolder: req.folder })
      progress({ phase: 'done', percent: 100 })
      return { outputPath, bytes: stat.size }
    } catch (err) {
      progress({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      if (abort.signal.aborted) throw new Error('Conversion cancelled')
      throw err
    } finally {
      if (!done) await fsp.rm(outputPath, { force: true }).catch(() => undefined)
      await fsp.rm(palettePath, { force: true }).catch(() => undefined)
      this.abort = null
    }
  }

  cancel(): void {
    this.abort?.abort()
  }
}
