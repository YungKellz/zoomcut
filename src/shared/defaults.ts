import type {
  CursorSettings,
  ExportSettings,
  FrameStyle,
  GifSettings,
  TextOverlay,
  ZoomSegment
} from './types'

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
  highlight: false,
  highlightColor: '#ffd60a',
  highlightRadius: 26,
  highlightOpacity: 0.35,
  highlightOutline: true,
  clicks: true,
  clickColor: '#ff453a',
  rightClickColor: '#0a84ff',
  clickRadius: 44,
  clickDurationMs: 450,
  offsetMs: 0,
  followSmoothing: 0.6,
  followDeadZone: 0.08
}

export const DEFAULT_FRAME_STYLE: FrameStyle = {
  padding: 0,
  cornerRadius: 0,
  background: '#111214',
  shadow: false
}

export const DEFAULT_GIF_SETTINGS: GifSettings = {
  colors: 256,
  dither: 'none',
  bayerScale: 3,
  paletteMode: 'diff',
  loop: true
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'mp4',
  fileName: '',
  folder: '',
  scale: 1,
  fps: 30,
  mp4Quality: 'high',
  gif: DEFAULT_GIF_SETTINGS
}

export const TEXT_DEFAULTS: Omit<TextOverlay, 'id' | 'start' | 'end'> = {
  text: 'New text',
  x: 0.5,
  y: 0.85,
  fontSize: 0.045,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0.6,
  cornerRadius: 10,
  bold: true,
  align: 'center',
  animation: 'fade',
  animationMs: 220
}

export const ZOOM_DEFAULTS: Omit<ZoomSegment, 'id' | 'start' | 'end'> = {
  scale: 2,
  mode: 'follow',
  target: { x: 0.5, y: 0.5 },
  easeInMs: 600,
  easeOutMs: 500
}

export const GRADIENT_PRESETS: Record<string, [string, string]> = {
  'gradient:dusk': ['#1f1c2c', '#928dab'],
  'gradient:ocean': ['#0f2027', '#2c5364'],
  'gradient:sunset': ['#ff7e5f', '#feb47b'],
  'gradient:mint': ['#0ba360', '#3cba92'],
  'gradient:berry': ['#7f00ff', '#e100ff'],
  'gradient:slate': ['#3a3d40', '#181719']
}

export const MP4_CRF: Record<ExportSettings['mp4Quality'], number> = {
  low: 28,
  medium: 23,
  high: 20,
  max: 17
}

export const GIF_FPS_OPTIONS = [10, 12, 15, 20, 25]
export const MP4_FPS_OPTIONS = [24, 30, 60]
export const SCALE_OPTIONS = [1, 0.75, 0.5]
