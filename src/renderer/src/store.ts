import { create } from 'zustand'
import type {
  CropRect,
  CursorSettings,
  CutRange,
  ExportSettings,
  FrameStyle,
  Project,
  TextOverlay,
  ZoomSegment
} from '@shared/types'
import { TEXT_DEFAULTS, ZOOM_DEFAULTS } from '@shared/defaults'
import { uid } from './engine/ids'
import { keepSegments, normalizeCuts } from './engine/timeline'
import { findZoom, resolveZoomOverlaps } from './engine/camera'

export type Selection = { kind: 'cut' | 'zoom' | 'text'; id: string } | null
export type EditorMode = 'normal' | 'pickTarget' | 'crop'
export interface RangeSelection {
  start: number
  end: number
}

const HISTORY_LIMIT = 60

export interface EditorState {
  screen: 'home' | 'editor'
  project: Project | null
  playheadMs: number
  playing: boolean
  /** bumped whenever the user explicitly seeks, so the player applies it */
  seekSeq: number
  selection: Selection
  range: RangeSelection | null
  mode: EditorMode
  pxPerMs: number
  history: Project[]
  future: Project[]
  exportOpen: boolean

  openProject(project: Project): void
  closeProject(): void
  setPlayhead(ms: number, seek?: boolean): void
  setPlaying(playing: boolean): void
  togglePlay(): void
  select(selection: Selection): void
  setRange(range: RangeSelection | null): void
  setMode(mode: EditorMode): void
  setPxPerMs(value: number): void
  setExportOpen(open: boolean): void

  mutate(fn: (p: Project) => Project, record?: boolean): void
  checkpoint(): void
  undo(): void
  redo(): void

  addCut(start: number, end: number): void
  removeCut(id: string): void
  addZoom(at?: number): string | null
  updateZoom(id: string, patch: Partial<ZoomSegment>, record?: boolean): void
  removeZoom(id: string): void
  setZooms(zooms: ZoomSegment[]): void
  addText(at?: number): string | null
  updateText(id: string, patch: Partial<TextOverlay>, record?: boolean): void
  removeText(id: string): void
  updateCursor(patch: Partial<CursorSettings>, record?: boolean): void
  setCrop(crop: CropRect, record?: boolean): void
  updateFrame(patch: Partial<FrameStyle>, record?: boolean): void
  updateExport(patch: Partial<ExportSettings>): void
  setName(name: string): void
  deleteSelected(): void
}

export const useStore = create<EditorState>((set, get) => ({
  screen: 'home',
  project: null,
  playheadMs: 0,
  playing: false,
  seekSeq: 0,
  selection: null,
  range: null,
  mode: 'normal',
  pxPerMs: 0.08,
  history: [],
  future: [],
  exportOpen: false,

  openProject: (project) =>
    set({
      screen: 'editor',
      project,
      playheadMs: 0,
      playing: false,
      seekSeq: get().seekSeq + 1,
      selection: null,
      range: null,
      mode: 'normal',
      history: [],
      future: [],
      exportOpen: false
    }),

  closeProject: () => set({ screen: 'home', project: null, playing: false, history: [], future: [] }),

  setPlayhead: (ms, seek = false) => {
    const p = get().project
    const clamped = Math.max(0, Math.min(p?.recording.durationMs ?? ms, ms))
    set(seek ? { playheadMs: clamped, seekSeq: get().seekSeq + 1 } : { playheadMs: clamped })
  },
  setPlaying: (playing) => set({ playing }),
  togglePlay: () => set({ playing: !get().playing }),
  select: (selection) => set({ selection, range: selection ? null : get().range }),
  setRange: (range) => set({ range, selection: range ? null : get().selection }),
  setMode: (mode) => set({ mode, playing: mode === 'normal' ? get().playing : false }),
  setPxPerMs: (value) => set({ pxPerMs: Math.max(0.005, Math.min(2, value)) }),
  setExportOpen: (exportOpen) => set({ exportOpen, playing: false }),

  mutate: (fn, record = true) => {
    const project = get().project
    if (!project) return
    const next = fn(project)
    if (next === project) return
    set({
      project: { ...next, updatedAt: Date.now() },
      history: record ? [...get().history.slice(-(HISTORY_LIMIT - 1)), project] : get().history,
      future: record ? [] : get().future
    })
  },

  checkpoint: () => {
    const project = get().project
    if (!project) return
    set({ history: [...get().history.slice(-(HISTORY_LIMIT - 1)), project], future: [] })
  },

  undo: () => {
    const { history, project } = get()
    if (!project || history.length === 0) return
    const prev = history[history.length - 1]
    set({ project: prev, history: history.slice(0, -1), future: [project, ...get().future].slice(0, HISTORY_LIMIT) })
  },

  redo: () => {
    const { future, project } = get()
    if (!project || future.length === 0) return
    const next = future[0]
    set({ project: next, future: future.slice(1), history: [...get().history, project].slice(-HISTORY_LIMIT) })
  },

  addCut: (start, end) => {
    get().mutate((p) => ({
      ...p,
      cuts: normalizeCuts([...p.cuts, { id: uid('cut'), start, end }], p.recording.durationMs)
    }))
    set({ range: null, selection: null })
  },

  removeCut: (id) => {
    get().mutate((p) => ({ ...p, cuts: p.cuts.filter((c) => c.id !== id) }))
    set({ selection: null })
  },

  addZoom: (at) => {
    const p = get().project
    if (!p) return null
    const t = at ?? get().playheadMs
    const existing = findZoom(p.zooms, t)
    if (existing) {
      set({ selection: { kind: 'zoom', id: existing.id } })
      return existing.id
    }
    const id = uid('zoom')
    const start = Math.max(0, Math.min(t, p.recording.durationMs - 500))
    const zoom: ZoomSegment = { ...ZOOM_DEFAULTS, id, start, end: Math.min(p.recording.durationMs, start + 3000) }
    get().mutate((proj) => ({ ...proj, zooms: resolveZoomOverlaps([...proj.zooms, zoom], id, proj.recording.durationMs) }))
    set({ selection: { kind: 'zoom', id } })
    return id
  },

  updateZoom: (id, patch, record = true) => {
    get().mutate((p) => {
      const zooms = p.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z))
      return { ...p, zooms: resolveZoomOverlaps(zooms, id, p.recording.durationMs) }
    }, record)
  },

  removeZoom: (id) => {
    get().mutate((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== id) }))
    set({ selection: null })
  },

  setZooms: (zooms) => get().mutate((p) => ({ ...p, zooms: [...zooms].sort((a, b) => a.start - b.start) })),

  addText: (at) => {
    const p = get().project
    if (!p) return null
    const t = at ?? get().playheadMs
    const id = uid('text')
    const start = Math.max(0, Math.min(t, p.recording.durationMs - 500))
    const text: TextOverlay = { ...TEXT_DEFAULTS, id, start, end: Math.min(p.recording.durationMs, start + 3000) }
    get().mutate((proj) => ({ ...proj, texts: [...proj.texts, text] }))
    set({ selection: { kind: 'text', id } })
    return id
  },

  updateText: (id, patch, record = true) => {
    get().mutate((p) => ({ ...p, texts: p.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }), record)
  },

  removeText: (id) => {
    get().mutate((p) => ({ ...p, texts: p.texts.filter((t) => t.id !== id) }))
    set({ selection: null })
  },

  updateCursor: (patch, record = true) =>
    get().mutate((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }), record),

  setCrop: (crop, record = true) => get().mutate((p) => ({ ...p, crop }), record),

  updateFrame: (patch, record = true) => get().mutate((p) => ({ ...p, frame: { ...p.frame, ...patch } }), record),

  updateExport: (patch) => get().mutate((p) => ({ ...p, export: { ...p.export, ...patch } }), false),

  setName: (name) => get().mutate((p) => ({ ...p, name }), false),

  deleteSelected: () => {
    const { selection, range } = get()
    if (selection?.kind === 'cut') get().removeCut(selection.id)
    else if (selection?.kind === 'zoom') get().removeZoom(selection.id)
    else if (selection?.kind === 'text') get().removeText(selection.id)
    else if (range && range.end - range.start > 10) get().addCut(range.start, range.end)
  }
}))

export function useProject(): Project {
  const project = useStore((s) => s.project)
  if (!project) throw new Error('No project open')
  return project
}

export function useKeepSegments(): { start: number; end: number }[] {
  const project = useProject()
  return keepSegments(project.recording.durationMs, project.cuts)
}

export type { CutRange }
