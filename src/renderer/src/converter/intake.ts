import { isVideoFileName } from '@shared/videoFiles'

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
