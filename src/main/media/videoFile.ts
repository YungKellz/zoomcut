import { promises as fsp } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isVideoFileName, videoFileErrorMessage, type VideoFileErrorCode } from '@shared/videoFiles'

function refused(code: VideoFileErrorCode): Error {
  return new Error(videoFileErrorMessage(code))
}

/**
 * Validates a video path that came from the renderer (a file dropped on the converter):
 * an absolute path to an existing regular file with an extension the file picker offers.
 * Throws an Error carrying a `video-file:<code>` message otherwise; the renderer translates it.
 */
export async function checkVideoFile(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw refused('not-path')
  if (!isVideoFileName(path)) throw refused('not-video')
  const stat = await fsp.stat(path).catch(() => null)
  if (!stat) throw refused('not-found')
  if (!stat.isFile()) throw refused('not-file')
  return path
}

/**
 * What the converter shows when ffmpeg could not read a video: a file with a video extension that
 * holds no video stream (an audio-only .webm) or no valid data at all (a broken .mp4: `ffmpeg -i`
 * then exits with AVERROR_INVALIDDATA instead of 1) gets the coded "unreadable" error instead of
 * the ffmpeg log. Every other failure (ffmpeg missing, ...) passes through untouched.
 */
export function asVideoReadError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err)
  const unreadable = message.startsWith('Could not read video metadata') || message.startsWith('ffmpeg exited with code')
  return unreadable ? refused('unreadable') : err
}
