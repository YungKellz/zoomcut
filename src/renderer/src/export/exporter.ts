import {
  ALL_FORMATS,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
  type VideoSample
} from 'mediabunny'
import type { AudioExportPlan, ExportFinishResult, ExportSettings, Project } from '@shared/types'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, outputSize, TRANSPARENT_BACKGROUND, type OutputSize } from '../engine/compose'
import { keepSegments, outputDuration, srcToOut, type Segment } from '../engine/timeline'
import { buildAudioPlan } from './audioPlan'
import { centerBox, compositionAudioPlan, compositionLayout, evenPx, fitOutputSize, type CompositionEntry } from '../composition/layout'

export interface RenderProgress {
  phase: 'render' | 'finalize'
  percent: number
  frame?: number
  frames?: number
}

export interface ExportRunOptions {
  project: Project
  settings: ExportSettings
  followPath: FollowPath | null
  onProgress: (p: RenderProgress) => void
  signal: AbortSignal
}

/** Bitrate of the intermediate H.264 file: generous so that the final ffmpeg pass starts from a near-lossless source. */
function intermediateBitrate(width: number, height: number, fps: number): number {
  const bitsPerPixel = 0.32
  return Math.min(80_000_000, Math.max(4_000_000, Math.round(width * height * fps * bitsPerPixel)))
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data.buffer
  }
  return data.slice().buffer as ArrayBuffer
}

type FrameHandler = (frame: VideoFrame, tSrc: number, tOut: number, index: number) => Promise<void>

/**
 * Walks the kept segments in order, decodes sequentially and calls `onFrame` once per
 * output frame with the source frame displayed at that moment. `outOffset` places this
 * recording's output timeline inside a longer one (a composition); frame indexes and `tOut`
 * are global.
 */
async function walkOutputFrames(
  sink: VideoSampleSink,
  segments: Segment[],
  fps: number,
  totalFrames: number,
  outOffset: number,
  signal: AbortSignal,
  onFrame: FrameHandler
): Promise<void> {
  const frameDur = 1000 / fps
  for (const seg of segments) {
    const iterator = sink.samples(seg.start / 1000, seg.end / 1000)
    let current: VideoSample | null = null
    let next = await iterator.next()
    const segOutStart = outOffset + srcToOut(seg.start, segments)
    const segOutEnd = segOutStart + (seg.end - seg.start)
    const firstFrame = Math.ceil(segOutStart / frameDur - 1e-6)
    try {
      for (let f = firstFrame; f * frameDur < segOutEnd - 1e-6 && f < totalFrames; f++) {
        if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
        const tOut = f * frameDur
        const tSrc = seg.start + (tOut - segOutStart)
        while (!next.done && next.value.timestamp * 1000 <= tSrc + 0.5) {
          current?.close()
          current = next.value
          next = await iterator.next()
        }
        if (!current) {
          if (next.done) break
          current = next.value
          next = await iterator.next()
        }
        const frame = current.toVideoFrame()
        try {
          await onFrame(frame, tSrc, tOut, f)
        } finally {
          frame.close()
        }
      }
    } finally {
      current?.close()
      if (!next.done) {
        next.value.close()
        await iterator.return(undefined)
      }
    }
  }
}

/** One recording on the output timeline. */
interface RenderPart {
  project: Project
  segments: Segment[]
  /** output time (ms) at which this recording starts */
  outOffset: number
  /** paints the output frame for source time `tSrc` onto the export canvas */
  draw(ctx: CanvasRenderingContext2D, frame: VideoFrame, tSrc: number): void
}

interface EncodeOptions {
  parts: RenderPart[]
  width: number
  height: number
  totalOutMs: number
  settings: ExportSettings
  alpha: boolean
  audio: AudioExportPlan | undefined
  onProgress: (p: RenderProgress) => void
  signal: AbortSignal
}

/**
 * Renders the parts frame by frame into an intermediate file that is streamed to the
 * main process, which then runs ffmpeg for the final MP4 or GIF. Two intermediate paths:
 * WebCodecs H.264 via Mediabunny (fast), or raw RGBA frames into a lossless ffv1 file
 * (used for transparent GIF backgrounds and when no WebCodecs encoder is available).
 */
async function encodeParts({ parts, width, height, totalOutMs, settings, alpha, audio, onProgress, signal }: EncodeOptions): Promise<ExportFinishResult> {
  const fps = settings.fps
  const frameDur = 1000 / fps
  const totalFrames = Math.max(1, Math.round(totalOutMs / frameDur))
  let begun: { exportId: string } | null = null
  let output: Output | null = null
  let input: Input | null = null

  try {
    const codec = alpha ? null : await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height })
    const useRaw = alpha || !codec

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: useRaw, willReadFrequently: useRaw })
    if (!ctx) throw new Error('Could not create a 2D canvas context.')
    const report = (index: number): void => {
      if ((index + 1) % 4 === 0 || index + 1 === totalFrames) {
        onProgress({ phase: 'render', percent: ((index + 1) / totalFrames) * 100, frame: index + 1, frames: totalFrames })
      }
    }

    begun = await window.zc.export.begin({
      fileName: settings.fileName,
      folder: settings.folder,
      format: settings.format,
      raw: useRaw ? { width, height, fps } : undefined
    })
    const exportId = begun.exportId
    // cancelling while ffmpeg runs in the main process has to kill it there
    signal.addEventListener('abort', () => void window.zc.export.cancel(exportId).catch(() => undefined))

    let source: CanvasSource | null = null
    if (!useRaw) {
      const writable = new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          await window.zc.export.write(exportId, chunk.position, toArrayBuffer(chunk.data))
        }
      })
      output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 2 ** 20 })
      })
      source = new CanvasSource(canvas, {
        codec: codec!,
        bitrate: intermediateBitrate(width, height, fps),
        latencyMode: 'quality',
        keyFrameInterval: 2
      })
      output.addVideoTrack(source, { frameRate: fps })
      await output.start()
    }

    for (const part of parts) {
      input = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(window.zc.media.url(part.project.recording.videoPath))
      })
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error(`The recording has no video track: ${part.project.name}`)
      if (!(await track.canDecode())) throw new Error(`This recording cannot be decoded with WebCodecs: ${part.project.name}`)
      const sink = new VideoSampleSink(track)
      await walkOutputFrames(sink, part.segments, fps, totalFrames, part.outOffset, signal, async (frame, tSrc, tOut, index) => {
        part.draw(ctx, frame, tSrc)
        if (source) {
          await source.add(tOut / 1000, frameDur / 1000)
        } else {
          const pixels = ctx.getImageData(0, 0, width, height)
          await window.zc.export.writeRaw(exportId, pixels.data.buffer as ArrayBuffer)
        }
        report(index)
      })
      input.dispose()
      input = null
    }

    if (source && output) {
      source.close()
      await output.finalize()
      output = null
    }

    onProgress({ phase: 'finalize', percent: 0 })
    return await window.zc.export.finish(exportId, settings, { durationMs: totalOutMs, alpha, audio })
  } catch (err) {
    if (output) await output.cancel().catch(() => undefined)
    input?.dispose()
    if (begun) await window.zc.export.cancel(begun.exportId).catch(() => undefined)
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
    throw err
  }
}

/** Exports one project with all its edits. */
export async function runExport({ project, settings, followPath, onProgress, signal }: ExportRunOptions): Promise<ExportFinishResult> {
  const segments = keepSegments(project.recording.durationMs, project.cuts)
  const outDurationMs = outputDuration(segments)
  if (outDurationMs <= 0) throw new Error('Nothing to export: the whole recording is cut out.')

  const size: OutputSize = outputSize(project, settings.scale)
  const alpha = settings.format === 'gif' && project.frame.background === TRANSPARENT_BACKGROUND
  const srcW = project.recording.width
  const srcH = project.recording.height
  return encodeParts({
    parts: [
      {
        project,
        segments,
        outOffset: 0,
        draw: (ctx, frame, tSrc) => composeFrame(ctx, frame, srcW, srcH, project, tSrc, size, followPath)
      }
    ],
    width: size.outW,
    height: size.outH,
    totalOutMs: outDurationMs,
    settings,
    alpha,
    // GIF ignores this (finalizeMp4 is the only consumer); harmless to always compute
    audio: buildAudioPlan(project, segments) ?? undefined,
    onProgress,
    signal
  })
}

// ---- composition ----
export interface CompositionExportOptions {
  entries: CompositionEntry[]
  frame: { width: number; height: number }
  background: string
  settings: ExportSettings
  onProgress: (p: RenderProgress) => void
  signal: AbortSignal
}

/**
 * Exports a composition: every recording is rendered with its own edits (composeFrame),
 * fitted into the composition frame over its background, one after another; the audio plans
 * are concatenated on the same output timeline.
 */
export async function runCompositionExport({ entries, frame, background, settings, onProgress, signal }: CompositionExportOptions): Promise<ExportFinishResult> {
  const layout = compositionLayout(entries)
  if (layout.totalMs <= 0) throw new Error('Nothing to export: the composition is empty.')
  const width = evenPx(frame.width * settings.scale)
  const height = evenPx(frame.height * settings.scale)

  const parts: RenderPart[] = layout.spans.map(({ entry, outOffset }) => {
    const p = entry.project
    const size = fitOutputSize(p, width, height)
    const box = centerBox(size.outW, size.outH, width, height)
    const itemCanvas = document.createElement('canvas')
    itemCanvas.width = size.outW
    itemCanvas.height = size.outH
    const itemCtx = itemCanvas.getContext('2d')
    if (!itemCtx) throw new Error('Could not create a 2D canvas context.')
    return {
      project: p,
      segments: entry.segments,
      outOffset,
      draw: (ctx, videoFrame, tSrc) => {
        composeFrame(itemCtx, videoFrame, p.recording.width, p.recording.height, p, tSrc, size, entry.followPath)
        ctx.fillStyle = background
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(itemCanvas, box.x, box.y)
      }
    }
  })

  return encodeParts({
    parts,
    width,
    height,
    totalOutMs: layout.totalMs,
    settings,
    alpha: false,
    audio: compositionAudioPlan(layout) ?? undefined,
    onProgress,
    signal
  })
}
