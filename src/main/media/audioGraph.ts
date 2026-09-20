import type { AudioExportPlan, AudioExportTrack } from '@shared/types'

const SAMPLE_RATE = 48000

export interface AudioFilterGraph {
  /** the -filter_complex argument */
  filterComplex: string
  /** absolute paths, in the order the caller must pass them as extra -i inputs (index i+1; input 0 is the video) */
  inputs: string[]
  /** -map argument for the mixed-down output, e.g. "[aout]" */
  outLabel: string
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3)
}

/**
 * Builds the ffmpeg -filter_complex graph that mixes every track's pieces into one output
 * stream in output time: per track, aresample/aformat (+ aloop only when a piece actually
 * runs past the file's own duration) -> per piece atrim/asetpts/apad/adelay -> amix the
 * track's own pieces -> volume/afade -> amix all tracks -> atrim to the output duration.
 *
 * Pure (no fs/electron/ffmpeg-static): the caller (media/ffmpeg.ts) is responsible for
 * resolving `plan.tracks[].path` into real -i arguments and for anything that touches disk
 * (e.g. dropping a track whose file went missing before this runs).
 */
export function buildAudioFilterComplex(plan: AudioExportPlan): AudioFilterGraph {
  const chains: string[] = []
  const trackLabels: string[] = []
  const inputs: string[] = []

  plan.tracks.forEach((track: AudioExportTrack, i) => {
    inputs.push(track.path)
    const inputIndex = i + 1
    // a piece only loops the source when it actually runs past the file's own duration;
    // cap `size` at the file's real sample count so aloop never has to loop unplayed content
    const needsLoop = track.pieces.some((p) => p.fileEnd > track.durationMs + 1)
    const loopSize = Math.max(1, Math.ceil((track.durationMs / 1000) * SAMPLE_RATE))
    const baseLabel = `a${i}b`
    chains.push(
      `[${inputIndex}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo` +
        (needsLoop ? `,aloop=loop=-1:size=${loopSize}` : '') +
        `[${baseLabel}]`
    )

    const pieceInputs = track.pieces.length > 1 ? track.pieces.map((_, j) => `${baseLabel}p${j}`) : [baseLabel]
    if (track.pieces.length > 1) {
      chains.push(`[${baseLabel}]asplit=${track.pieces.length}${pieceInputs.map((l) => `[${l}]`).join('')}`)
    }

    const pieceLabels = track.pieces.map((piece, j) => {
      const label = `${baseLabel}o${j}`
      const whole = ((piece.fileEnd - piece.fileStart) / 1000).toFixed(3)
      const delayMs = Math.max(0, Math.round(piece.outAt))
      chains.push(
        `[${pieceInputs[j]}]atrim=start=${sec(piece.fileStart)}:end=${sec(piece.fileEnd)},asetpts=PTS-STARTPTS,apad=whole_dur=${whole},adelay=${delayMs}:all=1[${label}]`
      )
      return label
    })

    const mixLabel = pieceLabels.length === 1 ? pieceLabels[0] : `a${i}mix`
    if (pieceLabels.length > 1) {
      chains.push(`${pieceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${pieceLabels.length}:normalize=0:duration=longest[${mixLabel}]`)
    }

    const firstOutAt = Math.min(...track.pieces.map((p) => p.outAt))
    const lastEnd = Math.max(...track.pieces.map((p) => p.outAt + (p.fileEnd - p.fileStart)))
    const finalLabel = `a${i}f`
    let chain = `[${mixLabel}]volume=${track.volume}`
    // afade fails to initialize on a negative `st`; clamp both, and skip a fade whose
    // duration is 0 rather than emit a no-op filter
    if (track.fadeInMs > 0) {
      chain += `,afade=t=in:st=${sec(Math.max(0, firstOutAt))}:d=${sec(track.fadeInMs)}`
    }
    if (track.fadeOutMs > 0) {
      chain += `,afade=t=out:st=${sec(Math.max(0, lastEnd - track.fadeOutMs))}:d=${sec(track.fadeOutMs)}`
    }
    chains.push(`${chain}[${finalLabel}]`)
    trackLabels.push(finalLabel)
  })

  const outDurSec = sec(plan.outDurationMs)
  if (trackLabels.length === 1) {
    chains.push(`[${trackLabels[0]}]atrim=0:${outDurSec}[aout]`)
  } else {
    chains.push(`${trackLabels.map((l) => `[${l}]`).join('')}amix=inputs=${trackLabels.length}:normalize=0:duration=longest,atrim=0:${outDurSec}[aout]`)
  }

  return { filterComplex: chains.join(';'), inputs, outLabel: '[aout]' }
}
