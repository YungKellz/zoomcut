import { describe, expect, it } from 'vitest'
import { DEFAULT_BIN_MS, barsForRange, peaksFromSamples } from './peaks'

describe('peaksFromSamples', () => {
  it('returns an empty array for an empty input', () => {
    expect(peaksFromSamples(new Float32Array(0), 48000, 20)).toEqual(new Float32Array(0))
  })

  it('bins samples into ceil(length / binSize) windows', () => {
    // 48000 Hz, 20ms bins -> 960 samples/bin; 2500 samples -> 3 bins (960, 960, 580)
    const samples = new Float32Array(2500)
    const peaks = peaksFromSamples(samples, 48000, 20)
    expect(peaks.length).toBe(3)
  })

  it('takes the max absolute value per bin, not an average', () => {
    // one loud spike among otherwise-silent samples must not get averaged away
    const samples = new Float32Array(100)
    samples[50] = 0.8
    const peaks = peaksFromSamples(samples, 1000, 10) // 1000 samples/sec, 10ms bins -> 10 samples/bin, 10 bins
    expect(peaks.length).toBe(10)
    expect(peaks[5]).toBeCloseTo(0.8, 6) // sample 50 falls in bin floor(50/10) = 5
    // every other bin (no spike) stays at 0
    const nonSpikeBins = peaks.filter((_, i) => i !== 5)
    expect(nonSpikeBins.every((v) => v === 0)).toBe(true)
  })

  it('treats negative samples the same as positive ones (absolute value)', () => {
    const samples = Float32Array.from([0.1, -0.9, 0.2])
    const peaks = peaksFromSamples(samples, 1000, 1000) // one big bin
    expect(peaks[0]).toBeCloseTo(0.9, 6)
  })

  it('never returns a value above 1 even for an out-of-range sample', () => {
    const samples = Float32Array.from([1.5, -2])
    const peaks = peaksFromSamples(samples, 1000, 1000)
    expect(peaks[0]).toBeLessThanOrEqual(1)
  })

  it('a uniformly quiet signal stays quiet instead of being rescaled to full height', () => {
    const quiet = new Float32Array(1000).fill(0.05)
    const peaks = peaksFromSamples(quiet, 1000, 100)
    expect(peaks.every((v) => Math.abs(v - 0.05) < 1e-6)).toBe(true)
  })
})

describe('barsForRange', () => {
  it('returns `count` bars', () => {
    const peaks = new Float32Array(50).fill(0.3)
    expect(barsForRange(peaks, 0, 1000, 25).length).toBe(25)
  })

  it('returns an empty array for a non-positive count, and `count` silent bars for an empty/inverted range', () => {
    const peaks = new Float32Array(50).fill(0.3)
    expect(barsForRange(peaks, 0, 1000, 0).length).toBe(0)
    // the range itself is degenerate (nothing to sample), but the caller still gets the bar
    // count it asked for, just silent - so it can always render a fixed-width row of bars
    // without special-casing this input
    const empty = barsForRange(peaks, 1000, 1000, 10)
    expect(empty.length).toBe(10)
    expect(Array.from(empty).every((v) => v === 0)).toBe(true)
    const inverted = barsForRange(peaks, 1000, 0, 10)
    expect(inverted.length).toBe(10)
    expect(Array.from(inverted).every((v) => v === 0)).toBe(true)
  })

  it('is silent (all zero) for an empty peaks array', () => {
    const bars = barsForRange(new Float32Array(0), 0, 1000, 10)
    expect(Array.from(bars).every((v) => v === 0)).toBe(true)
  })

  it('picks up an isolated loud bin instead of averaging it into its neighbours', () => {
    // 100 bins of DEFAULT_BIN_MS = 2000ms total; bin 50 (at 1000ms) is loud, everything else silent
    const peaks = new Float32Array(100)
    peaks[50] = 0.9
    // a handful of bars spanning the whole range - each bar covers several bins
    const bars = barsForRange(peaks, 0, 100 * DEFAULT_BIN_MS, 20)
    expect(Math.max(...bars)).toBeCloseTo(0.9, 6)
  })

  it('covers the full requested range: the first bar starts at fromMs, the last ends at toMs', () => {
    const peaks = new Float32Array(10).fill(1)
    peaks[0] = 0.2 // first bin quieter, so we can tell the first bar actually reached bin 0
    peaks[9] = 0.4 // last bin distinct too
    const bars = barsForRange(peaks, 0, 10 * DEFAULT_BIN_MS, 10)
    expect(bars[0]).toBeCloseTo(0.2, 6)
    expect(bars[9]).toBeCloseTo(0.4, 6)
  })

  it('reads a window past the end of peaks as silence rather than throwing', () => {
    const peaks = new Float32Array(5).fill(0.5)
    const bars = barsForRange(peaks, 0, 40 * DEFAULT_BIN_MS, 8) // range is 8x longer than the data
    expect(bars.length).toBe(8)
    expect(bars[bars.length - 1]).toBe(0)
  })
})
