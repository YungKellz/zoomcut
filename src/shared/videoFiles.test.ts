import { describe, expect, it } from 'vitest'
import { fileExtension, isVideoFileName, VIDEO_EXTENSIONS } from './videoFiles'

describe('fileExtension', () => {
  it('returns the lower-case extension of a name or a path', () => {
    expect(fileExtension('clip.MP4')).toBe('mp4')
    expect(fileExtension('C:\\Users\\me\\Videos\\demo.final.webm')).toBe('webm')
    expect(fileExtension('/home/me/demo.mkv')).toBe('mkv')
  })

  it('returns an empty string without an extension', () => {
    expect(fileExtension('clip')).toBe('')
    expect(fileExtension('C:\\videos.d\\clip')).toBe('')
    expect(fileExtension('.mp4')).toBe('')
    expect(fileExtension('clip.')).toBe('')
  })
})

describe('isVideoFileName', () => {
  it('accepts every extension the picker offers, in any case', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isVideoFileName(`recording.${ext}`)).toBe(true)
      expect(isVideoFileName(`recording.${ext.toUpperCase()}`)).toBe(true)
    }
  })

  it('rejects other files', () => {
    expect(isVideoFileName('notes.txt')).toBe(false)
    expect(isVideoFileName('picture.gif')).toBe(false)
    expect(isVideoFileName('archive.mp4.zip')).toBe(false)
    expect(isVideoFileName('mp4')).toBe(false)
    expect(isVideoFileName('')).toBe(false)
  })
})
