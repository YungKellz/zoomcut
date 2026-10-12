/**
 * The agent's view of a project (projects.get / projects.edit): everything needed to plan edits,
 * nothing heavy (no cursor samples, window snapshots or file contents). Shared because main
 * answers projects.get from disk while the renderer answers projects.edit from the edited project.
 */
import type { AgentProjectView } from './agent'
import { keepSegments, outputDuration } from './timeline'
import type { CutRange, Project } from './types'

/** at most this many recorded clicks are listed; more are thinned out evenly so the whole recording stays covered */
export const AGENT_MAX_CLICKS = 500

/** Length of the project once the cuts are applied: the same rule the editor, export and compositions use (shared/timeline.ts). */
export function outputDurationMs(durationMs: number, cuts: CutRange[]): number {
  return outputDuration(keepSegments(durationMs, cuts))
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.floor((i * items.length) / max)])
  return out
}

export function toAgentProjectView(project: Project): AgentProjectView {
  const { recording } = project
  return {
    id: project.id,
    name: project.name,
    createdAt: recording.createdAt,
    dir: recording.dir,
    width: recording.width,
    height: recording.height,
    fps: recording.fps,
    sourceDurationMs: recording.durationMs,
    outputDurationMs: outputDurationMs(recording.durationMs, project.cuts),
    cuts: project.cuts,
    zooms: project.zooms,
    texts: project.texts,
    blurs: project.blurs,
    crop: project.crop,
    frame: project.frame,
    cursor: project.cursor,
    export: project.export,
    origin: project.origin ?? null,
    clicks: thin(project.cursorData?.clicks ?? [], AGENT_MAX_CLICKS),
    audio: (project.audio ?? []).map((clip) => ({ id: clip.id, kind: clip.kind, name: clip.name }))
  }
}
