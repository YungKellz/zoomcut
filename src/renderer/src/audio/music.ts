import type { TKey } from '../i18n'

/**
 * Five procedural background-music presets, rendered on demand with OfflineAudioContext.
 *
 * The module is split in two halves on purpose:
 *  - a pure "score" half (notes/times, plain data, no Web Audio) that vitest can exercise in
 *    node and that is fully deterministic (seeded PRNG, never Math.random / Date.now), and
 *  - a Web Audio "render" half (OfflineAudioContext, oscillators, filters) that turns a score
 *    into an actual AudioBuffer and is only exercised by hand / in the browser, since jsdom-less
 *    vitest has no Web Audio implementation.
 * audioBufferToWav / normalizePeak operate on a minimal structural interface (AudioBufferLike)
 * instead of the real DOM AudioBuffer type, so they too can be unit-tested with a plain object.
 */

export type MusicPresetId = 'calm' | 'upbeat' | 'lofi' | 'corporate' | 'minimal'

export interface MusicPreset {
  id: MusicPresetId
  bpm: number
  nameKey: TKey
  descriptionKey: TKey
}

export const MUSIC_PRESETS: MusicPreset[] = [
  { id: 'calm', bpm: 72, nameKey: 'music.preset.calm.name', descriptionKey: 'music.preset.calm.desc' },
  { id: 'upbeat', bpm: 118, nameKey: 'music.preset.upbeat.name', descriptionKey: 'music.preset.upbeat.desc' },
  { id: 'lofi', bpm: 82, nameKey: 'music.preset.lofi.name', descriptionKey: 'music.preset.lofi.desc' },
  { id: 'corporate', bpm: 100, nameKey: 'music.preset.corporate.name', descriptionKey: 'music.preset.corporate.desc' },
  { id: 'minimal', bpm: 90, nameKey: 'music.preset.minimal.name', descriptionKey: 'music.preset.minimal.desc' }
]

// The loop length actually used is rounded to a whole number of chords near this target – see
// loopLengthS. Not every preset lands on exactly 60s (see chordDurationS/loopLengthS below).
const TARGET_LOOP_S = 60
const SAMPLE_RATE = 48000
const LOOP_CROSSFADE_S = 2.5
const TARGET_PEAK_DB = -6

// ---------------------------------------------------------------------------------------
// Pure helpers (testable in node)
// ---------------------------------------------------------------------------------------

/** mulberry32: a tiny seeded PRNG. Every preset reseeds from a fixed constant, so building
 * the same preset's score twice (even across processes) always yields the same notes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

// Diatonic scales (semitone offsets from the root) and triads built by stacking two more
// scale-thirds on top of a degree – the standard way to get I/ii/iii/... chords from a scale.
export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

export function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12)
}

/** `degree` is 0-based and may run past the scale length; it just wraps into another octave. */
function scaleNote(root: number, scale: number[], degree: number): number {
  const len = scale.length
  const octave = Math.floor(degree / len)
  const idx = ((degree % len) + len) % len
  return root + 12 * octave + scale[idx]
}

function triad(root: number, scale: number[], degree: number): number[] {
  return [scaleNote(root, scale, degree), scaleNote(root, scale, degree + 2), scaleNote(root, scale, degree + 4)]
}

export type InstrumentId = 'pad' | 'pluck' | 'bass' | 'kick' | 'hat' | 'noise'

/** Instruments whose `note` is a real scale pitch (as opposed to kick/hat/noise, which use
 * `note` as a placeholder – a kick has its own fixed drum pitch, hat/noise are unpitched). */
export const PITCHED_INSTRUMENTS: ReadonlySet<InstrumentId> = new Set(['pad', 'pluck', 'bass'])

export interface NoteEvent {
  /** seconds from the loop start; always inside [0, Score.durationS) */
  time: number
  /** seconds */
  duration: number
  /** MIDI note number; meaningful only for PITCHED_INSTRUMENTS */
  note: number
  /** 0..1 */
  velocity: number
  /** 0..1, higher opens the voice's lowpass filter further; instrument picks a default when omitted */
  brightness?: number
  /** -1..1 stereo position, center (0) when omitted */
  pan?: number
}

export interface InstrumentTrack {
  instrument: InstrumentId
  notes: NoteEvent[]
}

export interface Score {
  /** this preset's actual loop length in seconds (varies per preset, see loopLengthS) */
  durationS: number
  tracks: InstrumentTrack[]
}

// beats per chord/bar, one entry per preset – the single source of truth chordDurationS reads,
// so "{bpm} BPM" in the UI and what actually plays can never drift apart
const CHORD_BEATS: Record<MusicPresetId, number> = {
  calm: 6,
  upbeat: 4,
  lofi: 4,
  corporate: 4,
  minimal: 8
}

const PRESET_TONALITY: Record<MusicPresetId, { root: number; scale: number[] }> = {
  calm: { root: 60, scale: MAJOR_SCALE }, // C4 major
  upbeat: { root: 60, scale: MAJOR_SCALE },
  lofi: { root: 57, scale: MINOR_SCALE }, // A3 natural minor
  corporate: { root: 60, scale: MAJOR_SCALE },
  minimal: { root: 60, scale: MAJOR_SCALE }
}

export function presetTonality(id: MusicPresetId): { root: number; scale: number[] } {
  return PRESET_TONALITY[id]
}

function bpmOf(id: MusicPresetId): number {
  const preset = MUSIC_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`Unknown music preset '${id}'`)
  return preset.bpm
}

/** Seconds per chord/bar for a preset, derived from its listed bpm (see MUSIC_PRESETS) and a
 * fixed beats-per-chord count – never a separate hardcoded number, so the "{bpm} BPM" shown in
 * the UI can never drift from what the score actually plays. */
export function chordDurationS(id: MusicPresetId): number {
  return (60 / bpmOf(id)) * CHORD_BEATS[id]
}

/** The preset's actual loop length: the ~60s target rounded to a whole number of chords/bars,
 * so the loop always ends exactly where a new chord would start. makeSeamlessLoop's crossfade
 * blend still runs on top of this, to remove any residual click from a note or the reverb tail
 * still ringing at that instant. */
function loopLengthS(id: MusicPresetId): number {
  const chordDur = chordDurationS(id)
  return chordDur * Math.round(TARGET_LOOP_S / chordDur)
}

interface BuildCtx {
  rng: () => number
  /** seconds per beat (60 / bpm) */
  beat: number
  /** seconds per chord/bar, see chordDurationS */
  chordDur: number
  /** this preset's loop length, see loopLengthS */
  loopS: number
  root: number
  scale: number[]
}

/**
 * calm: a slow pad cycling the classic I-V-vi-IV progression, one chord every 6 beats
 * (spacious – about 5s at 72bpm), plus a soft root note an octave down for warmth. Nothing
 * percussive – this preset is meant to sit under narration without competing with it.
 */
function buildCalm(ctx: BuildCtx): Score {
  const { rng, chordDur, loopS, root, scale } = ctx
  const progression = [0, 4, 5, 3] // I, V, vi, IV
  const pad: InstrumentTrack = { instrument: 'pad', notes: [] }
  const bass: InstrumentTrack = { instrument: 'bass', notes: [] }
  let t = 0
  let i = 0
  while (t < loopS) {
    const chord = triad(root, scale, progression[i % progression.length])
    const vel = 0.16 + rng() * 0.04 // a little per-chord drift so it breathes, not mechanical
    const pans = [0, -0.3, 0.3]
    chord.forEach((note, idx) => pad.notes.push({ time: t, duration: chordDur * 1.3, note, velocity: vel, brightness: 0.35, pan: pans[idx] }))
    bass.notes.push({ time: t, duration: chordDur * 1.3, note: chord[0] - 12, velocity: 0.22, brightness: 0.2 })
    t += chordDur
    i++
  }
  return { durationS: loopS, tracks: [pad, bass] }
}

/**
 * upbeat: an 8th-note plucked arpeggio (root-third-fifth-third, jumping up an octave for the
 * second half of the bar) over a I-vi-IV-V progression, with a soft half-time kick and a light
 * closed-hat on every 8th note. Energetic but not loud.
 */
function buildUpbeat(ctx: BuildCtx): Score {
  const { rng, beat, chordDur, loopS, root, scale } = ctx
  const progression = [0, 5, 3, 4] // I, vi, IV, V
  const arp: InstrumentTrack = { instrument: 'pluck', notes: [] }
  const kick: InstrumentTrack = { instrument: 'kick', notes: [] }
  const hat: InstrumentTrack = { instrument: 'hat', notes: [] }
  let t = 0
  let bar = 0
  while (t < loopS) {
    const chord = triad(root, scale, progression[bar % progression.length])
    const pattern = [chord[0], chord[1], chord[2], chord[1]]
    for (let step = 0; step < 8; step++) {
      const stepT = t + step * (beat / 2)
      if (stepT >= loopS) break
      const note = pattern[step % pattern.length] + (step >= 4 ? 12 : 0)
      arp.notes.push({ time: stepT, duration: beat / 2, note, velocity: 0.18 + rng() * 0.05, brightness: 0.6 })
      hat.notes.push({ time: stepT, duration: 0.05, note: 0, velocity: 0.08 + rng() * 0.05 })
    }
    if (t < loopS) kick.notes.push({ time: t, duration: 0.15, note: 36, velocity: 0.5 })
    if (t + beat * 2 < loopS) kick.notes.push({ time: t + beat * 2, duration: 0.15, note: 36, velocity: 0.42 })
    t += chordDur
    bar++
  }
  return { durationS: loopS, tracks: [arp, kick, hat] }
}

/**
 * lofi: mellow swung 8th-note keys over a i-iv-v-i minor progression (some slots left silent
 * for a laid-back feel), plus a continuous gentle filtered-noise bed for texture.
 */
function buildLofi(ctx: BuildCtx): Score {
  const { rng, beat, chordDur, loopS, root, scale } = ctx
  const progression = [0, 3, 4, 0] // i, iv, v, i
  const keys: InstrumentTrack = { instrument: 'pluck', notes: [] }
  // the bed runs to the end of the render (loop + crossfade tail) with no fade-out of its own –
  // see scheduleNoiseBed, this is what lets the crossfade fold a live tail back into the loop
  // start instead of silence, so the "hiss" does not audibly dip once per loop
  const bed: InstrumentTrack = { instrument: 'noise', notes: [{ time: 0, duration: loopS + LOOP_CROSSFADE_S, note: 0, velocity: 0.05 }] }
  let t = 0
  let bar = 0
  while (t < loopS) {
    const chord = triad(root, scale, progression[bar % progression.length])
    for (let step = 0; step < 8; step++) {
      // swing: every offbeat 8th is dragged a third of an 8th later
      const stepT = t + step * (beat / 2) + (step % 2 === 1 ? (beat / 2) * 0.33 : 0)
      if (stepT >= loopS) break
      if (rng() < 0.35) continue // leave gaps instead of playing every note
      keys.notes.push({ time: stepT, duration: beat * 0.9, note: chord[step % chord.length], velocity: 0.14 + rng() * 0.05, brightness: 0.22 })
    }
    t += chordDur
    bar++
  }
  return { durationS: loopS, tracks: [keys, bed] }
}

/**
 * corporate: a bright sustained pad under a piano-like top-line pluck picking the chord's
 * upper notes on beats 1 and 3 of a I-IV-V-IV progression – upbeat and optimistic.
 */
function buildCorporate(ctx: BuildCtx): Score {
  const { rng, beat, chordDur, loopS, root, scale } = ctx
  const progression = [0, 3, 4, 3] // I, IV, V, IV
  const pad: InstrumentTrack = { instrument: 'pad', notes: [] }
  const pluck: InstrumentTrack = { instrument: 'pluck', notes: [] }
  let t = 0
  let bar = 0
  while (t < loopS) {
    const chord = triad(root, scale, progression[bar % progression.length])
    const pans = [0, -0.25, 0.25]
    chord.forEach((note, idx) => pad.notes.push({ time: t, duration: chordDur * 1.05, note, velocity: 0.14, brightness: 0.55, pan: pans[idx] }))
    pluck.notes.push({ time: t, duration: beat * 1.2, note: chord[2] + 12, velocity: 0.22 + rng() * 0.05, brightness: 0.8 })
    if (t + beat * 2 < loopS) pluck.notes.push({ time: t + beat * 2, duration: beat * 1.2, note: chord[1] + 12, velocity: 0.2 + rng() * 0.05, brightness: 0.8 })
    t += chordDur
    bar++
  }
  return { durationS: loopS, tracks: [pad, pluck] }
}

/**
 * minimal: a slow-moving sub bass (one note every bar) under sparse marimba-like plucks –
 * only ~a third of the 8th-note slots actually play a note, picked from the current chord at
 * a random octave-up degree.
 */
function buildMinimal(ctx: BuildCtx): Score {
  const { rng, beat, chordDur, loopS, root, scale } = ctx
  const progression = [0, 5, 3, 4]
  const sub: InstrumentTrack = { instrument: 'bass', notes: [] }
  const pluck: InstrumentTrack = { instrument: 'pluck', notes: [] }
  let t = 0
  let bar = 0
  while (t < loopS) {
    const chord = triad(root, scale, progression[bar % progression.length])
    sub.notes.push({ time: t, duration: chordDur * 0.95, note: chord[0] - 24, velocity: 0.3, brightness: 0.15 })
    const steps = Math.round(chordDur / (beat / 2))
    for (let step = 0; step < steps; step++) {
      const stepT = t + step * (beat / 2)
      if (stepT >= loopS) break
      if (rng() > 0.32) continue
      const note = chord[Math.floor(rng() * chord.length)] + 12
      pluck.notes.push({ time: stepT, duration: 0.35, note, velocity: 0.16 + rng() * 0.06, brightness: 0.7 })
    }
    t += chordDur
    bar++
  }
  return { durationS: loopS, tracks: [sub, pluck] }
}

// One fixed seed per preset: buildScore is a pure function of `id` alone.
const PRESET_SEEDS: Record<MusicPresetId, number> = {
  calm: 10403,
  upbeat: 20717,
  lofi: 30931,
  corporate: 41151,
  minimal: 51373
}

export function buildScore(id: MusicPresetId): Score {
  const ctx: BuildCtx = {
    rng: mulberry32(PRESET_SEEDS[id]),
    beat: 60 / bpmOf(id),
    chordDur: chordDurationS(id),
    loopS: loopLengthS(id),
    ...presetTonality(id)
  }
  switch (id) {
    case 'calm':
      return buildCalm(ctx)
    case 'upbeat':
      return buildUpbeat(ctx)
    case 'lofi':
      return buildLofi(ctx)
    case 'corporate':
      return buildCorporate(ctx)
    case 'minimal':
      return buildMinimal(ctx)
  }
}

/** Minimal structural subset of the DOM AudioBuffer, so audioBufferToWav/normalizePeak can be
 * unit-tested in node with a plain object instead of a real (browser-only) AudioBuffer. */
export interface AudioBufferLike {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData(channel: number): Float32Array
}

function writeAsciiString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 16-bit PCM WAV – the format the main process's ffmpeg convertAudio() step re-encodes to the
 * project's AAC .m4a (see src/main/media/audioImport.ts). Samples are interleaved per frame
 * (channel 0, channel 1, ..., channel 0, channel 1, ...), the standard WAV layout. */
export function audioBufferToWav(buffer: AudioBufferLike): ArrayBuffer {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const blockAlign = numChannels * 2
  const dataSize = numFrames * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)

  writeAsciiString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAsciiString(view, 8, 'WAVE')
  writeAsciiString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  writeAsciiString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch))
  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

/** Scans every channel for the highest absolute sample and scales the whole buffer so the
 * peak sits at `targetPeak` (linear amplitude, see dbToLinear). A silent buffer (peak 0) is
 * left untouched instead of dividing by zero. Mutates in place and returns the same buffer. */
export function normalizePeak(buffer: AudioBufferLike, targetPeak: number): AudioBufferLike {
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  }
  if (peak <= 1e-9) return buffer
  const gain = targetPeak / peak
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) data[i] *= gain
  }
  return buffer
}

// ---------------------------------------------------------------------------------------
// Web Audio render (browser-only; not covered by the node unit tests, see the module doc)
// ---------------------------------------------------------------------------------------

function whiteNoiseBuffer(ctx: BaseAudioContext, seconds: number, rng: () => number): AudioBuffer {
  const length = Math.max(1, Math.round(seconds * ctx.sampleRate))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = rng() * 2 - 1
  }
  return buffer
}

/** A short generated convolution reverb: white noise with an exponential decay envelope in
 * each ear. Uses the render's own seeded rng so the whole render stays deterministic. */
function createReverbImpulse(ctx: BaseAudioContext, rng: () => number, seconds = 1.6, decay = 3.2): AudioBuffer {
  const length = Math.max(1, Math.round(seconds * ctx.sampleRate))
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = (rng() * 2 - 1) * Math.pow(1 - i / length, decay)
  }
  return impulse
}

/** pad: two slightly detuned triangle oscillators through a lowpass filter with a soft
 * attack/release – a wide, sustained chord tone. */
function schedulePad(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent): void {
  const freq = midiToFreq(note.note)
  const attack = Math.min(0.9, note.duration * 0.4)
  const release = Math.min(1.2, note.duration * 0.4)
  const sustainAt = Math.max(attack, note.duration - release)
  const start = ctx.currentTime + note.time

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 400 + (note.brightness ?? 0.4) * 3000
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(note.velocity, start + attack)
  gain.gain.setValueAtTime(note.velocity, start + sustainAt)
  gain.gain.linearRampToValueAtTime(0, start + note.duration)
  const panner = ctx.createStereoPanner()
  panner.pan.value = note.pan ?? 0
  gain.connect(filter)
  filter.connect(panner)
  panner.connect(out)

  for (const detune of [-6, 6]) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq
    osc.detune.value = detune
    osc.connect(gain)
    osc.start(start)
    osc.stop(start + note.duration + 0.05)
  }
}

/** pluck: a single oscillator with a fast attack and an exponential decay – reads as a
 * plucked or mallet note. `brightness` opens the filter for a harder attack (piano/marimba). */
function schedulePluck(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent): void {
  const start = ctx.currentTime + note.time
  const attack = 0.006
  const tail = Math.max(attack + 0.02, note.duration)

  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = midiToFreq(note.note)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 500 + (note.brightness ?? 0.5) * 6000
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(note.velocity, start + attack)
  gain.gain.exponentialRampToValueAtTime(0.0008, start + tail)
  const panner = ctx.createStereoPanner()
  panner.pan.value = note.pan ?? 0
  osc.connect(filter)
  filter.connect(gain)
  gain.connect(panner)
  panner.connect(out)
  osc.start(start)
  osc.stop(start + tail + 0.05)
}

/** bass/sub: a plain sine – already free of harsh harmonics, so no filter is needed. */
function scheduleBass(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent): void {
  const start = ctx.currentTime + note.time
  const attack = Math.min(0.25, note.duration * 0.3)
  const release = Math.min(0.4, note.duration * 0.3)
  const sustainAt = Math.max(attack, note.duration - release)

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = midiToFreq(note.note)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(note.velocity, start + attack)
  gain.gain.setValueAtTime(note.velocity, start + sustainAt)
  gain.gain.linearRampToValueAtTime(0, start + note.duration)
  osc.connect(gain)
  gain.connect(out)
  osc.start(start)
  osc.stop(start + note.duration + 0.05)
}

/** kick: a sine dropping from ~150Hz to ~45Hz over ~90ms with a matching amplitude envelope. */
function scheduleKick(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent): void {
  const start = ctx.currentTime + note.time
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150, start)
  osc.frequency.exponentialRampToValueAtTime(45, start + 0.09)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(note.velocity, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16)
  osc.connect(gain)
  gain.connect(out)
  osc.start(start)
  osc.stop(start + 0.2)
}

/** hat: a highpassed noise burst – just the "tick" of a closed hi-hat. */
function scheduleHat(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent, rng: () => number): void {
  const start = ctx.currentTime + note.time
  const tail = Math.max(0.03, note.duration)
  const src = ctx.createBufferSource()
  src.buffer = whiteNoiseBuffer(ctx, 0.05, rng)
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 7000
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(note.velocity, start)
  gain.gain.exponentialRampToValueAtTime(0.0008, start + tail)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(out)
  src.start(start)
  src.stop(start + tail + 0.02)
}

/** noise: continuous band-passed noise at a low level – a gentle "tape hiss" bed (lofi). Only
 * fades in at the start; it is meant to run to the end of the render (through the crossfade
 * tail, see buildLofi) with no fade-out of its own, so makeSeamlessLoop's blend has real tail
 * content to fold back into the loop start instead of silence. */
function scheduleNoiseBed(ctx: BaseAudioContext, out: AudioNode, note: NoteEvent, rng: () => number): void {
  const start = ctx.currentTime + note.time
  const fadeIn = Math.min(0.5, note.duration * 0.3)
  const src = ctx.createBufferSource()
  src.buffer = whiteNoiseBuffer(ctx, note.duration, rng)
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 1400
  filter.Q.value = 0.6
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(note.velocity, start + fadeIn)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(out)
  src.start(start)
  src.stop(start + note.duration + 0.05)
}

function scheduleNote(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode, track: InstrumentTrack, note: NoteEvent, rng: () => number): void {
  // every voice gets both a dry path and a reverb send, mixed by the caller's gain nodes
  const bus = ctx.createGain()
  bus.connect(dry)
  bus.connect(wet)
  switch (track.instrument) {
    case 'pad':
      return schedulePad(ctx, bus, note)
    case 'pluck':
      return schedulePluck(ctx, bus, note)
    case 'bass':
      return scheduleBass(ctx, bus, note)
    case 'kick':
      return scheduleKick(ctx, bus, note)
    case 'hat':
      return scheduleHat(ctx, bus, note, rng)
    case 'noise':
      return scheduleNoiseBed(ctx, bus, note, rng)
  }
}

/**
 * Renders `loopS` seconds plus a `crossfadeS` tail past the end, then folds that tail into
 * the head: any note ringing out past the nominal loop point (a pad's release, the reverb
 * tail) gets added back at the start instead of being cut off, so playing the returned buffer
 * back-to-back has no audible seam. The head itself is untouched (not faded), only the
 * decaying tail is blended in – it is already quiet by construction, so this never clips
 * (normalizePeak runs after this and would catch it even if it did).
 */
function makeSeamlessLoop(rendered: AudioBuffer, loopS: number, crossfadeS: number): AudioBuffer {
  const n = Math.min(rendered.length, Math.round(loopS * rendered.sampleRate))
  const x = Math.max(1, Math.min(n, Math.round(crossfadeS * rendered.sampleRate)))
  const out = new AudioBuffer({ numberOfChannels: rendered.numberOfChannels, length: n, sampleRate: rendered.sampleRate })
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const src = rendered.getChannelData(ch)
    const dst = out.getChannelData(ch)
    dst.set(src.subarray(0, n))
    for (let i = 0; i < x; i++) {
      const tailIndex = n + i
      if (tailIndex >= rendered.length) break
      dst[i] += src[tailIndex] * (1 - i / x)
    }
  }
  return out
}

/**
 * Renders a preset to a seamless stereo AudioBuffer at 48kHz (loop length varies per preset,
 * see loopLengthS): builds its deterministic score, schedules every note through
 * OfflineAudioContext with a shared lowpass "tone" filter and a short algorithmic reverb send
 * (itself routed through the same tone filter), blends the loop seam and normalizes the peak
 * to ≈ -6 dBFS. Async because OfflineAudioContext rendering is (it never blocks the UI thread).
 */
export async function renderMusic(id: MusicPresetId): Promise<AudioBuffer> {
  const score = buildScore(id)
  const loopS = score.durationS
  const totalS = loopS + LOOP_CROSSFADE_S
  const ctx = new OfflineAudioContext(2, Math.ceil(totalS * SAMPLE_RATE), SAMPLE_RATE)
  const renderRng = mulberry32(PRESET_SEEDS[id] ^ 0x2545f491) // separate stream: reverb/noise, still deterministic

  const master = ctx.createGain()
  master.gain.value = 1
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 12000 // tasteful: no harsh top end on a background bed
  master.connect(tone)
  tone.connect(ctx.destination)

  const reverbSend = ctx.createGain()
  reverbSend.gain.value = 0.2
  const convolver = ctx.createConvolver()
  convolver.buffer = createReverbImpulse(ctx, renderRng, 1.6, 3.2)
  reverbSend.connect(convolver)
  convolver.connect(tone) // through the same lowpass as the dry signal, not straight to destination

  for (const track of score.tracks) {
    for (const note of track.notes) scheduleNote(ctx, master, reverbSend, track, note, renderRng)
  }

  const rendered = await ctx.startRendering()
  const looped = makeSeamlessLoop(rendered, loopS, LOOP_CROSSFADE_S)
  return normalizePeak(looped, dbToLinear(TARGET_PEAK_DB)) as AudioBuffer
}
