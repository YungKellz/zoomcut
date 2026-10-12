/**
 * The agent's view of a project (projects.get / projects.edit): everything needed to plan edits,
 * nothing heavy (no cursor samples, window snapshots or file contents). Shared because main
 * answers projects.get from disk while the renderer answers projects.edit from the edited project.
 */
import type { AgentProjectView } from './agent'
import type { CutRange, Project } from './types'

/** at most this many recorded clicks are listed; more are thinned out evenly so the whole recording stays covered */
export const AGENT_MAX_CLICKS = 500

/**
 * Length of the project once the cuts are applied. Mirrors renderer/engine/timeline.ts
 * (normalizeCuts → keepSegments → outputDuration, which drops kept pieces shorter than
 * MIN_SEGMENT_MS); shared code cannot import renderer code, agentProject.test.ts pins the two together.
 */
export function outputDurationMs(durationMs: number, cuts: CutRange[]): number {
  const MIN_SEGMENT_MS = 40
  const spans = cuts
    .map((c) => ({
      start: Math.max(0, Math.min(durationMs, Math.min(c.start, c.end))),
      end: Math.max(0, Math.min(durationMs, Math.max(c.start, c.end)))
    }))
    .filter((c) => c.end - c.start >= 1)
    .sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const cut of spans) {
    const last = merged[merged.length - 1]
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end)
    else merged.push({ ...cut })
  }
  let total = 0
  let cursor = 0
  for (const cut of merged) {
    if (cut.start - cursor >= MIN_SEGMENT_MS) total += cut.start - cursor
    cursor = Math.max(cursor, cut.end)
  }
  if (durationMs - cursor >= MIN_SEGMENT_MS) total += durationMs - cursor
  return total
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
