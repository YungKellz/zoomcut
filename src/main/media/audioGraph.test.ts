import { describe, expect, it } from 'vitest'
import type { AudioExportPlan } from '@shared/types'
import { buildAudioFilterComplex } from './audioGraph'

describe('buildAudioFilterComplex', () => {
  it('builds a two-track graph: resample/format, per-piece atrim/apad/adelay, per-track mix+volume, final mix+atrim', () => {
    const plan: AudioExportPlan = {
      outDurationMs: 10000,
      tracks: [
        {
          path: '/a/system.m4a',
          durationMs: 10000,
          pieces: [
            { fileStart: 0, fileEnd: 3000, outAt: 0 },
            { fileStart: 5000, fileEnd: 10000, outAt: 3000 }
          ],
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0
        },
        {
          path: '/a/music.wav',
          durationMs: 4000,
          // loops: fileEnd (10000) runs past this track's own durationMs (4000)
          pieces: [{ fileStart: 0, fileEnd: 10000, outAt: 0 }],
          volume: 0.35,
          fadeInMs: 0,
          fadeOutMs: 1500
        }
      ]
    }
    const graph = buildAudioFilterComplex(plan)

    // the caller (media/ffmpeg.ts) needs these to build its own -i / -map arguments
    expect(graph.inputs).toEqual(['/a/system.m4a', '/a/music.wav'])
    expect(graph.outLabel).toBe('[aout]')

    // track 0 (input index 1): two pieces, no aloop (no piece exceeds its own durationMs).
    // Piece/split labels are namespaced under the track's own base label (a0b -> a0bp*/a0bo*)
    // so two tracks' labels can never collide.
    expect(graph.filterComplex).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0b]')
    expect(graph.filterComplex).not.toMatch(/\[a0b\]aloop/)
    expect(graph.filterComplex).toContain('[a0b]asplit=2[a0bp0][a0bp1]')
    // atrim/apad in seconds, adelay in ms with :all=1
    expect(graph.filterComplex).toContain('[a0bp0]atrim=start=0.000:end=3.000,asetpts=PTS-STARTPTS,apad=whole_dur=3.000,adelay=0:all=1[a0bo0]')
    expect(graph.filterComplex).toContain('[a0bp1]atrim=start=5.000:end=10.000,asetpts=PTS-STARTPTS,apad=whole_dur=5.000,adelay=3000:all=1[a0bo1]')
    expect(graph.filterComplex).toContain('[a0bo0][a0bo1]amix=inputs=2:normalize=0:duration=longest[a0mix]')
    expect(graph.filterComplex).toContain('[a0mix]volume=1[a0f]')

    // track 1 (input index 2): one piece, loops (fileEnd 10000 > durationMs 4000); aloop's
    // size is capped at the file's own sample count, not an arbitrary huge constant
    const expectedLoopSize = Math.ceil((4000 / 1000) * 48000)
    expect(graph.filterComplex).toContain(
      `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,aloop=loop=-1:size=${expectedLoopSize}[a1b]`
    )
    // a single piece skips asplit/amix entirely and goes straight from the base label
    expect(graph.filterComplex).not.toContain('[a1b]asplit')
    expect(graph.filterComplex).toContain('[a1b]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,apad=whole_dur=10.000,adelay=0:all=1[a1bo0]')
    expect(graph.filterComplex).not.toContain('[a1bo0][')
    // fadeOut only (fadeIn is 0 and must be skipped): st = lastEnd(10000ms) - fadeOutMs(1500ms)
    expect(graph.filterComplex).toContain('[a1bo0]volume=0.35,afade=t=out:st=8.500:d=1.500[a1f]')

    // both tracks combined, then trimmed to the output duration
    expect(graph.filterComplex.endsWith('[a0f][a1f]amix=inputs=2:normalize=0:duration=longest,atrim=0:10.000[aout]')).toBe(true)
  })

  it('clamps a negative afade start to 0 instead of producing an invalid filter', () => {
    const plan: AudioExportPlan = {
      outDurationMs: 5000,
      tracks: [
        {
          path: '/a/voice.m4a',
          durationMs: 5000,
          // lastEnd(1000) - fadeOutMs(2000) would be -1000 if not clamped
          pieces: [{ fileStart: 0, fileEnd: 1000, outAt: 0 }],
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 2000
        }
      ]
    }
    const graph = buildAudioFilterComplex(plan)
    expect(graph.filterComplex).toContain('afade=t=out:st=0.000:d=2.000')
    expect(graph.filterComplex).not.toMatch(/st=-/)
  })

  it('skips a zero-duration fade entirely rather than emitting a no-op afade', () => {
    const plan: AudioExportPlan = {
      outDurationMs: 3000,
      tracks: [
        {
          path: '/a/x.m4a',
          durationMs: 3000,
          pieces: [{ fileStart: 0, fileEnd: 3000, outAt: 0 }],
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0
        }
      ]
    }
    const graph = buildAudioFilterComplex(plan)
    expect(graph.filterComplex).not.toContain('afade')
  })

  it('passes a single track straight through to the final atrim (no top-level amix for one track)', () => {
    const plan: AudioExportPlan = {
      outDurationMs: 2000,
      tracks: [
        {
          path: '/a/x.m4a',
          durationMs: 2000,
          pieces: [{ fileStart: 0, fileEnd: 2000, outAt: 0 }],
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0
        }
      ]
    }
    const graph = buildAudioFilterComplex(plan)
    expect(graph.filterComplex.endsWith('[a0f]atrim=0:2.000[aout]')).toBe(true)
    expect(graph.filterComplex).not.toMatch(/amix=inputs=1\b/)
  })
})
