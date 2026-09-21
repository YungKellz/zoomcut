import { describe, expect, it } from 'vitest'
import {
  MUSIC_PRESETS,
  PITCHED_INSTRUMENTS,
  audioBufferToWav,
  buildScore,
  chordDurationS,
  dbToLinear,
  midiToFreq,
  mulberry32,
  normalizePeak,
  presetTonality,
  type AudioBufferLike,
  type MusicPresetId
} from './music'

const PRESET_IDS: MusicPresetId[] = ['calm', 'upbeat', 'lofi', 'corporate', 'minimal']

/** A minimal AudioBufferLike whose getChannelData always returns the SAME Float32Array
 * instance per channel (like a real AudioBuffer), so in-place mutation is observable. */
function makeBuffer(channelsData: number[][], sampleRate = 48000): AudioBufferLike {
  const arrays = channelsData.map((c) => Float32Array.from(c))
  return {
    numberOfChannels: arrays.length,
    length: arrays[0]?.length ?? 0,
    sampleRate,
    getChannelData: (ch: number) => arrays[ch]
  }
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()])
  })

  it('differs across seeds', () => {
    const a = mulberry32(42)
    const b = mulberry32(43)
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()])
  })

  it('stays within [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('dbToLinear', () => {
  it('maps 0 dB to unity gain', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 6)
  })

  it('maps -6 dB to about 0.501 linear amplitude', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.50119, 4)
  })
})

describe('chordDurationS', () => {
  it('is derived from each preset\'s own listed bpm, not a separate hardcoded number', () => {
    for (const preset of MUSIC_PRESETS) {
      // chordDurationS(id) = (60 / bpm) * beatsPerChord; recovering beatsPerChord must be a
      // whole number for every preset, otherwise the bpm and the chord length have drifted
      // apart from each other
      const beatsPerChord = chordDurationS(preset.id) / (60 / preset.bpm)
      expect(beatsPerChord).toBeCloseTo(Math.round(beatsPerChord), 6)
      expect(Math.round(beatsPerChord)).toBeGreaterThan(0)
    }
  })
})

describe('buildScore', () => {
  it('is deterministic: building the same preset twice yields an identical score', () => {
    for (const id of PRESET_IDS) {
      expect(buildScore(id)).toEqual(buildScore(id))
    }
  })

  it('produces a distinct score per preset (different seeds, different music)', () => {
    const scores = PRESET_IDS.map((id) => JSON.stringify(buildScore(id)))
    expect(new Set(scores).size).toBe(PRESET_IDS.length)
  })

  it('lands close to the ~60s target loop length for every preset', () => {
    for (const id of PRESET_IDS) {
      const score = buildScore(id)
      expect(score.durationS).toBeGreaterThan(50)
      expect(score.durationS).toBeLessThan(70)
    }
  })

  it('loop-alignment invariant: durationS is a whole number of chords/bars for every preset', () => {
    for (const id of PRESET_IDS) {
      const score = buildScore(id)
      const chords = score.durationS / chordDurationS(id)
      expect(chords).toBeCloseTo(Math.round(chords), 6)
      expect(Math.round(chords)).toBeGreaterThan(0)
    }
  })

  it('has at least one track and one note for every preset', () => {
    for (const id of PRESET_IDS) {
      const score = buildScore(id)
      expect(score.tracks.length).toBeGreaterThan(0)
      const totalNotes = score.tracks.reduce((sum, tr) => sum + tr.notes.length, 0)
      expect(totalNotes).toBeGreaterThan(0)
    }
  })

  it('never schedules a note starting at or past its own loop length', () => {
    for (const id of PRESET_IDS) {
      const score = buildScore(id)
      for (const track of score.tracks) {
        for (const note of track.notes) {
          expect(note.time).toBeGreaterThanOrEqual(0)
          expect(note.time).toBeLessThan(score.durationS)
          expect(note.duration).toBeGreaterThan(0)
          expect(note.velocity).toBeGreaterThan(0)
          expect(note.velocity).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('every pitched note is in the preset\'s scale and yields a finite, positive frequency', () => {
    for (const id of PRESET_IDS) {
      const { root, scale } = presetTonality(id)
      const score = buildScore(id)
      for (const track of score.tracks) {
        if (!PITCHED_INSTRUMENTS.has(track.instrument)) continue
        for (const note of track.notes) {
          const degree = ((note.note - root) % 12 + 12) % 12
          expect(scale, `${id}/${track.instrument} note ${note.note} not in scale`).toContain(degree)
          const freq = midiToFreq(note.note)
          expect(Number.isFinite(freq)).toBe(true)
          expect(freq).toBeGreaterThan(0)
        }
      }
    }
  })

  it('MUSIC_PRESETS lists exactly the ids buildScore understands', () => {
    expect(MUSIC_PRESETS.map((p) => p.id).sort()).toEqual([...PRESET_IDS].sort())
    for (const preset of MUSIC_PRESETS) {
      expect(preset.bpm).toBeGreaterThan(0)
      expect(preset.nameKey).toMatch(/^music\.preset\./)
      expect(preset.descriptionKey).toMatch(/^music\.preset\./)
    }
  })
})

describe('audioBufferToWav', () => {
  it('writes a correct RIFF/WAVE/fmt/data 16-bit PCM header and total length', () => {
    const buffer = makeBuffer(
      [
        [0, 0.5, -0.5, 1, -1],
        [0, 0.25, -0.25, 0.75, -0.75]
      ],
      48000
    )
    const wav = audioBufferToWav(buffer)
    const view = new DataView(wav)
    const readStr = (offset: number, len: number): string => String.fromCharCode(...new Uint8Array(wav, offset, len))

    expect(readStr(0, 4)).toBe('RIFF')
    expect(readStr(8, 4)).toBe('WAVE')
    expect(readStr(12, 4)).toBe('fmt ')
    expect(readStr(36, 4)).toBe('data')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(2) // channels
    expect(view.getUint32(24, true)).toBe(48000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // bits per sample

    const dataSize = view.getUint32(40, true)
    expect(dataSize).toBe(5 * 2 * 2) // frames * channels * bytesPerSample
    expect(wav.byteLength).toBe(44 + dataSize)
    expect(view.getUint32(4, true)).toBe(36 + dataSize) // RIFF chunk size
  })

  it('interleaves channels per frame (offset 44 = channel 0 frame 0, offset 46 = channel 1 frame 0)', () => {
    const buffer = makeBuffer([
      [1, 0],
      [-1, 0.5]
    ])
    const wav = audioBufferToWav(buffer)
    const view = new DataView(wav)
    expect(view.getInt16(44, true)).toBe(32767) // channel 0 (L), frame 0 -> +1.0 clamps to max int16
    expect(view.getInt16(46, true)).toBe(-32768) // channel 1 (R), frame 0 -> -1.0 clamps to min int16
  })

  it('round-trips sample values through 16-bit PCM within quantization error, clamping out-of-range input', () => {
    const samples = [0, 0.5, -0.5, 0.999, -1, 1, 1.5, -1.5]
    const buffer = makeBuffer([samples])
    const wav = audioBufferToWav(buffer)
    const view = new DataView(wav)
    for (let i = 0; i < samples.length; i++) {
      const raw = view.getInt16(44 + i * 2, true)
      const decoded = raw / (raw < 0 ? 0x8000 : 0x7fff)
      const expected = Math.max(-1, Math.min(1, samples[i]))
      expect(decoded).toBeCloseTo(expected, 3)
    }
  })

  it('scales data size and length with channel count and frame count', () => {
    const mono = audioBufferToWav(makeBuffer([[0, 0, 0]]))
    const stereo = audioBufferToWav(
      makeBuffer([
        [0, 0, 0],
        [0, 0, 0]
      ])
    )
    expect(stereo.byteLength - 44).toBe((mono.byteLength - 44) * 2)
  })
})

describe('normalizePeak', () => {
  it('scales the buffer so its peak absolute sample matches the target amplitude', () => {
    const buffer = makeBuffer([
      [0.1, -0.2, 0.05],
      [0.2, -0.1, 0.3]
    ])
    const target = dbToLinear(-6)
    normalizePeak(buffer, target)
    let peak = 0
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      for (const v of buffer.getChannelData(ch)) peak = Math.max(peak, Math.abs(v))
    }
    expect(peak).toBeCloseTo(target, 5)
  })

  it('preserves the relative shape of the signal (a pure gain change)', () => {
    const buffer = makeBuffer([[0.1, -0.2, 0.05, 0]])
    normalizePeak(buffer, dbToLinear(-6))
    const data = Array.from(buffer.getChannelData(0))
    // ratios between samples are unchanged by a uniform gain
    expect(data[1] / data[0]).toBeCloseTo(-2, 5)
    expect(data[3]).toBe(0)
  })

  it('leaves a silent buffer untouched instead of dividing by zero', () => {
    const buffer = makeBuffer([[0, 0, 0]])
    normalizePeak(buffer, dbToLinear(-6))
    expect(Array.from(buffer.getChannelData(0))).toEqual([0, 0, 0])
  })

  it('mutates the buffer in place and also returns the same reference', () => {
    const buffer = makeBuffer([[1, -1, 0.5]])
    const result = normalizePeak(buffer, dbToLinear(-6))
    expect(result).toBe(buffer)
  })

  it('never leaves a sample at or above 1.0 in amplitude when targeting -6 dBFS', () => {
    const buffer = makeBuffer([[0.01, -0.02, 0.015]])
    normalizePeak(buffer, dbToLinear(-6))
    for (const v of buffer.getChannelData(0)) expect(Math.abs(v)).toBeLessThan(1)
  })
})
