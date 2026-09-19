import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { seekVideo, waitForMetadata } from '../util/video'

export interface Thumbnail {
  /** source time (ms) at the middle of the span this thumbnail represents */
  t: number
  url: string
}

export const THUMB_HEIGHT = 36

const cache = new Map<string, { stepMs: number; thumbs: Thumbnail[] }>()

/**
 * Small JPEG thumbnails of the cropped source along the video for the filmstrip on
 * the video track. Generated in the background (debounced while the crop is being
 * edited) and cached per recording + crop for the session.
 */
export function useThumbnails(project: Project): { stepMs: number; thumbs: Thumbnail[] } {
  const videoPath = project.recording.videoPath
  const duration = project.recording.durationMs
  const crop = project.crop
  const stepMs = Math.max(500, Math.ceil(duration / 150 / 100) * 100)
  const key = `${videoPath}|${crop.x.toFixed(3)}|${crop.y.toFixed(3)}|${crop.w.toFixed(3)}|${crop.h.toFixed(3)}`
  const [thumbs, setThumbs] = useState<Thumbnail[]>(() => cache.get(key)?.thumbs ?? [])

  useEffect(() => {
    const cached = cache.get(key)
    if (cached) {
      setThumbs(cached.thumbs)
      return
    }
    let cancelled = false
    const srcW = project.recording.width
    const srcH = project.recording.height
    const h = THUMB_HEIGHT * 2
    const w = Math.max(24, Math.round((h * (crop.w * srcW)) / Math.max(1, crop.h * srcH)))

    const timer = window.setTimeout(() => {
      const video = document.createElement('video')
      video.muted = true
      video.crossOrigin = 'anonymous'
      video.preload = 'auto'
      video.src = window.zc.media.url(videoPath)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')

      const run = async (): Promise<void> => {
        await waitForMetadata(video)
        const out: Thumbnail[] = []
        for (let t = stepMs / 2; t < duration && !cancelled; t += stepMs) {
          await seekVideo(video, t)
          if (cancelled || !ctx) break
          ctx.drawImage(video, crop.x * srcW, crop.y * srcH, crop.w * srcW, crop.h * srcH, 0, 0, w, h)
          out.push({ t, url: canvas.toDataURL('image/jpeg', 0.6) })
          if (out.length % 6 === 0) setThumbs([...out])
        }
        if (!cancelled) {
          cache.set(key, { stepMs, thumbs: out })
          setThumbs(out)
        }
        video.removeAttribute('src')
        video.load()
      }
      void run().catch((err) => console.warn('thumbnails failed', err))
    }, 500)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, videoPath, duration, stepMs, crop.x, crop.y, crop.w, crop.h, project.recording.width, project.recording.height])

  return { stepMs, thumbs }
}
