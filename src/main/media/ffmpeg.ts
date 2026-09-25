import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { AudioExportPlan, GifSettings, Mp4Quality } from '@shared/types'
import { MP4_CRF } from '@shared/defaults'
import { buildAudioFilterComplex } from './audioGraph'

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

export interface AudioProbeResult {
  durationMs: number
}

/** Reads the duration from `ffmpeg -i` metadata output (no video stream expected). */
export async function probeAudio(path: string): Promise<AudioProbeResult> {
  const { stderr } = await runFfmpeg({ args: ['-i', path], okCodes: [0, 1] })
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!dur) throw new Error('Could not read audio metadata:\n' + stderr.slice(-1500))
  return { durationMs: Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) }
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
      // a keyframe every 30 frames keeps seeks (scrubbing, jumping over cuts) fast
      '-g', '30',
      '-keyint_min', '30',
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

/**
 * Converts a raw opus/webm recording (mic or system loopback) into the AAC 48 kHz stereo
 * .m4a that AudioClip.file always points at. `durationMs` is an estimate (the recording's
 * own wall-clock length) used only to turn ffmpeg's `time=` output into a percentage.
 */
export async function convertAudio(
  input: string,
  output: string,
  durationMs?: number,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await runFfmpeg({
    args: ['-i', input, '-vn', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', output],
    durationMs,
    onProgress,
    signal
  })
}

/** Minimal shape `rawAudioInputArgs`/`convertRawAudio` need from a captured raw-audio format;
 * `LoopbackFormat` (src/main/audio/loopback.ts) satisfies this structurally. */
export interface RawAudioFormat {
  isFloat: boolean
  rate: number
  channels: number
  /** dwChannelMask from WAVEFORMATEXTENSIBLE, 0 when unknown. Only the masks in
   * CHANNEL_LAYOUT_BY_MASK are given an explicit -channel_layout; anything else is left for
   * ffmpeg to infer from the channel count alone (its usual behaviour without this field). */
  channelMask?: number
}

/** Windows channel masks (WAVEFORMATEXTENSIBLE dwChannelMask) that map to an unambiguous ffmpeg
 * channel layout name. Raw PCM/float carries no layout metadata of its own, so without this
 * ffmpeg would guess a default layout from the channel count alone, which is not guaranteed to
 * match the endpoint's actual speaker mapping. */
const CHANNEL_LAYOUT_BY_MASK: Record<number, string> = {
  0x3: 'stereo',
  0x3f: '5.1',
  0x63f: '7.1',
  0xff: '7.1(wide)'
}

/** Pure "format -> ffmpeg input args" mapping, kept separate so it can be unit-tested without
 * spawning ffmpeg (src/main/media/ffmpeg.test.ts). */
export function rawAudioInputArgs(format: RawAudioFormat): string[] {
  const args = ['-f', format.isFloat ? 'f32le' : 's16le', '-ar', String(format.rate), '-ac', String(format.channels)]
  const layout = format.channelMask ? CHANNEL_LAYOUT_BY_MASK[format.channelMask] : undefined
  if (layout) args.push('-channel_layout', layout)
  return args
}

/**
 * Converts a raw interleaved capture from the system-audio loopback helper (audio/loopback.ts) -
 * float32 or int16, any channel count - into the AAC 48 kHz stereo .m4a that AudioClip.file
 * always points at. ffmpeg's own default downmix collapses a surround-configured playback
 * device's 6/8 channels to stereo. That downmix is only level-accurate when it runs in float:
 * libswresample normalizes its channel-mix matrix for float samples but not for s16 - feeding it
 * an s16 intermediate for a 7.1 source measured about 9.9 dB quieter output in testing. Keep the
 * input format as f32le for any float capture (already the common case: `isFloat` mirrors
 * whatever the endpoint's own mix format is) rather than "simplifying" this to a fixed s16 input.
 */
export async function convertRawAudio(
  input: string,
  output: string,
  format: RawAudioFormat,
  durationMs?: number,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await runFfmpeg({
    args: [...rawAudioInputArgs(format), '-i', input, '-vn', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', output],
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
  signal?: AbortSignal,
  audio?: AudioExportPlan
): Promise<void> {
  const videoArgs = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(MP4_CRF[quality]), '-pix_fmt', 'yuv420p']
  // a clip can be deleted from disk between the renderer building the plan and this running;
  // drop it rather than failing the whole export (see also RecordingController.finishAudio,
  // which is the only place these files are ever written)
  const tracks = (audio?.tracks ?? []).filter((t) => {
    if (t.pieces.length === 0) return false
    if (!existsSync(t.path)) {
      console.warn(`[export] audio track file is missing, dropping it: ${t.path}`)
      return false
    }
    return true
  })
  if (tracks.length === 0) {
    await runFfmpeg({
      args: ['-i', input, '-an', ...videoArgs, '-movflags', '+faststart', output],
      durationMs,
      onProgress,
      signal
    })
    return
  }
  const graph = buildAudioFilterComplex({ tracks, outDurationMs: audio!.outDurationMs })
  const args: string[] = ['-i', input]
  for (const path of graph.inputs) args.push('-i', path)
  args.push(
    '-filter_complex', graph.filterComplex,
    '-map', '0:v',
    '-map', graph.outLabel,
    ...videoArgs,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    output
  )
  await runFfmpeg({ args, durationMs, onProgress, signal })
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
export interface GifSourceOptions {
  /** input options placed before `-i` (e.g. a trim) */
  inputArgs?: string[]
  /** filters applied to the input before palettegen/paletteuse (e.g. fps + scale) */
  prefilter?: string
}

export async function encodeGif(
  input: string,
  palettePath: string,
  output: string,
  gif: GifSettings,
  alpha: boolean,
  durationMs: number,
  onProgress: (phase: 'palette' | 'quantize', percent: number) => void,
  signal?: AbortSignal,
  source: GifSourceOptions = {}
): Promise<void> {
  const statsMode = gif.paletteMode === 'global' ? 'full' : gif.paletteMode === 'diff' ? 'diff' : 'single'
  const perFrame = gif.paletteMode === 'perframe'
  const inputArgs = source.inputArgs ?? []
  const pre = source.prefilter ? `${source.prefilter},` : ''

  await runFfmpeg({
    args: [
      ...inputArgs,
      '-i', input,
      '-vf', `${pre}palettegen=max_colors=${gif.colors}:stats_mode=${statsMode}:reserve_transparent=${alpha ? 1 : 0}`,
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
  const lavfi = source.prefilter ? `[0:v]${source.prefilter}[src];[src][1:v]${paletteuse}` : `[0:v][1:v]${paletteuse}`
  await runFfmpeg({
    args: [
      ...inputArgs,
      '-i', input,
      '-i', palettePath,
      '-lavfi', lavfi,
      '-loop', gif.loop ? '0' : '-1',
      output
    ],
    durationMs,
    onProgress: (p) => onProgress('quantize', p),
    signal
  })
}

// ---- gif converter ----
/** fps + lanczos scale for converting an arbitrary video into a GIF (height keeps the aspect). */
export function gifConvertPrefilter(fps: number, width: number): string {
  const f = Math.max(1, Math.min(50, Math.round(fps)))
  const w = Math.max(16, Math.round(width / 2) * 2)
  return `fps=${f},scale=${w}:-2:flags=lanczos`
}

/** Input-side trim (fast seek before -i); empty when the whole file is used. */
export function gifConvertInputArgs(startMs: number, endMs: number, durationMs: number): string[] {
  const start = Math.max(0, Math.min(startMs, durationMs))
  const end = Math.max(start, Math.min(endMs, durationMs))
  const args: string[] = []
  if (start > 0) args.push('-ss', (start / 1000).toFixed(3))
  if (end < durationMs) args.push('-t', ((end - start) / 1000).toFixed(3))
  return args
}
