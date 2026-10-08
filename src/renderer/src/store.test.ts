import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { useStore } from './store'

/** Only the fields the playback actions read. */
function project(durationMs: number, fps: number, cuts: Array<[number, number]> = []): Project {
  return {
    recording: { durationMs, fps },
    cuts: cuts.map(([start, end], i) => ({ id: `c${i}`, start, end }))
  } as unknown as Project
}

function open(p: Project, playheadMs = 0, playing = false): void {
  useStore.setState({ project: p, playheadMs, playing, seekSeq: 0, mode: 'normal' })
}

const state = (): { playheadMs: number; playing: boolean; seekSeq: number } => {
  const { playheadMs, playing, seekSeq } = useStore.getState()
  return { playheadMs, playing, seekSeq }
}

describe('Play / pause', () => {
  beforeEach(() => open(project(10000, 30)))

  it('plays from where the playhead is without seeking', () => {
    useStore.setState({ playheadMs: 4000 })
    useStore.getState().togglePlay()
    expect(state()).toEqual({ playheadMs: 4000, playing: true, seekSeq: 0 })
    useStore.getState().togglePlay()
    expect(state().playing).toBe(false)
  })

  it('at the end starts over from the first frame', () => {
    useStore.setState({ playheadMs: 10000 })
    useStore.getState().togglePlay()
    expect(state()).toEqual({ playheadMs: 0, playing: true, seekSeq: 1 })
  })

  it('at the end of the last kept piece starts over from the first kept frame', () => {
    open(project(10000, 30, [[0, 2000], [8000, 10000]]), 8000)
    useStore.getState().togglePlay()
    expect(state()).toEqual({ playheadMs: 2000, playing: true, seekSeq: 1 })
  })

  it('from inside a removed piece plays the next kept frame', () => {
    open(project(10000, 30, [[2000, 5000]]), 3000)
    useStore.getState().togglePlay()
    expect(state()).toEqual({ playheadMs: 5000, playing: true, seekSeq: 1 })
  })

  it('pausing leaves the playhead alone', () => {
    open(project(10000, 30), 10000, true)
    useStore.getState().togglePlay()
    expect(state()).toEqual({ playheadMs: 10000, playing: false, seekSeq: 0 })
  })
})

describe('frame step', () => {
  const FRAME = 1000 / 30

  it('moves one frame and asks the player to seek', () => {
    open(project(10000, 30), 1000)
    useStore.getState().stepFrame(1)
    expect(state().playheadMs).toBeCloseTo(1000 + FRAME, 3)
    expect(state().seekSeq).toBe(1)
    useStore.getState().stepFrame(-1)
    expect(state().playheadMs).toBeCloseTo(1000, 3)
    expect(state().seekSeq).toBe(2)
  })

  it('uses the recording frame rate', () => {
    open(project(10000, 60), 0)
    useStore.getState().stepFrame(1)
    expect(state().playheadMs).toBeCloseTo(1000 / 60, 3)
  })

  it('stops playback first', () => {
    open(project(10000, 30), 1000, true)
    useStore.getState().stepFrame(1)
    expect(state().playing).toBe(false)
    expect(state().playheadMs).toBeCloseTo(1000 + FRAME, 3)
  })

  it('skips removed pieces and stops at both ends of the output', () => {
    open(project(10000, 30, [[2000, 5000]]), 2000 - FRAME)
    useStore.getState().stepFrame(1)
    expect(state().playheadMs).toBeCloseTo(5000, 3)
    useStore.getState().stepFrame(-1)
    expect(state().playheadMs).toBeCloseTo(2000 - FRAME, 3)

    open(project(10000, 30), 0)
    useStore.getState().stepFrame(-1)
    expect(state().playheadMs).toBe(0)
    useStore.setState({ playheadMs: 10000 })
    useStore.getState().stepFrame(1)
    expect(state().playheadMs).toBe(10000)
  })
})
