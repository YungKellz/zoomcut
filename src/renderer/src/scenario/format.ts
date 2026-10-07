/**
 * Pure formatting/computation helpers for the scenario review screen and the replay overlay.
 * Kept free of React and Electron so they are plain-unit-testable (format.test.ts).
 */
import type { AudioCaptureOptions, ScenarioAction, ScenarioPoint, ScenarioShot } from '@shared/types'
import { graphemes } from '@shared/scenario'
import { clamp } from '../util/format'
import type { Lang, TKey } from '../i18n'

/** Minimum visual width of an action span on the scenario timeline, px - wide enough that its
 * 12px kind icon (plus the span's own padding) is never clipped. */
const SPAN_MIN_WIDTH_PX = 24

/** "m:ss" (no leading zero on minutes, no fractional seconds) - the scenario total, e.g. "1:23 / 10:00". */
export function formatMinSec(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Position of a point inside a shot's cropped rect, as 0..100 percentages (left, top), clamped
 * to the rect's edges - a point outside the crop (should not normally happen, but a shot can be
 * clamped to the display edge while the action's own point is not) still lands on the border
 * instead of outside the thumbnail. A degenerate (zero-size) rect reports the top-left corner. */
export function dotPositionPercent(shot: ScenarioShot, point: ScenarioPoint): { left: number; top: number } {
  const left = shot.w > 0 ? clamp((point.x - shot.x) / shot.w, 0, 1) * 100 : 0
  const top = shot.h > 0 ? clamp((point.y - shot.y) / shot.h, 0, 1) * 100 : 0
  return { left, top }
}

/** Which i18n key describes the audio sources `audio` will capture, for the "Record & replay"
 * hint on the review screen - the same AppSettings.audioDefaults the home screen's checkboxes
 * write to and a plain recording reads from. Null/undefined (settings never loaded yet) reads
 * the same as both sources off. */
export function audioHintKey(audio: AudioCaptureOptions | null | undefined): TKey {
  const mic = audio?.mic ?? false
  const system = audio?.system ?? false
  if (mic && system) return 'scenario.audioHintBoth'
  if (mic) return 'scenario.audioHintMic'
  if (system) return 'scenario.audioHintSystem'
  return 'scenario.audioHintNone'
}

/** Truncates a caption to at most `max` user-perceived characters (grapheme clusters, so a
 * surrogate pair, emoji or combining mark is never split in half), appending an ellipsis when
 * it was cut. */
export function truncateCaption(text: string, max = 40): string {
  const chars = graphemes(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('').trimEnd() + '…'
}

/** "m:ss.t" with one decimal (truncated, so it never runs ahead of the real start) - the read-only
 * start time of an action row, e.g. "0:03.5". */
export function formatStartTime(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100)
  const total = Math.floor(tenths / 10)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}.${tenths % 10}`
}

/** Milliseconds as seconds for an input: at most 2 decimals, trailing zeros trimmed, a decimal
 * comma in Russian ("1,5") and a dot otherwise ("1.5"). */
export function formatSecondsValue(ms: number, lang: Lang): string {
  const text = (Math.max(0, ms) / 1000).toFixed(2).replace(/\.?0+$/, '')
  return lang === 'ru' ? text.replace('.', ',') : text
}

/** Parses what the user typed into a seconds field ("1,5", "1.5", ".5", "2") into whole
 * milliseconds; null for anything that is not a plain non-negative number, so a half-typed or
 * empty draft is never committed. */
export function parseSecondsInput(raw: string): number | null {
  const text = raw.trim().replace(',', '.')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null
  const secs = Number(text)
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null
}

/** Subtle label inside a span: the typed text (truncated) for `type`, nothing for the others. */
export function spanLabel(a: ScenarioAction): string | null {
  return a.kind === 'type' ? truncateCaption(a.text, 24) : null
}

/** Pixel width of an action's span at the timeline's current scale, floored so a short action
 * (or a narrow timeline) never shrinks below SPAN_MIN_WIDTH_PX. */
export function spanWidthPx(startMs: number, endMs: number, pxPerMs: number): number {
  return Math.max(SPAN_MIN_WIDTH_PX, (endMs - startMs) * pxPerMs)
}
