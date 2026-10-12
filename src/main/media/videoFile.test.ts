import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asVideoReadError, checkVideoFile } from './videoFile'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zc-videofile-'))
  writeFileSync(join(dir, 'clip.mp4'), 'x')
  writeFileSync(join(dir, 'CLIP.MKV'), 'x')
  writeFileSync(join(dir, 'notes.txt'), 'x')
  mkdirSync(join(dir, 'folder.mp4'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('checkVideoFile', () => {
  it('accepts an existing video file, whatever the case of its extension', async () => {
    await expect(checkVideoFile(join(dir, 'clip.mp4'))).resolves.toBe(join(dir, 'clip.mp4'))
    await expect(checkVideoFile(join(dir, 'CLIP.MKV'))).resolves.toBe(join(dir, 'CLIP.MKV'))
  })

  it('rejects a file with another extension', async () => {
    await expect(checkVideoFile(join(dir, 'notes.txt'))).rejects.toThrow('video-file:not-video')
  })

  it('rejects a missing file and a directory named like a video', async () => {
    await expect(checkVideoFile(join(dir, 'missing.mp4'))).rejects.toThrow('video-file:not-found')
    await expect(checkVideoFile(join(dir, 'folder.mp4'))).rejects.toThrow('video-file:not-file')
  })

  it('rejects anything that is not an absolute path string', async () => {
    await expect(checkVideoFile('clip.mp4')).rejects.toThrow('video-file:not-path')
    await expect(checkVideoFile('')).rejects.toThrow('video-file:not-path')
    await expect(checkVideoFile(undefined)).rejects.toThrow('video-file:not-path')
    await expect(checkVideoFile({ path: 'x.mp4' })).rejects.toThrow('video-file:not-path')
  })
})

describe('asVideoReadError', () => {
  it('turns the ffmpeg metadata failure into the coded unreadable error', () => {
    const log = ['Could not read video metadata:', 'Input #0, matroska,webm ...'].join('\n')
    const err = asVideoReadError(new Error(log))
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('video-file:unreadable')
  })

  it('treats a failed `ffmpeg -i` (invalid data exits with a huge code) as unreadable too', () => {
    const err = asVideoReadError(new Error('ffmpeg exited with code 3199971767\nbroken.mp4: Invalid data found when processing input'))
    expect((err as Error).message).toBe('video-file:unreadable')
  })

  it('leaves every other failure alone', () => {
    const other = new Error('ffmpeg is not installed')
    expect(asVideoReadError(other)).toBe(other)
    expect(asVideoReadError('plain')).toBe('plain')
  })
})
