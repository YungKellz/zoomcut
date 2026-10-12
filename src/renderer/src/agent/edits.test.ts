import { describe, expect, it } from 'vitest'
import type { Project, ZoomSegment } from '@shared/types'
import { AgentError, type AgentEditOp } from '@shared/agent'
import { BLUR_DEFAULTS, DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE, TEXT_DEFAULTS, ZOOM_DEFAULTS } from '@shared/defaults'
import { applyAgentEdits, toAgentProjectView } from './edits'

function project(patch: Partial<Project> = {}): Project {
  return {
    version: 1,
    id: 'p1',
    name: 'Demo',
    recording: {
      id: 'p1',
      createdAt: 1700000000000,
      dir: 'C:\\Videos\\ZoomCut\\p1',
      videoPath: 'C:\\Videos\\ZoomCut\\p1\\recording.mp4',
      width: 1920,
      height: 1080,
      durationMs: 10000,
      fps: 30,
      displayName: 'Display 1'
    },
    cursorData: { samples: [], clicks: [], source: 'uiohook' },
    windows: [],
    cuts: [],
    texts: [],
    zooms: [],
    blurs: [],
    audio: [],
    cursor: { ...DEFAULT_CURSOR_SETTINGS },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: { ...DEFAULT_FRAME_STYLE },
    export: { ...DEFAULT_EXPORT_SETTINGS },
    updatedAt: 0,
    ...patch
  }
}

const zoom = (patch: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id: 'z1',
  start: 1000,
  end: 3000,
  scale: 2,
  mode: 'fixed',
  target: { x: 0.3, y: 0.4 },
  easeInMs: 600,
  easeOutMs: 500,
  ...patch
})

/** the error an edit must throw */
function badParams(p: Project, ops: unknown[]): AgentError {
  try {
    applyAgentEdits(p, ops as AgentEditOp[])
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).code).toBe('bad_params')
    return err as AgentError
  }
  throw new Error('expected bad_params')
}

describe('applyAgentEdits: general', () => {
  it('returns the same project for no operations and never mutates its input', () => {
    const p = project({ zooms: [zoom()] })
    expect(applyAgentEdits(p, [])).toBe(p)
    const snapshot = JSON.stringify(p)
    applyAgentEdits(p, [
      { op: 'rename', name: 'x' },
      { op: 'addCut', start: 4000, end: 5000 },
      { op: 'removeZoom', id: 'z1' }
    ])
    expect(JSON.stringify(p)).toBe(snapshot)
  })

  it('rejects unknown operations and malformed lists', () => {
    expect(badParams(project(), [{ op: 'explode' }]).message).toMatch(/operations\[0\].*unknown op "explode".*addCut/)
    expect(badParams(project(), ['addCut']).message).toMatch(/operations\[0\] must be an object/)
    expect(badParams(project(), [{ nope: 1 }]).message).toMatch(/"op" field/)
    expect(() => applyAgentEdits(project(), 'addCut' as unknown as AgentEditOp[])).toThrow(/array/)
  })

  it('is atomic: a bad operation names its index and nothing is applied', () => {
    const p = project()
    const err = badParams(p, [
      { op: 'rename', name: 'ok' },
      { op: 'addCut', start: 5000, end: 5000 }
    ])
    expect(err.message).toMatch(/^operations\[1\] \(addCut\): /)
    expect(p.name).toBe('Demo')
  })

  it('applies operations in order, later ones see earlier ones', () => {
    const p = applyAgentEdits(project(), [
      { op: 'addZoom', start: 1000, end: 3000, mode: 'follow' },
      { op: 'addCut', start: 2000, end: 4000 }
    ])
    // the cut shortens the zoom that was just added
    expect(p.zooms[0].end).toBe(2000)
  })
})

describe('applyAgentEdits: rename', () => {
  it('trims and renames', () => {
    expect(applyAgentEdits(project(), [{ op: 'rename', name: '  Intro tour ' }]).name).toBe('Intro tour')
  })
  it('rejects an empty or non-string name', () => {
    badParams(project(), [{ op: 'rename', name: '   ' }])
    badParams(project(), [{ op: 'rename', name: 5 }])
  })
})

describe('applyAgentEdits: cuts', () => {
  it('adds a cut with an id and rounds to whole ms', () => {
    const p = applyAgentEdits(project(), [{ op: 'addCut', start: 1000.4, end: 2000.6 }])
    expect(p.cuts).toHaveLength(1)
    expect(p.cuts[0]).toMatchObject({ start: 1000, end: 2001 })
    expect(p.cuts[0].id).toMatch(/^cut_/)
  })

  it('merges overlapping cuts and clips zooms, texts and blurs like the editor', () => {
    const p0 = project({
      cuts: [{ id: 'c1', start: 1000, end: 2000 }],
      zooms: [zoom({ id: 'zin', start: 3000, end: 3500 }), zoom({ id: 'zedge', start: 4000, end: 7000 })],
      texts: [{ ...TEXT_DEFAULTS, id: 't1', start: 3100, end: 3300 }],
      blurs: [{ ...BLUR_DEFAULTS, id: 'b1', start: 0, end: 10000 }]
    })
    const p = applyAgentEdits(p0, [{ op: 'addCut', start: 1500, end: 5000 }])
    expect(p.cuts.map((c) => [c.start, c.end])).toEqual([[1000, 5000]])
    expect(p.zooms.map((z) => [z.id, z.start, z.end])).toEqual([['zedge', 5000, 7000]])
    expect(p.texts).toEqual([])
    // a blur spanning the cut is kept whole
    expect(p.blurs).toHaveLength(1)
  })

  it('rejects ranges that are empty, reversed, negative or past the end', () => {
    expect(badParams(project(), [{ op: 'addCut', start: 3000, end: 3000 }]).message).toMatch(/at least 10 ms before end/)
    badParams(project(), [{ op: 'addCut', start: 5000, end: 4000 }])
    expect(badParams(project(), [{ op: 'addCut', start: -1, end: 400 }]).message).toMatch(/before the recording starts/)
    expect(badParams(project(), [{ op: 'addCut', start: 9000, end: 12000 }]).message).toMatch(/past the end of the recording \(10000 ms/)
    expect(badParams(project(), [{ op: 'addCut', start: '5', end: 6000 }]).message).toMatch(/start must be a number/)
    expect(badParams(project(), [{ op: 'addCut', end: 6000 }]).message).toMatch(/start is required/)
  })

  it('refuses to cut the whole recording', () => {
    expect(badParams(project(), [{ op: 'addCut', start: 0, end: 10000 }]).message).toMatch(/whole recording/)
  })

  it('removes a cut by id and rejects an unknown id naming the known ones', () => {
    const p0 = project({ cuts: [{ id: 'c1', start: 1000, end: 2000 }] })
    expect(applyAgentEdits(p0, [{ op: 'removeCut', id: 'c1' }]).cuts).toEqual([])
    expect(badParams(p0, [{ op: 'removeCut', id: 'nope' }]).message).toMatch(/unknown cut id "nope" \(existing: c1\)/)
    expect(badParams(project(), [{ op: 'removeCut', id: 'nope' }]).message).toMatch(/the project has none/)
    badParams(p0, [{ op: 'removeCut' }])
  })
})

describe('applyAgentEdits: zooms', () => {
  it('adds a follow zoom with the editor defaults', () => {
    const p = applyAgentEdits(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'follow' }])
    expect(p.zooms).toHaveLength(1)
    expect(p.zooms[0]).toMatchObject({ ...ZOOM_DEFAULTS, start: 1000, end: 3000, mode: 'follow' })
    expect(p.zooms[0].id).toMatch(/^zoom_/)
    // not the shared default object
    expect(p.zooms[0].target).not.toBe(ZOOM_DEFAULTS.target)
  })

  it('adds a fixed zoom with target, scale and easing', () => {
    const p = applyAgentEdits(project(), [
      { op: 'addZoom', start: 2000, end: 4000, mode: 'fixed', scale: 3, target: { x: 0.25, y: 0.75 }, easeInMs: 300, easeOutMs: 100 }
    ])
    expect(p.zooms[0]).toMatchObject({ mode: 'fixed', scale: 3, target: { x: 0.25, y: 0.75 }, easeInMs: 300, easeOutMs: 100 })
  })

  it('clamps scale and easing to the editor ranges', () => {
    const p = applyAgentEdits(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'follow', scale: 50, easeInMs: 99999, easeOutMs: -5 }])
    expect(p.zooms[0]).toMatchObject({ scale: 5, easeInMs: 1500, easeOutMs: 0 })
    const q = applyAgentEdits(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'follow', scale: 1 }])
    expect(q.zooms[0].scale).toBe(1.2)
  })

  it('needs a mode, and a target for fixed zooms', () => {
    expect(badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000 }]).message).toMatch(/mode is required/)
    expect(badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'fixed' }]).message).toMatch(/needs a target/)
    expect(badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'sideways' }]).message).toMatch(/mode must be one of follow, fixed/)
  })

  it('rejects a target that looks like pixels', () => {
    const err = badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'fixed', target: { x: 960, y: 0.5 } }])
    expect(err.message).toMatch(/target\.x must be between 0 and 1.*not pixels.*960/)
    badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'fixed', target: { x: 0.5 } }])
    badParams(project(), [{ op: 'addZoom', start: 1000, end: 3000, mode: 'fixed', target: [0.5, 0.5] }])
  })

  it('enforces the minimum length', () => {
    expect(badParams(project(), [{ op: 'addZoom', start: 1000, end: 1100, mode: 'follow' }]).message).toMatch(/at least 200 ms/)
  })

  it('refuses zooms that overlap another one instead of moving them silently', () => {
    const p0 = project({ zooms: [zoom()] })
    const err = badParams(p0, [{ op: 'addZoom', start: 2500, end: 5000, mode: 'follow' }])
    expect(err.message).toMatch(/overlaps the zoom z1 \(1000-3000 ms\)/)
    badParams(p0, [{ op: 'addZoom', start: 0, end: 1500, mode: 'follow' }])
    badParams(p0, [{ op: 'addZoom', start: 500, end: 4000, mode: 'follow' }])
    // touching is fine, and the list stays sorted
    const p = applyAgentEdits(p0, [{ op: 'addZoom', start: 0, end: 1000, mode: 'follow' }, { op: 'addZoom', start: 3000, end: 4000, mode: 'follow' }])
    expect(p.zooms.map((z) => z.start)).toEqual([0, 1000, 3000])
  })

  it('updates fields of a zoom and keeps the rest', () => {
    const p = applyAgentEdits(project({ zooms: [zoom()] }), [{ op: 'updateZoom', id: 'z1', scale: 3.5, target: { x: 0.9, y: 0.1 } }])
    expect(p.zooms[0]).toMatchObject({ id: 'z1', start: 1000, end: 3000, mode: 'fixed', scale: 3.5, target: { x: 0.9, y: 0.1 }, easeInMs: 600 })
  })

  it('moves a zoom with its parts when both edges shift alike', () => {
    const z = zoom({ parts: [{ id: 'pt', start: 2000, target: { x: 0.8, y: 0.8 }, scale: 3 }] })
    const p = applyAgentEdits(project({ zooms: [z] }), [{ op: 'updateZoom', id: 'z1', start: 4000, end: 6000 }])
    expect(p.zooms[0]).toMatchObject({ start: 4000, end: 6000 })
    expect(p.zooms[0].parts?.[0].start).toBe(5000)
  })

  it('refuses an update that would overlap a neighbour or break the length', () => {
    const p0 = project({ zooms: [zoom(), zoom({ id: 'z2', start: 4000, end: 6000 })] })
    expect(badParams(p0, [{ op: 'updateZoom', id: 'z1', end: 4500 }]).message).toMatch(/overlaps the zoom z2/)
    badParams(p0, [{ op: 'updateZoom', id: 'z1', end: 1050 }])
    badParams(p0, [{ op: 'updateZoom', id: 'z1', start: 2000, end: 1000 }])
    expect(badParams(p0, [{ op: 'updateZoom', id: 'z1' }]).message).toMatch(/nothing to change/)
    expect(badParams(p0, [{ op: 'updateZoom', id: 'zz', scale: 2 }]).message).toMatch(/unknown zoom id "zz" \(existing: z1, z2\)/)
  })

  it('removes a zoom', () => {
    expect(applyAgentEdits(project({ zooms: [zoom()] }), [{ op: 'removeZoom', id: 'z1' }]).zooms).toEqual([])
    badParams(project(), [{ op: 'removeZoom', id: 'z1' }])
  })
})

describe('applyAgentEdits: texts', () => {
  it('adds a text with the defaults of the editor', () => {
    const p = applyAgentEdits(project(), [{ op: 'addText', start: 500, end: 2500, text: 'Click Save' }])
    expect(p.texts).toHaveLength(1)
    expect(p.texts[0]).toMatchObject({ ...TEXT_DEFAULTS, text: 'Click Save', start: 500, end: 2500 })
    expect(p.texts[0].id).toMatch(/^text_/)
  })

  it('takes position, size, colors and animation, normalizing hex colors', () => {
    const p = applyAgentEdits(project(), [
      { op: 'addText', start: 0, end: 1000, text: 'Hi', x: 0.2, y: 0.1, fontSize: 0.08, color: '#FFF', background: '#102030', animation: 'pop' }
    ])
    expect(p.texts[0]).toMatchObject({ x: 0.2, y: 0.1, fontSize: 0.08, color: '#ffffff', background: '#102030', animation: 'pop' })
  })

  it('clamps the font size and validates everything else', () => {
    expect(applyAgentEdits(project(), [{ op: 'addText', start: 0, end: 1000, text: 'a', fontSize: 5 }]).texts[0].fontSize).toBe(0.14)
    expect(badParams(project(), [{ op: 'addText', start: 0, end: 1000 }]).message).toMatch(/text is required/)
    badParams(project(), [{ op: 'addText', start: 0, end: 1000, text: '  ' }])
    badParams(project(), [{ op: 'addText', start: 0, end: 1000, text: 'x'.repeat(501) }])
    expect(badParams(project(), [{ op: 'addText', start: 0, end: 1000, text: 'a', color: 'red' }]).message).toMatch(/color must be a hex color/)
    expect(badParams(project(), [{ op: 'addText', start: 0, end: 1000, text: 'a', x: 540 }]).message).toMatch(/x must be between 0 and 1/)
    badParams(project(), [{ op: 'addText', start: 0, end: 1000, text: 'a', animation: 'spin' }])
    badParams(project(), [{ op: 'addText', start: 0, end: 50, text: 'a' }])
  })

  it('updates and removes a text', () => {
    const p0 = applyAgentEdits(project(), [{ op: 'addText', start: 0, end: 1000, text: 'a' }])
    const id = p0.texts[0].id
    const p1 = applyAgentEdits(p0, [{ op: 'updateText', id, text: 'b', end: 2000, y: 0.5 }])
    expect(p1.texts[0]).toMatchObject({ id, text: 'b', start: 0, end: 2000, y: 0.5, x: TEXT_DEFAULTS.x })
    badParams(p1, [{ op: 'updateText', id, start: 3000, end: 2000 }])
    badParams(p1, [{ op: 'updateText', id }])
    expect(applyAgentEdits(p1, [{ op: 'removeText', id }]).texts).toEqual([])
    badParams(p1, [{ op: 'removeText', id: 'nope' }])
  })
})

describe('applyAgentEdits: blurs', () => {
  it('adds a blur in source-normalized coordinates with defaults', () => {
    const p = applyAgentEdits(project(), [{ op: 'addBlur', start: 0, end: 10000, x: 0.1, y: 0.2, w: 0.3, h: 0.1 }])
    expect(p.blurs[0]).toMatchObject({ x: 0.1, y: 0.2, w: 0.3, h: 0.1, style: BLUR_DEFAULTS.style, strength: BLUR_DEFAULTS.strength })
    expect(p.blurs[0].id).toMatch(/^blur_/)
  })

  it('takes style and clamps strength', () => {
    const p = applyAgentEdits(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0, w: 1, h: 1, style: 'pixelate', strength: 500 }])
    expect(p.blurs[0]).toMatchObject({ style: 'pixelate', strength: 80 })
  })

  it('rejects rectangles outside the recording, pixels and tiny sizes', () => {
    expect(badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0.8, y: 0, w: 0.4, h: 0.1 }]).message).toMatch(/x \+ w must not exceed 1/)
    expect(badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0.95, w: 0.1, h: 0.1 }]).message).toMatch(/y \+ h must not exceed 1/)
    expect(badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 100, y: 0, w: 0.1, h: 0.1 }]).message).toMatch(/not pixels/)
    expect(badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0, w: 0, h: 0.1 }]).message).toMatch(/at least 0.01/)
    badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0, w: 0.1 }])
    badParams(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0, w: 0.1, h: 0.1, style: 'smear' }])
  })

  it('removes a blur', () => {
    const p0 = applyAgentEdits(project(), [{ op: 'addBlur', start: 0, end: 1000, x: 0, y: 0, w: 0.5, h: 0.5 }])
    expect(applyAgentEdits(p0, [{ op: 'removeBlur', id: p0.blurs[0].id }]).blurs).toEqual([])
    badParams(p0, [{ op: 'removeBlur', id: 'nope' }])
  })
})

describe('applyAgentEdits: crop, frame, cursor', () => {
  it('sets the crop', () => {
    expect(applyAgentEdits(project(), [{ op: 'setCrop', x: 0.1, y: 0.2, w: 0.5, h: 0.6 }]).crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 })
  })

  it('rejects crops that leave the recording or are tiny', () => {
    badParams(project(), [{ op: 'setCrop', x: 0.6, y: 0, w: 0.6, h: 1 }])
    badParams(project(), [{ op: 'setCrop', x: 0, y: 0, w: 0.01, h: 1 }])
    badParams(project(), [{ op: 'setCrop', x: 0, y: 0, w: 1920, h: 1080 }])
    badParams(project(), [{ op: 'setCrop', x: 0, y: 0, w: 1 }])
  })

  it('tolerates float noise at the edge', () => {
    const crop = applyAgentEdits(project(), [{ op: 'setCrop', x: 0.3, y: 0, w: 0.7000000001, h: 1 }]).crop
    expect(crop.x + crop.w).toBeLessThanOrEqual(1)
  })

  it('updates only the given frame fields, clamped to the editor ranges', () => {
    const p = applyAgentEdits(project(), [{ op: 'setFrame', padding: 9, cornerRadius: 12.4, shadow: true }])
    expect(p.frame).toEqual({ ...DEFAULT_FRAME_STYLE, padding: 0.2, cornerRadius: 12, shadow: true })
  })

  it('accepts hex, gradient presets and transparent as frame background', () => {
    expect(applyAgentEdits(project(), [{ op: 'setFrame', background: '#ABC' }]).frame.background).toBe('#aabbcc')
    expect(applyAgentEdits(project(), [{ op: 'setFrame', background: 'gradient:ocean' }]).frame.background).toBe('gradient:ocean')
    expect(applyAgentEdits(project(), [{ op: 'setFrame', background: 'transparent' }]).frame.background).toBe('transparent')
    expect(badParams(project(), [{ op: 'setFrame', background: 'gradient:nope' }]).message).toMatch(/gradient:dusk/)
    badParams(project(), [{ op: 'setFrame', background: 'toString' }])
    badParams(project(), [{ op: 'setFrame', shadow: 'yes' }])
    badParams(project(), [{ op: 'setFrame' }])
  })

  it('updates the cursor settings', () => {
    const p = applyAgentEdits(project(), [{ op: 'setCursor', highlight: true, clicks: false, followSmoothing: 7, followDeadZone: 0.1 }])
    expect(p.cursor).toMatchObject({ highlight: true, clicks: false, followSmoothing: 1, followDeadZone: 0.1, clickRadius: DEFAULT_CURSOR_SETTINGS.clickRadius })
    badParams(project(), [{ op: 'setCursor' }])
    badParams(project(), [{ op: 'setCursor', highlight: 1 }])
  })
})

describe('toAgentProjectView', () => {
  it('summarizes the project', () => {
    const p = project({
      cuts: [{ id: 'c', start: 1000, end: 3000 }],
      audio: [
        {
          id: 'a1',
          kind: 'mic',
          file: 'mic.m4a',
          name: 'Microphone',
          start: -40,
          durationMs: 10000,
          volume: 1,
          muted: false,
          loop: false,
          fadeInMs: 0,
          fadeOutMs: 0
        }
      ],
      origin: { displayId: 2, audio: null, scenarioId: 's1' }
    })
    const v = toAgentProjectView(p)
    expect(v).toMatchObject({
      id: 'p1',
      name: 'Demo',
      createdAt: 1700000000000,
      dir: 'C:\\Videos\\ZoomCut\\p1',
      width: 1920,
      height: 1080,
      fps: 30,
      sourceDurationMs: 10000,
      outputDurationMs: 8000,
      origin: { displayId: 2, audio: null, scenarioId: 's1' },
      audio: [{ id: 'a1', kind: 'mic', name: 'Microphone' }]
    })
    expect(v.cuts).toBe(p.cuts)
    expect(v.crop).toBe(p.crop)
    expect(v.export).toBe(p.export)
    expect(toAgentProjectView(project()).origin).toBeNull()
  })

  it('caps the clicks at 500, spread over the whole recording', () => {
    const clicks = Array.from({ length: 2000 }, (_, i) => ({ t: i * 5, x: 0.5, y: 0.5, button: 'left' as const }))
    const v = toAgentProjectView(project({ cursorData: { samples: [], clicks, source: 'uiohook' } }))
    expect(v.clicks).toHaveLength(500)
    expect(v.clicks[0].t).toBe(0)
    expect(v.clicks[499].t).toBeGreaterThan(9000)
    for (let i = 1; i < v.clicks.length; i++) expect(v.clicks[i].t).toBeGreaterThan(v.clicks[i - 1].t)
    const few = toAgentProjectView(project({ cursorData: { samples: [], clicks: clicks.slice(0, 3), source: 'uiohook' } }))
    expect(few.clicks).toHaveLength(3)
  })

  it('reflects edits made through applyAgentEdits', () => {
    const edited = applyAgentEdits(project(), [{ op: 'addCut', start: 0, end: 4000 }, { op: 'addText', start: 5000, end: 6000, text: 'Done' }])
    const v = toAgentProjectView(edited)
    expect(v.outputDurationMs).toBe(6000)
    expect(v.texts).toHaveLength(1)
  })
})
