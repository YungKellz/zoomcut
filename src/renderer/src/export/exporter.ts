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
import type { ExportFinishResult, ExportSettings, Project } from '@shared/types'
import type { FollowPath } from '../engine/cursor'
import { composeFrame, outputSize } from '../engine/compose'
import { keepSegments, outputDuration, srcToOut } from '../engine/timeline'

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

/**
 * Renders the project frame by frame into an intermediate MP4 (WebCodecs via Mediabunny),
 * streaming it to the main process, which then runs ffmpeg for the final MP4 or GIF.
 */
export async function runExport({ project, settings, followPath, onProgress, signal }: ExportRunOptions): Promise<ExportFinishResult> {
  const segments = keepSegments(project.recording.durationMs, project.cuts)
  const outDurationMs = outputDuration(segments)
  if (outDurationMs <= 0) throw new Error('Nothing to export: the whole recording is cut out.')

  const size = outputSize(project, settings.scale)
  const fps = settings.fps
  const frameDur = 1000 / fps
  const totalFrames = Math.max(1, Math.round(outDurationMs / frameDur))

  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(window.zc.media.url(project.recording.videoPath))
  })
  let begun: { exportId: string } | null = null
  let output: Output | null = null

  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The recording has no video track.')
    if (!(await track.canDecode())) throw new Error('This recording cannot be decoded with WebCodecs.')
    const sink = new VideoSampleSink(track)

    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], {
      width: size.outW,
      height: size.outH
    })
    if (!codec) throw new Error('No WebCodecs video encoder is available on this system.')

    begun = await window.zc.export.begin({ fileName: settings.fileName, folder: settings.folder, format: settings.format })
    const exportId = begun.exportId
    const writable = new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        await window.zc.export.write(exportId, chunk.position, toArrayBuffer(chunk.data))
      }
    })
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 2 ** 20 })
    })

    const canvas = document.createElement('canvas')
    canvas.width = size.outW
    canvas.height = size.outH
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create a 2D canvas context.')

    const source = new CanvasSource(canvas, {
      codec,
      bitrate: intermediateBitrate(size.outW, size.outH, fps),
      latencyMode: 'quality',
      keyFrameInterval: 2
    })
    output.addVideoTrack(source, { frameRate: fps })
    await output.start()

    const srcW = project.recording.width
    const srcH = project.recording.height
    let frameIndex = 0

    for (const seg of segments) {
      const iterator = sink.samples(seg.start / 1000, seg.end / 1000)
      let current: VideoSample | null = null
      let next = await iterator.next()
      const segOutStart = srcToOut(seg.start, segments)
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
            composeFrame(ctx, frame, srcW, srcH, project, tSrc, size, followPath)
          } finally {
            frame.close()
          }
          await source.add(tOut / 1000, frameDur / 1000)
          frameIndex++
          if (frameIndex % 4 === 0 || frameIndex === totalFrames) {
            onProgress({ phase: 'render', percent: (frameIndex / totalFrames) * 100, frame: frameIndex, frames: totalFrames })
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

    source.close()
    await output.finalize()
    output = null
    input.dispose()

    onProgress({ phase: 'finalize', percent: 0 })
    return await window.zc.export.finish(exportId, settings, { durationMs: outDurationMs })
  } catch (err) {
    if (output) await output.cancel().catch(() => undefined)
    input.dispose()
    if (begun) await window.zc.export.cancel(begun.exportId).catch(() => undefined)
    throw err
  }
}
