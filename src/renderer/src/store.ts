import { create } from 'zustand'
import type {
  AudioCaptureOptions,
  AudioClip,
  BlurRegion,
  Composition,
  CropRect,
  CursorSettings,
  CutRange,
  ExportSettings,
  FrameStyle,
  Project,
  Scenario,
  TextOverlay,
  ZoomSegment
} from '@shared/types'
import { BLUR_DEFAULTS, TEXT_DEFAULTS, ZOOM_DEFAULTS } from '@shared/defaults'
import { uid } from './engine/ids'
import { clipRegionsToCuts, firstKeptTime, keepSegments, normalizeCuts } from './engine/timeline'
import {
  findZoom,
  insertZoomPart,
  normalizeZoomParts,
  patchZoomArea,
  removeZoomPart,
  resolveZoomOverlaps,
  shiftZoomParts,
  zoomAreaFocusMs,
  zoomAreas,
  type ZoomAreaPatch
} from './engine/camera'
import { clamp } from './util/format'
import { t } from './i18n'

export type Selection = { kind: 'cut' | 'zoom' | 'text' | 'audio' | 'blur'; id: string } | null
/** 'blur' = editing the selected blur region's rectangle on the uncropped-by-zoom source */
export type EditorMode = 'normal' | 'pickTarget' | 'crop' | 'blur'
export interface RangeSelection {
  start: number
  end: number
}

/** Zoom area being picked, in crop-normalized coordinates; size = 1 / zoom scale. */
export interface PickRect {
  cx: number
  cy: number
  size: number
}

/**
 * What a screen starts by itself the moment it opens - how "Record again" hands the new attempt
 * over: Home starts a plain recording ('record') or a scenario capture ('capture'), the scenario
 * review replays its scenario with the original audio sources ('replay'). Consumed once, through
 * takePendingStart().
 */
export type PendingStart =
  | { kind: 'record'; displayId: number; audio: AudioCaptureOptions | null }
  | { kind: 'replay'; scenarioId: string; audio: AudioCaptureOptions | null }
  | { kind: 'capture'; displayId: number }

export const PICK_MIN_SIZE = 1 / 5
export const PICK_MAX_SIZE = 1 / 1.2

const HISTORY_LIMIT = 60

/** snapshot taken by checkpoint(), committed by the first unrecorded mutation that changes something */
let pendingCheckpoint: Project | null = null

export interface EditorState {
  screen: 'home' | 'editor' | 'scenario' | 'composition'
  /** transient dismissible notice shown by NoticeBar (App.tsx); outlives Home unmounting */
  notice: string | null
  /** set by "Record again", taken by the screen that starts it (see PendingStart) */
  pendingStart: PendingStart | null
  project: Project | null
  scenario: Scenario | null
  /** open composition; stays set while one of its recordings is edited, so Back returns to it */
  composition: Composition | null
  playheadMs: number
  playing: boolean
  /** bumped whenever the user explicitly seeks, so the player applies it */
  seekSeq: number
  selection: Selection
  range: RangeSelection | null
  mode: EditorMode
  pickRect: PickRect | null
  /** which area pickTarget mode edits: 0 = the zoom's own target/scale, k = parts[k - 1] */
  pickArea: number
  pxPerMs: number
  history: Project[]
  future: Project[]
  exportOpen: boolean
  /** editor UI state (not saved): silences every audio clip, e.g. while recording a voiceover */
  audioMuted: boolean
  /** clip ids whose <audio> element reported a load/decode error (e.g. a missing file);
   * AudioPlayer sets this instead of retrying play() forever, the Audio panel shows a warning */
  audioErrors: Record<string, boolean>

  openProject(project: Project): void
  closeProject(): void
  openScenario(scenario: Scenario): void
  closeScenario(): void
  setScenario(scenario: Scenario): void
  openComposition(composition: Composition): void
  closeComposition(): void
  setComposition(fn: (c: Composition) => Composition): void
  setPlayhead(ms: number, seek?: boolean): void
  setPlaying(playing: boolean): void
  togglePlay(): void
  playFromStart(): void
  select(selection: Selection): void
  setRange(range: RangeSelection | null): void
  setMode(mode: EditorMode): void
  beginPick(zoomId: string, area?: number): void
  setPickRect(rect: PickRect): void
  applyPick(): void
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
  /** adds a part at source time `at`; returns its area index, or null when there is no room */
  addZoomPart(zoomId: string, at: number): number | null
  removeZoomPart(zoomId: string, area: number): void
  updateZoomPart(zoomId: string, area: number, patch: ZoomAreaPatch, record?: boolean): void
  addText(at?: number): string | null
  updateText(id: string, patch: Partial<TextOverlay>, record?: boolean): void
  removeText(id: string): void
  addBlur(at?: number): string | null
  updateBlur(id: string, patch: Partial<BlurRegion>, record?: boolean): void
  removeBlur(id: string): void
  beginBlurEdit(id: string): void
  updateCursor(patch: Partial<CursorSettings>, record?: boolean): void
  setCrop(crop: CropRect, record?: boolean): void
  updateFrame(patch: Partial<FrameStyle>, record?: boolean): void
  updateExport(patch: Partial<ExportSettings>): void
  setName(name: string): void
  deleteSelected(): void
  setNotice(notice: string | null): void
  setPendingStart(start: PendingStart | null): void
  /** Returns the pending start and clears it in one step, but only when `accept` agrees: a
   * StrictMode double-invoked mount effect can then never start twice, and a screen never
   * swallows a start meant for another one. */
  takePendingStart(accept: (start: PendingStart) => boolean): PendingStart | null

  addAudioClip(clip: AudioClip): void
  updateAudioClip(id: string, patch: Partial<AudioClip>, record?: boolean): void
  removeAudioClip(id: string): void
  setAudioMuted(muted: boolean): void
  setAudioError(id: string, hasError: boolean): void
}

export const useStore = create<EditorState>((set, get) => ({
  screen: 'home',
  notice: null,
  pendingStart: null,
  project: null,
  scenario: null,
  composition: null,
  playheadMs: 0,
  playing: false,
  seekSeq: 0,
  selection: null,
  range: null,
  mode: 'normal',
  pickRect: null,
  pickArea: 0,
  pxPerMs: 0.08,
  history: [],
  future: [],
  exportOpen: false,
  audioMuted: false,
  audioErrors: {},

  openProject: (project) =>
    set({
      screen: 'editor',
      project,
      // a scenario replay's own onDone already calls closeScenario() first, but openProject is
      // also reachable from Home directly - either way a stale scenario must never linger
      scenario: null,
      playheadMs: 0,
      playing: false,
      seekSeq: get().seekSeq + 1,
      selection: null,
      range: null,
      mode: 'normal',
      history: [],
      future: [],
      exportOpen: false,
      // a previous project's mute (e.g. mid-voiceover-recording) or file-missing warnings must
      // never bleed into the next project opened
      audioMuted: false,
      audioErrors: {}
    }),

  closeProject: () =>
    set({
      screen: get().composition ? 'composition' : 'home',
      project: null,
      playing: false,
      history: [],
      future: [],
      audioMuted: false,
      audioErrors: {}
    }),

  openScenario: (scenario) => set({ screen: 'scenario', scenario }),
  closeScenario: () => set({ screen: 'home', scenario: null }),
  setScenario: (scenario) => set({ scenario }),
  openComposition: (composition) => set({ screen: 'composition', composition, project: null, scenario: null }),
  closeComposition: () => set({ screen: 'home', composition: null }),
  setComposition: (fn) => {
    const c = get().composition
    if (!c) return
    const next = fn(c)
    if (next !== c) set({ composition: { ...next, updatedAt: Date.now() } })
  },

  setPlayhead: (ms, seek = false) => {
    const p = get().project
    const clamped = Math.max(0, Math.min(p?.recording.durationMs ?? ms, ms))
    set(seek ? { playheadMs: clamped, seekSeq: get().seekSeq + 1 } : { playheadMs: clamped })
  },
  setPlaying: (playing) => set({ playing }),
  togglePlay: () => set({ playing: !get().playing }),
  playFromStart: () => {
    const p = get().project
    if (!p) return
    const start = firstKeptTime(keepSegments(p.recording.durationMs, p.cuts))
    set({ playheadMs: start, seekSeq: get().seekSeq + 1, playing: true, mode: 'normal' })
  },
  select: (selection) =>
    set({
      selection,
      range: selection ? null : get().range,
      // the blur editor edits the selected region: selecting anything else leaves it
      ...(get().mode === 'blur' && selection?.kind !== 'blur' ? { mode: 'normal' as const } : {})
    }),
  setRange: (range) => set({ range, selection: range ? null : get().selection }),
  setMode: (mode) => set({ mode, playing: mode === 'normal' ? get().playing : false, pickRect: mode === 'pickTarget' ? get().pickRect : null }),

  beginPick: (zoomId, area = 0) => {
    const p = get().project
    const z = p?.zooms.find((x) => x.id === zoomId)
    if (!p || !z) return
    const areas = zoomAreas(z)
    const index = clamp(area, 0, areas.length - 1)
    const picked = areas[index]
    const crop = p.crop
    const size = clamp(1 / picked.scale, PICK_MIN_SIZE, PICK_MAX_SIZE)
    let cx = 0.5
    let cy = 0.5
    if (z.mode === 'fixed') {
      cx = (picked.target.x - crop.x) / crop.w
      cy = (picked.target.y - crop.y) / crop.h
    }
    cx = clamp(cx, size / 2, 1 - size / 2)
    cy = clamp(cy, size / 2, 1 - size / 2)
    set({
      mode: 'pickTarget',
      pickRect: { cx, cy, size },
      pickArea: index,
      selection: { kind: 'zoom', id: zoomId },
      range: null,
      playing: false,
      playheadMs: zoomAreaFocusMs(z, index),
      seekSeq: get().seekSeq + 1
    })
  },

  setPickRect: (rect) => set({ pickRect: rect }),

  applyPick: () => {
    const { project: p, pickRect: r, selection } = get()
    if (!p || !r || selection?.kind !== 'zoom') return
    const crop = p.crop
    const target = { x: crop.x + r.cx * crop.w, y: crop.y + r.cy * crop.h }
    const scale = clamp(Math.round((1 / r.size) * 10) / 10, 1.2, 5)
    const area = get().pickArea
    // a part that vanished while picking (undo) is a no-op rather than a write into area 0
    if (area > 0) get().updateZoomPart(selection.id, area, { target, scale })
    else get().updateZoom(selection.id, { mode: 'fixed', target, scale })
    set({ mode: 'normal', pickRect: null })
  },
  setPxPerMs: (value) => set({ pxPerMs: Math.max(0.005, Math.min(2, value)) }),
  setExportOpen: (exportOpen) => set({ exportOpen, playing: false }),

  mutate: (fn, record = true) => {
    const project = get().project
    if (!project) return
    const next = fn(project)
    if (next === project) return
    // an unrecorded change (drag, slider, typing) commits the checkpoint taken when the
    // interaction began; a recorded change makes its own history entry
    const checkpointed = pendingCheckpoint
    pendingCheckpoint = null
    const history = record
      ? [...get().history.slice(-(HISTORY_LIMIT - 1)), project]
      : checkpointed && checkpointed !== project
        ? [...get().history.slice(-(HISTORY_LIMIT - 1)), checkpointed]
        : checkpointed === project
          ? [...get().history.slice(-(HISTORY_LIMIT - 1)), project]
          : get().history
    set({
      project: { ...next, updatedAt: Date.now() },
      history,
      future: record || checkpointed ? [] : get().future
    })
  },

  // Lazy: the snapshot is only pushed to history if the interaction actually changes
  // something, so a mere selecting click or focusing a field costs no undo step.
  checkpoint: () => {
    const project = get().project
    if (!project) return
    pendingCheckpoint = project
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
    get().mutate((p) => {
      const duration = p.recording.durationMs
      const cuts = normalizeCuts([...p.cuts, { id: uid('cut'), start, end }], duration)
      return {
        ...p,
        cuts,
        // a shortened zoom may no longer have room for all its parts
        zooms: clipRegionsToCuts(p.zooms, cuts, duration, 200).map(normalizeZoomParts),
        texts: clipRegionsToCuts(p.texts, cuts, duration, 100),
        blurs: clipRegionsToCuts(p.blurs, cuts, duration, 100)
      }
    })
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
    const duration = p.recording.durationMs
    const at0 = Math.max(0, Math.min(t, duration - 500))
    // the ease-in runs *before* the current frame, so the frame you are looking at is already zoomed;
    // near the start of the video the ease-in shrinks to whatever room there is
    const start = Math.max(0, at0 - ZOOM_DEFAULTS.easeInMs)
    const easeInMs = at0 - start < 100 ? 0 : at0 - start
    const zoom: ZoomSegment = { ...ZOOM_DEFAULTS, id, start, easeInMs, end: Math.min(duration, at0 + 2500) }
    get().mutate((proj) => ({ ...proj, zooms: resolveZoomOverlaps([...proj.zooms, zoom], id, proj.recording.durationMs) }))
    set({ selection: { kind: 'zoom', id } })
    return id
  },

  updateZoom: (id, patch, record = true) => {
    get().mutate((p) => {
      const zooms = p.zooms.map((z) => {
        if (z.id !== id) return z
        const next = { ...z, ...patch }
        // dragging the whole region (both edges move alike) carries its parts along; any other
        // change is normalized by resolveZoomOverlaps, which drops the parts that no longer fit
        const ds = next.start - z.start
        return Math.abs(ds - (next.end - z.end)) < 0.5 ? shiftZoomParts(next, ds) : next
      })
      return { ...p, zooms: resolveZoomOverlaps(zooms, id, p.recording.durationMs) }
    }, record)
  },

  removeZoom: (id) => {
    get().mutate((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== id) }))
    set({ selection: null })
  },

  addZoomPart: (zoomId, at) => {
    const z = get().project?.zooms.find((x) => x.id === zoomId)
    const res = z ? insertZoomPart(z, at, uid('part')) : null
    if (!res) return null
    get().mutate((p) => ({ ...p, zooms: p.zooms.map((x) => (x.id === zoomId ? res.zoom : x)) }))
    return res.index
  },

  removeZoomPart: (zoomId, area) =>
    get().mutate((p) => {
      const z = p.zooms.find((x) => x.id === zoomId)
      const next = z && removeZoomPart(z, area)
      return z && next !== z ? { ...p, zooms: p.zooms.map((x) => (x === z ? next! : x)) } : p
    }),

  updateZoomPart: (zoomId, area, patch, record = true) =>
    get().mutate((p) => {
      const z = p.zooms.find((x) => x.id === zoomId)
      const next = z && patchZoomArea(z, area, patch)
      return z && next !== z ? { ...p, zooms: p.zooms.map((x) => (x === z ? next! : x)) } : p
    }, record),

  setZooms: (zooms) => get().mutate((p) => ({ ...p, zooms: [...zooms].sort((a, b) => a.start - b.start) })),

  addText: (at) => {
    const p = get().project
    if (!p) return null
    const time = at ?? get().playheadMs
    const id = uid('text')
    const duration = p.recording.durationMs
    const at0 = Math.max(0, Math.min(time, duration - 500))
    // same idea as zooms: the fade-in ends at the current frame
    const start = Math.max(0, at0 - TEXT_DEFAULTS.animationMs)
    const animationMs = at0 - start < 80 ? 0 : at0 - start
    const text: TextOverlay = {
      ...TEXT_DEFAULTS,
      text: t('text.default'),
      id,
      start,
      animationMs,
      end: Math.min(duration, at0 + 2500)
    }
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

  addBlur: () => {
    const p = get().project
    if (!p) return null
    const duration = p.recording.durationMs
    const id = uid('blur')
    // centered in the current crop, so a new rectangle is always on screen
    const c = p.crop
    const region: BlurRegion = {
      ...BLUR_DEFAULTS,
      id,
      x: c.x + BLUR_DEFAULTS.x * c.w,
      y: c.y + BLUR_DEFAULTS.y * c.h,
      w: BLUR_DEFAULTS.w * c.w,
      h: BLUR_DEFAULTS.h * c.h,
      // a new blur covers the whole recording by default
      start: 0,
      end: duration
    }
    get().mutate((proj) => ({ ...proj, blurs: [...proj.blurs, region] }))
    set({ selection: { kind: 'blur', id }, range: null, mode: 'blur', playing: false, pickRect: null })
    return id
  },

  updateBlur: (id, patch, record = true) =>
    get().mutate((p) => ({ ...p, blurs: p.blurs.map((b) => (b.id === id ? { ...b, ...patch } : b)) }), record),

  removeBlur: (id) => {
    get().mutate((p) => ({ ...p, blurs: p.blurs.filter((b) => b.id !== id) }))
    set({ selection: null, mode: get().mode === 'blur' ? 'normal' : get().mode })
  },

  beginBlurEdit: (id) => {
    const p = get().project
    const b = p?.blurs.find((x) => x.id === id)
    if (!p || !b) return
    const head = get().playheadMs
    // the rectangle is drawn over a frame in which it is actually active
    const inside = head >= b.start && head < b.end
    set({
      mode: 'blur',
      selection: { kind: 'blur', id },
      range: null,
      playing: false,
      pickRect: null,
      ...(inside ? {} : { playheadMs: b.start, seekSeq: get().seekSeq + 1 })
    })
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
    else if (selection?.kind === 'audio') get().removeAudioClip(selection.id)
    else if (selection?.kind === 'blur') get().removeBlur(selection.id)
    else if (range && range.end - range.start > 10) get().addCut(range.start, range.end)
  },

  addAudioClip: (clip) => {
    get().mutate((p) => ({ ...p, audio: [...p.audio, clip] }))
    set({ selection: { kind: 'audio', id: clip.id } })
  },

  updateAudioClip: (id, patch, record = true) =>
    get().mutate((p) => ({ ...p, audio: p.audio.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), record),

  removeAudioClip: (id) => {
    // the underlying file is NOT deleted here: this change is undoable (Ctrl+Z), and deleting
    // eagerly would leave a restored clip pointing at a file that no longer exists. Orphaned
    // files are swept once, when the editor closes and undo history is discarded (main.tsx).
    get().mutate((p) => ({ ...p, audio: p.audio.filter((c) => c.id !== id) }))
    set({ selection: null })
  },

  setAudioMuted: (audioMuted) => set({ audioMuted }),

  setAudioError: (id, hasError) =>
    set((s) => {
      if (Boolean(s.audioErrors[id]) === hasError) return s
      const next = { ...s.audioErrors }
      if (hasError) next[id] = true
      else delete next[id]
      return { audioErrors: next }
    }),

  setNotice: (notice) => set({ notice }),

  setPendingStart: (pendingStart) => set({ pendingStart }),

  takePendingStart: (accept) => {
    const pending = get().pendingStart
    if (!pending || !accept(pending)) return null
    set({ pendingStart: null })
    return pending
  }
}))

export function useProject(): Project {
  const project = useStore((s) => s.project)
  if (!project) throw new Error('No project open')
  return project
}

export function useScenario(): Scenario {
  const scenario = useStore((s) => s.scenario)
  if (!scenario) throw new Error('No scenario open')
  return scenario
}

export function useKeepSegments(): { start: number; end: number }[] {
  const project = useProject()
  return keepSegments(project.recording.durationMs, project.cuts)
}

export type { CutRange }
