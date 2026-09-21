/**
 * Peak levels for the volume-scale waveform drawn on the selected clip's timeline strip
 * (editor/AudioWaveform.tsx). Split the same way as the removed procedural music module used to
 * be: a pure, node-testable half (peaksFromSamples, barsForRange - plain arrays in, plain arrays
 * out) and a Web Audio half (loadPeaks - fetch + AudioContext.decodeAudioData) that only runs in
 * the renderer and is exercised by hand, since vitest's `environment: 'node'` (vitest.config.ts)
 * has no Web Audio / fetch-of-a-real-file implementation.
 */

/** Bin width loadPeaks uses by default, and the width barsForRange assumes every peaks array
 * was built with (loadPeaks is always called with its default in this codebase - AudioWaveform
 * never overrides it - so the two stay in sync without threading binMs through every call). */
export const DEFAULT_BIN_MS = 20

/**
 * Bins mono `samples` into `binMs`-wide windows and takes the max absolute value in each. The
 * samples are already normalized floats in [-1, 1] (the Web Audio decode format), so the peak of
 * `abs(sample)` is already in [0, 1] with no further rescale - a quiet recording stays visibly
 * quiet on the waveform instead of being stretched to fill the bar like a loud one.
 */
export function peaksFromSamples(samples: Float32Array, sampleRate: number, binMs: number): Float32Array {
  if (samples.length === 0) return new Float32Array(0)
  const binSize = Math.max(1, Math.round((sampleRate * binMs) / 1000))
  const binCount = Math.ceil(samples.length / binSize)
  const out = new Float32Array(binCount)
  for (let i = 0; i < binCount; i++) {
    const start = i * binSize
    const end = Math.min(samples.length, start + binSize)
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j])
      if (v > peak) peak = v
    }
    out[i] = Math.min(1, peak)
  }
  return out
}

/**
 * Downsamples `peaks` (bins of DEFAULT_BIN_MS, see above) to `count` bars evenly covering the
 * contiguous file-time window [fromMs, toMs): each bar is the max of every peak bin its own
 * slice of the window overlaps, so a short loud transient is never averaged away by a quiet
 * neighbour. A window (or part of one) past the end of `peaks` reads as silence (0), never a
 * crash or an out-of-bounds read - a clip can be longer than what got decoded, or a looping
 * clip's file time can sit exactly on the boundary.
 */
export function barsForRange(peaks: Float32Array, fromMs: number, toMs: number, count: number): Float32Array {
  const out = new Float32Array(Math.max(0, count))
  if (out.length === 0 || peaks.length === 0 || toMs <= fromMs) return out
  const msPerBar = (toMs - fromMs) / out.length
  for (let i = 0; i < out.length; i++) {
    const barFromMs = fromMs + i * msPerBar
    const barToMs = barFromMs + msPerBar
    const i0 = Math.max(0, Math.floor(barFromMs / DEFAULT_BIN_MS))
    const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(barToMs / DEFAULT_BIN_MS)))
    let peak = 0
    for (let j = i0; j < i1; j++) if (peaks[j] > peak) peak = peaks[j]
    out[i] = peak
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Web Audio decode + cache (browser-only; not covered by the node unit tests, see the module doc)
// ---------------------------------------------------------------------------------------

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels: channels, length } = buffer
  const out = new Float32Array(length)
  if (channels <= 1) {
    if (channels === 1) out.set(buffer.getChannelData(0))
    return out
  }
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) out[i] += data[i] / channels
  }
  return out
}

async function decodePeaks(url: string, binMs: number): Promise<Float32Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load audio for the waveform (${res.status}).`)
  const data = await res.arrayBuffer()
  // a throwaway OfflineAudioContext just for this one decode: decodeAudioData ignores the
  // (channels, length, sampleRate) constructor args entirely (it only reads `data`'s own
  // encoded format) and works the same on any BaseAudioContext - unlike a plain AudioContext,
  // an OfflineAudioContext never opens a live audio render endpoint, so nothing here needs to
  // be kept alive or closed between calls the way a shared AudioContext would.
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const buffer = await ctx.decodeAudioData(data)
  return peaksFromSamples(mixToMono(buffer), buffer.sampleRate, binMs)
}

const MAX_CACHE_ENTRIES = 12
// Map insertion order doubles as recency here: loadPeaks re-inserts a hit key at the end (see
// below), so the oldest key (first in iteration order) is always the least recently used one.
const cache = new Map<string, Promise<Float32Array>>()

/**
 * Peaks for the audio file at `url` (a zc-media:// URL), decoded once and cached per URL - a
 * second selection of the same clip resolves instantly instead of re-decoding. Caches the
 * in-flight promise itself, so concurrent callers (e.g. a fast reselect while still decoding)
 * share one decode instead of racing two. Evicts the least recently used entry once the cache
 * holds more than ~12 files, so switching between many clips in one editing session cannot grow
 * this without bound.
 */
export function loadPeaks(url: string, binMs = DEFAULT_BIN_MS): Promise<Float32Array> {
  const existing = cache.get(url)
  if (existing) {
    cache.delete(url)
    cache.set(url, existing)
    return existing
  }
  const promise = decodePeaks(url, binMs)
  cache.set(url, promise)
  // a failed decode must not poison the cache forever - let a later selection retry
  promise.catch(() => cache.delete(url))
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
  return promise
}
