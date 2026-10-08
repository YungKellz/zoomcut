import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkVideoFile } from './videoFile'

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
    await expect(checkVideoFile(join(dir, 'notes.txt'))).rejects.toThrow('Not a video file')
  })

  it('rejects a missing file and a directory named like a video', async () => {
    await expect(checkVideoFile(join(dir, 'missing.mp4'))).rejects.toThrow('File not found')
    await expect(checkVideoFile(join(dir, 'folder.mp4'))).rejects.toThrow('Not a regular file')
  })

  it('rejects anything that is not an absolute path string', async () => {
    await expect(checkVideoFile('clip.mp4')).rejects.toThrow('Not a file path')
    await expect(checkVideoFile('')).rejects.toThrow('Not a file path')
    await expect(checkVideoFile(undefined)).rejects.toThrow('Not a file path')
    await expect(checkVideoFile({ path: 'x.mp4' })).rejects.toThrow('Not a file path')
  })
})
