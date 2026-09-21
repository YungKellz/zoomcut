import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AudioClip } from '@shared/types'
import { isRecordedClip } from '@shared/audio'
import { outToSrc, segmentAt, type Segment } from '../engine/timeline'
import { barsForRange, loadPeaks } from '../audio/peaks'
import { useT } from '../i18n'

const BAR_STEP_PX = 3
const BAR_WIDTH_CSS_PX = 2
/** total vertical padding subtracted from the strip height, so bars never quite touch the
 * region's top/bottom edge. */
const PADDING_CSS_PX = 2
/** a lighter tint of .region.audio's amber background/text (styles.css), so bars read clearly
 * against it without turning the region a flat white. */
const BAR_COLOR = 'rgba(255, 224, 178, 0.9)'

/**
 * Maps a GLOBAL output-time position (ms) to the clip's own file time (ms), or null where the
 * clip has no audio playing at that point:
 *  - a recorded clip (system/mic) only plays inside a kept segment - `outToSrc` follows it
 *    through cuts the same way AudioPlayer.tsx's recordedActive does, just from output time
 *    instead of from the stored (source-time) playhead;
 *  - an overlay clip (voiceover/music/file) has no audio before its own `start`, wraps every
 *    `durationMs` when it loops, and simply ends otherwise - mirrors AudioPlayer.tsx's
 *    overlayActive, again worked from output time directly since every canvas pixel already is one.
 */
function fileTimeAtOut(clip: AudioClip, outMs: number, segments: Segment[]): number | null {
  if (isRecordedClip(clip)) {
    const src = outToSrc(outMs, segments)
    if (segmentAt(src, segments) === null) return null
    const fileMs = src - clip.start
    return fileMs >= 0 && fileMs < clip.durationMs ? fileMs : null
  }
  const raw = outMs - clip.start
  if (raw < 0) return null
  if (clip.loop && clip.durationMs > 0) return ((raw % clip.durationMs) + clip.durationMs) % clip.durationMs
  return raw < clip.durationMs ? raw : null
}

/**
 * The [fromMs, toMs) file-time window one bar (the pixel run [x, x + BAR_STEP_PX)) should read
 * its peak from, or null when the bar starts outside the clip's audio entirely (a cut, or past
 * a non-looping clip's end - fileTimeAtOut(x) itself is null). `toMs` normally comes from
 * fileTimeAtOut at the bar's own right edge, which is what makes barsForRange read the *actual*
 * max over every bin the bar spans instead of one arbitrarily-chosen bin (see AudioWaveform's
 * doc comment); when that edge falls across a cut/loop-wrap (null, or time appears to run
 * backwards) the window is estimated locally instead, since a single ~3px-wide bar's own time
 * span is short enough that treating it as linear there is not visibly different.
 */
function barWindow(clip: AudioClip, x: number, pxPerMs: number, regionStartOut: number, segments: Segment[]): { fromMs: number; toMs: number } | null {
  const fromMs = fileTimeAtOut(clip, regionStartOut + x / pxPerMs, segments)
  if (fromMs === null) return null
  const rawToMs = fileTimeAtOut(clip, regionStartOut + (x + BAR_STEP_PX) / pxPerMs, segments)
  const toMs = rawToMs !== null && rawToMs > fromMs ? rawToMs : fromMs + BAR_STEP_PX / pxPerMs
  return { fromMs, toMs }
}

interface AudioWaveformProps {
  clip: AudioClip
  /** zc-media:// URL of the clip's own file (audioClipPath + window.zc.media.url) */
  url: string
  pxPerMs: number
  /** kept (non-cut) source-time spans, for a recorded clip's outToSrc mapping */
  segments: Segment[]
}

/**
 * Volume-scale overlay for the selected clip's timeline region (Timeline.tsx renders this only
 * for the selected audio clip - an unselected region stays a plain colour block): a canvas of
 * thin vertical bars, one every BAR_STEP_PX, centered on the region's own vertical middle and
 * scaled to the clip's raw peak level in its file, so silence reads as a flat line and loud
 * passages read as tall bars. Each bar's height is the true MAX peak over the file-time span it
 * covers (via peaks.ts's barsForRange, one call per bar with its own [fromMs, toMs) window from
 * barWindow above) - a single nearest-bin lookup would silently discard most of that span
 * whenever a bar covers more than one peak bin (any time pxPerMs is small enough that
 * BAR_STEP_PX/pxPerMs exceeds peaks.ts's DEFAULT_BIN_MS, i.e. whenever the timeline is zoomed
 * out even a little), making transients vanish or flicker as pxPerMs changes. Sits absolutely
 * positioned inside the region (a `position: absolute` box itself, see .region in styles.css),
 * behind the (now chip-backed, see styles.css .region-label.chip) label so the name stays
 * readable on top.
 */
export function AudioWaveform({ clip, url, pxPerMs, segments }: AudioWaveformProps): JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })

  // decode (or reuse the cached decode of) this clip's file whenever its URL changes
  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    setError(false)
    setLoading(true)
    void loadPeaks(url)
      .then((p) => {
        if (!cancelled) setPeaks(p)
      })
      .catch((err) => {
        console.error('[waveform] could not decode peaks for', url, err)
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  // track the region's own box (zoom, or the region growing/shrinking) via the canvas's parent
  useEffect(() => {
    const el = canvasRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the actual draw: only re-runs when something that changes bar heights/positions changes -
  // never on a per-frame timer, the waveform does not track playback position
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cssW = box.w
    const cssH = box.h
    const pxW = Math.max(1, Math.round(cssW * dpr))
    const pxH = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== pxW) canvas.width = pxW
    if (canvas.height !== pxH) canvas.height = pxH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, pxW, pxH)
    if (!peaks || peaks.length === 0 || cssW <= 0 || cssH <= 0) return

    const regionStartOut = isRecordedClip(clip) ? 0 : clip.start
    const mid = pxH / 2
    const maxBarH = Math.max(1, pxH - Math.round(PADDING_CSS_PX * dpr))
    const barWpx = Math.max(1, Math.round(BAR_WIDTH_CSS_PX * dpr))
    // a true-silent bar still draws a thin flat line (not nothing), the same way a quiet-but-
    // nonzero one draws a slightly taller bar - silence should be visibly *flat*, not invisible
    const minBarH = Math.max(1, Math.round(dpr))
    ctx.fillStyle = BAR_COLOR
    for (let x = 0; x < cssW; x += BAR_STEP_PX) {
      const win = barWindow(clip, x, pxPerMs, regionStartOut, segments)
      if (!win) continue
      const [peak] = barsForRange(peaks, win.fromMs, win.toMs, 1)
      const barH = Math.max(minBarH, (peak ?? 0) * maxBarH)
      const px = Math.round(x * dpr)
      ctx.fillRect(px, mid - barH / 2, barWpx, barH)
    }
  }, [peaks, box, pxPerMs, clip, segments])

  const className = 'audio-waveform' + (loading ? ' loading' : '') + (error ? ' error' : '')
  return <canvas className={className} ref={canvasRef} title={error ? t('audio.waveformError') : undefined} />
}
