import { describe, expect, it } from 'vitest'
import type { AudioClip, Project } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'
import { keepSegments } from '../engine/timeline'
import { buildAudioPlan } from './audioPlan'

function makeProject(audio: AudioClip[], durationMs: number): Project {
  return {
    version: 1,
    id: 'p1',
    name: 'test project',
    recording: {
      id: 'p1',
      createdAt: 0,
      dir: '/rec/p1',
      videoPath: '/rec/p1/source.mp4',
      width: 1920,
      height: 1080,
      durationMs,
      fps: 30,
      displayName: 'Display 1'
    },
    cursorData: { samples: [], clicks: [], source: 'none' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio,
    cursor: DEFAULT_CURSOR_SETTINGS,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: DEFAULT_FRAME_STYLE,
    export: { ...DEFAULT_EXPORT_SETTINGS, gif: { ...DEFAULT_EXPORT_SETTINGS.gif } },
    updatedAt: 0
  }
}

function makeClip(overrides: Partial<AudioClip>): AudioClip {
  return {
    id: 'c1',
    kind: 'system',
    file: 'system.m4a',
    name: 'System audio',
    start: 0,
    durationMs: 10000,
    volume: 1,
    muted: false,
    loop: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...overrides
  }
}

describe('buildAudioPlan', () => {
  it('returns null when there is nothing audible', () => {
    expect(buildAudioPlan(makeProject([], 5000), keepSegments(5000, []))).toBeNull()
  })

  it('splits a recorded clip into one piece per kept segment, skipping the cut (negative start)', () => {
    const segments = keepSegments(10000, [{ id: 'cut', start: 3000, end: 5000 }])
    const project = makeProject([makeClip({ kind: 'system', start: -100, durationMs: 10100 })], 10000)
    const plan = buildAudioPlan(project, segments)
    expect(plan).not.toBeNull()
    expect(plan!.outDurationMs).toBe(8000)
    expect(plan!.tracks).toHaveLength(1)
    expect(plan!.tracks[0].path).toBe('/rec/p1/system.m4a')
    expect(plan!.tracks[0].durationMs).toBe(10100)
    expect(plan!.tracks[0].pieces).toEqual([
      { fileStart: 100, fileEnd: 3100, outAt: 0 },
      { fileStart: 5100, fileEnd: 10100, outAt: 3000 }
    ])
  })

  it("clamps a recorded piece to the file's own duration when it is shorter than the segment", () => {
    const segments = keepSegments(10000, [])
    const project = makeProject([makeClip({ kind: 'mic', start: -50, durationMs: 9980 })], 10000)
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 50, fileEnd: 9980, outAt: 0 }])
  })

  it('drops an overlay clip that starts after the output ends', () => {
    const segments = keepSegments(5000, [])
    const project = makeProject([makeClip({ kind: 'music', start: 6000, durationMs: 3000, loop: true })], 5000)
    expect(buildAudioPlan(project, segments)).toBeNull()
  })

  it("expresses a looped clip as a piece whose fileEnd runs past the file's own duration", () => {
    const segments = keepSegments(20000, [])
    const project = makeProject([makeClip({ kind: 'music', start: 0, durationMs: 5000, loop: true, volume: 0.35 })], 20000)
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 0, fileEnd: 20000, outAt: 0 }])
    expect(plan!.tracks[0].volume).toBe(0.35)
  })

  it('skips a muted clip and a clip with zero volume', () => {
    const segments = keepSegments(5000, [])
    const project = makeProject(
      [makeClip({ id: 'c1', kind: 'system', muted: true }), makeClip({ id: 'c2', kind: 'mic', volume: 0 })],
      5000
    )
    expect(buildAudioPlan(project, segments)).toBeNull()
  })

  it('shifts outAt when a cut removes the very beginning (first piece has fileStart > 0 at outAt 0)', () => {
    const segments = keepSegments(10000, [{ id: 'cut', start: 0, end: 2000 }])
    const project = makeProject([makeClip({ kind: 'system', start: 0, durationMs: 10000 })], 10000)
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 2000, fileEnd: 10000, outAt: 0 }])
  })

  it('shifts outAt forward when a recorded clip started after the video (clip.start > 0)', () => {
    const segments = keepSegments(10000, [])
    // the mic recorder started 200ms late: the file has nothing for the output's first 200ms
    const project = makeProject([makeClip({ kind: 'mic', start: 200, durationMs: 9800 })], 10000)
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 0, fileEnd: 9800, outAt: 200 }])
  })

  it('truncates a non-looping overlay clip that would otherwise run past the output end', () => {
    const segments = keepSegments(10000, [])
    const project = makeProject([makeClip({ kind: 'music', start: 8000, durationMs: 5000, loop: false })], 10000)
    const plan = buildAudioPlan(project, segments)
    // only 2s of output remain after outAt=8000, even though the file has 5s of content
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 0, fileEnd: 2000, outAt: 8000 }])
  })

  it('drops a kept segment that falls entirely past the end of the recorded file', () => {
    const segments = keepSegments(10000, [{ id: 'cut', start: 2000, end: 5000 }])
    const project = makeProject([makeClip({ kind: 'system', start: 0, durationMs: 3000 })], 10000)
    const plan = buildAudioPlan(project, segments)
    // segment [0,2000) fits; segment [5000,10000) maps to file time [5000,10000), entirely
    // past the file's own 3000ms duration, so it produces no piece
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 0, fileEnd: 2000, outAt: 0 }])
  })

  it('places a negative-start overlay clip at outAt 0 with the lead-in trimmed off', () => {
    const segments = keepSegments(10000, [])
    const project = makeProject([makeClip({ kind: 'music', start: -500, durationMs: 5000, loop: false })], 10000)
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks[0].pieces).toEqual([{ fileStart: 500, fileEnd: 5000, outAt: 0 }])
  })

  it('keeps two tracks in project.audio order (index/label ordering downstream)', () => {
    const segments = keepSegments(5000, [])
    const project = makeProject(
      [makeClip({ id: 'c1', kind: 'system', file: 'system.m4a' }), makeClip({ id: 'c2', kind: 'mic', file: 'mic.m4a', durationMs: 5000 })],
      5000
    )
    const plan = buildAudioPlan(project, segments)
    expect(plan!.tracks.map((t) => t.path)).toEqual(['/rec/p1/system.m4a', '/rec/p1/mic.m4a'])
  })
})
