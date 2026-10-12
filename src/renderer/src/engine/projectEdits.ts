import type { CutRange, Project } from '@shared/types'
import { normalizeZoomParts } from './camera'
import { clipRegionsToCuts, normalizeCuts } from './timeline'

/**
 * Removes `cut` from the recording: overlapping cuts merge, and zooms, texts and blurs are
 * shortened (or dropped when they lie entirely inside a cut) to what stays. Shared by the
 * editor's cut tool and the agent's addCut.
 */
export function addCutToProject(p: Project, cut: CutRange): Project {
  const duration = p.recording.durationMs
  const cuts = normalizeCuts([...p.cuts, cut], duration)
  return {
    ...p,
    cuts,
    // a shortened zoom may no longer have room for all its parts
    zooms: clipRegionsToCuts(p.zooms, cuts, duration, 200).map(normalizeZoomParts),
    texts: clipRegionsToCuts(p.texts, cuts, duration, 100),
    blurs: clipRegionsToCuts(p.blurs, cuts, duration, 100)
  }
}
