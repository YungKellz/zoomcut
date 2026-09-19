import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { GifSettings, Mp4Quality } from '@shared/types'
import { MP4_CRF } from '@shared/defaults'

export function ffmpegPath(): string | null {
  let p = ffmpegStatic as unknown as string | null
  if (!p) return null
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked')
  return existsSync(p) ? p : null
}

export interface SpawnOptions {
  args: string[]
  /** used to turn ffmpeg's `time=` output into a percentage */
  durationMs?: number
  onProgress?: (percent: number) => void
  signal?: AbortSignal
  /** exit codes to treat as success (ffmpeg -i without output exits with 1) */
  okCodes?: number[]
  /** keep stdin open so the caller can pipe raw frames into ffmpeg */
  stdin?: boolean
}

export interface RunResult {
  code: number
  stderr: string
}

export interface FfmpegProcess {
  proc: ChildProcess
  done: Promise<RunResult>
}

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g

export function spawnFfmpeg({ args, durationMs, onProgress, signal, okCodes = [0], stdin = false }: SpawnOptions): FfmpegProcess {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg binary not found (ffmpeg-static)')
  const proc = spawn(bin, ['-hide_banner', '-y', ...(stdin ? [] : ['-nostdin']), ...args], {
    windowsHide: true,
    stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe']
  })
  proc.stdin?.on('error', () => undefined)
  const done = new Promise<RunResult>((resolve, reject) => {
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 60_000) stderr = stderr.slice(-30_000)
      if (durationMs && onProgress) {
        let last: RegExpExecArray | null = null
        let m: RegExpExecArray | null
        TIME_RE.lastIndex = 0
        while ((m = TIME_RE.exec(text))) last = m
        if (last) {
          const ms = (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000
          onProgress(Math.max(0, Math.min(100, (ms / durationMs) * 100)))
        }
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      const c = code ?? -1
      if (okCodes.includes(c)) resolve({ code: c, stderr })
      else reject(new Error(`ffmpeg exited with code ${c}\n${stderr.slice(-3000)}`))
    })
    signal?.addEventListener('abort', () => {
      proc.kill('SIGKILL')
    })
  })
  return { proc, done }
}

export function runFfmpeg(options: SpawnOptions): Promise<RunResult> {
  try {
    return spawnFfmpeg(options).done
  } catch (err) {
    return Promise.reject(err)
  }
}

export interface ProbeResult {
  width: number
  height: number
  durationMs: number
  fps: number
}

/** Reads dimensions / duration / fps from `ffmpeg -i` metadata output. */
export async function probeVideo(path: string): Promise<ProbeResult> {
  const { stderr } = await runFfmpeg({ args: ['-i', path], okCodes: [0, 1] })
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const dims = /Video:.*?\s(\d{2,5})x(\d{2,5})[,\s]/.exec(stderr)
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  if (!dur || !dims) throw new Error('Could not read video metadata:\n' + stderr.slice(-1500))
  return {
    width: Number(dims[1]),
    height: Number(dims[2]),
    durationMs: Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000),
    fps: fps ? Number(fps[1]) : 30
  }
}

/**
 * Turns a MediaRecorder file (WebM/VP9 or fragmented MP4, variable frame rate, no cues)
 * into a constant-frame-rate, seekable H.264 MP4 that the editor can scrub quickly.
 * Timestamps are rebased so that the first recorded frame sits at t=0 – the cursor
 * data is anchored on the same frame.
 */
export async function transcodeRecording(
  input: string,
  output: string,
  fps: number,
  durationMs: number | undefined,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const safeFps = Math.min(60, Math.max(10, Math.round(fps || 30)))
  await runFfmpeg({
    args: [
      '-i', input,
      '-an',
      '-vf', 'setpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '17',
      '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr',
      '-r', String(safeFps),
      '-movflags', '+faststart',
      output
    ],
    durationMs,
    onProgress,
    signal
  })
}

/** ffmpeg process that turns raw RGBA frames on stdin into a lossless intermediate with alpha. */
export function startRawIntermediate(output: string, width: number, height: number, fps: number, signal?: AbortSignal): FfmpegProcess {
  return spawnFfmpeg({
    args: [
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', '-',
      '-c:v', 'ffv1',
      '-level', '3',
      '-pix_fmt', 'bgra',
      output
    ],
    stdin: true,
    signal
  })
}

export async function finalizeMp4(
  input: string,
  output: string,
  quality: Mp4Quality,
  durationMs: number,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await runFfmpeg({
    args: [
      '-i', input,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(MP4_CRF[quality]),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      output
    ],
    durationMs,
    onProgress,
    signal
  })
}

function ditherExpression(gif: GifSettings): string {
  switch (gif.dither) {
    case 'none':
      return 'none'
    case 'bayer':
      return `bayer:bayer_scale=${Math.max(0, Math.min(5, Math.round(gif.bayerScale)))}`
    case 'floyd_steinberg':
      return 'floyd_steinberg'
    case 'sierra2_4a':
      return 'sierra2_4a'
  }
}

/**
 * Two-pass GIF encode: palettegen → paletteuse. The intermediate already has the
 * final size and frame rate, so ffmpeg only has to quantize. `perframe` builds a
 * palette per frame (best for colour-changing content, biggest files); `diff` weighs
 * pixels that change between frames (best for UI recordings); `global` is a single
 * palette computed over every pixel of every frame. With `alpha` one palette entry is
 * reserved for transparency (transparent frame background).
 */
export async function encodeGif(
  input: string,
  palettePath: string,
  output: string,
  gif: GifSettings,
  alpha: boolean,
  durationMs: number,
  onProgress: (phase: 'palette' | 'quantize', percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const statsMode = gif.paletteMode === 'global' ? 'full' : gif.paletteMode === 'diff' ? 'diff' : 'single'
  const perFrame = gif.paletteMode === 'perframe'

  await runFfmpeg({
    args: [
      '-i', input,
      '-vf', `palettegen=max_colors=${gif.colors}:stats_mode=${statsMode}:reserve_transparent=${alpha ? 1 : 0}`,
      ...(perFrame ? ['-c:v', 'rawvideo', '-f', 'nut'] : ['-frames:v', '1']),
      palettePath
    ],
    durationMs,
    onProgress: (p) => onProgress('palette', p),
    signal
  })

  const paletteuse =
    `paletteuse=dither=${ditherExpression(gif)}:diff_mode=rectangle` +
    (perFrame ? ':new=1' : '') +
    (alpha ? ':alpha_threshold=128' : '')
  await runFfmpeg({
    args: [
      '-i', input,
      '-i', palettePath,
      '-lavfi', `[0:v][1:v]${paletteuse}`,
      '-loop', gif.loop ? '0' : '-1',
      output
    ],
    durationMs,
    onProgress: (p) => onProgress('quantize', p),
    signal
  })
}
