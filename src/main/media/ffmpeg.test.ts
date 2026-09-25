import { describe, expect, it } from 'vitest'
import { gifConvertInputArgs, gifConvertPrefilter, rawAudioInputArgs } from './ffmpeg'

describe('rawAudioInputArgs', () => {
  it('maps a float-tagged format (WAVE_FORMAT_EXTENSIBLE/IEEE_FLOAT) to f32le with its rate/channel count', () => {
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8 })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8'
    ])
  })

  it('maps a PCM-tagged format to s16le', () => {
    expect(rawAudioInputArgs({ isFloat: false, rate: 48000, channels: 2 })).toEqual([
      '-f', 's16le', '-ar', '48000', '-ac', '2'
    ])
  })

  it('stringifies rate/channels rather than leaving them numeric (ffmpeg argv is all strings)', () => {
    const args = rawAudioInputArgs({ isFloat: false, rate: 96000, channels: 6 })
    for (const arg of args) expect(typeof arg).toBe('string')
    expect(args).toEqual(['-f', 's16le', '-ar', '96000', '-ac', '6'])
  })

  it('adds -channel_layout for known WAVEFORMATEXTENSIBLE masks (stereo, 5.1, 7.1, 7.1(wide))', () => {
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 2, channelMask: 0x3 })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '2', '-channel_layout', 'stereo'
    ])
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 6, channelMask: 0x3f })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '6', '-channel_layout', '5.1'
    ])
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8, channelMask: 0x63f })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8', '-channel_layout', '7.1'
    ])
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8, channelMask: 0xff })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8', '-channel_layout', '7.1(wide)'
    ])
  })

  it('omits -channel_layout when the mask is unknown, zero, or absent', () => {
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8, channelMask: 0x60f })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8'
    ])
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8, channelMask: 0 })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8'
    ])
    expect(rawAudioInputArgs({ isFloat: true, rate: 44100, channels: 8 })).toEqual([
      '-f', 'f32le', '-ar', '44100', '-ac', '8'
    ])
  })
})

describe('gif converter arguments', () => {
  it('builds an fps + even-width lanczos scale prefilter', () => {
    expect(gifConvertPrefilter(15, 961)).toBe('fps=15,scale=962:-2:flags=lanczos')
    expect(gifConvertPrefilter(0, 4)).toBe('fps=1,scale=16:-2:flags=lanczos')
  })

  it('trims only what is actually trimmed', () => {
    expect(gifConvertInputArgs(0, 10_000, 10_000)).toEqual([])
    expect(gifConvertInputArgs(1500, 10_000, 10_000)).toEqual(['-ss', '1.500'])
    expect(gifConvertInputArgs(0, 4000, 10_000)).toEqual(['-t', '4.000'])
    expect(gifConvertInputArgs(2000, 5000, 10_000)).toEqual(['-ss', '2.000', '-t', '3.000'])
    expect(gifConvertInputArgs(-5, 99_000, 10_000)).toEqual([])
  })
})
