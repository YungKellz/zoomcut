/**
 * Input tags for the editor timeline. Pure: no Electron, no clock, no I/O.
 *
 * While a normal recording runs, the cursor tracker (main/recorder/cursorTracker.ts) keeps the
 * raw global-hook events in memory; when it stops they are turned into InputMarks once, here:
 * clicks, double / right / middle clicks, drags, scroll bursts, typing bursts and key
 * combinations / special keys, each with the span it lasts. The timeline draws them on the Video
 * lane, so it is easier to see where something happens on screen - and where a cut is safe.
 *
 * Privacy: a typing burst is only a time span. Which keys were typed never leaves the raw events
 * (dropped as soon as the marks are built), and a label is produced only for a combination or a
 * special key ("Ctrl+C", "Enter"), never for a plain typed key.
 */
import { isModifierKey } from './scenario'
import type { ClickEvent, InputMark, InputMarkKind, MouseButton } from './types'

// ---- raw hook events ----
// Times are recording-relative ms (the tracker subtracts the recording start); positions are in
// DIP-sized screen pixels (the hook's own event position over the display's scale factor), only
// used for the drag / double-click distances.

export interface RawPointerDown {
  t: number
  type: 'down'
  button: MouseButton
  x: number
  y: number
  /** the hook's own multi-click counter (2 = second click of a pair), when available */
  clicks?: number
}
export interface RawPointerUp {
  t: number
  type: 'up'
  button: MouseButton
  x: number
  y: number
}
export interface RawWheel {
  t: number
  type: 'wheel'
}
export interface RawKeyDown {
  t: number
  type: 'keydown'
  /** uiohook keycode: a PC/AT set-1 scancode, extended keys carry a 0x0E00 / 0xE000 prefix; 0 = unmapped (KEYEVENTF_UNICODE text) */
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}
export interface RawKeyUp {
  t: number
  type: 'keyup'
  keycode: number
}
export type RawHookEvent = RawPointerDown | RawPointerUp | RawWheel | RawKeyDown | RawKeyUp

export interface BuildInputMarksOptions {
  /** events at or after this ms are ignored (the Stop click / shortcut itself) */
  cutoffMs?: number
}

// ---- tunables ----
const DRAG_THRESHOLD_PX = 6
const DOUBLE_CLICK_MS = 400
const DOUBLE_CLICK_PX = 6
// clicks of a recording without `input` only have normalized positions (fractions of the display)
const DOUBLE_CLICK_NORM = 0.005
const SCROLL_MERGE_MS = 400
const TYPE_MERGE_MS = 1500
/** the same key / combination pressed again within this gap extends the previous mark (arrows) */
const KEY_MERGE_MS = 1000
/** ... and within this one while its Ctrl/Alt/Win stay down (Alt held, Tab pressed again and again) */
const KEY_HELD_MERGE_MS = 5000
/** a combination lasts until its modifiers are released when that follows its last press this soon (Alt+Tab) */
const KEY_HOLD_MS = 1500
/** a keydown of a key that is still down is auto-repeat only this close to its previous press, else a lost keyup */
const KEY_REPEAT_MS = 1500

/** uiohook keycode -> set-1 scancode; every extended key has a 0x0E00 or 0xE000 prefix (see scenario/capture.ts). */
function decodeKeycode(keycode: number): { scan: number; extended: boolean } {
  return keycode < 256 ? { scan: keycode, extended: false } : { scan: keycode & 0xff, extended: true }
}

/**
 * Keys that edit the text being typed: pressed inside a typing burst they stay in it (a new line,
 * the next field, fixing a typo), outside one they are marks of their own. Backspace, Tab, Enter,
 * Delete, Home, End and the arrows.
 */
function isEditingKey(scan: number, extended: boolean): boolean {
  if (scan === 28) return true // Enter, main and numpad
  if (!extended) return scan === 14 || scan === 15 // Backspace, Tab
  return scan === 83 || scan === 71 || scan === 79 || scan === 72 || scan === 75 || scan === 77 || scan === 80
}

/** The numpad digits (NumLock on): with Alt held they type an Alt code (Alt+0169), they are no shortcut. */
function isNumpadDigit(scan: number, extended: boolean): boolean {
  return !extended && ((scan >= 71 && scan <= 73) || (scan >= 75 && scan <= 77) || (scan >= 79 && scan <= 82))
}

/** Keys that type a character (letters, digits, punctuation, space, the numpad). */
function isTypingKey(scan: number, extended: boolean): boolean {
  if (extended) return scan === 53 // Numpad /
  return (
    (scan >= 2 && scan <= 13) ||
    (scan >= 16 && scan <= 27) ||
    (scan >= 30 && scan <= 41) ||
    (scan >= 43 && scan <= 53) ||
    scan === 55 || // Numpad *
    scan === 57 || // Space
    (scan >= 71 && scan <= 83) || // Numpad digits, - + .
    scan === 86 || // the extra key of ISO keyboards
    scan === 115 || // ABNT / JIS
    scan === 125
  )
}

// Special keys get a mark of their own even without Ctrl/Alt/Win, keyed by "scan:extended".
const SPECIAL_KEYS: Record<string, string> = {
  '1:false': 'Esc',
  '14:false': 'Backspace',
  '15:false': 'Tab',
  '28:false': 'Enter',
  '28:true': 'Enter',
  '59:false': 'F1', '60:false': 'F2', '61:false': 'F3', '62:false': 'F4', '63:false': 'F5', '64:false': 'F6',
  '65:false': 'F7', '66:false': 'F8', '67:false': 'F9', '68:false': 'F10', '87:false': 'F11', '88:false': 'F12',
  '82:true': 'Insert', '83:true': 'Delete', '71:true': 'Home', '79:true': 'End',
  '73:true': 'PageUp', '81:true': 'PageDown',
  '75:true': '←', '77:true': '→', '72:true': '↑', '80:true': '↓',
  '55:true': 'PrintScreen',
  '93:true': 'Menu'
}

// Names of the typing keys, only ever used inside a combination ("Ctrl+C"): the US-layout name
// of the key at that position, which is how shortcuts are written on other layouts too.
const COMBO_KEYS: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  const rows: [number, string][] = [
    [2, '1234567890-='],
    [16, 'QWERTYUIOP[]'],
    [30, "ASDFGHJKL;'`"],
    [44, 'ZXCVBNM,./']
  ]
  for (const [first, keys] of rows) Array.from(keys).forEach((k, i) => (out[`${first + i}:false`] = k))
  out['43:false'] = '\\'
  out['57:false'] = 'Space'
  const numpad: [number, string][] = [
    [82, '0'], [79, '1'], [80, '2'], [81, '3'], [75, '4'], [76, '5'], [77, '6'], [71, '7'], [72, '8'], [73, '9'],
    [83, '.'], [78, '+'], [74, '-'], [55, '*']
  ]
  for (const [scan, k] of numpad) out[`${scan}:false`] = `Num${k}`
  out['53:true'] = 'Num/'
  return out
})()

type ChordModifier = 'ctrl' | 'alt' | 'meta'
type ChordMods = Record<ChordModifier, boolean>

/** Which chord modifier a modifier key is (Shift is not one: Shift+letter is typing). */
function chordModifierOf(scan: number): ChordModifier | null {
  if (scan === 29) return 'ctrl'
  if (scan === 56) return 'alt'
  if (scan === 91 || scan === 92) return 'meta'
  return null
}

function keyLabel(scan: number, extended: boolean, mods: ChordMods & { shift: boolean }): string {
  const sig = `${scan}:${extended}`
  const parts: string[] = []
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.meta) parts.push('Win')
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  parts.push(SPECIAL_KEYS[sig] ?? COMBO_KEYS[sig] ?? `Key${scan}`)
  return parts.join('+')
}

interface Burst {
  mark: InputMark
  /** the latest press that belongs to it - the merge gap is measured from here */
  lastT: number
}
interface KeyRun extends Burst {
  mods: ChordMods
  /** its Ctrl/Alt/Win are all still down */
  held: boolean
}
interface LastClick {
  mark: InputMark
  t: number
  x: number
  y: number
}

/**
 * Turns the raw hook events of one recording into timeline marks, sorted by start.
 *
 * Rules: a left down+up moving 6px or more is a drag (down -> up), less is a click; a second
 * click within 400ms and 6px (or the hook's own `clicks === 2`, distance still gating) makes it a
 * doubleClick. Right / middle presses are rightClick / middleClick. Wheel events less than 400ms
 * apart are one scroll. Typing keys without Ctrl/Alt/Win (AltGr, Ctrl+Alt without Win and Alt
 * codes count as typing; keycode 0 is text injected with KEYEVENTF_UNICODE, e.g. a scenario
 * replay) less than 1.5s apart are one `type` burst; Backspace / Tab / Enter / Delete / Home / End
 * / arrows inside a burst stay in it. Any other key with Ctrl/Alt/Win held, and Esc / F-keys /
 * PageUp / ... (or one of those editing keys outside a burst) without, is a `key` mark
 * labelled like "Ctrl+Shift+T"; pressing it again within 1s (5s while its Ctrl/Alt/Win stay down)
 * extends it, and it lasts until its key (or, soon after, its modifiers) is released. Bare modifier
 * presses, lock keys and unknown keys without a modifier leave no mark. A mouse press or wheel
 * ends a typing burst / key run and the other way round.
 */
export function buildInputMarks(raw: RawHookEvent[], opts: BuildInputMarksOptions = {}): InputMark[] {
  const cutoff = opts.cutoffMs ?? Number.POSITIVE_INFINITY
  const sorted = [...raw].sort((a, b) => a.t - b.t)
  const events = sorted.filter((e) => e.t >= 0 && e.t < cutoff)

  const marks: InputMark[] = []
  const push = (kind: InputMarkKind, t: number, end = t, label?: string): InputMark => {
    const mark: InputMark = label === undefined ? { t, end, kind } : { t, end, kind, label }
    marks.push(mark)
    return mark
  }
  const downs: Record<MouseButton, RawPointerDown | null> = { left: null, right: null, middle: null }
  let lastClick: LastClick | null = null
  let typing: Burst | null = null
  let scroll: Burst | null = null
  let keyRun: KeyRun | null = null
  // keys that are still down -> the mark their auto-repeat and keyup extend
  const held = new Map<number, Burst>()
  let rightAltHeld = false

  const release = (down: RawPointerDown, upT: number, x: number, y: number): void => {
    if (down.button !== 'left') {
      push(down.button === 'right' ? 'rightClick' : 'middleClick', down.t)
      lastClick = null
      return
    }
    if (Math.hypot(x - down.x, y - down.y) >= DRAG_THRESHOLD_PX) {
      push('drag', down.t, upT)
      lastClick = null
      return
    }
    const prev = lastClick
    if (prev && Math.hypot(down.x - prev.x, down.y - prev.y) <= DOUBLE_CLICK_PX && ((down.clicks ?? 1) >= 2 || down.t - prev.t <= DOUBLE_CLICK_MS)) {
      prev.mark.kind = 'doubleClick'
      prev.t = down.t
      return
    }
    lastClick = { mark: push('click', down.t), t: down.t, x: down.x, y: down.y }
  }

  const keyDown = (e: RawKeyDown): void => {
    const { scan, extended } = decodeKeycode(e.keycode)
    if (scan === 56 && extended) rightAltHeld = true
    if (isModifierKey(scan, extended)) return

    const repeat = held.get(e.keycode)
    if (repeat && e.t - repeat.lastT <= KEY_REPEAT_MS) {
      // auto-repeat of a key that is still down: it only makes its mark last longer
      repeat.lastT = e.t
      repeat.mark.end = Math.max(repeat.mark.end, e.t)
      if (typing?.mark === repeat.mark) typing.lastT = e.t
      if (keyRun?.mark === repeat.mark) keyRun.lastT = e.t
      return
    }

    const typingKey = e.keycode === 0 || isTypingKey(scan, extended)
    // These type a character, they are no shortcut - and naming their keys would spell out what was
    // typed: AltGr (Ctrl+Alt with the right Alt down), any Ctrl+Alt without Win on a character key
    // (Windows takes it for AltGr: left Ctrl + left Alt + A types "ą" on the Polish layout) and Alt
    // with the numpad digits (an Alt code such as Alt+0169).
    const altgr = e.ctrl && e.alt && (rightAltHeld || (!e.meta && typingKey))
    const altCode = e.alt && !e.ctrl && !e.meta && isNumpadDigit(scan, extended)
    const text = altgr || altCode
    const mods = { ctrl: e.ctrl && !text, alt: e.alt && !text, meta: e.meta, shift: e.shift }
    const chord = mods.ctrl || mods.alt || mods.meta
    scroll = null
    lastClick = null

    const inBurst = typing !== null && e.t - typing.lastT <= TYPE_MERGE_MS
    if (!chord && (typingKey || (inBurst && isEditingKey(scan, extended)))) {
      keyRun = null
      if (typing && inBurst) {
        typing.lastT = e.t
        typing.mark.end = Math.max(typing.mark.end, e.t)
      } else {
        typing = { mark: push('type', e.t), lastT: e.t }
      }
      held.set(e.keycode, { mark: typing.mark, lastT: e.t })
      return
    }
    if (e.keycode === 0) return // unmapped key with a modifier: nothing to name
    if (!chord && !SPECIAL_KEYS[`${scan}:${extended}`]) return // CapsLock, NumLock, media keys ...

    typing = null
    const label = keyLabel(scan, extended, mods)
    if (keyRun && keyRun.mark.label === label && e.t - keyRun.lastT <= (keyRun.held ? KEY_HELD_MERGE_MS : KEY_MERGE_MS)) {
      keyRun.lastT = e.t
      keyRun.mark.end = Math.max(keyRun.mark.end, e.t)
    } else {
      keyRun = { mark: push('key', e.t, e.t, label), lastT: e.t, mods: { ctrl: mods.ctrl, alt: mods.alt, meta: mods.meta }, held: chord }
    }
    held.set(e.keycode, { mark: keyRun.mark, lastT: e.t })
  }

  const keyUp = (e: RawKeyUp): void => {
    const { scan, extended } = decodeKeycode(e.keycode)
    if (scan === 56 && extended) rightAltHeld = false
    if (isModifierKey(scan, extended)) {
      const mod = chordModifierOf(scan)
      if (keyRun && keyRun.held && mod && keyRun.mods[mod]) {
        keyRun.held = false
        // a combination held on to (Alt+Tab with its switcher open) lasts until it is let go
        if (e.t - keyRun.lastT <= KEY_HOLD_MS) keyRun.mark.end = Math.max(keyRun.mark.end, e.t)
      }
      return
    }
    const down = held.get(e.keycode)
    if (!down) return
    held.delete(e.keycode)
    down.mark.end = Math.max(down.mark.end, e.t)
  }

  for (const e of events) {
    switch (e.type) {
      case 'down': {
        typing = null
        scroll = null
        keyRun = null
        const open = downs[e.button]
        if (open) release(open, open.t, open.x, open.y) // its up was lost
        downs[e.button] = e
        break
      }
      case 'up': {
        const down = downs[e.button]
        if (!down) break
        downs[e.button] = null
        release(down, e.t, e.x, e.y)
        break
      }
      case 'wheel':
        typing = null
        keyRun = null
        lastClick = null
        if (scroll && e.t - scroll.lastT <= SCROLL_MERGE_MS) {
          scroll.lastT = e.t
          scroll.mark.end = e.t
        } else {
          scroll = { mark: push('scroll', e.t), lastT: e.t }
        }
        break
      case 'keydown':
        keyDown(e)
        break
      case 'keyup':
        keyUp(e)
        break
    }
  }
  // a button still down at the cutoff: its press still happened (it is in `clicks` too); when it is
  // let go after the cutoff, that release tells a drag (which then ends at the cutoff) from a click
  for (const down of Object.values(downs)) {
    if (!down) continue
    const late = sorted.find((e): e is RawPointerUp => e.type === 'up' && e.button === down.button && e.t >= cutoff)
    if (late) release(down, cutoff, late.x, late.y)
    else release(down, down.t, down.x, down.y)
  }

  return marks.sort((a, b) => a.t - b.t)
}

/**
 * Click marks for a recording without `input` (made before 0.4.1): its mousedown `clicks` still
 * tell clicks, double clicks (two left clicks within 400ms at nearly the same spot) and right /
 * middle clicks apart.
 */
export function marksFromClicks(clicks: ClickEvent[]): InputMark[] {
  const marks: InputMark[] = []
  let last: LastClick | null = null
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) {
    if (c.button !== 'left') {
      marks.push({ t: c.t, end: c.t, kind: c.button === 'right' ? 'rightClick' : 'middleClick' })
      last = null
      continue
    }
    if (last && c.t - last.t <= DOUBLE_CLICK_MS && Math.hypot(c.x - last.x, c.y - last.y) <= DOUBLE_CLICK_NORM) {
      last.mark.kind = 'doubleClick'
      last.t = c.t
      continue
    }
    const mark: InputMark = { t: c.t, end: c.t, kind: 'click' }
    marks.push(mark)
    last = { mark, t: c.t, x: c.x, y: c.y }
  }
  return marks
}

/**
 * The part of each mark that survives the cuts (`segments`: the kept source spans, in order).
 * An instant must lie inside a kept segment; a span is clipped to its first and last kept
 * moment and dropped when all of it was cut. Source time in and out - the timeline maps the
 * result with srcToOut, which collapses every cut inside a span to a point.
 */
export function clipMarksToSegments(marks: InputMark[], segments: { start: number; end: number }[]): InputMark[] {
  const out: InputMark[] = []
  for (const m of marks) {
    if (m.end <= m.t) {
      if (segments.some((s) => m.t >= s.start && m.t < s.end)) out.push(m)
      continue
    }
    const kept = segments.filter((s) => s.start < m.end && s.end > m.t)
    if (kept.length === 0) continue
    out.push({ ...m, t: Math.max(m.t, kept[0].start), end: Math.min(m.end, kept[kept.length - 1].end) })
  }
  return out
}
