import { describe, expect, it, vi } from 'vitest'

// only snapshotWindows() asks Electron's `screen` for the display's physical bounds
vi.mock('electron', () => ({ screen: {} }))

import { helperArgs, parse, selectWindows, type PixelRect } from './windowsSnapshot'

const row = (kind: 'c' | 'o', rect: number[], app = '', page: number[] | null = null, title = ''): string =>
  [kind, ...rect, app, ...(page ?? ['', '', '', '']), title].join('\t')

// A real layout (two 2560×1440 displays side by side, titles replaced), as the helper printed it,
// topmost first: on the primary display a near-maximized app hides everything below it but a 205 px
// strip; on the left one a browser sits over another browser and a chat app, a maximized document
// behind all of them.
const OUTPUT = [
  row('o', [0, 1392, 2560, 1440]), // taskbar
  row('o', [-2560, 1392, 0, 1440]), // taskbar of the second display
  row('c', [205, 0, 2560, 1392], 'claude.exe', null, 'Claude'),
  row('c', [-2097, 412, -967, 1209], 'browser.exe', [-2096, 517, -968, 1208], 'Docs — Yandex Browser'),
  row('c', [163, 241, 1671, 1089], 'outlook.exe', null, 'Calendar - Outlook'),
  row('c', [142, 209, 1528, 1102], 'electron.exe', null, 'ZoomCut'),
  row('c', [-2188, 7, -642, 930], 'chrome.exe', [-2187, 94, -643, 929], 'Settings - Google Chrome'),
  row('c', [-1677, 460, -842, 1289], 'telegram.exe', null, 'Chat'),
  row('o', [1998, 178, 2026, 206]),
  row('c', [0, 0, 2560, 1392], 'winword.exe', null, 'Report.docx - Word'),
  row('c', [439, 243, 2417, 1317], 'excel.exe', null, 'Plan.xlsx - Excel'),
  row('c', [-2560, 0, 0, 1392], 'winword.exe', null, 'Notes.docx - Word')
].join('\r\n')

const PRIMARY: PixelRect = { x: 0, y: 0, w: 2560, h: 1440 }
const LEFT: PixelRect = { x: -2560, y: 0, w: 2560, h: 1440 }

describe('window snapshot', () => {
  it('parses the helper output, with and without a page rectangle', () => {
    const raw = parse(OUTPUT + '\r\ngarbage line\r\n')
    expect(raw).toHaveLength(12)
    expect(raw[0]).toMatchObject({ candidate: false, left: 0, top: 1392, page: null, title: '' })
    expect(raw[3]).toMatchObject({ candidate: true, app: 'browser.exe', page: { left: -2096, top: 517, right: -968, bottom: 1208 } })
    expect(raw[2].page).toBeNull()
  })

  it('lists only the windows really visible on each display', () => {
    const raw = parse(OUTPUT)
    expect(selectWindows(raw, PRIMARY).map((w) => w.title)).toEqual(['Claude'])
    // the chat app is three quarters hidden; the maximized document shows around the browsers
    expect(selectWindows(raw, LEFT).map((w) => w.title)).toEqual(['Docs — Yandex Browser', 'Settings - Google Chrome', 'Notes.docx - Word'])
  })

  it('normalizes windows and pages to the display and marks how much was visible', () => {
    const [yandex, chrome] = selectWindows(parse(OUTPUT), LEFT)
    expect(yandex.x).toBeCloseTo(463 / 2560)
    expect(yandex.y).toBeCloseTo(412 / 1440)
    expect(yandex.w).toBeCloseTo(1130 / 2560)
    expect(yandex.app).toBe('browser.exe')
    expect(yandex.visible).toBe(1)
    expect(yandex.content!.y).toBeCloseTo(517 / 1440)
    expect(yandex.content!.h).toBeCloseTo(691 / 1440)
    expect(chrome.visible).toBeCloseTo(0.59, 2)
    expect(chrome.content!.x).toBeGreaterThanOrEqual(chrome.x)
  })

  it('counts untitled and own windows as occluders but never lists them', () => {
    const raw = parse(
      [
        row('o', [0, 0, 1920, 1080]), // an untitled window over the whole display
        row('c', [100, 100, 900, 700], 'app.exe', null, 'Hidden')
      ].join('\n')
    )
    expect(selectWindows(raw, { x: 0, y: 0, w: 1920, h: 1080 })).toEqual([])
    const own = parse([row('c', [0, 0, 1920, 1080], 'zoomcut.exe', null, 'ZoomCut'), row('c', [100, 100, 900, 700], 'app.exe', null, 'App')].join('\n'))
    expect(selectWindows(own, { x: 0, y: 0, w: 1920, h: 1080 })).toEqual([])
  })

  it('never lists a known overlay nor lets it hide anything', () => {
    const raw = parse([row('c', [0, 0, 1920, 1080], 'nvidia overlay.exe', null, 'NVIDIA GeForce Overlay'), row('c', [100, 100, 900, 700], 'app.exe', null, 'App')].join('\n'))
    expect(selectWindows(raw, { x: 0, y: 0, w: 1920, h: 1080 }).map((w) => w.title)).toEqual(['App'])
  })

  it('tells the helper the display in whole physical pixels', () => {
    expect(helperArgs(42, LEFT)).toEqual(['-OwnPid', '42', '-DisplayL', '-2560', '-DisplayT', '0', '-DisplayR', '0', '-DisplayB', '1440'])
    // 125 % scaling of a DIP rectangle can leave fractions
    expect(helperArgs(1, { x: 1920.4, y: 0, w: 1599.6, h: 900 }).slice(2)).toEqual(['-DisplayL', '1920', '-DisplayT', '0', '-DisplayR', '3520', '-DisplayB', '900'])
  })

  it('ignores windows on another display as occluders, and windows mostly off this one', () => {
    const raw = parse(
      [
        row('c', [-1920, 0, 0, 1080], 'left.exe', null, 'Left'),
        row('c', [-1500, 100, 300, 900], 'mostly-left.exe', null, 'Mostly left'),
        row('c', [200, 200, 1000, 800], 'app.exe', null, 'App')
      ].join('\n')
    )
    expect(selectWindows(raw, { x: 0, y: 0, w: 1920, h: 1080 }).map((w) => w.title)).toEqual(['App'])
  })

  it('drops page rectangles that are tiny or as large as the window', () => {
    const d = { x: 0, y: 0, w: 1920, h: 1080 }
    const raw = parse(
      [
        row('c', [0, 0, 960, 1040], 'chrome.exe', [0, 0, 960, 1040], 'Full screen page'),
        row('c', [960, 0, 1920, 1040], 'chrome.exe', [970, 90, 1030, 130], 'Tiny page')
      ].join('\n')
    )
    const listed = selectWindows(raw, d)
    expect(listed.map((w) => w.title)).toEqual(['Full screen page', 'Tiny page'])
    expect(listed.every((w) => w.content === undefined)).toBe(true)
  })
})
