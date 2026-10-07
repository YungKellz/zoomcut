import type { ProjectSummary, ScenarioSummary } from '@shared/types'

/** One entry of the home list: a recording on its own, or a scenario with the recordings made from it. */
export type HomeItem =
  | { kind: 'recording'; project: ProjectSummary; at: number }
  | { kind: 'scenario'; scenario: ScenarioSummary; children: ProjectSummary[]; at: number }

/**
 * Merges recordings and scenarios into the single home list. A recording whose scenario no
 * longer exists (deleted - its recordings are kept) is a standalone one again. Newest activity
 * first: a recording by its creation time, a scenario block by the newest of its own creation
 * and its recordings'; the recordings inside a block are newest first as well.
 */
export function buildHomeItems(projects: ProjectSummary[], scenarios: ScenarioSummary[]): HomeItem[] {
  const blocks = new Map<string, Extract<HomeItem, { kind: 'scenario' }>>()
  for (const scenario of scenarios) blocks.set(scenario.id, { kind: 'scenario', scenario, children: [], at: scenario.createdAt })
  const items: HomeItem[] = []
  for (const project of projects) {
    const block = project.scenarioId ? blocks.get(project.scenarioId) : undefined
    if (block) {
      block.children.push(project)
      block.at = Math.max(block.at, project.createdAt)
    } else {
      items.push({ kind: 'recording', project, at: project.createdAt })
    }
  }
  for (const block of blocks.values()) {
    block.children.sort((a, b) => b.createdAt - a.createdAt)
    items.push(block)
  }
  return items.sort((a, b) => b.at - a.at)
}
