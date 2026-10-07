import { describe, expect, it } from 'vitest'
import type { ProjectSummary, ScenarioSummary } from '@shared/types'
import { buildHomeItems } from './items'

function project(id: string, createdAt: number, scenarioId: string | null = null): ProjectSummary {
  return { id, name: id, createdAt, updatedAt: createdAt, durationMs: 1000, width: 1920, height: 1080, dir: id, scenarioId }
}
function scenario(id: string, createdAt: number): ScenarioSummary {
  return { id, name: id, createdAt, actions: 3, durationMs: 5000 }
}

/** compact view of the result: "r:<id>" for a recording, "s:<id>[child,child]" for a block */
function shape(items: ReturnType<typeof buildHomeItems>): string[] {
  return items.map((i) => (i.kind === 'recording' ? `r:${i.project.id}` : `s:${i.scenario.id}[${i.children.map((c) => c.id).join(',')}]`))
}

describe('buildHomeItems', () => {
  it('is empty without recordings and scenarios', () => {
    expect(buildHomeItems([], [])).toEqual([])
  })

  it('lists plain recordings newest first', () => {
    expect(shape(buildHomeItems([project('a', 1), project('b', 3), project('c', 2)], []))).toEqual(['r:b', 'r:c', 'r:a'])
  })

  it('nests the recordings made from a scenario under it, newest first', () => {
    const items = buildHomeItems([project('old', 10, 's1'), project('new', 20, 's1')], [scenario('s1', 5)])
    expect(shape(items)).toEqual(['s:s1[new,old]'])
  })

  it('shows a scenario without recordings as an empty block', () => {
    expect(shape(buildHomeItems([], [scenario('s1', 5)]))).toEqual(['s:s1[]'])
  })

  it('orders a block by its newest activity among standalone recordings', () => {
    const items = buildHomeItems(
      [project('plain', 15), project('child', 30, 's1'), project('plain2', 1)],
      [scenario('s1', 5), scenario('s2', 20)]
    )
    // s1 was active at 30 (its child), s2 at 20, the plain recordings at 15 and 1
    expect(shape(items)).toEqual(['s:s1[child]', 's:s2[]', 'r:plain', 'r:plain2'])
  })

  it('keeps the recordings of a deleted scenario as standalone ones', () => {
    expect(shape(buildHomeItems([project('orphan', 10, 'gone'), project('child', 5, 's1')], [scenario('s1', 1)]))).toEqual([
      'r:orphan',
      's:s1[child]'
    ])
  })
})
