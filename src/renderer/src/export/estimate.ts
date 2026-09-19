import type { ExportSettings, Project } from '@shared/types'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, outputSize } from '../engine/compose'
import { keepSegments, outToSrc, outputDuration, segmentAt } from '../engine/timeline'

export interface SizeEstimate {
  bytes: number
  /** average fraction of pixels that change between consecutive frames (0..1) */
  motion: number
}

function seek(video: HTMLVideoElement, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const target = ms / 1000
    if (Math.abs(video.currentTime - target) < 0.0005) {
      resolve()
      return
    }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      resolve()
    }
    video.addEventListener('seeked', finish)
    video.currentTime = target
    window.setTimeout(finish, 1500)
  })
}

function changedFraction(a: ImageData, b: ImageData): number {
  const pa = a.data
  const pb = b.data
  let changed = 0
  const n = pa.length / 4
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
    if (d > 18) changed++
  }
  return n ? changed / n : 0
}

/**
 * Rough output size estimate. It renders a few pairs of consecutive frames at a tiny
 * resolution to measure how much of the picture changes (zoom pans and cursor make
 * everything change), then applies per-format heuristics calibrated on UI recordings.
 * Expect the real file to land within roughly ±50 % of this.
 */
export async function estimateExportSize(
  project: Project,
  settings: ExportSettings,
  followPath: FollowPath | null,
  video: HTMLVideoElement,
  signal?: AbortSignal
): Promise<SizeEstimate> {
  const segments = keepSegments(project.recording.durationMs, project.cuts)
  const outDur = outputDuration(segments)
  const size = outputSize(project, settings.scale)
  const fps = settings.fps
  const frames = Math.max(1, Math.round((outDur / 1000) * fps))
  const px = size.outW * size.outH
  if (outDur <= 0) return { bytes: 0, motion: 0 }

  // tiny render size with the same proportions
  const small = outputSize(project, settings.scale * (200 / size.outW))
  const canvasA = document.createElement('canvas')
  const canvasB = document.createElement('canvas')
  canvasA.width = canvasB.width = small.outW
  canvasA.height = canvasB.height = small.outH
  const ctxA = canvasA.getContext('2d', { willReadFrequently: true })
  const ctxB = canvasB.getContext('2d', { willReadFrequently: true })
  const srcW = project.recording.width
  const srcH = project.recording.height

  const samples: number[] = []
  if (ctxA && ctxB) {
    const count = Math.min(6, Math.max(2, Math.floor(outDur / 1000)))
    const step = 1000 / fps
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) break
      const tOut = (outDur * (i + 0.5)) / count
      const tSrc = outToSrc(tOut, segments)
      const tSrc2 = tSrc + step
      if (segmentAt(tSrc, segments) !== segmentAt(tSrc2, segments)) continue
      await seek(video, tSrc)
      composeFrame(ctxA, video, srcW, srcH, project, tSrc, small, followPath)
      await seek(video, tSrc2)
      composeFrame(ctxB, video, srcW, srcH, project, tSrc2, small, followPath)
      samples.push(changedFraction(ctxA.getImageData(0, 0, small.outW, small.outH), ctxB.getImageData(0, 0, small.outW, small.outH)))
    }
  }
  const motion = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0.5

  let bytes: number
  if (settings.format === 'mp4') {
    const bpp = { max: 0.09, high: 0.06, medium: 0.04, low: 0.025 }[settings.mp4Quality]
    const motionFactor = 0.15 + 0.85 * Math.min(1, motion * 2)
    bytes = (px * fps * bpp * motionFactor * (outDur / 1000)) / 8 + 25_000
  } else {
    const colorFactor = { 256: 1, 128: 0.85, 64: 0.7, 32: 0.55 }[settings.gif.colors]
    const ditherFactor = { none: 1, bayer: 1.6, floyd_steinberg: 2.2, sierra2_4a: 2.1 }[settings.gif.dither]
    const first = px * 0.25 * colorFactor * ditherFactor
    const perFrame = px * Math.max(0.02, Math.min(1, motion * 1.3)) * 0.1 * colorFactor * ditherFactor
    bytes = first + (frames - 1) * perFrame
  }
  return { bytes: Math.round(bytes), motion }
}
