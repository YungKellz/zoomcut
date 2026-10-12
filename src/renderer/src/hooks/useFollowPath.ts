import { useMemo } from 'react'
import type { Project } from '@shared/types'
import { followPathFor, type FollowPath } from '../engine/cursor'

/** Memoized "follow the cursor" camera path (followPathFor, like every export); rebuilt only when its inputs change. */
export function useFollowPath(project: Project): FollowPath | null {
  const samples = project.cursorData.samples
  const { followSmoothing, followDeadZone, offsetMs } = project.cursor
  const duration = project.recording.durationMs
  // the path depends on exactly these fields; the rest of the project changing (zooms, texts, ...) must not rebuild it
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => followPathFor(project), [samples, followSmoothing, followDeadZone, offsetMs, duration])
}
