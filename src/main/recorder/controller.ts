import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, session } from 'electron'
import { createWriteStream, promises as fsp, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type {
  DisplayInfo,
  Project,
  RecorderBarState,
  RecordingProgress,
  RecordingStartMeta
} from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { createBarWindow, getMainWindow } from '../windows'
import { getSettings, newRecordingId, projectDir, saveProject, updateSettings } from '../storage'
import { probeVideo, transcodeRecording } from '../media/ffmpeg'
import { CursorTracker } from './cursorTracker'
import { snapshotWindows } from './windowsSnapshot'
import type { WindowRect } from '@shared/types'

export const STOP_SHORTCUT = 'CommandOrControl+Alt+R'

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
      (_request, callback) => {
        if (this.selectedSource) callback({ video: this.selectedSource })
        else callback({})
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
      stopRequestedAt: null
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
    this.setBarState({ phase: 'recording', startedAt: meta.startedAt, countdownEndsAt: null })
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
      await saveProject(project)
      progress({ phase: 'done', percent: 100 })
      return project
    } catch (err) {
      progress({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      this.teardownRecordingUi()
      throw err
    } finally {
      this.active = null
      this.selectedSource = null
    }
  }

  async cancel(id: string): Promise<void> {
    const a = this.active
    if (!a || a.id !== id) return
    this.tracker.stop(null)
    if (a.stream) {
      await new Promise<void>((resolve) => a.stream!.end(() => resolve()))
    }
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
