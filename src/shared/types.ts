/**
 * Shared data model used by the main process, the preload bridge and the renderer.
 * All times are milliseconds. "Source time" is the time inside the recorded video;
 * "output time" is the time in the exported video after cuts have been removed.
 * All coordinates are normalized (0..1) unless stated otherwise.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  sourceId: string
  name: string
  bounds: Rect
  scaleFactor: number
  primary: boolean
  /** Data URL of a small thumbnail. */
  thumbnail: string
}

export interface CursorSample {
  /** ms since recording start */
  t: number
  /** normalized position inside the captured display */
  x: number
  y: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export interface ClickEvent {
  t: number
  x: number
  y: number
  button: MouseButton
}

export interface CursorData {
  samples: CursorSample[]
  clicks: ClickEvent[]
  /** how the data was captured; polling has no click events */
  source: 'uiohook' | 'polling' | 'none'
}

export interface RecordingInfo {
  id: string
  createdAt: number
  dir: string
  /** transcoded, seekable H.264 MP4 used by the editor */
  videoPath: string
  width: number
  height: number
  durationMs: number
  fps: number
  displayName: string
}

/** A removed range of source time. */
export interface CutRange {
  id: string
  start: number
  end: number
}

export type TextAnimation = 'none' | 'fade' | 'pop'

export interface TextOverlay {
  id: string
  start: number
  end: number
  text: string
  /** center of the text box, normalized to the output frame */
  x: number
  y: number
  /** font size as a fraction of the output height */
  fontSize: number
  color: string
  background: string
  backgroundOpacity: number
  cornerRadius: number
  bold: boolean
  align: 'left' | 'center' | 'right'
  animation: TextAnimation
  animationMs: number
}

export type BlurStyle = 'blur' | 'pixelate'

/** A rectangle hidden by a blur or pixelation while [start, end) of source time plays. */
export interface BlurRegion {
  id: string
  start: number
  end: number
  /** rectangle in source-normalized coordinates (the whole recording, not the crop) */
  x: number
  y: number
  w: number
  h: number
  style: BlurStyle
  /** blur radius / pixel block size in px at 1080p content height */
  strength: number
}

export type ZoomMode = 'follow' | 'fixed'

export interface ZoomSegment {
  id: string
  start: number
  end: number
  /** 1.0 = no zoom */
  scale: number
  mode: ZoomMode
  /** focus point in source-normalized coordinates (used in fixed mode) */
  target: { x: number; y: number }
  easeInMs: number
  easeOutMs: number
}

export interface CursorSettings {
  highlight: boolean
  highlightColor: string
  /** radius in px at 1080p content height */
  highlightRadius: number
  highlightOpacity: number
  highlightOutline: boolean
  clicks: boolean
  clickColor: string
  rightClickColor: string
  clickRadius: number
  clickDurationMs: number
  /** shifts cursor data relative to the video, to fix sync */
  offsetMs: number
  /** 0..1 how lazily the camera follows the cursor (higher = smoother/slower) */
  followSmoothing: number
  /** normalized radius around the camera center inside which the cursor may move without panning */
  followDeadZone: number
}

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameStyle {
  /** padding as a fraction of the content height */
  padding: number
  /** corner radius in px at 1080p */
  cornerRadius: number
  /** css color, a gradient preset id starting with "gradient:", or "transparent" (GIF only) */
  background: string
  shadow: boolean
}

export type ExportFormat = 'mp4' | 'gif'
export type Mp4Quality = 'low' | 'medium' | 'high' | 'max'
export type GifDither = 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2_4a'
export type GifPaletteMode = 'global' | 'diff' | 'perframe'

export interface GifSettings {
  colors: 256 | 128 | 64 | 32
  dither: GifDither
  /** 0..5, only for bayer */
  bayerScale: number
  paletteMode: GifPaletteMode
  loop: boolean
}

export interface ExportSettings {
  format: ExportFormat
  fileName: string
  folder: string
  /** output scale relative to the source crop, e.g. 1, 0.75, 0.5 */
  scale: number
  fps: number
  mp4Quality: Mp4Quality
  gif: GifSettings
}

/** A top-level window seen on the recorded display, normalized to the display. */
export interface WindowRect {
  title: string
  x: number
  y: number
  w: number
  h: number
}

export interface WindowSnapshot {
  /** ms since recording start (0 = at start, duration = at the end) */
  t: number
  windows: WindowRect[]
}

/** How a recording was made – what "Record again" repeats, and the scenario it belongs to on the
 * home screen. Absent on projects recorded before 0.4. */
export interface RecordingOrigin {
  /** the display that was actually captured (the requested one, or the fallback when it was gone) */
  displayId: number
  audio: AudioCaptureOptions | null
  /** the scenario replayed into this recording; null for a plain recording */
  scenarioId: string | null
}

export interface Project {
  version: 1
  id: string
  name: string
  recording: RecordingInfo
  cursorData: CursorData
  /** window layout captured at the start and the end of the recording (for crop-to-window) */
  windows: WindowSnapshot[]
  cuts: CutRange[]
  texts: TextOverlay[]
  zooms: ZoomSegment[]
  blurs: BlurRegion[]
  audio: AudioClip[]
  cursor: CursorSettings
  crop: CropRect
  frame: FrameStyle
  export: ExportSettings
  /** how it was recorded (display, audio, scenario); absent on projects recorded before 0.4 */
  origin?: RecordingOrigin
  updatedAt: number
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  durationMs: number
  width: number
  height: number
  dir: string
  /** the scenario this recording was replayed from, null for a plain (or pre-0.4) recording */
  scenarioId: string | null
}

export interface RecordingStartMeta {
  startedAt: number
  mimeType: string
  width: number
  height: number
  fps: number
  /** wall-clock time the mic MediaRecorder started, for turning it into a clip offset. System
   * audio has no entry here: its own helper (src/main/audio/loopback.ts) is started by
   * RecordingController.prepare() and main reads its startWall directly in started(). */
  audio?: { mic?: { startWall: number } }
}

export type RecordingPhase = 'idle' | 'countdown' | 'recording' | 'processing' | 'scenario'

export interface RecorderBarState {
  phase: RecordingPhase
  startedAt: number | null
  countdownEndsAt: number | null
  /** audio being captured, for a small indicator on the bar */
  audio?: { mic: boolean; system: boolean }
  /** what the countdown leads to; 'scenario' = capturing input, not video */
  mode?: 'record' | 'scenario'
  /** number of actions captured so far (phase 'scenario') */
  actions?: number
  /** replay progress while recording; null/undefined = plain recording */
  replay?: { index: number; total: number } | null
}

export interface RecordingProgress {
  id: string
  phase: 'transcode' | 'analyze' | 'audio' | 'done' | 'error'
  percent: number
  message?: string
}

export interface ExportBeginRequest {
  fileName: string
  folder: string
  format: ExportFormat
  /**
   * When set, frames are streamed as raw RGBA into ffmpeg (lossless intermediate with alpha)
   * instead of being encoded with WebCodecs. Used for transparent GIFs and as a fallback.
   */
  raw?: { width: number; height: number; fps: number }
}

export interface ExportBeginResult {
  exportId: string
  tempPath: string
}

export interface ExportFinishResult {
  outputPath: string
  bytes: number
}

export interface ExportProgress {
  exportId: string
  phase: 'encode' | 'palette' | 'quantize' | 'done' | 'error'
  percent: number
  message?: string
}

export type Language = 'system' | 'en' | 'ru'

export interface AppSettings {
  lastExportFolder: string | null
  lastDisplayId: number | null
  language: Language
  /** last used cursor / frame settings, applied to new projects */
  cursorDefaults: CursorSettings | null
  frameDefaults: FrameStyle | null
  /** last used microphone / system audio choice, applied to new recordings */
  audioDefaults: AudioCaptureOptions | null
}

export interface AppInfo {
  version: string
  recordingsDir: string
  ffmpegPath: string | null
  platform: string
}

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error'

/** Auto-update state pushed from the main process (src/main/updater.ts). */
export interface UpdateState {
  status: UpdateStatus
  /** why updates are off: an unpackaged dev run, the portable exe, or a test run */
  reason: 'dev' | 'portable' | 'test' | null
  currentVersion: string
  /** version offered by the feed while available / downloading / downloaded */
  version: string | null
  /** download progress, 0–100 */
  percent: number
  /** what went wrong, for a manual check */
  message: string | null
  checkedAt: number | null
}

// ---- audio ----

export type AudioClipKind = 'system' | 'mic' | 'voiceover' | 'music' | 'file'

/** Which raw audio channel a captured chunk belongs to (recording:audio-chunk). Mic only: system
 * audio is captured directly by main through its own WASAPI loopback helper
 * (src/main/audio/loopback.ts), never chunked over IPC. */
export type AudioTrackKind = 'mic'

/** Non-fatal problems recording.finish() reports alongside the finished project - degraded
 * results the recording still succeeded despite (contrast with a rejected finish(), which means
 * the recording itself failed). */
export type RecordingWarning = 'systemAudio'

export interface AudioClip {
  id: string
  kind: AudioClipKind
  /** file name inside the project folder (always .m4a, AAC 48 kHz stereo) */
  file: string
  name: string
  /**
   * 'system' | 'mic' (recorded with the video): SOURCE time (ms) at which the file's t=0 sits – usually ≤ 0,
   * the audio recorder starts a moment before the first video frame. The clip follows the video through cuts.
   * Other kinds (overlays): OUTPUT time (ms) at which the clip starts; cuts do not move it.
   */
  start: number
  durationMs: number
  /** 0..2, 1 = as recorded */
  volume: number
  muted: boolean
  /** repeat the file until the output ends (music beds) */
  loop: boolean
  fadeInMs: number
  fadeOutMs: number
  /** id of the bundled library track (resources/music/manifest.json), when kind === 'music' –
   * an older project can carry an id from the removed procedural presets; nothing reads this
   * back except as a display fallback (see clipLabel in src/renderer/src/audio/clipLabel.tsx). */
  preset?: string
}

export interface AudioCaptureOptions {
  mic: boolean
  micDeviceId: string | null
  system: boolean
}

/** Mood tag on a bundled library track (resources/music/manifest.json), shown translated in the
 * "Add music" picker via `music.mood.<mood>`. */
export type MusicMood = 'upbeat' | 'corporate' | 'bright' | 'lofi' | 'calm' | 'minimal'

/** One row of the bundled CC0 music library, returned by audio:music-list (see
 * src/main/audio/musicLibrary.ts). `path` is the absolute file path, fed to `media.url()` for
 * a `zc-media://` preview URL; `durationMs` is probed from the file, not trusted from the id. */
export interface MusicTrack {
  id: string
  title: string
  artist: string
  mood: MusicMood
  durationMs: number
  path: string
}

/** What the renderer computes for the export (all times ms, output timeline). */
export interface AudioExportPiece {
  /** span of the audio file to use */
  fileStart: number
  fileEnd: number
  /** output time where the piece starts */
  outAt: number
}
export interface AudioExportTrack {
  /** absolute path */
  path: string
  /** the clip's own file duration (ms); a piece with fileEnd beyond this needs aloop */
  durationMs: number
  pieces: AudioExportPiece[]
  volume: number
  fadeInMs: number
  fadeOutMs: number
}
export interface AudioExportPlan {
  tracks: AudioExportTrack[]
  outDurationMs: number
}

// ---- scenario ----
export type ScenarioActionKind = 'click' | 'doubleClick' | 'rightClick' | 'middleClick' | 'drag' | 'scroll' | 'type' | 'key'
export interface ScenarioPoint { x: number; y: number }
/** dt = ms since the previous point in the path (or the previous action's end, for the first point); positions in DIP screen coordinates (virtual screen) */
export interface ScenarioPathPoint extends ScenarioPoint { dt: number }
export interface ScenarioModifiers { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
/** crop of the screen around the action, file relative to the scenario dir, rect in DIP screen coordinates */
export interface ScenarioShot { file: string; x: number; y: number; w: number; h: number }

export interface ScenarioActionBase {
  id: string
  kind: ScenarioActionKind
  /** ms from the scenario start when the action happens (mouse down / first key) */
  at: number
  /** mouse position when the action happens, DIP */
  x: number
  y: number
  /** recorded mouse movement from the previous action to (x, y): recorded, currently not
   * replayed (compileScenario in shared/scenario.ts always moves in a straight eased line
   * instead) - kept in the data model for a possible future "as recorded" replay option */
  path: ScenarioPathPoint[]
  modifiers: ScenarioModifiers
  shot: ScenarioShot | null
}
export interface ScenarioClickAction extends ScenarioActionBase { kind: 'click' | 'doubleClick' | 'rightClick' | 'middleClick' }
export interface ScenarioDragAction extends ScenarioActionBase { kind: 'drag'; toX: number; toY: number; dragPath: ScenarioPathPoint[]; durationMs: number }
/** deltaY/deltaX in wheel notches (positive = down / right); replayed as `steps` wheel events over durationMs */
export interface ScenarioScrollAction extends ScenarioActionBase { kind: 'scroll'; deltaY: number; deltaX: number; durationMs: number }
export interface ScenarioTypeAction extends ScenarioActionBase { kind: 'type'; text: string; durationMs: number }
/** a non-text key or a chord: `key` is a display label ("Enter", "Ctrl+S"), vk = Windows virtual-key code, scan = set-1 scancode */
export interface ScenarioKeyAction extends ScenarioActionBase { kind: 'key'; key: string; vk: number; scan: number; extended: boolean }
export type ScenarioAction = ScenarioClickAction | ScenarioDragAction | ScenarioScrollAction | ScenarioTypeAction | ScenarioKeyAction

export interface Scenario {
  version: 1
  id: string
  name: string
  createdAt: number
  displayId: number
  /** DIP bounds and scale of the display it was recorded on */
  displayBounds: Rect
  scaleFactor: number
  actions: ScenarioAction[]
  /** cursor position, DIP, at the moment capture began (end of the countdown) - compileScenario
   * (shared/scenario.ts) uses it as the start of the very first action's leading move; missing
   * on a scenario captured before this field existed (falls back to no initial move). */
  startPoint?: ScenarioPoint
  /**
   * ms; the RECORDED capture length (when Stop was pressed, ≥ last action end at that time) -
   * frozen at capture time, never updated by review-screen edits (retiming/deleting actions).
   * UI code showing "how long is this scenario" should use scenarioEnd(actions) instead
   * (src/shared/scenario.ts), which reflects the current, possibly-edited end.
   */
  durationMs: number
  /** absolute folder (userData/scenarios/<id>) holding scenario.json and shots/ */
  dir: string
}
/** durationMs here is scenarioEnd(actions) (see Scenario.durationMs), not the frozen recorded length. */
export interface ScenarioSummary { id: string; name: string; createdAt: number; actions: number; durationMs: number }

export interface ScenarioCaptureState {
  phase: 'idle' | 'countdown' | 'capturing' | 'saving'
  actions: number
  startedAt: number | null
}
export interface ReplayState {
  phase: 'idle' | 'preparing' | 'ready' | 'running' | 'done' | 'aborted' | 'error'
  index: number
  total: number
  message?: string
}
/** what the overlay window draws; x/y (and toX/toY) are DIP relative to the display's top-left */
export interface OverlayEffect {
  kind: ScenarioActionKind
  x: number
  y: number
  label?: string
  index: number
  total: number
  /** drag only: end point, for the fading line from the start (x/y) to here */
  toX?: number
  toY?: number
  /** scroll only: wheel notches, same sign convention as ScenarioScrollAction (positive = down/right) */
  deltaY?: number
  deltaX?: number
}

/** Options for recording.prepare() / useRecorder's start(): what to capture besides the screen
 * (microphone / system audio) and, for the scenario recorder, which scenario to replay while
 * recording. RecordingController.prepare() reads `audio.system` itself (starts the loopback
 * helper, src/main/audio/loopback.ts) and `scenario`; the renderer still captures the microphone
 * itself (see useRecorder.ts) and reads `audio.mic`/`audio.micDeviceId`. */
export interface RecordOptions {
  audio?: AudioCaptureOptions
  scenario?: Scenario
}

// ---- composition ----
/** One recording placed in a composition; the project is referenced, not copied, so the
 * composition always plays the recording with its current edits. */
export interface CompositionItem {
  id: string
  projectId: string
}

export interface Composition {
  version: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  items: CompositionItem[]
  /** output frame at 100 % scale; null = the first recording's own output size */
  size: { width: number; height: number } | null
  /** fills the frame around a recording whose aspect ratio differs from the output */
  background: string
  export: ExportSettings
}

export interface CompositionSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  items: number
}

// ---- gif converter ----
export interface VideoFileInfo {
  path: string
  /** file name without the extension */
  name: string
  width: number
  height: number
  durationMs: number
  fps: number
}

export interface GifConvertRequest {
  input: string
  folder: string
  fileName: string
  fps: number
  /** output width in px; the height follows the aspect ratio */
  width: number
  /** trimmed span of the input, ms */
  startMs: number
  endMs: number
  gif: GifSettings
}

export interface GifConvertProgress {
  phase: 'palette' | 'quantize' | 'done' | 'error'
  percent: number
  message?: string
}
