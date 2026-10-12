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

const okOp = (op: unknown): boolean => agentEditOpSchema.safeParse(op).success
const edit = (...operations: unknown[]): boolean => agentParamSchemas['projects.edit'].safeParse({ projectId: 'p1', operations }).success

describe('the editor limits the schemas enforce instead of clamping', () => {
  it('keeps text size, blur strength and frame styling inside the editor sliders', () => {
    const text = { op: 'addText', start: 0, end: 500, text: 'x' }
    expect(okOp({ ...text, fontSize: 0.02 })).toBe(true)
    expect(okOp({ ...text, fontSize: 0.14 })).toBe(true)
    expect(okOp({ ...text, fontSize: 0.015 })).toBe(false)
    expect(okOp({ ...text, fontSize: 0.2 })).toBe(false)
    const blur = { op: 'addBlur', start: 0, end: 500, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    expect(okOp({ ...blur, strength: 4 })).toBe(true)
    expect(okOp({ ...blur, strength: 80 })).toBe(true)
    expect(okOp({ ...blur, strength: 3 })).toBe(false)
    expect(okOp({ ...blur, strength: 81 })).toBe(false)
    expect(okOp({ op: 'setFrame', padding: 0.2 })).toBe(true)
    expect(okOp({ op: 'setFrame', padding: 0.21 })).toBe(false)
    expect(okOp({ op: 'setFrame', cornerRadius: 64 })).toBe(true)
    expect(okOp({ op: 'setFrame', cornerRadius: 65 })).toBe(false)
    expect(okOp({ op: 'addZoom', start: 0, end: 500, mode: 'follow', scale: 1.2 })).toBe(true)
    expect(okOp({ op: 'addZoom', start: 0, end: 500, mode: 'follow', scale: 1.1 })).toBe(false)
    expect(okOp({ op: 'addZoom', start: 0, end: 500, mode: 'follow', scale: 5.1 })).toBe(false)
    expect(okOp({ op: 'setCursor', followDeadZone: 0.31 })).toBe(false)
  })

  it('wants the shortest spans the editor allows', () => {
    expect(okOp({ op: 'addCut', start: 100, end: 110 })).toBe(true)
    expect(okOp({ op: 'addCut', start: 100, end: 109 })).toBe(false)
    expect(okOp({ op: 'addCut', start: 500, end: 100 })).toBe(false)
    expect(okOp({ op: 'addZoom', start: 0, end: 200, mode: 'fixed' })).toBe(true)
    expect(okOp({ op: 'addZoom', start: 0, end: 199, mode: 'fixed' })).toBe(false)
    expect(okOp({ op: 'addText', start: 0, end: 100, text: 'x' })).toBe(true)
    expect(okOp({ op: 'addText', start: 0, end: 99, text: 'x' })).toBe(false)
    expect(okOp({ op: 'addBlur', start: 0, end: 99, x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(false)
    // an update that moves only one end cannot be judged here: the renderer knows the other one
    expect(okOp({ op: 'updateZoom', id: 'z1', end: 50 })).toBe(true)
    expect(okOp({ op: 'updateZoom', id: 'z1', start: 0, end: 50 })).toBe(false)
    expect(okOp({ op: 'updateText', id: 't1', start: 10, end: 20 })).toBe(false)
  })

  it('rejects an update or style change that changes nothing', () => {
    expect(okOp({ op: 'updateZoom', id: 'z1' })).toBe(false)
    expect(okOp({ op: 'updateText', id: 't1' })).toBe(false)
    expect(okOp({ op: 'setFrame' })).toBe(false)
    expect(okOp({ op: 'setCursor' })).toBe(false)
    expect(okOp({ op: 'updateZoom', id: 'z1', scale: 3 })).toBe(true)
    expect(okOp({ op: 'updateText', id: 't1', color: 'red' })).toBe(true)
    expect(okOp({ op: 'setFrame', shadow: false })).toBe(true)
    expect(okOp({ op: 'setCursor', highlight: false })).toBe(true)
    expect(edit({ op: 'updateZoom', id: 'z1' })).toBe(false)
  })

  it('keeps rectangles inside the frame and not tiny', () => {
    expect(okOp({ op: 'setCrop', x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe(true)
    expect(okOp({ op: 'setCrop', x: 0.6, y: 0, w: 0.5, h: 1 })).toBe(false)
    expect(okOp({ op: 'setCrop', x: 0, y: 0, w: 0.04, h: 1 })).toBe(false)
    expect(okOp({ op: 'addBlur', start: 0, end: 500, x: 0.8, y: 0, w: 0.3, h: 0.1 })).toBe(false)
    expect(okOp({ op: 'addBlur', start: 0, end: 500, x: 0, y: 0, w: 0.005, h: 0.1 })).toBe(false)
    expect(okOp({ op: 'addBlur', start: 0, end: 500, x: 0.9, y: 0.9, w: 0.1, h: 0.1 })).toBe(true)
  })

  it('takes opaque CSS colours only', () => {
    const text = (color: string): boolean => okOp({ op: 'addText', start: 0, end: 500, text: 'x', color })
    for (const ok of ['#fff', '#FFCC00', 'white', 'rebeccapurple', 'rgb(1, 2, 3)', 'rgb(1 2 3)', 'hsl(200, 80%, 50%)', 'hsl(200 80% 50%)', ' #abc ']) {
      expect(text(ok), ok).toBe(true)
    }
    for (const bad of ['#ffcc0080', '#ffff', 'rgba(0, 0, 0, 0.5)', 'hsla(10, 20%, 30%, 0.5)', 'rgb(0 0 0 / 50%)', 'rgb(1, 2, 3, 0.5)', 'transparent', '', 'url(x)', 'red;', 'rgb(1,2)']) {
      expect(text(bad), bad).toBe(false)
    }
    expect(okOp({ op: 'addText', start: 0, end: 500, text: 'x', background: 'rgba(0,0,0,.5)' })).toBe(false)
  })

  it('takes a colour, a gradient preset or transparent as the frame background', () => {
    for (const ok of ['#111214', 'black', 'gradient:ocean', 'gradient:slate', 'transparent']) expect(okOp({ op: 'setFrame', background: ok }), ok).toBe(true)
    for (const bad of ['gradient:nope', 'rgba(0,0,0,0.5)', '#12345678']) expect(okOp({ op: 'setFrame', background: bad }), bad).toBe(false)
  })

  it('refuses blank names and texts', () => {
    expect(okOp({ op: 'rename', name: '   ' })).toBe(false)
    expect(okOp({ op: 'addText', start: 0, end: 500, text: '  ' })).toBe(false)
    expect(okOp({ op: 'rename', name: 'ok' })).toBe(true)
  })

  it('allows up to 500 operations', () => {
    const op = { op: 'removeCut', id: 'c1' }
    expect(edit(...Array.from({ length: 500 }, () => op))).toBe(true)
    expect(edit(...Array.from({ length: 501 }, () => op))).toBe(false)
  })
})

describe('export parameters', () => {
  const exp = (params: Record<string, unknown>): boolean => agentParamSchemas['projects.export'].safeParse({ projectId: 'p1', ...params }).success

  it('only takes frame rates the export dialog offers, per format', () => {
    for (const fps of [24, 30, 60]) expect(exp({ fps }), String(fps)).toBe(true)
    for (const fps of [10, 12, 15, 20, 25]) expect(exp({ fps }), String(fps)).toBe(true)
    for (const fps of [1, 17, 29.97, 120]) expect(exp({ fps }), String(fps)).toBe(false)
    expect(exp({ format: 'mp4', fps: 30 })).toBe(true)
    expect(exp({ format: 'gif', fps: 15 })).toBe(true)
    expect(exp({ format: 'gif', fps: 30 })).toBe(false)
    expect(exp({ format: 'mp4', fps: 12 })).toBe(false)
  })

  it('wants an absolute folder', () => {
    for (const ok of ['C:\\Users\\me\\Videos', 'D:/clips', '\\\\server\\share\\x', '/home/me/videos']) expect(exp({ folder: ok }), ok).toBe(true)
    for (const bad of ['Videos', '.\\out', '..\\out', 'C:out', '']) expect(exp({ folder: bad }), bad).toBe(false)
  })

  it('keeps the scale between 0.1 and 1', () => {
    expect(exp({ scale: 0.5 })).toBe(true)
    expect(exp({ scale: 1.5 })).toBe(false)
    expect(exp({ scale: 0 })).toBe(false)
  })
})
