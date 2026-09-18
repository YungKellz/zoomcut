import { useMemo } from 'react'
import type { Project } from '@shared/types'
import { buildFollowPath, type FollowPath } from '../engine/cursor'

/** Memoized "follow the cursor" camera path; rebuilt only when the inputs change. */
export function useFollowPath(project: Project): FollowPath | null {
  const samples = project.cursorData.samples
  const { followSmoothing, followDeadZone, offsetMs } = project.cursor
  const duration = project.recording.durationMs
  return useMemo(() => {
    if (samples.length === 0) return null
    return buildFollowPath(samples, { followSmoothing, followDeadZone, offsetMs }, duration)
  }, [samples, followSmoothing, followDeadZone, offsetMs, duration])
}
