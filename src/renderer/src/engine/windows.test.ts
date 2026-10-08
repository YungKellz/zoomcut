import { describe, expect, it } from 'vitest'
import type { WindowRect, WindowSnapshot } from '@shared/types'
import { cropFromWindows, pageToCrop, sameCrop, uniqueWindows, visibleWindows, windowAt, windowToCrop } from './windows'

const win = (title: string, x: number, y: number, w: number, h: number, extra: Partial<WindowRect> = {}): WindowRect => ({ title, x, y, w, h, ...extra })
const snap = (t: number, windows: WindowRect[]): WindowSnapshot => ({ t, windows })

describe('visible windows', () => {
  it('drops windows of an old snapshot that the windows above them hide', () => {
    const old = snap(0, [
      win('Editor', 0, 0, 1, 0.96), // maximized, in front
      win('Mail', 0.1, 0.1, 0.5, 0.5), // completely behind it
      win('Notes', 0.7, 0.8, 0.3, 0.2) // only its bottom sliver below the maximized window
    ])
    expect(visibleWindows(old).map((w) => w.title)).toEqual(['Editor'])
  })

  it('keeps side-by-side and partly covered windows of an old snapshot', () => {
    const old = snap(0, [win('Browser', 0, 0, 0.4, 0.8), win('Terminal', 0.35, 0.1, 0.35, 0.5), win('Desktop app', 0, 0, 1, 0.96)])
    // Terminal: a seventh of it is under the browser; the maximized app still shows around both
    expect(visibleWindows(old).map((w) => w.title)).toEqual(['Browser', 'Terminal', 'Desktop app'])
  })

  it('never lets a full-screen overlay of an old snapshot hide everything', () => {
    // a known overlay title: neither listed nor in front of anything
    const nvidia = snap(0, [win('NVIDIA GeForce Overlay', 0, 0, 1, 1), win('Editor', 0, 0, 1, 0.96), win('Mail', 0.1, 0.1, 0.5, 0.5)])
    expect(visibleWindows(nvidia).map((w) => w.title)).toEqual(['Editor'])
    // an unknown one (or a full-screen app – the snapshot cannot tell): the topmost window over the
    // whole display stays listed and hides nothing; the windows below still hide each other
    const unknown = snap(0, [win('Overlay', 0, 0, 1, 1), win('Editor', 0, 0, 1, 0.96), win('Mail', 0.1, 0.1, 0.5, 0.5)])
    expect(visibleWindows(unknown).map((w) => w.title)).toEqual(['Overlay', 'Editor'])
    // below a small topmost window too; a second full-display window does hide what is below it
    const second = snap(0, [win('Sticky', 0.8, 0, 0.2, 0.2), win('Overlay', 0, 0, 1, 1), win('Video', 0, 0, 1, 1), win('Mail', 0.1, 0.1, 0.5, 0.5)])
    expect(visibleWindows(second).map((w) => w.title)).toEqual(['Sticky', 'Overlay', 'Video'])
  })

  it('leaves snapshots filtered by the recorder as they are', () => {
    // the recorder saw what the list cannot: these two were visible on screen (`visible` set)
    const filtered = snap(0, [win('Editor', 0, 0, 1, 1, { visible: 1 }), win('Mail', 0.1, 0.1, 0.5, 0.5, { visible: 0.6 })])
    expect(visibleWindows(filtered)).toHaveLength(2)
  })

  it('lists each window once, keeping a page rectangle seen later', () => {
    const page = { x: 0.1, y: 0.15, w: 0.4, h: 0.6 }
    const list = uniqueWindows([
      snap(0, [win('Chrome', 0.1, 0.1, 0.4, 0.65)]),
      snap(5000, [win('Chrome', 0.1, 0.1, 0.4, 0.65, { content: page, visible: 1 })])
    ])
    expect(list).toHaveLength(1)
    expect(list[0].content).toEqual(page)
  })

  it('puts a window first seen at the end in front of the ones it covered', () => {
    const start = snap(0, [win('Word', 0, 0, 1, 0.96, { visible: 1 })])
    const end = snap(9000, [win('Chrome', 0.2, 0.1, 0.5, 0.7, { visible: 1 }), win('Word', 0, 0, 1, 0.96, { visible: 0.65 })])
    expect(uniqueWindows([start, end]).map((w) => w.title)).toEqual(['Chrome', 'Word'])
    // nothing of the end snapshot below it: appended
    const later = snap(9000, [win('Word', 0, 0, 1, 0.96, { visible: 1 }), win('Side', 0.8, 0, 0.2, 0.4, { visible: 0.9 })])
    expect(uniqueWindows([start, later]).map((w) => w.title)).toEqual(['Word', 'Side'])
  })
})

describe('crop to a window', () => {
  it('crops to the window, or to the page of a browser window', () => {
    const chrome = win('Chrome', 0.1, 0.1, 0.4, 0.6, { content: { x: 0.1, y: 0.16, w: 0.4, h: 0.54 } })
    expect(windowToCrop(chrome)).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.6 })
    expect(pageToCrop(chrome)).toEqual({ x: 0.1, y: 0.16, w: 0.4, h: 0.54 })
    expect(pageToCrop(win('Editor', 0, 0, 1, 1))).toBeNull()
    // clamped into the frame, never smaller than 5 %
    expect(windowToCrop(win('Off', -0.1, 0.9, 0.5, 0.02))).toEqual({ x: 0, y: 0.9, w: 0.5, h: 0.05 })
  })

  it('recognizes the crop a window gave', () => {
    const w = win('A', 0.123456, 0.2, 0.5, 0.5)
    expect(sameCrop(windowToCrop(w), { x: 0.1235, y: 0.2, w: 0.5, h: 0.5 })).toBe(true)
    expect(sameCrop(windowToCrop(w), { x: 0.13, y: 0.2, w: 0.5, h: 0.5 })).toBe(false)
  })

  it('tells a crop taken from a window or a page from one adjusted by hand', () => {
    const chrome = win('Chrome', 0.1, 0.1, 0.4, 0.6, { content: { x: 0.1, y: 0.16, w: 0.4, h: 0.54 } })
    const windows = [chrome, win('Word', 0, 0, 1, 0.96)]
    expect(cropFromWindows({ x: 0, y: 0, w: 1, h: 1 }, windows)).toBe(true)
    expect(cropFromWindows(windowToCrop(chrome), windows)).toBe(true)
    expect(cropFromWindows(pageToCrop(chrome)!, windows)).toBe(true)
    expect(cropFromWindows({ x: 0, y: 0, w: 1, h: 0.96 }, windows)).toBe(true)
    // the browser's crop moved by a few pixels
    expect(cropFromWindows({ x: 0.12, y: 0.1, w: 0.4, h: 0.6 }, windows)).toBe(false)
    expect(cropFromWindows({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, [])).toBe(false)
  })

  it('picks the frontmost window under the pointer, and its page', () => {
    const windows = [win('Chrome', 0.2, 0.1, 0.5, 0.7, { content: { x: 0.2, y: 0.2, w: 0.5, h: 0.6 } }), win('Word', 0, 0, 1, 0.96)]
    expect(windowAt(windows, 0.3, 0.15)).toEqual({ index: 0, page: false }) // Chrome's tab strip
    expect(windowAt(windows, 0.3, 0.5)).toEqual({ index: 0, page: true })
    expect(windowAt(windows, 0.9, 0.5)).toEqual({ index: 1, page: false })
    expect(windowAt(windows, 0.5, 0.99)).toBeNull()
  })
})
