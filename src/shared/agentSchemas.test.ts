import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentEditOpSchema, agentParamSchemas, agentScenarioInputSchema, formatZodError } from './agentSchemas'

describe('agentParamSchemas', () => {
  it('converts every method schema to JSON schema, objects only', () => {
    for (const [method, schema] of Object.entries(agentParamSchemas)) {
      const json = z.toJSONSchema(schema) as { type?: string }
      expect(json.type, method).toBe('object')
    }
  })

  it('documents every field of the edit operations', () => {
    const json = JSON.stringify(z.toJSONSchema(agentEditOpSchema))
    expect(json).toContain('SOURCE milliseconds')
    expect(json).toContain('normalized to the whole source frame')
  })

  it('accepts one of every edit operation', () => {
    const ops = [
      { op: 'rename', name: 'Demo' },
      { op: 'addCut', start: 0, end: 500 },
      { op: 'removeCut', id: 'c1' },
      { op: 'addZoom', start: 100, end: 2000, mode: 'fixed', scale: 2.5, target: { x: 0.3, y: 0.6 }, easeInMs: 300 },
      { op: 'updateZoom', id: 'z1', scale: 3 },
      { op: 'removeZoom', id: 'z1' },
      { op: 'addText', start: 0, end: 1000, text: 'Hello', y: 0.1, animation: 'pop' },
      { op: 'updateText', id: 't1', text: 'Bye' },
      { op: 'removeText', id: 't1' },
      { op: 'addBlur', start: 0, end: 1000, x: 0.1, y: 0.1, w: 0.2, h: 0.1, style: 'pixelate' },
      { op: 'removeBlur', id: 'b1' },
      { op: 'setCrop', x: 0, y: 0, w: 1, h: 1 },
      { op: 'setFrame', padding: 0.05, shadow: true, background: 'gradient:ocean' },
      { op: 'setCursor', highlight: true, followSmoothing: 0.4 }
    ]
    for (const op of ops) expect(agentEditOpSchema.safeParse(op).success, JSON.stringify(op)).toBe(true)
  })

  it('rejects a misspelled field with a readable message', () => {
    const parsed = agentParamSchemas['projects.edit'].safeParse({
      projectId: 'p1',
      operations: [{ op: 'addCut', start: 0, end_ms: 100 }]
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(formatZodError(parsed.error)).toMatch(/operations\.0/)
  })

  it('rejects ids that could leave the recordings folder', () => {
    expect(agentParamSchemas['projects.get'].safeParse({ projectId: '../x' }).success).toBe(false)
    expect(agentParamSchemas['projects.get'].safeParse({ projectId: '2026-01-02_03-04-05-2' }).success).toBe(true)
    expect(agentParamSchemas['scenarios.get'].safeParse({ scenarioId: 'a\b' }).success).toBe(false)
  })

  it('takes a scenario with every action kind', () => {
    const parsed = agentScenarioInputSchema.safeParse({
      name: 's',
      actions: [
        { kind: 'click', x: 1, y: 2, modifiers: ['ctrl'], pauseMs: 0 },
        { kind: 'drag', x: 1, y: 2, toX: 3, toY: 4 },
        { kind: 'scroll', x: 1, y: 2, deltaY: -3 },
        { kind: 'type', text: 'hi' },
        { kind: 'key', key: 'Ctrl+S' }
      ]
    })
    expect(parsed.success).toBe(true)
  })

  it('names the wrong kind', () => {
    const parsed = agentScenarioInputSchema.safeParse({ name: 's', actions: [{ kind: 'hover', x: 1, y: 2 }] })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(formatZodError(parsed.error)).toContain('actions.0')
  })
})
