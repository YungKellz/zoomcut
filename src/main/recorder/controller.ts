import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fsp, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type {
  AudioClip,
  AudioTrackKind,
  DisplayInfo,
  Project,
  RecorderBarState,
  RecordingProgress,
  RecordingStartMeta
} from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { newAudioClipDefaults } from '@shared/audio'
import { createBarWindow, getMainWindow } from '../windows'
import { getSettings, newRecordingId, projectDir, saveProject, updateSettings } from '../storage'
import { convertAudio, probeAudio, probeVideo, transcodeRecording } from '../media/ffmpeg'
import { CursorTracker } from './cursorTracker'
import { snapshotWindows } from './windowsSnapshot'
import type { WindowRect } from '@shared/types'

export const STOP_SHORTCUT = 'CommandOrControl+Alt+R'

/** One raw audio track being captured alongside the video (mic or system loopback). */
interface AudioTrackState {
  /** raw opus/webm file, converted to .m4a and deleted in finish() */
  rawPath: string
  stream: WriteStream
  startWall: number
}

interface ActiveRecording {
  id: string
  dir: string
  display: Electron.Display
  displayName: string
  startedAt: number | null
  meta: RecordingStartMeta | null
  rawPath: string | null
  stream: WriteStream | null
  bytes: number
  windowsAtStart: Promise<WindowRect[]>
  stopRequestedAt: number | null
  audio: { mic: AudioTrackState | null; system: AudioTrackState | null }
}

/**
 * Ends the mic/system raw write streams if they are still open. Idempotent (checks
 * writableEnded/destroyed first) so it is safe to call from every exit path – finish's
 * success path (via finishAudio), finish's error path, and cancel – without double-ending.
 */
function closeAudioStreams(a: ActiveRecording): Promise<void> {
  const tracks = [a.audio.mic, a.audio.system].filter((t): t is AudioTrackState => Boolean(t))
  return Promise.all(
    tracks.map(
      (track) =>
        new Promise<void>((resolve) => {
          if (track.stream.writableEnded || track.stream.destroyed) {
            resolve()
            return
          }
          track.stream.end(() => resolve())
        })
    )
  ).then(() => undefined)
}

export class RecordingController {
  private active: ActiveRecording | null = null
  private selectedSource: Electron.DesktopCapturerSource | null = null
  private sources = new Map<string, Electron.DesktopCapturerSource>()
  private bar: BrowserWindow | null = null
  private tracker = new CursorTracker()
  private barState: RecorderBarState = { phase: 'idle', startedAt: null, countdownEndsAt: null }

  installDisplayMediaHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        if (this.selectedSource) {
          // 'loopback' captures the system's audio output; only supported on Windows,
          // which is this app's only target platform
          callback({ video: this.selectedSource, audio: request.audioRequested ? 'loopback' : undefined })
        } else {
          callback({})
        }
      },
      { useSystemPicker: false }
    )
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 360, height: 220 },
      fetchWindowIcons: false
    })
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    this.sources.clear()
    const out: DisplayInfo[] = []
    sources.forEach((source, index) => {
      this.sources.set(source.id, source)
      const display =
        displays.find((d) => String(d.id) === source.display_id) ?? displays[index] ?? primary
      out.push({
        id: display.id,
        sourceId: source.id,
        name: source.name || `Display ${index + 1}`,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        primary: display.id === primary.id,
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL()
      })
    })
    return out
  }

  getBarState(): RecorderBarState {
    return this.barState
  }

  async prepare(displayId: number): Promise<{ id: string; countdownEndsAt: number }> {
    if (this.active) throw new Error('A recording is already in progress')
    const displays = await this.listDisplays()
    const info = displays.find((d) => d.id === displayId) ?? displays[0]
    if (!info) throw new Error('No display available for recording')
    const source = this.sources.get(info.sourceId)
    const display = screen.getAllDisplays().find((d) => d.id === info.id) ?? screen.getPrimaryDisplay()
    if (!source) throw new Error('Display source not found')

    this.selectedSource = source
    const id = await newRecordingId()
    const dir = projectDir(id)
    await fsp.mkdir(dir, { recursive: true })
    this.active = {
      id,
      dir,
      display,
      displayName: info.name,
      startedAt: null,
      meta: null,
      rawPath: null,
      stream: null,
      bytes: 0,
      // window layout is captured in the background; used later for "crop to window"
      windowsAtStart: snapshotWindows(display),
      stopRequestedAt: null,
      audio: { mic: null, system: null }
    }
    await updateSettings({ lastDisplayId: displayId })
    await this.tracker.start(display)

    getMainWindow()?.hide()
    this.bar = createBarWindow(display.bounds)
    this.bar.on('closed', () => {
      this.bar = null
    })
    const countdownEndsAt = Date.now() + 3200
    this.setBarState({ phase: 'countdown', startedAt: null, countdownEndsAt })

    globalShortcut.unregister(STOP_SHORTCUT)
    globalShortcut.register(STOP_SHORTCUT, () => this.requestStop())
    return { id, countdownEndsAt }
  }

  started(id: string, meta: RecordingStartMeta): void {
    const a = this.requireActive(id)
    a.startedAt = meta.startedAt
    a.meta = meta
    a.rawPath = join(a.dir, meta.mimeType.includes('mp4') ? 'raw.mp4' : 'raw.webm')
    a.stream = createWriteStream(a.rawPath)
    if (meta.audio?.mic) {
      const rawPath = join(a.dir, 'mic.webm')
      a.audio.mic = { rawPath, stream: createWriteStream(rawPath), startWall: meta.audio.mic.startWall }
    }
    if (meta.audio?.system) {
      const rawPath = join(a.dir, 'system.webm')
      a.audio.system = { rawPath, stream: createWriteStream(rawPath), startWall: meta.audio.system.startWall }
    }
    this.setBarState({
      phase: 'recording',
      startedAt: meta.startedAt,
      countdownEndsAt: null,
      audio: meta.audio ? { mic: Boolean(meta.audio.mic), system: Boolean(meta.audio.system) } : undefined
    })
  }

  chunk(id: string, data: ArrayBuffer): Promise<void> {
    const a = this.requireActive(id)
    if (!a.stream) throw new Error('Recording has not started')
    const buf = Buffer.from(data)
    a.bytes += buf.byteLength
    const stream = a.stream
    return new Promise((resolve, reject) => {
      stream.write(buf, (err) => (err ? reject(err) : resolve()))
    })
  }

  audioChunk(id: string, kind: AudioTrackKind, data: ArrayBuffer): Promise<void> {
    const a = this.requireActive(id)
    const track = a.audio[kind]
    if (!track) throw new Error(`Audio track '${kind}' was not started`)
    const buf = Buffer.from(data)
    return new Promise((resolve, reject) => {
      track.stream.write(buf, (err) => (err ? reject(err) : resolve()))
    })
  }

  requestStop(): void {
    if (!this.active) return
    this.active.stopRequestedAt = Date.now()
    this.setBarState({ ...this.barState, phase: 'processing' })
    getMainWindow()?.webContents.send('recorder:stop')
  }

  requestCancel(): void {
    if (!this.active) return
    getMainWindow()?.webContents.send('recorder:cancel')
  }

  async finish(id: string): Promise<Project> {
    const a = this.requireActive(id)
    const progress = (p: Omit<RecordingProgress, 'id'>): void => {
      getMainWindow()?.webContents.send('recording:progress', { id, ...p })
    }
    try {
      if (!a.startedAt || !a.meta || !a.rawPath || !a.stream) {
        throw new Error('Recording never started')
      }
      const cursorData = this.tracker.stop(a.startedAt, a.stopRequestedAt)
      const stoppedAt = Date.now()
      await new Promise<void>((resolve, reject) => {
        a.stream!.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
      // second window snapshot while our own windows are still hidden
      const windowsAtEnd = await snapshotWindows(a.display)
      const windowsAtStart = await a.windowsAtStart
      this.teardownRecordingUi()

      const estimatedDuration = Date.now() - a.startedAt
      const sourcePath = join(a.dir, 'source.mp4')
      progress({ phase: 'transcode', percent: 0 })
      await transcodeRecording(a.rawPath, sourcePath, a.meta.fps, estimatedDuration, (percent) =>
        progress({ phase: 'transcode', percent })
      )
      progress({ phase: 'analyze', percent: 100 })
      const probe = await probeVideo(sourcePath)
      await fsp.rm(a.rawPath, { force: true })

      const settings = await getSettings()
      const createdAt = a.startedAt
      const project: Project = {
        version: 1,
        id,
        name: `Recording ${formatDate(createdAt)}`,
        recording: {
          id,
          createdAt,
          dir: a.dir,
          videoPath: sourcePath,
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          fps: probe.fps,
          displayName: a.displayName
        },
        cursorData,
        windows: [
          { t: 0, windows: windowsAtStart },
          { t: stoppedAt - a.startedAt, windows: windowsAtEnd }
        ],
        cuts: [],
        texts: [],
        zooms: [],
        audio: [],
        // last used cursor / frame settings become the defaults of a new project
        cursor: { ...DEFAULT_CURSOR_SETTINGS, ...(settings.cursorDefaults ?? {}), offsetMs: 0 },
        crop: { x: 0, y: 0, w: 1, h: 1 },
        frame: { ...DEFAULT_FRAME_STYLE, ...(settings.frameDefaults ?? {}) },
        export: {
          ...DEFAULT_EXPORT_SETTINGS,
          gif: { ...DEFAULT_EXPORT_SETTINGS.gif },
          fileName: id,
          folder: settings.lastExportFolder ?? app.getPath('videos')
        },
        updatedAt: Date.now()
      }
      project.audio = await this.finishAudio(a, createdAt, estimatedDuration, progress)
      await saveProject(project)
      progress({ phase: 'done', percent: 100 })
      return project
    } catch (err) {
      progress({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      this.teardownRecordingUi()
      throw err
    } finally {
      // the success path already closes these via finishAudio; on an error thrown before
      // that point (transcode, probe, snapshot, ...) they would otherwise stay open forever
      await closeAudioStreams(a)
      this.active = null
      this.selectedSource = null
    }
  }

  /**
   * Converts every raw audio track captured alongside the video into an AAC .m4a, probes
   * its duration and turns it into an AudioClip. A track that fails to convert is logged
   * and skipped (never fails the whole recording) – its raw file is still removed.
   */
  private async finishAudio(
    a: ActiveRecording,
    startedAt: number,
    estimatedDuration: number,
    progress: (p: Omit<RecordingProgress, 'id'>) => void
  ): Promise<AudioClip[]> {
    await closeAudioStreams(a)
    const clips: AudioClip[] = []
    const kinds: Array<{ kind: AudioTrackKind; name: string }> = [
      { kind: 'system', name: 'System audio' },
      { kind: 'mic', name: 'Microphone' }
    ]
    for (const { kind, name } of kinds) {
      const track = a.audio[kind]
      if (!track) continue
      const file = `${kind}.m4a`
      const outPath = join(a.dir, file)
      let converted = false
      try {
        progress({ phase: 'audio', percent: 0 })
        await convertAudio(track.rawPath, outPath, estimatedDuration, (percent) => progress({ phase: 'audio', percent }))
        converted = true
        const probe = await probeAudio(outPath)
        clips.push({
          id: randomUUID(),
          kind,
          file,
          name,
          start: track.startWall - startedAt,
          durationMs: probe.durationMs,
          ...newAudioClipDefaults(kind)
        })
      } catch (err) {
        console.warn(`[recorder] audio conversion failed for '${kind}':`, err)
        // convertAudio succeeded but probing its output failed: do not leave an orphan .m4a
        if (converted) await fsp.rm(outPath, { force: true }).catch(() => undefined)
      } finally {
        await fsp.rm(track.rawPath, { force: true }).catch(() => undefined)
      }
    }
    return clips
  }

  async cancel(id: string): Promise<void> {
    const a = this.active
    if (!a || a.id !== id) return
    this.tracker.stop(null)
    if (a.stream) {
      await new Promise<void>((resolve) => a.stream!.end(() => resolve()))
    }
    await closeAudioStreams(a)
    this.teardownRecordingUi()
    this.active = null
    this.selectedSource = null
    await fsp.rm(a.dir, { recursive: true, force: true })
  }

  dispose(): void {
    this.tracker.dispose()
    if (this.bar && !this.bar.isDestroyed()) this.bar.close()
  }

  private teardownRecordingUi(): void {
    globalShortcut.unregister(STOP_SHORTCUT)
    this.setBarState({ phase: 'idle', startedAt: null, countdownEndsAt: null })
    if (this.bar && !this.bar.isDestroyed()) this.bar.close()
    this.bar = null
    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
    }
  }

  private setBarState(state: RecorderBarState): void {
    this.barState = state
    if (this.bar && !this.bar.isDestroyed()) this.bar.webContents.send('bar:state', state)
  }

  private requireActive(id: string): ActiveRecording {
    if (!this.active || this.active.id !== id) throw new Error('Unknown recording ' + id)
    return this.active
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
