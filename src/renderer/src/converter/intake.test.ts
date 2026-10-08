import { describe, expect, it } from 'vitest'
import { dragHasFiles, ipcErrorMessage, pickDroppedFile, videoErrorText } from './intake'

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

describe('videoErrorText', () => {
  // a translator that makes the key visible and appends its variables
  const t = (key: string, vars?: Record<string, string | number>): string => (vars ? `${key} ${JSON.stringify(vars)}` : key)

  it('translates every reason main reports, behind the invoke prefix too', () => {
    const wrapped = (code: string): Error => new Error(`Error invoking remote method 'converter:probe': Error: video-file:${code}`)
    expect(videoErrorText(wrapped('not-video'), t)).toBe('converter.dropNotVideo')
    expect(videoErrorText(wrapped('not-found'), t)).toBe('converter.dropNotFound')
    expect(videoErrorText(wrapped('not-file'), t)).toBe('converter.dropNotFile')
    expect(videoErrorText(wrapped('not-path'), t)).toBe('converter.dropNoPath')
    expect(videoErrorText(wrapped('unreadable'), t)).toBe('converter.dropUnreadable')
  })

  it('shows other errors as their first line without a dangling colon', () => {
    const log = ['Could not read video metadata:', 'Input #0, mov ...'].join('\n')
    expect(videoErrorText(new Error(log), t)).toBe('converter.dropFailed {"error":"Could not read video metadata"}')
    expect(videoErrorText(new Error('boom'), t)).toBe('converter.dropFailed {"error":"boom"}')
    expect(videoErrorText('plain', t)).toBe('converter.dropFailed {"error":"plain"}')
  })
})
