import { promises as fsp } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isVideoFileName } from '@shared/videoFiles'

/**
 * Validates a video path that came from the renderer (a file dropped on the converter):
 * an absolute path to an existing regular file with an extension the file picker offers.
 * Throws a short English message otherwise.
 */
export async function checkVideoFile(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Not a file path')
  if (!isVideoFileName(path)) throw new Error('Not a video file')
  const stat = await fsp.stat(path).catch(() => null)
  if (!stat) throw new Error('File not found')
  if (!stat.isFile()) throw new Error('Not a regular file')
  return path
}
