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
  audio: AudioClip[]
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
  /** track A: wall-clock time each audio MediaRecorder started, for turning it into a clip offset */
  audio?: { mic?: { startWall: number }; system?: { startWall: number } }
}

export type RecordingPhase = 'idle' | 'countdown' | 'recording' | 'processing'

export interface RecorderBarState {
  phase: RecordingPhase
  startedAt: number | null
  countdownEndsAt: number | null
  /** track A: audio being captured, for a small indicator on the bar */
  audio?: { mic: boolean; system: boolean }
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

/** Which raw audio channel a captured chunk belongs to (recording:audio-chunk). */
export type AudioTrackKind = 'mic' | 'system'

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
  /** id of the generated music preset, when kind === 'music' */
  preset?: string
}

export interface AudioCaptureOptions {
  mic: boolean
  micDeviceId: string | null
  system: boolean
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
