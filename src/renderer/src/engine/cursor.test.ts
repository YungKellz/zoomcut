import { describe, expect, it } from 'vitest'
import type { CursorSample, Project } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS } from '@shared/defaults'
import { buildFollowPath, followPathFor } from './cursor'

const samples: CursorSample[] = [
  { t: 0, x: 0.2, y: 0.2 },
  { t: 100, x: 0.8, y: 0.7 },
  { t: 200, x: 0.8, y: 0.7 }
]

/** the parts of a project the follow path reads */
function project(patch: Partial<Pick<Project, 'cursor'>> & { samples?: CursorSample[]; durationMs?: number } = {}): Project {
  return {
    cursor: patch.cursor ?? { ...DEFAULT_CURSOR_SETTINGS },
    cursorData: { samples: patch.samples ?? samples, clicks: [], source: 'uiohook' },
    recording: { durationMs: patch.durationMs ?? 1000 }
  } as unknown as Project
}

describe('followPathFor', () => {
  it('is null for a recording without cursor data', () => {
    expect(followPathFor(project({ samples: [] }))).toBeNull()
  })

  it('builds the path from the project own samples, cursor settings and duration', () => {
    const p = project({ cursor: { ...DEFAULT_CURSOR_SETTINGS, followSmoothing: 0.2, followDeadZone: 0.05, offsetMs: 40 }, durationMs: 800 })
    const { followSmoothing, followDeadZone, offsetMs } = p.cursor
    const expected = buildFollowPath(samples, { followSmoothing, followDeadZone, offsetMs }, 800)
    const path = followPathFor(p)!
    expect(path.stepMs).toBe(expected.stepMs)
    expect(Array.from(path.xs)).toEqual(Array.from(expected.xs))
    expect(Array.from(path.ys)).toEqual(Array.from(expected.ys))
  })

  it('follows a changed cursor setting', () => {
    const calm = followPathFor(project({ cursor: { ...DEFAULT_CURSOR_SETTINGS, followSmoothing: 1 } }))!
    const quick = followPathFor(project({ cursor: { ...DEFAULT_CURSOR_SETTINGS, followSmoothing: 0 } }))!
    expect(Array.from(quick.xs)).not.toEqual(Array.from(calm.xs))
  })
})
