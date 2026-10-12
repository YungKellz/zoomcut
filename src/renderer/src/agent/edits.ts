import type { BlurRegion, CropRect, CursorSettings, FrameStyle, Project, TextOverlay, ZoomSegment } from '@shared/types'
import { AgentError, type AgentEditOp } from '@shared/agent'
import { BLUR_DEFAULTS, GRADIENT_PRESETS, TEXT_DEFAULTS, ZOOM_DEFAULTS } from '@shared/defaults'
import { uid } from '../engine/ids'
import { ZOOM_MIN_MS, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN, patchZoom, resolveZoomOverlaps } from '../engine/camera'
import { TRANSPARENT_BACKGROUND } from '../engine/compose'
import { addCutToProject } from '../engine/projectEdits'
import { clipRegionsToCuts, keepSegments } from '../engine/timeline'
import { clamp } from '../util/format'
import { cssColorToHex } from './color'

/**
 * What the agent's `edit_project` does to a project, as one pure function (the executor applies
 * the result as a single undo step). The control server validates the parameters against
 * shared/agentSchemas.ts before they get here; this is the second line: it also checks what only
 * the project can tell (an id that exists, times inside the recording, no overlapping zooms) and
 * stays defensive about types. A value that is wrong is a `bad_params` error that says what to fix
 * (an unknown cut / zoom / text / blur id is `not_found`), and the whole batch is rejected - nothing
 * is half applied. Cosmetic numbers are clamped to the range the editor's own controls offer, exactly
 * like the UI does. Times are source ms, positions are normalized (see AgentEditOp).
 */

type Raw = Record<string, unknown>

/** Smallest length of a text / blur span, as in the Inspector's time fields. */
export const TEXT_MIN_MS = 100
export const BLUR_MIN_MS = 100
/** A removed range shorter than this is not a cut (the editor ignores smaller selections too). */
export const CUT_MIN_MS = 10
/** Smallest crop and blur rectangle (normalized), as the editor's drag handles allow. */
export const CROP_MIN_SIZE = 0.05
export const BLUR_MIN_SIZE = 0.01

const MAX_OPS = 500
const MAX_NAME = 200
const MAX_TEXT = 500
/** tolerance for coordinates that are 1.0000001 because of float math */
const EPS = 1e-6

function fail(message: string): never {
  throw new AgentError('bad_params', message)
}

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// ---- field readers ----

/** Optional finite number. */
function num(raw: Raw, key: string): number | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${key} must be a number, got ${JSON.stringify(v)}`)
  return v
}

function reqNum(raw: Raw, key: string, what: string): number {
  const v = num(raw, key)
  if (v === undefined) fail(`${key} is required (${what})`)
  return v
}

/** Optional normalized coordinate. Pixels (or anything outside 0..1) are rejected, not clamped: that is a unit mistake. */
function unit(raw: Raw, key: string, label = key): number | undefined {
  const v = num(raw, key)
  if (v === undefined) return undefined
  if (v < -EPS || v > 1 + EPS) fail(`${label} must be between 0 and 1 (normalized to the recording, not pixels), got ${v}`)
  return clamp(v, 0, 1)
}

function reqUnit(raw: Raw, key: string, label = key): number {
  const v = unit(raw, key, label)
  if (v === undefined) fail(`${label} is required (0..1, normalized)`)
  return v
}

function bool(raw: Raw, key: string): boolean | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') fail(`${key} must be true or false, got ${JSON.stringify(v)}`)
  return v
}

function oneOf<T extends string>(raw: Raw, key: string, options: readonly T[]): T | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) fail(`${key} must be one of ${options.join(', ')}, got ${JSON.stringify(v)}`)
  return v as T
}

/** Any opaque CSS color, stored the way the editor's color fields do: "#rrggbb". */
function color(v: unknown, key: string): string {
  const hex = typeof v === 'string' ? cssColorToHex(v) : null
  if (!hex) fail(`${key} must be an opaque CSS color such as #ffcc00 or "white", got ${JSON.stringify(v)}`)
  return hex
}

function optColor(raw: Raw, key: string): string | undefined {
  return raw[key] === undefined || raw[key] === null ? undefined : color(raw[key], key)
}

function frameBackground(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === TRANSPARENT_BACKGROUND || has(GRADIENT_PRESETS, s)) return s
    const hex = cssColorToHex(s)
    if (hex) return hex
  }
  fail(`background must be an opaque CSS color such as #111214, "${TRANSPARENT_BACKGROUND}" (GIF only) or one of ${Object.keys(GRADIENT_PRESETS).join(', ')}, got ${JSON.stringify(v)}`)
}

/** An optional {x, y} in source-normalized coordinates. */
function point(raw: Raw, key: string): { x: number; y: number } | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (!isObj(v)) fail(`${key} must be {x, y} in source-normalized coordinates (0..1), got ${JSON.stringify(v)}`)
  return { x: reqUnit(v, 'x', `${key}.x`), y: reqUnit(v, 'y', `${key}.y`) }
}

// ---- time ----

function checkSpan(start: number, end: number, duration: number, minMs: number): void {
  if (start < 0) fail(`start ${start} ms is before the recording starts (0 ms, source time)`)
  if (end > duration) fail(`end ${end} ms is past the end of the recording (${duration} ms, source time)`)
  if (end - start < minMs) fail(`start (${start} ms) must be at least ${minMs} ms before end (${end} ms)`)
}

/** Required `start` / `end`, rounded to ms and checked against the recording. */
function span(raw: Raw, duration: number, minMs: number): { start: number; end: number } {
  const start = Math.round(reqNum(raw, 'start', 'source ms'))
  const end = Math.round(reqNum(raw, 'end', 'source ms'))
  checkSpan(start, end, duration, minMs)
  return { start, end }
}

/** Looks an id up in a list; the error names the ids that exist. */
function existing<T extends { id: string }>(list: T[], raw: Raw, label: string): T {
  const id = raw.id
  if (typeof id !== 'string' || id === '') fail(`id is required: the id of the ${label} (see get_project)`)
  const found = list.find((x) => x.id === id)
  if (!found) {
    const known = list.slice(0, 12).map((x) => x.id)
    throw new AgentError('not_found', `unknown ${label} id "${id}" (${known.length > 0 ? 'existing: ' + known.join(', ') : 'the project has none'})`)
  }
  return found
}

function nonEmpty<T extends object>(patch: T, fields: string): T {
  if (Object.keys(patch).length === 0) fail(`nothing to change: give at least one of ${fields}`)
  return patch
}

// ---- operations ----

function rename(p: Project, raw: Raw): Project {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) fail('name must be a non-empty string')
  if (name.length > MAX_NAME) fail(`name is too long (${name.length} > ${MAX_NAME} characters)`)
  return { ...p, name }
}

function addCut(p: Project, raw: Raw): Project {
  const { start, end } = span(raw, p.recording.durationMs, CUT_MIN_MS)
  return addCutToProject(p, { id: uid('cut'), start, end })
}

function removeCut(p: Project, raw: Raw): Project {
  const cut = existing(p.cuts, raw, 'cut')
  return { ...p, cuts: p.cuts.filter((c) => c !== cut) }
}

function zoomScale(raw: Raw): number | undefined {
  const v = num(raw, 'scale')
  return v === undefined ? undefined : clamp(v, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX)
}

/** the ease sliders go 0..1500 ms */
function zoomEase(raw: Raw, key: string): number | undefined {
  const v = num(raw, key)
  return v === undefined ? undefined : Math.round(clamp(v, 0, 1500))
}

/** Sorts `zooms` and keeps them apart; a zoom that would have to move or shrink to fit is an error, not a silent change. */
function placeZoom(p: Project, zooms: ZoomSegment[], id: string, start: number, end: number): Project {
  const resolved = resolveZoomOverlaps(zooms, id, p.recording.durationMs)
  const placed = resolved.find((z) => z.id === id)
  if (!placed || placed.start !== start || placed.end !== end) {
    const clash = zooms.find((z) => z.id !== id && z.start < end && z.end > start)
    fail(
      clash
        ? `the zoom ${start}-${end} ms overlaps the zoom ${clash.id} (${clash.start}-${clash.end} ms); zooms cannot overlap, move or remove that one first`
        : `the zoom ${start}-${end} ms does not fit into the recording`
    )
  }
  return { ...p, zooms: resolved }
}

function addZoom(p: Project, raw: Raw): Project {
  const { start, end } = span(raw, p.recording.durationMs, ZOOM_MIN_MS)
  const mode = oneOf(raw, 'mode', ['follow', 'fixed'] as const)
  if (!mode) fail('mode is required: "follow" (the camera follows the cursor) or "fixed" (zooms into target)')
  // a fixed zoom without a target aims at the centre, like a freshly added zoom in the editor
  const target = point(raw, 'target')
  const id = uid('zoom')
  const zoom: ZoomSegment = {
    ...ZOOM_DEFAULTS,
    id,
    start,
    end,
    mode,
    scale: zoomScale(raw) ?? ZOOM_DEFAULTS.scale,
    target: target ?? { ...ZOOM_DEFAULTS.target },
    easeInMs: zoomEase(raw, 'easeInMs') ?? ZOOM_DEFAULTS.easeInMs,
    easeOutMs: zoomEase(raw, 'easeOutMs') ?? ZOOM_DEFAULTS.easeOutMs
  }
  return placeZoom(p, [...p.zooms, zoom], id, start, end)
}

function updateZoom(p: Project, raw: Raw): Project {
  const zoom = existing(p.zooms, raw, 'zoom')
  const patch: Partial<ZoomSegment> = {}
  const start = num(raw, 'start')
  const end = num(raw, 'end')
  if (start !== undefined) patch.start = Math.round(start)
  if (end !== undefined) patch.end = Math.round(end)
  const mode = oneOf(raw, 'mode', ['follow', 'fixed'] as const)
  if (mode) patch.mode = mode
  const scale = zoomScale(raw)
  if (scale !== undefined) patch.scale = scale
  const target = point(raw, 'target')
  if (target) patch.target = target
  nonEmpty(patch, 'start, end, mode, scale, target')
  const next = patchZoom(zoom, patch)
  if (start !== undefined || end !== undefined) checkSpan(next.start, next.end, p.recording.durationMs, ZOOM_MIN_MS)
  return placeZoom(
    p,
    p.zooms.map((z) => (z === zoom ? next : z)),
    zoom.id,
    next.start,
    next.end
  )
}

function removeZoom(p: Project, raw: Raw): Project {
  const zoom = existing(p.zooms, raw, 'zoom')
  return { ...p, zooms: p.zooms.filter((z) => z !== zoom) }
}

/** The text-overlay fields shared by addText and updateText; only what was given. */
function textFields(raw: Raw): Partial<TextOverlay> {
  const out: Partial<TextOverlay> = {}
  if (raw.text !== undefined && raw.text !== null) {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') fail('text must be a non-empty string')
    if (raw.text.length > MAX_TEXT) fail(`text is too long (${raw.text.length} > ${MAX_TEXT} characters)`)
    out.text = raw.text
  }
  const x = unit(raw, 'x')
  if (x !== undefined) out.x = x
  const y = unit(raw, 'y')
  if (y !== undefined) out.y = y
  const fontSize = num(raw, 'fontSize')
  // the size slider: 2..14 % of the output height
  if (fontSize !== undefined) out.fontSize = clamp(fontSize, 0.02, 0.14)
  const color = optColor(raw, 'color')
  if (color !== undefined) out.color = color
  const background = optColor(raw, 'background')
  if (background !== undefined) out.background = background
  const animation = oneOf(raw, 'animation', ['none', 'fade', 'pop'] as const)
  if (animation !== undefined) out.animation = animation
  return out
}

function addText(p: Project, raw: Raw): Project {
  const { start, end } = span(raw, p.recording.durationMs, TEXT_MIN_MS)
  const fields = textFields(raw)
  if (fields.text === undefined) fail('text is required')
  const text: TextOverlay = { ...TEXT_DEFAULTS, ...fields, id: uid('text'), start, end }
  return { ...p, texts: [...p.texts, text] }
}

function updateText(p: Project, raw: Raw): Project {
  const text = existing(p.texts, raw, 'text')
  const patch: Partial<TextOverlay> = textFields(raw)
  const start = num(raw, 'start')
  const end = num(raw, 'end')
  if (start !== undefined) patch.start = Math.round(start)
  if (end !== undefined) patch.end = Math.round(end)
  nonEmpty(patch, 'start, end, text, x, y, fontSize, color, background, animation')
  const next = { ...text, ...patch }
  if (start !== undefined || end !== undefined) checkSpan(next.start, next.end, p.recording.durationMs, TEXT_MIN_MS)
  return { ...p, texts: p.texts.map((t) => (t === text ? next : t)) }
}

function removeText(p: Project, raw: Raw): Project {
  const text = existing(p.texts, raw, 'text')
  return { ...p, texts: p.texts.filter((t) => t !== text) }
}

/** x/y/w/h of a rectangle that has to stay inside the recording. */
function rect(raw: Raw, minSize: number): CropRect {
  const x = reqUnit(raw, 'x')
  const y = reqUnit(raw, 'y')
  const w = reqUnit(raw, 'w')
  const h = reqUnit(raw, 'h')
  if (w < minSize || h < minSize) fail(`w and h must be at least ${minSize} (a fraction of the recording), got w=${w}, h=${h}`)
  if (x + w > 1 + EPS) fail(`x + w must not exceed 1 (the rectangle leaves the recording): x=${x}, w=${w}`)
  if (y + h > 1 + EPS) fail(`y + h must not exceed 1 (the rectangle leaves the recording): y=${y}, h=${h}`)
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) }
}

function addBlur(p: Project, raw: Raw): Project {
  const { start, end } = span(raw, p.recording.durationMs, BLUR_MIN_MS)
  const r = rect(raw, BLUR_MIN_SIZE)
  const style = oneOf(raw, 'style', ['blur', 'pixelate'] as const)
  const strength = num(raw, 'strength')
  const region: BlurRegion = {
    ...BLUR_DEFAULTS,
    id: uid('blur'),
    start,
    end,
    ...r,
    style: style ?? BLUR_DEFAULTS.style,
    // the strength slider: 4..80
    strength: strength === undefined ? BLUR_DEFAULTS.strength : clamp(strength, 4, 80)
  }
  return { ...p, blurs: [...p.blurs, region] }
}

function removeBlur(p: Project, raw: Raw): Project {
  const blur = existing(p.blurs, raw, 'blur')
  return { ...p, blurs: p.blurs.filter((b) => b !== blur) }
}

function setCrop(p: Project, raw: Raw): Project {
  return { ...p, crop: rect(raw, CROP_MIN_SIZE) }
}

function setFrame(p: Project, raw: Raw): Project {
  const patch: Partial<FrameStyle> = {}
  const padding = num(raw, 'padding')
  if (padding !== undefined) patch.padding = clamp(padding, 0, 0.2)
  const cornerRadius = num(raw, 'cornerRadius')
  if (cornerRadius !== undefined) patch.cornerRadius = Math.round(clamp(cornerRadius, 0, 64))
  if (raw.background !== undefined && raw.background !== null) patch.background = frameBackground(raw.background)
  const shadow = bool(raw, 'shadow')
  if (shadow !== undefined) patch.shadow = shadow
  nonEmpty(patch, 'padding, cornerRadius, background, shadow')
  return { ...p, frame: { ...p.frame, ...patch } }
}

function setCursor(p: Project, raw: Raw): Project {
  const patch: Partial<CursorSettings> = {}
  const highlight = bool(raw, 'highlight')
  if (highlight !== undefined) patch.highlight = highlight
  const clicks = bool(raw, 'clicks')
  if (clicks !== undefined) patch.clicks = clicks
  const smoothing = num(raw, 'followSmoothing')
  if (smoothing !== undefined) patch.followSmoothing = clamp(smoothing, 0, 1)
  const deadZone = num(raw, 'followDeadZone')
  if (deadZone !== undefined) patch.followDeadZone = clamp(deadZone, 0, 0.3)
  nonEmpty(patch, 'highlight, clicks, followSmoothing, followDeadZone')
  return { ...p, cursor: { ...p.cursor, ...patch } }
}

const HANDLERS: Record<AgentEditOp['op'], (p: Project, raw: Raw) => Project> = {
  rename,
  addCut,
  removeCut,
  addZoom,
  updateZoom,
  removeZoom,
  addText,
  updateText,
  removeText,
  addBlur,
  removeBlur,
  setCrop,
  setFrame,
  setCursor
}

interface Spanned {
  id: string
  start: number
  end: number
}

type ItemKind = 'zoom' | 'text' | 'blur'
const ITEM_KINDS: readonly ItemKind[] = ['zoom', 'text', 'blur']
/** the shortest piece of each kind that survives a cut (addCutToProject drops what a cut shortens below it) */
const ITEM_MIN_MS: Record<ItemKind, number> = { zoom: ZOOM_MIN_MS, text: TEXT_MIN_MS, blur: BLUR_MIN_MS }

function itemsOf(p: Project, kind: ItemKind): readonly Spanned[] {
  return kind === 'zoom' ? p.zooms : kind === 'text' ? p.texts : p.blurs
}

/** An item one of the batch's own operations created, with the span it was created with (a later cut may shorten or drop it). */
interface Added extends Spanned {
  kind: ItemKind
  /** "operations[2] (addText)" */
  where: string
}

/** The items `after` has that `before` does not: what an add operation just created. */
function createdBy(before: Project, after: Project, where: string): Added[] {
  const out: Added[] = []
  for (const kind of ITEM_KINDS) {
    const known = new Set(itemsOf(before, kind).map((x) => x.id))
    for (const x of itemsOf(after, kind)) {
      if (!known.has(x.id)) out.push({ kind, id: x.id, start: x.start, end: x.end, where })
    }
  }
  return out
}

/** The items of `after` that got another start / end than their namesake in `before` (the new ones are createdBy's). */
function movedSpans(before: readonly Spanned[], after: readonly Spanned[]): Spanned[] {
  const old = new Map(before.map((x) => [x.id, x]))
  return after.filter((x) => {
    const was = old.get(x.id)
    return was !== undefined && (was.start !== x.start || was.end !== x.end)
  })
}

/**
 * Judged once all operations are applied, so the outcome does not depend on their order.
 * - An item the batch added must show in at least one piece that stays, and survive the cuts the way the
 *   editor lets an item survive them (a cut drops a region entirely inside it, and one it shortens below the
 *   shortest of its kind). An addCut after an addText would silently drop a text that lies inside the cut,
 *   and the same text added after the cut would be kept, invisible: both orders are an error, naming the
 *   operation that added it.
 * - An item that existed before and was moved by an update must not end up hidden either.
 * Items that existed before and were not touched keep the editor's behaviour: a new cut drops them when
 * they lie entirely inside it, and shortens them at its edges (addCutToProject).
 */
function assertVisible(before: Project, after: Project, added: readonly Added[]): void {
  const duration = after.recording.durationMs
  const kept = keepSegments(duration, after.cuts)
  const shows = (s: Spanned): boolean => kept.some((k) => k.start < s.end && k.end > s.start)
  const hidden = (kind: ItemKind, s: Spanned, where = ''): never =>
    fail(
      `${where}the ${kind} ${s.start}-${s.end} ms lies entirely inside removed ranges (cuts) once all operations are applied, so it would never be visible; ` +
        'times are source ms, not output time (see cuts in get_project)'
    )
  for (const kind of ITEM_KINDS) {
    for (const item of movedSpans(itemsOf(before, kind), itemsOf(after, kind))) {
      if (!shows(item)) hidden(kind, item)
    }
  }
  for (const a of added) {
    const where = `${a.where}: `
    if (!shows(a)) hidden(a.kind, a, where)
    if (clipRegionsToCuts([a], after.cuts, duration, ITEM_MIN_MS[a.kind]).length === 0) {
      fail(
        `${where}the cuts of this call would shorten the ${a.kind} ${a.start}-${a.end} ms to under ${ITEM_MIN_MS[a.kind]} ms, the shortest ${a.kind} the editor keeps, ` +
          'and so drop it; times are source ms, not output time (see cuts in get_project)'
      )
    }
  }
}

/**
 * Applies the operations in order and returns the edited project (the same object when `ops` is
 * empty). Throws AgentError('bad_params') naming the offending operation; the input is never mutated.
 */
export function applyAgentEdits(project: Project, ops: readonly AgentEditOp[]): Project {
  if (!Array.isArray(ops)) fail('operations must be an array of edit operations')
  if (ops.length > MAX_OPS) fail(`too many operations in one call (${ops.length} > ${MAX_OPS})`)
  let p = project
  const added: Added[] = []
  for (let i = 0; i < ops.length; i++) {
    const raw: unknown = ops[i]
    const where = `operations[${i}]`
    if (!isObj(raw) || typeof raw.op !== 'string') fail(`${where} must be an object with an "op" field`)
    if (!has(HANDLERS, raw.op)) fail(`${where}: unknown op "${raw.op}" (valid: ${Object.keys(HANDLERS).join(', ')})`)
    try {
      const next = HANDLERS[raw.op as AgentEditOp['op']](p, raw)
      added.push(...createdBy(p, next, `${where} (${raw.op})`))
      p = next
    } catch (err) {
      if (err instanceof AgentError) throw new AgentError(err.code, `${where} (${raw.op}): ${err.message}`)
      throw err
    }
  }
  if (p !== project && keepSegments(p.recording.durationMs, p.cuts).length === 0) {
    fail('these cuts would remove the whole recording; keep at least part of it (use removeCut to restore a range)')
  }
  if (p !== project) assertVisible(project, p, added)
  return p
}
