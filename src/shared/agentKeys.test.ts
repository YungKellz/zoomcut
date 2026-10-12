import { describe, expect, it } from 'vitest'
import { AgentError } from './agent'
import { KEY_CHORD_HELP, parseKeyChord } from './agentKeys'
import { compileScenario, describeKeyLabel } from './scenario'
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
