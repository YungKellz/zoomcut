/**
 * Key chords for agent-built scenarios ("Ctrl+Shift+T", "Enter", "Alt+Tab", "F5") → the
 * vk / scan / extended / modifiers a captured `key` action carries, so a built scenario replays
 * through exactly the same path (compileScenario) as one recorded from real input. Pure: no
 * Electron, no I/O. Scancodes are PC/AT set 1 (low byte, `extended` marks the 0xE0 prefix), key
 * names follow the US layout – a virtual-key code names a physical key, the character it types
 * depends on the layout the replayed machine uses.
 */
import { AgentError } from './agent'
import type { ScenarioModifiers } from './types'

export interface ParsedKeyChord {
  /** canonical label, as the review screen shows a captured chord ("Ctrl+Shift+T") */
  key: string
  vk: number
  scan: number
  extended: boolean
  modifiers: ScenarioModifiers
}

interface KeyDef {
  label: string
  vk: number
  scan: number
  extended: boolean
}

type ModifierName = keyof ScenarioModifiers

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  win: 'meta',
  windows: 'meta',
  meta: 'meta',
  cmd: 'meta',
  super: 'meta'
}
const MODIFIER_ORDER: ModifierName[] = ['ctrl', 'shift', 'alt', 'meta']
const MODIFIER_LABEL: Record<ModifierName, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Win' }
// left-hand modifier keys, for a chord that is only modifiers ("Win" opens the Start menu)
const MODIFIER_KEY: Record<ModifierName, KeyDef> = {
  ctrl: { label: 'Ctrl', vk: 0x11, scan: 0x1d, extended: false },
  shift: { label: 'Shift', vk: 0x10, scan: 0x2a, extended: false },
  alt: { label: 'Alt', vk: 0x12, scan: 0x38, extended: false },
  meta: { label: 'Win', vk: 0x5b, scan: 0x5b, extended: true }
}

const KEYS = new Map<string, KeyDef>()

function def(names: string[], label: string, vk: number, scan: number, extended = false): void {
  const key: KeyDef = { label, vk, scan, extended }
  for (const name of names) KEYS.set(name.toLowerCase(), key)
}

// letters, by scancode row (QWERTY)
const LETTER_SCANS: Record<string, number> = {
  Q: 0x10, W: 0x11, E: 0x12, R: 0x13, T: 0x14, Y: 0x15, U: 0x16, I: 0x17, O: 0x18, P: 0x19,
  A: 0x1e, S: 0x1f, D: 0x20, F: 0x21, G: 0x22, H: 0x23, J: 0x24, K: 0x25, L: 0x26,
  Z: 0x2c, X: 0x2d, C: 0x2e, V: 0x2f, B: 0x30, N: 0x31, M: 0x32
}
for (const [letter, scan] of Object.entries(LETTER_SCANS)) def([letter], letter, letter.charCodeAt(0), scan)

// digits 1..9 are scans 2..10, 0 is scan 11
for (let d = 0; d <= 9; d++) def([String(d)], String(d), 0x30 + d, d === 0 ? 0x0b : d + 1)

// F1..F10 are 0x3B.., F11/F12 0x57/0x58, F13..F23 0x64.., F24 0x76; virtual keys F1 = 0x70 on
for (let n = 1; n <= 24; n++) {
  const scan = n <= 10 ? 0x3a + n : n === 11 ? 0x57 : n === 12 ? 0x58 : n <= 23 ? 0x64 + (n - 13) : 0x76
  def([`F${n}`], `F${n}`, 0x6f + n, scan)
}

def(['Enter', 'Return'], 'Enter', 0x0d, 0x1c)
def(['Tab'], 'Tab', 0x09, 0x0f)
def(['Escape', 'Esc'], 'Escape', 0x1b, 0x01)
def(['Backspace', 'Bksp'], 'Backspace', 0x08, 0x0e)
def(['Space', 'Spacebar'], 'Space', 0x20, 0x39)
def(['CapsLock'], 'CapsLock', 0x14, 0x3a)
def(['Delete', 'Del'], 'Delete', 0x2e, 0x53, true)
def(['Insert', 'Ins'], 'Insert', 0x2d, 0x52, true)
def(['Home'], 'Home', 0x24, 0x47, true)
def(['End'], 'End', 0x23, 0x4f, true)
def(['PageUp', 'PgUp'], 'PageUp', 0x21, 0x49, true)
def(['PageDown', 'PgDn'], 'PageDown', 0x22, 0x51, true)
def(['ArrowUp', 'Up'], 'ArrowUp', 0x26, 0x48, true)
def(['ArrowDown', 'Down'], 'ArrowDown', 0x28, 0x50, true)
def(['ArrowLeft', 'Left'], 'ArrowLeft', 0x25, 0x4b, true)
def(['ArrowRight', 'Right'], 'ArrowRight', 0x27, 0x4d, true)
def(['PrintScreen', 'PrtSc'], 'PrintScreen', 0x2c, 0x37, true)

// punctuation of the US layout: the character itself, plus a spelled-out name (a "+" cannot be a chord part)
def(['-', 'Minus'], '-', 0xbd, 0x0c)
def(['=', 'Equal', 'Equals'], '=', 0xbb, 0x0d)
def(['[', 'LeftBracket'], '[', 0xdb, 0x1a)
def([']', 'RightBracket'], ']', 0xdd, 0x1b)
def([';', 'Semicolon'], ';', 0xba, 0x27)
def(["'", 'Quote'], "'", 0xde, 0x28)
def(['\\', 'Backslash'], '\\', 0xdc, 0x2b)
def([',', 'Comma'], ',', 0xbc, 0x33)
def(['.', 'Period'], '.', 0xbe, 0x34)
def(['/', 'Slash'], '/', 0xbf, 0x35)
def(['`', 'Backtick', 'Grave'], '`', 0xc0, 0x29)

/** One-line list of what parseKeyChord accepts, for error messages and tool descriptions. */
export const KEY_CHORD_HELP =
  'Modifiers: Ctrl, Shift, Alt, Win. Keys: A-Z, 0-9, F1-F24, Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, ' +
  'PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, PrintScreen, CapsLock, and the US-layout punctuation ' +
  '- = [ ] ; \' \\ , . / ` (also spelled Minus, Equals, LeftBracket, RightBracket, Semicolon, Quote, Backslash, Comma, ' +
  'Period, Slash, Backtick). Join with "+": "Ctrl+S", "Ctrl+Shift+T", "Alt+Tab". "+" itself cannot be a chord part: write "Ctrl+=" for zoom in.'

function bad(message: string): never {
  throw new AgentError('bad_params', message)
}

/**
 * "Ctrl+Shift+T" → the key and held modifiers of a `key` action. Names are case-insensitive. A
 * chord made only of modifiers ("Win", "Alt+Shift") presses the last one as the key with the
 * others held. Throws AgentError('bad_params') naming the offending part and listing the valid names.
 */
export function parseKeyChord(input: string): ParsedKeyChord {
  if (typeof input !== 'string' || input.trim() === '') bad(`Empty key. ${KEY_CHORD_HELP}`)
  const parts = input.split('+').map((p) => p.trim())
  const modifiers: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }
  const held: ModifierName[] = []
  let base: KeyDef | null = null

  for (const part of parts) {
    if (part === '') bad(`Cannot read the key "${input}": empty part between "+" signs. ${KEY_CHORD_HELP}`)
    const lower = part.toLowerCase()
    const modifier = MODIFIER_ALIASES[lower]
    if (modifier) {
      if (modifiers[modifier]) bad(`Cannot read the key "${input}": ${MODIFIER_LABEL[modifier]} is listed twice.`)
      modifiers[modifier] = true
      held.push(modifier)
      continue
    }
    const key = KEYS.get(lower)
    if (!key) bad(`Unknown key "${part}" in "${input}". ${KEY_CHORD_HELP}`)
    if (base) bad(`Cannot read the key "${input}": it has two non-modifier keys ("${base.label}" and "${key.label}"). Use one key action per key.`)
    base = key
  }

  if (!base) {
    // only modifiers: the last one is pressed as the key itself, the rest are held
    const last = held[held.length - 1]
    base = MODIFIER_KEY[last]
    modifiers[last] = false
  }

  const prefix = MODIFIER_ORDER.filter((m) => modifiers[m]).map((m) => MODIFIER_LABEL[m])
  return {
    key: [...prefix, base.label].join('+'),
    vk: base.vk,
    scan: base.scan,
    extended: base.extended,
    modifiers
  }
}
