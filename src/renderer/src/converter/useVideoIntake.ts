import type { DragEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VideoFileInfo } from '@shared/types'
import { isVideoFileName } from '@shared/videoFiles'
import { useT } from '../i18n'
import { dragHasFiles, pickDroppedFile, videoErrorText } from './intake'

interface Options {
  /** false while something else owns the screen (recording, an open converter): drops are swallowed, not used */
  enabled: boolean
  onVideo(video: VideoFileInfo): void
}

export interface VideoIntake {
  /** a file is being dragged over the window */
  dragging: boolean
  /** the picker is open or a file is being read: no second one is started meanwhile */
  busy: boolean
  /** a dropped file is being probed (the picker has its own native dialog, the card shows nothing for it) */
  probing: boolean
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
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dragenter/dragleave also fire for every child element: count them instead of toggling
  const depth = useRef(0)
  // the probe is asynchronous: what matters is the state when it ends, not when it started
  const enabledRef = useRef(enabled)
  const busyRef = useRef(false)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  const load = useCallback(
    async (get: () => Promise<VideoFileInfo | null>, probe: boolean): Promise<void> => {
      // one file at a time: a second drop while the first is read would replace it with the older one
      if (busyRef.current) return
      busyRef.current = true
      setError(null)
      setBusy(true)
      setProbing(probe)
      try {
        const info = await get()
        // a recording may have started (or the dialog opened) while the file was being read
        if (info && enabledRef.current) onVideo(info)
      } catch (err) {
        setError(videoErrorText(err, t))
      } finally {
        busyRef.current = false
        setBusy(false)
        setProbing(false)
      }
    },
    [onVideo, t]
  )

  const choose = useCallback(() => load(() => window.zc.converter.chooseVideo(), false), [load])

  const accept = useCallback(
    async (files: FileList): Promise<void> => {
      if (busyRef.current) return
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
      await load(() => window.zc.converter.probe(path), true)
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

  return { dragging: dragging && enabled, busy, probing, error, clearError: () => setError(null), choose, dropProps }
}
