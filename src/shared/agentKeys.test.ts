import { describe, expect, it } from 'vitest'
import { AgentError } from './agent'
import { KEY_CHORD_HELP, parseKeyChord } from './agentKeys'
import { compileScenario, describeKeyLabel, isModifierKey } from './scenario'
import type { ScenarioKeyAction, ScenarioModifiers } from './types'

const NONE: ScenarioModifiers = { ctrl: false, shift: false, alt: false, meta: false }

function badParams(fn: () => unknown): AgentError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).code).toBe('bad_params')
    return err as AgentError
  }
  throw new Error('expected parseKeyChord to throw')
}

describe('parseKeyChord', () => {
  it('parses a plain chord like a captured one', () => {
    expect(parseKeyChord('Ctrl+S')).toEqual({
      key: 'Ctrl+S',
      vk: 0x53,
      scan: 31,
      extended: false,
      modifiers: { ...NONE, ctrl: true }
    })
  })

  it('is case-insensitive, accepts aliases and orders modifiers Ctrl, Shift, Alt, Win', () => {
    const chord = parseKeyChord('cmd + alt+ SHIFT +control+t')
    expect(chord.key).toBe('Ctrl+Shift+Alt+Win+T')
    expect(chord.modifiers).toEqual({ ctrl: true, shift: true, alt: true, meta: true })
    expect(chord.vk).toBe(0x54)
    expect(chord.scan).toBe(0x14)
  })

  it('knows the function keys, including the ones past F12', () => {
    expect(parseKeyChord('F5')).toMatchObject({ key: 'F5', vk: 0x74, scan: 0x3f, extended: false })
    expect(parseKeyChord('f10')).toMatchObject({ vk: 0x79, scan: 0x44 })
    expect(parseKeyChord('F11')).toMatchObject({ vk: 0x7a, scan: 0x57 })
    expect(parseKeyChord('F12')).toMatchObject({ vk: 0x7b, scan: 0x58 })
    expect(parseKeyChord('F13')).toMatchObject({ vk: 0x7c, scan: 0x64 })
    expect(parseKeyChord('F23')).toMatchObject({ vk: 0x86, scan: 0x6e })
    expect(parseKeyChord('F24')).toMatchObject({ vk: 0x87, scan: 0x76 })
  })

  it('marks the extended keys', () => {
    for (const name of ['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen']) {
      expect(parseKeyChord(name).extended, name).toBe(true)
    }
    for (const name of ['Enter', 'Tab', 'Escape', 'Backspace', 'Space', 'A', '5', 'F1', '-', '/']) {
      expect(parseKeyChord(name).extended, name).toBe(false)
    }
    expect(parseKeyChord('Left')).toMatchObject({ key: 'ArrowLeft', vk: 0x25, scan: 0x4b })
    expect(parseKeyChord('pgdn')).toMatchObject({ key: 'PageDown', vk: 0x22, scan: 0x51 })
  })

  it('handles the navigation and editing keys', () => {
    expect(parseKeyChord('Enter')).toMatchObject({ vk: 0x0d, scan: 0x1c })
    expect(parseKeyChord('Return').key).toBe('Enter')
    expect(parseKeyChord('Esc')).toMatchObject({ key: 'Escape', vk: 0x1b, scan: 0x01 })
    expect(parseKeyChord('Tab')).toMatchObject({ vk: 0x09, scan: 0x0f })
    expect(parseKeyChord('Backspace')).toMatchObject({ vk: 0x08, scan: 0x0e })
    expect(parseKeyChord('Space')).toMatchObject({ vk: 0x20, scan: 0x39 })
    expect(parseKeyChord('Alt+Tab')).toMatchObject({ key: 'Alt+Tab', modifiers: { ...NONE, alt: true } })
  })

  it('maps digits and punctuation of the US layout', () => {
    expect(parseKeyChord('1')).toMatchObject({ vk: 0x31, scan: 2 })
    expect(parseKeyChord('9')).toMatchObject({ vk: 0x39, scan: 10 })
    expect(parseKeyChord('0')).toMatchObject({ vk: 0x30, scan: 11 })
    expect(parseKeyChord('Ctrl+=')).toMatchObject({ key: 'Ctrl+=', vk: 0xbb, scan: 0x0d })
    expect(parseKeyChord('Ctrl+-')).toMatchObject({ vk: 0xbd, scan: 0x0c })
    expect(parseKeyChord('Ctrl+Equals').key).toBe('Ctrl+=')
    expect(parseKeyChord('[')).toMatchObject({ vk: 0xdb, scan: 0x1a })
    expect(parseKeyChord(']')).toMatchObject({ vk: 0xdd, scan: 0x1b })
    expect(parseKeyChord(';')).toMatchObject({ vk: 0xba, scan: 0x27 })
    expect(parseKeyChord("'")).toMatchObject({ vk: 0xde, scan: 0x28 })
    expect(parseKeyChord('\\')).toMatchObject({ vk: 0xdc, scan: 0x2b })
    expect(parseKeyChord(',')).toMatchObject({ vk: 0xbc, scan: 0x33 })
    expect(parseKeyChord('.')).toMatchObject({ vk: 0xbe, scan: 0x34 })
    expect(parseKeyChord('/')).toMatchObject({ vk: 0xbf, scan: 0x35 })
    expect(parseKeyChord('`')).toMatchObject({ vk: 0xc0, scan: 0x29 })
  })

  it('presses the last modifier as the key when a chord has only modifiers', () => {
    expect(parseKeyChord('Win')).toEqual({ key: 'Win', vk: 0x5b, scan: 0x5b, extended: true, modifiers: NONE })
    expect(parseKeyChord('Alt+Shift')).toEqual({
      key: 'Alt+Shift',
      vk: 0x10,
      scan: 0x2a,
      extended: false,
      modifiers: { ...NONE, alt: true }
    })
  })

  it('rejects what it cannot read, naming the part and listing the valid keys', () => {
    expect(badParams(() => parseKeyChord('Ctrl+Banana')).message).toContain('"Banana"')
    expect(badParams(() => parseKeyChord('Ctrl+Banana')).message).toContain(KEY_CHORD_HELP)
    expect(badParams(() => parseKeyChord('')).message).toContain('Empty key')
    expect(badParams(() => parseKeyChord('   ')).message).toContain('Empty key')
    expect(badParams(() => parseKeyChord('Ctrl++')).message).toContain('empty part')
    expect(badParams(() => parseKeyChord('Ctrl+Ctrl+S')).message).toContain('twice')
    expect(badParams(() => parseKeyChord('A+B')).message).toContain('two non-modifier keys')
    expect(badParams(() => parseKeyChord(undefined as unknown as string)).message).toContain('Empty key')
  })

  it('never takes a name from the prototype chain', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Ctrl+__proto__', '__proto__+S', 'Ctrl+constructor']) {
      const message = badParams(() => parseKeyChord(name)).message
      expect(message, name).toContain('Unknown key')
      expect(message, name).toContain(KEY_CHORD_HELP)
    }
    // and an ordinary chord does not pick up stray modifier keys
    expect(Object.keys(parseKeyChord('Ctrl+S').modifiers).sort()).toEqual(['alt', 'ctrl', 'meta', 'shift'])
  })

  it('knows the numpad and the lock keys', () => {
    expect(parseKeyChord('NumpadEnter')).toMatchObject({ key: 'NumpadEnter', vk: 0x0d, scan: 0x1c, extended: true })
    expect(parseKeyChord('Enter')).toMatchObject({ vk: 0x0d, scan: 0x1c, extended: false })
    expect(parseKeyChord('numpad5')).toMatchObject({ key: 'Numpad5', vk: 0x65, scan: 0x4c, extended: false })
    expect(parseKeyChord('Numpad0')).toMatchObject({ vk: 0x60, scan: 0x52 })
    expect(parseKeyChord('Numpad9')).toMatchObject({ vk: 0x69, scan: 0x49 })
    expect(parseKeyChord('NumLock')).toMatchObject({ vk: 0x90, scan: 0x45 })
    expect(parseKeyChord('ScrollLock')).toMatchObject({ vk: 0x91, scan: 0x46 })
    expect(parseKeyChord('Numpad*')).toMatchObject({ vk: 0x6a, scan: 0x37, extended: false })
    expect(parseKeyChord('PrintScreen')).toMatchObject({ scan: 0x37, extended: true })
    expect(parseKeyChord('Numpad/')).toMatchObject({ vk: 0x6f, scan: 0x35, extended: true })
    expect(parseKeyChord('Numpad.')).toMatchObject({ vk: 0x6e, scan: 0x53 })
    expect(parseKeyChord('Numpad-')).toMatchObject({ vk: 0x6d, scan: 0x4a })
    expect(parseKeyChord('NumpadMinus').key).toBe('Numpad-')
    expect(parseKeyChord('NumpadMultiply').key).toBe('Numpad*')
  })

  it('reads Numpad+ although its name ends in the separator', () => {
    expect(parseKeyChord('Numpad+')).toMatchObject({ key: 'Numpad+', vk: 0x6b, scan: 0x4e, modifiers: NONE })
    expect(parseKeyChord('Ctrl+Numpad+')).toMatchObject({ key: 'Ctrl+Numpad+', vk: 0x6b, modifiers: { ...NONE, ctrl: true } })
    expect(parseKeyChord(' shift + alt + NUMPAD + ')).toMatchObject({ key: 'Shift+Alt+Numpad+', vk: 0x6b })
    expect(parseKeyChord('Ctrl+NumpadPlus').key).toBe('Ctrl+Numpad+')
    expect(parseKeyChord('Ctrl+NumpadAdd').key).toBe('Ctrl+Numpad+')
    expect(badParams(() => parseKeyChord('Numpad++')).message).toContain('Unknown key "Numpad"')
    expect(badParams(() => parseKeyChord('Numpad+Ctrl')).message).toContain('Unknown key "Numpad"')
    expect(badParams(() => parseKeyChord('Ctrl++')).message).toContain('empty part')
    expect(badParams(() => parseKeyChord('A+Numpad+')).message).toContain('two non-modifier keys')
  })

  it('takes a key by its scancode, the way a capture names a key it has no name for', () => {
    // the ISO "<>" key
    expect(parseKeyChord('Key86')).toEqual({ key: 'Key86', vk: 0xe2, scan: 86, extended: false, modifiers: NONE })
    // F13 on its scancode keeps its virtual key, the Menu key its extended flag
    expect(parseKeyChord('Key100')).toMatchObject({ key: 'Key100', vk: 0x7c, scan: 100, extended: false })
    expect(parseKeyChord('Ctrl+key93')).toMatchObject({ key: 'Ctrl+Key93', vk: 0x5d, scan: 93, extended: true })
    // nothing known about the key: just the scancode, as a capture without a keytext answer stores it
    expect(parseKeyChord('Key200')).toMatchObject({ key: 'Key200', vk: 0, scan: 200, extended: false })
    expect(parseKeyChord('Key007').key).toBe('Key7')
    expect(badParams(() => parseKeyChord('Key256')).message).toContain('Unknown key')
    expect(badParams(() => parseKeyChord('Key')).message).toContain('Unknown key')
    expect(badParams(() => parseKeyChord('Key1234')).message).toContain('Unknown key')
  })

  it('reads back every label a capture can give a key', () => {
    // describeKeyLabel is the one place that names captured keys: every scan, both extended flags and the virtual
    // keys it labels by themselves (digits, letters, punctuation) or does not (0, an F-key, 0xff)
    const vks = [0, 0x70, 0xff, ...Array.from({ length: 10 }, (_, i) => 48 + i), ...Array.from({ length: 26 }, (_, i) => 65 + i)]
    vks.push(0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde)
    const bases = new Map<string, { scan: number; vk: number; extended: boolean }>()
    for (let scan = 0; scan <= 255; scan++) {
      for (const extended of [false, true]) {
        // a pure modifier press is never an action (groupRawEvents drops it)
        if (isModifierKey(scan, extended)) continue
        for (const vk of vks) {
          const key = { scan, vk, extended }
          const base = describeKeyLabel({ mods: NONE, ...key })
          const chord = parseKeyChord(base)
          expect(chord.key, base).toBe(base)
          expect(chord.modifiers, base).toEqual(NONE)
          if (/^Key\d+$/.test(base)) {
            expect(chord.scan, base).toBe(scan)
          } else if (base.length === 1) {
            // a character names the key by its virtual key
            expect(chord.vk, base).toBe(vk)
          } else {
            expect([chord.scan, chord.extended], base).toEqual([scan, extended])
          }
          if (!/^Key\d+$/.test(base)) expect(chord.vk, base).not.toBe(0)
          bases.set(base, key)
        }
      }
    }
    expect(bases.size).toBeGreaterThan(100)
    // and behind any modifiers
    for (let bits = 0; bits < 16; bits++) {
      const mods: ScenarioModifiers = { ctrl: !!(bits & 1), shift: !!(bits & 2), alt: !!(bits & 4), meta: !!(bits & 8) }
      for (const [base, key] of bases) {
        const label = describeKeyLabel({ mods, ...key })
        const chord = parseKeyChord(label)
        expect(chord.key, label).toBe(label)
        expect(chord.modifiers, label).toEqual(mods)
        expect(label.endsWith(base)).toBe(true)
      }
    }
  })

  it('labels every key the way the review screen labels a captured one', () => {
    const names = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
      'Enter', 'Tab', 'Escape', 'Backspace', 'Space', 'CapsLock', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen', '-', '=', '[', ']', ';', "'", '\\', ',', '.', '/', '`'
    ]
    for (const name of names) {
      const chord = parseKeyChord(name)
      expect(describeKeyLabel({ mods: chord.modifiers, scan: chord.scan, vk: chord.vk, extended: chord.extended }), name).toBe(chord.key)
    }
    const withMods = parseKeyChord('Win+Alt+Shift+Ctrl+Delete')
    expect(describeKeyLabel({ mods: withMods.modifiers, scan: withMods.scan, vk: withMods.vk, extended: withMods.extended })).toBe(withMods.key)
  })

  it('compiles to the same steps a captured chord produces', () => {
    const chord = parseKeyChord('Ctrl+Shift+T')
    const action: ScenarioKeyAction = {
      id: 'k',
      kind: 'key',
      at: 0,
      x: 10,
      y: 10,
      path: [],
      modifiers: chord.modifiers,
      shot: null,
      durationMs: 500,
      pauseMs: 0,
      key: chord.key,
      vk: chord.vk,
      scan: chord.scan,
      extended: chord.extended
    }
    const steps = compileScenario([action], { startPos: { x: 10, y: 10 } }).filter((s) => s.op === 'key')
    // modifiers go down 20 ms before the key, the key is pressed at end-60 and released at end-20, modifiers up at end
    expect(steps).toEqual([
      { t: 420, op: 'key', vk: 0x11, scan: 29, extended: false, down: true },
      { t: 420, op: 'key', vk: 0x10, scan: 42, extended: false, down: true },
      { t: 440, op: 'key', vk: 0x54, scan: 0x14, extended: false, down: true },
      { t: 480, op: 'key', vk: 0x54, scan: 0x14, extended: false, down: false },
      { t: 500, op: 'key', vk: 0x11, scan: 29, extended: false, down: false },
      { t: 500, op: 'key', vk: 0x10, scan: 42, extended: false, down: false }
    ])
  })
})
