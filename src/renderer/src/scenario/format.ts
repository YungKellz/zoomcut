/**
 * Pure formatting/computation helpers for the scenario review screen and the replay overlay.
 * Kept free of React and Electron so they are plain-unit-testable (format.test.ts).
 */
import type { AudioCaptureOptions, ScenarioAction, ScenarioPoint, ScenarioShot } from '@shared/types'
import { actionEnd, effectiveDuration, graphemes } from '@shared/scenario'
import { clamp } from '../util/format'
import type { TKey } from '../i18n'

/** Below this, a type/drag/scroll action is short enough to stay a point marker on the scenario
 * review timeline. */
const SPAN_MIN_DURATION_MS = 100
/** Minimum visual width of a span marker, px - wide enough that its 12px kind icon (plus the
 * span's own padding) is never clipped. */
const SPAN_MIN_WIDTH_PX = 20

/** "m:ss" (no leading zero on minutes, no fractional seconds) - the scenario total, e.g. "1:23 / 10:00". */
export function formatMinSec(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Gap (ms) between the end of the previous action and the start of the action at `index` -
 * the action's own `at` for the first action, 0 for an out-of-range index. O(1): the caller
 * already has the index from iterating the array, so this never re-scans it (kept that way on
 * purpose - the review screen must stay usable with hundreds of actions).
 */
export function gapBeforeIndex(actions: ScenarioAction[], index: number): number {
  const action = actions[index]
  if (!action) return 0
  const prev = actions[index - 1]
  return action.at - (prev ? actionEnd(prev) : 0)
}

/**
 * Inverse of gapBeforeIndex: the `at` (ms) an action at `index` needs so the gap since the
 * previous action's end equals `gapMs` - the action's own `at` becomes exactly `gapMs` when it
 * is the first action (no previous end to add to). Hand the result to retimeAction(..., true).
 */
export function gapToAt(actions: ScenarioAction[], index: number, gapMs: number): number {
  const prev = actions[index - 1]
  return (prev ? actionEnd(prev) : 0) + gapMs
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

/** type/drag/scroll actions with a real duration are drawn as a span (from `at` to `actionEnd`)
 * on the scenario review timeline instead of a point marker; clicks/doubleClick/key keep their
 * fixed, near-instant duration and always stay points. Uses effectiveDuration (not the raw,
 * recorded durationMs) so a fast drag/scroll that gets floor-clamped at replay still shows the
 * span width it will actually occupy - see effectiveDuration's doc comment in shared/scenario.ts. */
export function isSpanAction(a: ScenarioAction): boolean {
  return (a.kind === 'type' || a.kind === 'drag' || a.kind === 'scroll') && effectiveDuration(a) > SPAN_MIN_DURATION_MS
}

/** Subtle label inside a span: the typed text (truncated) for `type`, nothing for drag/scroll. */
export function spanLabel(a: ScenarioAction): string | null {
  return a.kind === 'type' ? truncateCaption(a.text, 24) : null
}

/** Pixel width of a span marker at the timeline's current scale, floored so a span that barely
 * qualifies (or a narrow timeline) never shrinks below SPAN_MIN_WIDTH_PX. */
export function spanWidthPx(a: ScenarioAction, pxPerMs: number): number {
  return Math.max(SPAN_MIN_WIDTH_PX, effectiveDuration(a) * pxPerMs)
}
