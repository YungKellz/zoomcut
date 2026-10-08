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
