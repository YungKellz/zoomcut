import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ZoomSegment } from '@shared/types'
import { DEFAULT_CURSOR_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_FRAME_STYLE } from '@shared/defaults'

// the i18n module reads navigator.language when it loads
vi.stubGlobal('navigator', { language: 'en' })

type StoreModule = typeof import('./store')
let useStore: StoreModule['useStore']

beforeAll(async () => {
  ;({ useStore } = await import('./store'))
})

function makeProject(zooms: ZoomSegment[] = []): Project {
  return {
    version: 1,
    id: 'p',
    name: 'p',
    recording: { id: 'p', createdAt: 0, dir: '', videoPath: '', width: 1920, height: 1080, durationMs: 10000, fps: 30, displayName: '' },
    cursorData: { samples: [], clicks: [], source: 'polling' },
    windows: [],
    cuts: [],
    texts: [],
    zooms,
    blurs: [],
    audio: [],
    cursor: { ...DEFAULT_CURSOR_SETTINGS },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: { ...DEFAULT_FRAME_STYLE },
    export: { ...DEFAULT_EXPORT_SETTINGS },
    updatedAt: 0
  }
}

const fixed: ZoomSegment = {
  id: 'z1',
  start: 1000,
  end: 6000,
  scale: 2,
  mode: 'fixed',
  target: { x: 0.8, y: 0.8 },
  easeInMs: 500,
  easeOutMs: 500,
  parts: [
    { id: 'a', start: 3000, target: { x: 0.2, y: 0.2 }, scale: 4 },
    { id: 'b', start: 4500, target: { x: 0.5, y: 0.5 }, scale: 2 }
  ]
}

function open(zooms: ZoomSegment[] = []): void {
  useStore.setState({
    project: makeProject(zooms),
    screen: 'editor',
    playheadMs: 0,
    selection: null,
    range: null,
    mode: 'normal',
    pickRect: null,
    pickArea: 0,
    history: [],
    future: []
  })
}

const zoomsOf = (): ZoomSegment[] => useStore.getState().project!.zooms

describe('whole milliseconds', () => {
  beforeEach(() => open())

  it('addZoom at a fractional playhead stores whole ms near the start (the 439.203 ms case)', () => {
    // a playhead read off <video>.currentTime * 1000: closer to the start than the default ease-in
    useStore.setState({ playheadMs: 439.20300000000003 })
    const id = useStore.getState().addZoom()
    expect(id).not.toBeNull()
    const z = zoomsOf()[0]
    for (const v of [z.start, z.end, z.easeInMs, z.easeOutMs]) expect(Number.isInteger(v)).toBe(true)
    expect(z.start).toBe(0)
    expect(z.easeInMs).toBe(439)
  })

  it('addZoom in the middle of the recording stores whole ms too', () => {
    useStore.setState({ playheadMs: 5123.7777 })
    useStore.getState().addZoom()
    const z = zoomsOf()[0]
    for (const v of [z.start, z.end, z.easeInMs]) expect(Number.isInteger(v)).toBe(true)
    expect(z.end).toBe(5124 + 2500)
  })

  it('addText stores whole ms for start, end and the fade', () => {
    useStore.setState({ playheadMs: 123.456 })
    useStore.getState().addText()
    const x = useStore.getState().project!.texts[0]
    for (const v of [x.start, x.end, x.animationMs]) expect(Number.isInteger(v)).toBe(true)
    expect(x.start).toBe(0)
    expect(x.animationMs).toBe(123)
  })

  it('addBlur covers the whole recording in whole ms', () => {
    useStore.getState().addBlur()
    const b = useStore.getState().project!.blurs[0]
    expect([b.start, b.end]).toEqual([0, 10000])
  })

  it('edits that come from a drag or a seconds field are rounded where they are stored', () => {
    open([{ ...fixed, parts: undefined }])
    const s = useStore.getState()
    s.updateZoom('z1', { start: 1000.4, end: 5999.6, easeInMs: 439.203, easeOutMs: 100.5 }, false)
    const z = zoomsOf()[0]
    expect([z.start, z.end, z.easeInMs, z.easeOutMs]).toEqual([1000, 6000, 439, 101])
    s.addText(1000)
    const id = useStore.getState().project!.texts[0].id
    s.updateText(id, { start: 10.6, end: 2000.2, animationMs: 33.3 }, false)
    const x = useStore.getState().project!.texts[0]
    expect([x.start, x.end, x.animationMs]).toEqual([11, 2000, 33])
    s.addBlur()
    const bid = useStore.getState().project!.blurs[0].id
    s.updateBlur(bid, { start: 0.2, end: 9999.7 }, false)
    const b = useStore.getState().project!.blurs[0]
    expect([b.start, b.end]).toEqual([0, 10000])
  })

  it('dragging a whole zoom still carries its parts along when the edges round differently', () => {
    open([fixed])
    // both edges move by 500.4 / 500.6 -> 500 / 501 after rounding
    useStore.getState().updateZoom('z1', { start: 1500.4, end: 6500.6 }, false)
    const z = zoomsOf()[0]
    expect(z.start).toBe(1500)
    expect(z.parts!.map((p) => p.start)).toEqual([3500, 5000])
  })

  it('a part boundary is a whole ms', () => {
    open([{ ...fixed, parts: undefined }])
    const index = useStore.getState().addZoomPart('z1', 2500.6)
    expect(index).toBe(1)
    expect(zoomsOf()[0].parts![0].start).toBe(2501)
    useStore.getState().updateZoomPart('z1', 1, { start: 3000.4 }, false)
    expect(zoomsOf()[0].parts![0].start).toBe(3000)
  })
})

describe('picking an area is modal', () => {
  beforeEach(() => {
    open([fixed, { ...fixed, id: 'z2', start: 7000, end: 9000, parts: undefined }])
  })

  it('beginPick selects the zoom and enters the mode', () => {
    useStore.getState().beginPick('z1', 1)
    const s = useStore.getState()
    expect(s.mode).toBe('pickTarget')
    expect(s.pickArea).toBe(1)
    expect(s.selection).toEqual({ kind: 'zoom', id: 'z1' })
  })

  it('ignores selecting anything else (a timeline click, another zoom) until Apply or Cancel', () => {
    useStore.getState().beginPick('z1', 0)
    const s = useStore.getState()
    s.select(null)
    expect(useStore.getState().selection).toEqual({ kind: 'zoom', id: 'z1' })
    s.select({ kind: 'zoom', id: 'z2' })
    expect(useStore.getState().selection).toEqual({ kind: 'zoom', id: 'z1' })
    s.select({ kind: 'text', id: 'nope' })
    expect(useStore.getState().selection).toEqual({ kind: 'zoom', id: 'z1' })
    s.setRange({ start: 100, end: 900 })
    expect(useStore.getState().range).toBeNull()
    expect(useStore.getState().selection).toEqual({ kind: 'zoom', id: 'z1' })
    expect(useStore.getState().mode).toBe('pickTarget')
    // selecting the picked zoom itself is fine, and seeking keeps working
    s.select({ kind: 'zoom', id: 'z1' })
    s.setPlayhead(2000, true)
    expect(useStore.getState().playheadMs).toBe(2000)
    expect(useStore.getState().mode).toBe('pickTarget')
  })

  it('the Z / T / B / Delete hotkeys do nothing while picking', () => {
    useStore.getState().beginPick('z1', 0)
    const s = useStore.getState()
    expect(s.addZoom(7500)).toBeNull()
    expect(s.addText(100)).toBeNull()
    expect(s.addBlur()).toBeNull()
    s.deleteSelected()
    const after = useStore.getState()
    expect(after.project!.zooms).toHaveLength(2)
    expect(after.project!.texts).toHaveLength(0)
    expect(after.project!.blurs).toHaveLength(0)
    expect(after.mode).toBe('pickTarget')
    expect(after.selection).toEqual({ kind: 'zoom', id: 'z1' })
  })

  it('everything works again after Cancel', () => {
    useStore.getState().beginPick('z1', 0)
    useStore.getState().setMode('normal')
    useStore.getState().select(null)
    expect(useStore.getState().selection).toBeNull()
    expect(useStore.getState().addBlur()).not.toBeNull()
  })

  it('Apply writes the picked area to the step that is being picked', () => {
    useStore.getState().beginPick('z1', 1)
    useStore.getState().setPickRect({ cx: 0.3, cy: 0.4, size: 0.25 })
    useStore.getState().applyPick()
    const s = useStore.getState()
    expect(s.mode).toBe('normal')
    expect(s.pickRect).toBeNull()
    const z = zoomsOf()[0]
    expect(z.parts![0].target).toEqual({ x: 0.3, y: 0.4 })
    expect(z.parts![0].scale).toBe(4)
    expect(z.target).toEqual({ x: 0.8, y: 0.8 }) // step 1 (area 0) is untouched
  })

  it('Apply with nothing to apply to leaves the mode instead of sticking in it', () => {
    useStore.getState().beginPick('z1', 0)
    useStore.setState({ selection: null }) // however it got lost
    useStore.getState().applyPick()
    expect(useStore.getState().mode).toBe('normal')
    expect(useStore.getState().pickRect).toBeNull()

    useStore.getState().beginPick('z1', 0)
    useStore.setState({ pickRect: null })
    useStore.getState().applyPick()
    expect(useStore.getState().mode).toBe('normal')
  })

  it('leaving the editor mid-pick does not leave the lock behind', () => {
    useStore.getState().beginPick('z1', 0)
    useStore.getState().closeProject()
    expect(useStore.getState().mode).toBe('normal')
    expect(useStore.getState().pickRect).toBeNull()
  })

  it('a delete during a pick keeps pickArea pointing at a real step', () => {
    useStore.getState().beginPick('z1', 2)
    useStore.getState().removeZoomPart('z1', 0) // later steps move down
    expect(useStore.getState().pickArea).toBe(1)
    expect(zoomsOf()[0].parts).toHaveLength(1)
    useStore.getState().removeZoomPart('z1', 1)
    expect(useStore.getState().pickArea).toBe(0)
    expect(zoomsOf()[0].parts).toBeUndefined()
  })
})

describe('deleting steps', () => {
  beforeEach(() => open([fixed]))

  it('the first step can go: the second one becomes the zoom itself', () => {
    useStore.getState().removeZoomPart('z1', 0)
    const z = zoomsOf()[0]
    expect(z.target).toEqual({ x: 0.2, y: 0.2 })
    expect(z.scale).toBe(4)
    expect(z.start).toBe(1000)
    expect(z.parts!.map((p) => p.id)).toEqual(['b'])
    expect(useStore.getState().history).toHaveLength(1) // one undo step
    useStore.getState().undo()
    expect(zoomsOf()[0]).toEqual(fixed)
  })

  it('the only step cannot be removed', () => {
    const single = { ...fixed, parts: undefined }
    open([single])
    const before = useStore.getState().project
    useStore.getState().removeZoomPart('z1', 0)
    expect(useStore.getState().project).toBe(before)
    expect(useStore.getState().history).toHaveLength(0)
  })
})
