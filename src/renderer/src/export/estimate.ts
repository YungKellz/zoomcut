import type { ExportSettings, Project } from '@shared/types'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, outputSize } from '../engine/compose'
import { keepSegments, outToSrc, outputDuration, segmentAt } from '../engine/timeline'
import { seekVideo as seek } from '../util/video'

export interface SizeEstimate {
  bytes: number
  /** average fraction of pixels that change between consecutive frames (0..1) */
  motion: number
  /** how "busy" the picture is: fraction of pixels that differ from their left neighbour (0..1) */
  detail: number
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

function detailFraction(img: ImageData): number {
  const p = img.data
  const w = img.width
  let edges = 0
  let n = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4
      const j = i - 4
      const d = Math.abs(p[i] - p[j]) + Math.abs(p[i + 1] - p[j + 1]) + Math.abs(p[i + 2] - p[j + 2])
      if (d > 24) edges++
      n++
    }
  }
  return n ? edges / n : 0
}

/**
 * Rough output size estimate. It renders a few pairs of consecutive frames at a tiny
 * resolution to measure how much of the picture changes (zoom pans and the cursor make
 * everything move) and how busy it is (flat UI compresses far better than photos or
 * games), then applies per-format heuristics calibrated on screen recordings.
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
  if (outDur <= 0) return { bytes: 0, motion: 0, detail: 0 }

  // tiny render size with the same proportions
  const small = outputSize(project, settings.scale * (240 / size.outW))
  const canvasA = document.createElement('canvas')
  const canvasB = document.createElement('canvas')
  canvasA.width = canvasB.width = small.outW
  canvasA.height = canvasB.height = small.outH
  const ctxA = canvasA.getContext('2d', { willReadFrequently: true })
  const ctxB = canvasB.getContext('2d', { willReadFrequently: true })
  const srcW = project.recording.width
  const srcH = project.recording.height

  const motionSamples: number[] = []
  const detailSamples: number[] = []
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
      const a = ctxA.getImageData(0, 0, small.outW, small.outH)
      detailSamples.push(detailFraction(a))
      await seek(video, tSrc2)
      composeFrame(ctxB, video, srcW, srcH, project, tSrc2, small, followPath)
      motionSamples.push(changedFraction(a, ctxB.getImageData(0, 0, small.outW, small.outH)))
    }
  }
  const avg = (xs: number[], fallback: number): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : fallback)
  const motion = avg(motionSamples, 0.5)
  const detail = avg(detailSamples, 0.2)

  let bytes: number
  if (settings.format === 'mp4') {
    const q = { max: 0.09, high: 0.06, medium: 0.04, low: 0.025 }[settings.mp4Quality]
    const bpp = q * (0.6 + 1.2 * detail)
    const motionFactor = 0.15 + 0.85 * Math.min(1, motion * 2)
    bytes = (px * fps * bpp * motionFactor * (outDur / 1000)) / 8 + 25_000
  } else {
    const colorFactor = { 256: 1, 128: 0.85, 64: 0.7, 32: 0.55 }[settings.gif.colors]
    const ditherFactor = { none: 1, bayer: 1.6, floyd_steinberg: 2.2, sierra2_4a: 2.1 }[settings.gif.dither]
    // transparent frames lose ffmpeg's transparency-based frame differencing: measured 6–20× bigger
    const alphaFactor = project.frame.background === 'transparent' ? 8 : 1
    const bppFull = 0.14 + 0.55 * detail
    const first = px * (0.25 + 0.5 * detail) * colorFactor * ditherFactor
    const perFrame = px * Math.max(0.03, Math.min(1, motion * 1.3)) * bppFull * colorFactor * ditherFactor * alphaFactor
    bytes = first + (frames - 1) * perFrame
  }
  return { bytes: Math.round(bytes), motion, detail }
}
