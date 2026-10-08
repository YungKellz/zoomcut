import { describe, expect, it } from 'vitest'
import { dragHasFiles, ipcErrorMessage, pickDroppedFile } from './intake'

describe('dragHasFiles', () => {
  it('is true only for drags that carry files', () => {
    expect(dragHasFiles(['Files'])).toBe(true)
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true)
    expect(dragHasFiles(['text/plain', 'text/html'])).toBe(false)
    expect(dragHasFiles([])).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
    expect(dragHasFiles(undefined)).toBe(false)
  })
})

describe('pickDroppedFile', () => {
  it('prefers the first video among several dropped files', () => {
    const files = [{ name: 'notes.txt' }, { name: 'demo.MP4' }, { name: 'other.mov' }]
    expect(pickDroppedFile(files)).toBe(files[1])
  })

  it('falls back to the first file so the caller can explain why it is rejected', () => {
    const files = [{ name: 'notes.txt' }, { name: 'logo.png' }]
    expect(pickDroppedFile(files)).toBe(files[0])
  })

  it('returns undefined for an empty or missing list', () => {
    expect(pickDroppedFile([])).toBeUndefined()
    expect(pickDroppedFile(null)).toBeUndefined()
  })
})

describe('ipcErrorMessage', () => {
  it('strips the Electron invoke prefix', () => {
    const err = new Error("Error invoking remote method 'converter:probe': Error: Not a video file")
    expect(ipcErrorMessage(err)).toBe('Not a video file')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'converter:probe': File not found"))).toBe('File not found')
  })

  it('keeps ordinary messages and non-error values', () => {
    expect(ipcErrorMessage(new Error('boom'))).toBe('boom')
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})
