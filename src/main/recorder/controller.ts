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
  RecordingOrigin,
  RecordingProgress,
  RecordingStartMeta,
  RecordingWarning,
  RecordOptions
} from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { newAudioClipDefaults } from '@shared/audio'
import { createBarWindow, getMainWindow } from '../windows'
import { getSettings, newRecordingId, projectDir, saveProject, updateSettings } from '../storage'
import { convertAudio, convertRawAudio, probeAudio, probeVideo, transcodeRecording } from '../media/ffmpeg'
import { CursorTracker } from './cursorTracker'
import { snapshotWindows } from './windowsSnapshot'
import { ReplaySession } from '../scenario/replay'
import { LoopbackCapture, type LoopbackFormat } from '../audio/loopback'
import type { WindowRect } from '@shared/types'

export const STOP_SHORTCUT = 'CommandOrControl+Alt+R'

/** The mic's raw audio track, captured alongside the video via the renderer's own MediaRecorder
 * (recording:audio-chunk). System audio no longer goes through this path - see SystemAudioState. */
interface AudioTrackState {
  /** raw opus/webm file, converted to .m4a and deleted in finish() */
  rawPath: string
  stream: WriteStream
  startWall: number
}

/** The system-audio track, captured directly by main through LoopbackCapture (own WASAPI
 * loopback helper, src/main/audio/loopback.ts) - no renderer/IPC chunking involved. Filled in by
 * started() once the helper has reported both its format and its first frame's wall time. */
interface SystemAudioState {
  /** raw interleaved samples written by the helper, converted to .m4a and deleted in finish() */
  rawPath: string
  startWall: number
  format: LoopbackFormat
}

interface ActiveRecording {
  id: string
  dir: string
  display: Electron.Display
  displayName: string
  /** how this attempt was started; written to project.origin so "Record again" can repeat it */
  origin: RecordingOrigin
  startedAt: number | null
  meta: RecordingStartMeta | null
  rawPath: string | null
  stream: WriteStream | null
  bytes: number
  windowsAtStart: Promise<WindowRect[]>
  stopRequestedAt: number | null
  audio: { mic: AudioTrackState | null; system: SystemAudioState | null }
  /** the system-audio helper for this recording, present as soon as prepare() starts it - even
   * before `audio.system` itself is filled in by started() */
  loopback: LoopbackCapture | null
  /** path the helper is writing to; known as soon as prepare() starts it */
  systemRawPath: string | null
  /** the format the helper reported (its 'F' line); known once loopback.start() resolves */
  systemFormat: LoopbackFormat | null
  /** true when prepare() tried to start system audio and the helper failed outright */
  systemAudioFailed: boolean
  /** settles once startSystemAudio() has set loopback/systemFormat/systemAudioFailed one way or
   * the other; prepare() kicks it off without awaiting it (see startSystemAudio's own doc), so
   * every other place that reads `loopback` before started() has run must await this first. */
  systemAudioPromise: Promise<void> | null
  /** frames the helper actually wrote, stashed by stopSystemAudio() (called right after
   * teardownRecordingUi() in finish(), before the transcode) for finishAudio() to read once it
   * runs later - stopping it any later would leave it tapping the desktop for the whole transcode. */
  systemFrames: number | null
}

/**
 * Ends the mic raw write stream if it is still open, and resolves once its fd has actually
 * closed (not merely flushed - see the 'close' vs 'finish' note below). Idempotent (checks
 * `destroyed` first) so it is safe to call from every exit path – finish's success path (via
 * finishAudio), finish's error path, and cancel – without double-ending. System audio has no
 * stream to close (LoopbackCapture writes its own file; see finishAudio/RecordingController.dispose).
 */
function closeAudioStreams(a: ActiveRecording): Promise<void> {
  const tracks = [a.audio.mic].filter((t): t is AudioTrackState => Boolean(t))
  return Promise.all(
    tracks.map(
      (track) =>
        new Promise<void>((resolve) => {
          const stream = track.stream
          // already fully closed by an earlier call (finishAudio() already ran, or a previous
          // cancel already did) - 'close' will never fire again, so waiting for it would hang
          if (stream.destroyed) {
            resolve()
            return
          }
          // wait for 'close' (the fd actually released) rather than 'finish' (all data flushed -
          // what end()'s own callback waits for): on Windows a stream whose fd has not yet fully
          // closed can make a following recursive delete of the recording folder fail
          stream.once('close', () => resolve())
          if (!stream.writableEnded) stream.end()
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
  private replaySession: ReplaySession | null = null
  private otherBusyCheck: (() => boolean) | null = null
  /** true while requestCancel() is re-entering itself from a replay's onAbort callback */
  private cancelingViaAbort = false

  /** Lets main/index.ts wire this up against the scenario capture: they refuse to run at once. */
  setOtherBusyCheck(fn: () => boolean): void {
    this.otherBusyCheck = fn
  }

  isActive(): boolean {
    return this.active !== null
  }

  installDisplayMediaHandler(): void {
    // Video only: system audio is captured separately, through our own WASAPI loopback helper
    // (src/main/audio/loopback.ts) - see the CLAUDE.md gotcha for why Chromium's own loopback
    // (the 'audio: loopback' constraint this used to pass here) is not used any more.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        if (this.selectedSource) {
          callback({ video: this.selectedSource })
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

  async prepare(displayId: number, options?: RecordOptions): Promise<{ id: string; countdownEndsAt: number }> {
    if (this.active) throw new Error('A recording is already in progress')
    if (this.otherBusyCheck?.()) throw new Error('A scenario capture is already in progress')
    const displays = await this.listDisplays()
    const info = displays.find((d) => d.id === displayId) ?? displays[0]
    if (!info) throw new Error('No display available for recording')
    const source = this.sources.get(info.sourceId)
    const display = screen.getAllDisplays().find((d) => d.id === info.id) ?? screen.getPrimaryDisplay()
    if (!source) throw new Error('Display source not found')

    try {
      if (options?.scenario) {
        this.replaySession = await ReplaySession.create(display, options.scenario, {
          onProgress: (index, total) => {
            this.setBarState({ ...this.barState, replay: { index: index + 1, total } })
          },
          onDone: () => this.requestStop(),
          onAbort: () => this.cancelFromReplay(),
          onError: () => this.cancelFromReplay()
        })
      }

      this.selectedSource = source
      const id = await newRecordingId()
      const dir = projectDir(id)
      await fsp.mkdir(dir, { recursive: true })
      this.active = {
        id,
        dir,
        display,
        displayName: info.name,
        origin: { displayId: info.id, audio: options?.audio ?? null, scenarioId: options?.scenario?.id ?? null },
        startedAt: null,
        meta: null,
        rawPath: null,
        stream: null,
        bytes: 0,
        // window layout is captured in the background; used later for "crop to window"
        windowsAtStart: snapshotWindows(display),
        stopRequestedAt: null,
        audio: { mic: null, system: null },
        loopback: null,
        systemRawPath: null,
        systemFormat: null,
        systemAudioFailed: false,
        systemAudioPromise: null,
        systemFrames: null
      }
      await updateSettings({ lastDisplayId: displayId })
      await this.tracker.start(display)

      // Started here (rather than in started()) so it is already running well before the first
      // video frame - the ~3.2s countdown below gives it a large margin. Not awaited: starting
      // the helper takes ~1s, and awaiting it here delayed hiding the main window / showing the
      // countdown bar by that much. started() awaits this same promise before reading its
      // result. A failure must not fail the whole recording (see startSystemAudio): the renderer
      // never captures system audio itself any more, so this is the only place it can come from.
      if (options?.audio?.system) this.active.systemAudioPromise = this.startSystemAudio(this.active)

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
    } catch (err) {
      this.replaySession?.dispose()
      this.replaySession = null
      // startSystemAudio() never throws (catches its own errors), but it may still be in flight
      // (see above) - wait for it to settle before checking `loopback`, or an immediate retry
      // from the renderer could leak this attempt's helper process and race its temp .ps1
      // (fixed name, reused per-process) against the retry's own write of the same file.
      if (this.active?.systemAudioPromise) await this.active.systemAudioPromise.catch(() => undefined)
      if (this.active?.loopback) await this.active.loopback.dispose()
      this.active = null
      this.selectedSource = null
      throw err
    }
  }

  /**
   * Starts the system-audio loopback helper for `a` (src/main/audio/loopback.ts) and waits for
   * it to report the endpoint's format. Never throws: a failure here (no default playback
   * device, the helper failing to spawn, ...) just means the recording proceeds without system
   * audio - the same "degrade gracefully" contract the renderer used to implement for Chromium's
   * loopback. finishAudio() turns `systemAudioFailed` into the 'systemAudio' warning.
   */
  private async startSystemAudio(a: ActiveRecording): Promise<void> {
    const loopback = new LoopbackCapture()
    const rawPath = join(a.dir, 'system.raw')
    a.systemRawPath = rawPath
    try {
      a.systemFormat = await loopback.start(rawPath)
      a.loopback = loopback
    } catch (err) {
      console.warn('[recorder] system-audio loopback capture failed to start:', err)
      a.systemAudioFailed = true
      await loopback.dispose()
    }
  }

  /**
   * Stops the loopback helper right away - called from finish() immediately after
   * teardownRecordingUi(), before the (possibly long) transcode starts, so the helper is not
   * left tapping the desktop and growing system.raw for the whole transcode. Returns the frame
   * count for finishAudio() (which runs later) to read back via `a.systemFrames`. When the
   * helper's own D line never arrives (stop() timed out and had to kill it), falls back to the
   * raw file's size on disk: a hard-killed helper still leaves a fully flushed file behind
   * (every WriteZeros/fs.Write in the helper's loop completes synchronously before the next poll).
   */
  private async stopSystemAudio(a: ActiveRecording): Promise<number> {
    if (!a.loopback) return 0
    const stopResult = await a.loopback.stop().catch((err) => {
      console.warn('[recorder] loopback helper stop failed:', err)
      return { frames: 0 }
    })
    if (stopResult.frames > 0) return stopResult.frames
    if (a.systemRawPath && a.systemFormat) {
      try {
        const stat = await fsp.stat(a.systemRawPath)
        const bytesPerFrame = a.systemFormat.channels * (a.systemFormat.bits / 8)
        if (bytesPerFrame > 0) return Math.floor(stat.size / bytesPerFrame)
      } catch {
        // raw file missing or unreadable (helper never wrote anything) - genuinely 0 frames
      }
    }
    return 0
  }

  /** Re-enters requestCancel() past its replay-abort branch, once the replay is already released. */
  private cancelFromReplay(): void {
    this.cancelingViaAbort = true
    this.requestCancel()
    this.cancelingViaAbort = false
  }

  async started(id: string, meta: RecordingStartMeta): Promise<void> {
    const a = this.requireActive(id)
    a.startedAt = meta.startedAt
    a.meta = meta
    a.rawPath = join(a.dir, meta.mimeType.includes('mp4') ? 'raw.mp4' : 'raw.webm')
    a.stream = createWriteStream(a.rawPath)
    if (meta.audio?.mic) {
      const rawPath = join(a.dir, 'mic.webm')
      a.audio.mic = { rawPath, stream: createWriteStream(rawPath), startWall: meta.audio.mic.startWall }
    }
    // System audio: prepare() kicked the helper off without awaiting it (see its own comment),
    // so it may occasionally still be starting up here - the ~3.2s countdown almost always
    // already covers it, but await it anyway to be sure before reading its result. By the time
    // this resolves the helper has long since seen its first frame and set startWall, unless it
    // failed outright (a.loopback is then null).
    if (a.systemAudioPromise) await a.systemAudioPromise
    if (a.loopback && a.systemRawPath && a.systemFormat) {
      const startWall = a.loopback.startWall
      if (startWall !== null) {
        a.audio.system = { rawPath: a.systemRawPath, startWall, format: a.systemFormat }
      }
    }
    this.setBarState({
      phase: 'recording',
      startedAt: meta.startedAt,
      countdownEndsAt: null,
      audio: { mic: Boolean(meta.audio?.mic), system: Boolean(a.loopback) },
      replay: this.replaySession ? { index: 0, total: this.replaySession.total } : undefined
    })
    // the helper's Stopwatch is anchored on this epoch; 800ms gives it (and the pre-positioned
    // cursor) a moment of lead before the first captured action fires
    this.replaySession?.go(meta.startedAt + 800)
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
    // stop injecting input immediately; the recording itself keeps running to a normal finish
    if (this.replaySession) void this.replaySession.stopReplay()
    this.active.stopRequestedAt = Date.now()
    this.setBarState({ ...this.barState, phase: 'processing' })
    getMainWindow()?.webContents.send('recorder:stop')
  }

  requestCancel(): void {
    if (!this.active) return
    if (this.replaySession && !this.cancelingViaAbort) {
      // release input first (this re-enters requestCancel() via onAbort, past this branch, once
      // the helper has actually stopped pressing keys/buttons); a replay already in a terminal
      // phase (or disposed) makes abort() a no-op that resolves false immediately - fall through
      // to the normal cancel path right away instead of leaving the bar's X dead until finish()
      // eventually tears the recording down on its own
      void this.replaySession.abort('bar').then((aborted) => {
        if (!aborted) getMainWindow()?.webContents.send('recorder:cancel')
      })
      return
    }
    getMainWindow()?.webContents.send('recorder:cancel')
  }

  async finish(id: string): Promise<{ project: Project; warnings: RecordingWarning[] }> {
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

      // Stop the system-audio helper right away, before the transcode below (which can take a
      // while): otherwise it keeps capturing the desktop and system.raw keeps growing for the
      // whole transcode. finishAudio() (much later) reads the frame count back from `systemFrames`.
      a.systemFrames = await this.stopSystemAudio(a)

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
        blurs: [],
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
        origin: a.origin,
        updatedAt: Date.now()
      }
      const { clips, warnings } = await this.finishAudio(a, createdAt, estimatedDuration, progress)
      project.audio = clips
      await saveProject(project)
      progress({ phase: 'done', percent: 100 })
      return { project, warnings }
    } catch (err) {
      progress({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      this.teardownRecordingUi()
      throw err
    } finally {
      // the success path already closes/stops most of these above; on an error thrown before
      // that point (transcode, probe, snapshot, ...) they would otherwise stay open/running
      // forever, and the raw file would otherwise only ever get deleted by finishAudio's own
      // success branch - never on this error path, nor when systemAudioFailed left it unset.
      await closeAudioStreams(a)
      if (a.systemAudioPromise) await a.systemAudioPromise.catch(() => undefined)
      if (a.loopback) await a.loopback.dispose()
      if (a.systemRawPath) await fsp.rm(a.systemRawPath, { force: true }).catch(() => undefined)
      this.active = null
      this.selectedSource = null
    }
  }

  /**
   * Converts every raw audio track captured alongside the video into an AAC .m4a, probes its
   * duration and turns it into an AudioClip. A track that fails to convert is logged and skipped
   * (never fails the whole recording); the raw file itself is always removed in finish()'s
   * finally, not here. System audio additionally reports the 'systemAudio' warning whenever it
   * ends up with no clip: the helper failed to start (systemAudioFailed), produced no frames
   * (a.systemFrames, stashed by stopSystemAudio() - already stopped by the time this runs), or
   * its raw file failed to convert.
   */
  private async finishAudio(
    a: ActiveRecording,
    startedAt: number,
    estimatedDuration: number,
    progress: (p: Omit<RecordingProgress, 'id'>) => void
  ): Promise<{ clips: AudioClip[]; warnings: RecordingWarning[] }> {
    await closeAudioStreams(a)
    const clips: AudioClip[] = []
    const warnings: RecordingWarning[] = []

    // ---- system (own WASAPI loopback helper; src/main/audio/loopback.ts) ----
    if (a.loopback) {
      const system = a.audio.system
      const frames = a.systemFrames ?? 0
      let addedClip = false
      if (system && frames > 0) {
        const outPath = join(a.dir, 'system.m4a')
        let converted = false
        try {
          progress({ phase: 'audio', percent: 0 })
          await convertRawAudio(system.rawPath, outPath, system.format, estimatedDuration, (percent) => progress({ phase: 'audio', percent }))
          converted = true
          const probe = await probeAudio(outPath)
          clips.push({
            id: randomUUID(),
            kind: 'system',
            file: 'system.m4a',
            name: 'System audio',
            start: system.startWall - startedAt,
            durationMs: probe.durationMs,
            ...newAudioClipDefaults('system')
          })
          addedClip = true
        } catch (err) {
          console.warn('[recorder] system audio conversion failed:', err)
          // convertRawAudio succeeded but probing its output failed: do not leave an orphan .m4a
          if (converted) await fsp.rm(outPath, { force: true }).catch(() => undefined)
        }
      }
      if (!addedClip) warnings.push('systemAudio')
    } else if (a.systemAudioFailed) {
      warnings.push('systemAudio')
    }

    // ---- mic (renderer's own opus MediaRecorder, chunked over recording:audio-chunk) ----
    const mic = a.audio.mic
    if (mic) {
      const outPath = join(a.dir, 'mic.m4a')
      let converted = false
      try {
        progress({ phase: 'audio', percent: 0 })
        await convertAudio(mic.rawPath, outPath, estimatedDuration, (percent) => progress({ phase: 'audio', percent }))
        converted = true
        const probe = await probeAudio(outPath)
        clips.push({
          id: randomUUID(),
          kind: 'mic',
          file: 'mic.m4a',
          name: 'Microphone',
          start: mic.startWall - startedAt,
          durationMs: probe.durationMs,
          ...newAudioClipDefaults('mic')
        })
      } catch (err) {
        console.warn(`[recorder] audio conversion failed for 'mic':`, err)
        if (converted) await fsp.rm(outPath, { force: true }).catch(() => undefined)
      } finally {
        await fsp.rm(mic.rawPath, { force: true }).catch(() => undefined)
      }
    }

    return { clips, warnings }
  }

  async cancel(id: string): Promise<void> {
    const a = this.active
    if (!a || a.id !== id) return
    this.tracker.stop(null)
    // release any input the replay helper might still be holding before spending time on the
    // audio flush below - a helper that was mid-keystroke when cancel arrived must not keep a
    // modifier held any longer than necessary just because closing the audio streams takes a moment
    this.replaySession?.dispose()
    this.replaySession = null
    // startSystemAudio() may still be starting up (prepare() does not await it) - wait for it to
    // settle before touching `loopback`, or a helper that finishes starting a moment after this
    // runs would never get disposed. Then kill outright rather than a graceful stop(): the raw
    // file is about to be deleted with the rest of the folder anyway, nothing to gain from
    // waiting on its D line.
    if (a.systemAudioPromise) await a.systemAudioPromise.catch(() => undefined)
    if (a.loopback) await a.loopback.dispose()
    if (a.stream) {
      await new Promise<void>((resolve) => a.stream!.end(() => resolve()))
    }
    await closeAudioStreams(a)
    this.teardownRecordingUi()
    this.active = null
    this.selectedSource = null
    // maxRetries/retryDelay: a still-closing audio stream fd (or antivirus) can otherwise make
    // this fail on Windows even after closeAudioStreams() above has resolved
    await fsp.rm(a.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }

  dispose(): void {
    this.tracker.dispose()
    this.replaySession?.dispose()
    this.replaySession = null
    const a = this.active
    if (a) {
      // startSystemAudio() may still be starting up (prepare() does not await it): if so, wait
      // for it to settle before disposing, otherwise a helper that finishes starting a moment
      // after quit began would never get killed.
      const disposeLoopback = (): void => {
        if (a.loopback) void a.loopback.dispose()
      }
      if (a.systemAudioPromise) void a.systemAudioPromise.then(disposeLoopback, disposeLoopback)
      else disposeLoopback()
    }
    if (this.bar && !this.bar.isDestroyed()) this.bar.close()
  }

  private teardownRecordingUi(): void {
    globalShortcut.unregister(STOP_SHORTCUT)
    // a replay never outlives its recording
    this.replaySession?.dispose()
    this.replaySession = null
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
