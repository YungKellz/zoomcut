/** Extensions the MP4 → GIF converter accepts (file picker filter and dropped files alike). */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']

/** The lower-case extension of a file name or path, without the dot; '' when there is none. */
export function fileExtension(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Whether a file name (or path) looks like a video file the converter can open. */
export function isVideoFileName(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(fileExtension(name))
}

/**
 * Why main refuses a video file. Main throws an Error whose message is `video-file:<code>`; the
 * renderer recognises it and shows its own translation instead of an English sentence.
 */
export type VideoFileErrorCode = 'not-path' | 'not-video' | 'not-found' | 'not-file' | 'unreadable'

const VIDEO_FILE_ERROR_PREFIX = 'video-file:'
const VIDEO_FILE_ERROR_CODES: readonly string[] = ['not-path', 'not-video', 'not-found', 'not-file', 'unreadable']

/** The Error message main uses for a refused video file. */
export function videoFileErrorMessage(code: VideoFileErrorCode): string {
  return VIDEO_FILE_ERROR_PREFIX + code
}

/** The code inside such a message (text around it, such as Electron's invoke prefix, is ignored); null for other messages. */
export function parseVideoFileError(message: string): VideoFileErrorCode | null {
  const at = message.indexOf(VIDEO_FILE_ERROR_PREFIX)
  if (at < 0) return null
  const code = /^[a-z-]+/.exec(message.slice(at + VIDEO_FILE_ERROR_PREFIX.length))?.[0] ?? ''
  return VIDEO_FILE_ERROR_CODES.includes(code) ? (code as VideoFileErrorCode) : null
}
