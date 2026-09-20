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
  cursor: CursorSettings
  crop: CropRect
  frame: FrameStyle
  export: ExportSettings
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
}

export interface RecordingStartMeta {
  startedAt: number
  mimeType: string
  width: number
  height: number
  fps: number
}

export type RecordingPhase = 'idle' | 'countdown' | 'recording' | 'processing' | 'scenario'

export interface RecorderBarState {
  phase: RecordingPhase
  startedAt: number | null
  countdownEndsAt: number | null
  /** what the countdown leads to; 'scenario' = capturing input, not video */
  mode?: 'record' | 'scenario'
  /** number of actions captured so far (phase 'scenario') */
  actions?: number
  /** replay progress while recording; null/undefined = plain recording */
  replay?: { index: number; total: number } | null
}

export interface RecordingProgress {
  id: string
  phase: 'transcode' | 'analyze' | 'done' | 'error'
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
  /** recorded mouse movement from the previous action to (x, y); [] = synthesize a curve at replay */
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
  /** ms; when the capture was stopped (≥ last action end) */
  durationMs: number
  /** absolute folder (userData/scenarios/<id>) holding scenario.json and shots/ */
  dir: string
}
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
/** what the overlay window draws; x/y are DIP relative to the display's top-left */
export interface OverlayEffect {
  kind: ScenarioActionKind
  x: number
  y: number
  label?: string
  index: number
  total: number
}
