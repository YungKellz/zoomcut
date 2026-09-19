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
 * Small JPEG thumbnails along the source video for the filmstrip on the video track.
 * Generated once per recording in the background and cached for the session.
 */
export function useThumbnails(project: Project): { stepMs: number; thumbs: Thumbnail[] } {
  const key = project.recording.videoPath
  const duration = project.recording.durationMs
  const stepMs = Math.max(500, Math.ceil(duration / 150 / 100) * 100)
  const [thumbs, setThumbs] = useState<Thumbnail[]>(() => cache.get(key)?.thumbs ?? [])

  useEffect(() => {
    const cached = cache.get(key)
    if (cached) {
      setThumbs(cached.thumbs)
      return
    }
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.src = window.zc.media.url(key)
    const h = THUMB_HEIGHT * 2
    const w = Math.max(24, Math.round((h * project.recording.width) / project.recording.height))
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
        ctx.drawImage(video, 0, 0, w, h)
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
    return () => {
      cancelled = true
    }
  }, [key, duration, stepMs, project.recording.width, project.recording.height])

  return { stepMs, thumbs }
}
