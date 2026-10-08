import type { DragEvent } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { VideoFileInfo } from '@shared/types'
import { isVideoFileName } from '@shared/videoFiles'
import { useT } from '../i18n'
import { dragHasFiles, ipcErrorMessage, pickDroppedFile } from './intake'

interface Options {
  /** false while something else owns the screen (recording, an open converter): drops are swallowed, not used */
  enabled: boolean
  onVideo(video: VideoFileInfo): void
}

export interface VideoIntake {
  /** a file is being dragged over the window */
  dragging: boolean
  /** a picked or dropped file is being probed */
  busy: boolean
  error: string | null
  clearError(): void
  /** native file picker, then onVideo */
  choose(): Promise<void>
  /** spread onto the element that should accept drops (the whole Home screen) */
  dropProps: {
    onDragEnter(e: DragEvent): void
    onDragOver(e: DragEvent): void
    onDragLeave(e: DragEvent): void
    onDrop(e: DragEvent): void
  }
}

/**
 * Gets a video into the MP4 → GIF converter: through the picker or by dropping a file anywhere on
 * the element carrying `dropProps`. Every file drag is cancelled (preventDefault), otherwise
 * Electron would navigate the window to the dropped file.
 */
export function useVideoIntake({ enabled, onVideo }: Options): VideoIntake {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dragenter/dragleave also fire for every child element: count them instead of toggling
  const depth = useRef(0)

  const load = useCallback(
    async (get: () => Promise<VideoFileInfo | null>): Promise<void> => {
      setError(null)
      setBusy(true)
      try {
        const info = await get()
        if (info) onVideo(info)
      } catch (err) {
        // the card only has room for the first line (ffmpeg errors carry a long log after it)
        setError(t('converter.dropFailed', { error: ipcErrorMessage(err).split('\n')[0] }))
      } finally {
        setBusy(false)
      }
    },
    [onVideo, t]
  )

  const choose = useCallback(() => load(() => window.zc.converter.chooseVideo()), [load])

  const accept = useCallback(
    async (files: FileList): Promise<void> => {
      const file = pickDroppedFile(files)
      if (!file) return
      if (!isVideoFileName(file.name)) {
        setError(t('converter.dropNotVideo'))
        return
      }
      let path = ''
      try {
        path = window.zc.converter.pathForFile(file)
      } catch {
        // not a file from disk: handled like an empty path
      }
      if (!path) {
        setError(t('converter.dropNoPath'))
        return
      }
      await load(() => window.zc.converter.probe(path))
    },
    [load, t]
  )

  const dropProps: VideoIntake['dropProps'] = {
    onDragEnter: (e) => {
      if (!dragHasFiles(e.dataTransfer.types)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    },
    onDragOver: (e) => {
      if (!dragHasFiles(e.dataTransfer.types)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
    },
    onDragLeave: (e) => {
      if (!dragHasFiles(e.dataTransfer.types)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    },
    onDrop: (e) => {
      if (!dragHasFiles(e.dataTransfer.types)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      if (enabled) void accept(e.dataTransfer.files)
    }
  }

  return { dragging: dragging && enabled, busy, error, clearError: () => setError(null), choose, dropProps }
}
