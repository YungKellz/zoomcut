import { isVideoFileName, parseVideoFileError, type VideoFileErrorCode } from '@shared/videoFiles'
import type { TKey, Translate } from '../i18n'

/** True when a drag carries files (as opposed to selected text or a dragged page element). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files')
}

/**
 * The file to convert out of everything that was dropped: the first video, otherwise the first
 * file (which then gets the "not a video" message instead of being silently ignored).
 */
export function pickDroppedFile<T extends { name: string }>(files: ArrayLike<T> | null | undefined): T | undefined {
  const list = files ? Array.from(files) : []
  return list.find((f) => isVideoFileName(f.name)) ?? list[0]
}

/** The message of an error that came through ipcRenderer.invoke, without Electron's "Error invoking remote method" prefix. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const VIDEO_ERROR_KEYS: Record<VideoFileErrorCode, TKey> = {
  'not-path': 'converter.dropNoPath',
  'not-video': 'converter.dropNotVideo',
  'not-found': 'converter.dropNotFound',
  'not-file': 'converter.dropNotFile',
  unreadable: 'converter.dropUnreadable'
}

/** The first line of an error message, with the dangling colon of a "reason:" + log message trimmed. */
function firstLine(message: string): string {
  const line = message.split(/\r?\n/)[0] ?? ''
  return line.replace(/[: ]+$/, '')
}

/**
 * What the converter card and dialog say when picking or probing a video failed: the reasons main
 * knows (`video-file:<code>`) are translated, anything else is shown as "could not open: <first line>".
 */
export function videoErrorText(err: unknown, t: Translate): string {
  const message = ipcErrorMessage(err)
  const code = parseVideoFileError(message)
  if (code) return t(VIDEO_ERROR_KEYS[code])
  return t('converter.dropFailed', { error: firstLine(message) })
}
