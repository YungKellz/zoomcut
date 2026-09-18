import type { ClickEvent, CursorSample, CursorSettings } from '@shared/types'

export interface Point {
  x: number
  y: number
}

/** Interpolated cursor position at time `t` (ms), or null when there is no data. */
export function cursorAt(samples: CursorSample[], t: number): Point | null {
  const n = samples.length
  if (n === 0) return null
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y }
  if (t >= samples[n - 1].t) return { x: samples[n - 1].x, y: samples[n - 1].y }

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  const span = b.t - a.t
  // Big gaps mean the mouse did not move: hold the last position instead of gliding.
  if (span <= 0 || span > 400) return { x: a.x, y: a.y }
  const f = (t - a.t) / span
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

export interface ActiveClick {
  click: ClickEvent
  /** 0 at the click, 1 when the ripple has finished */
  progress: number
}

export function activeClicks(clicks: ClickEvent[], t: number, durationMs: number): ActiveClick[] {
  const out: ActiveClick[] = []
  for (const click of clicks) {
    const dt = t - click.t
    if (dt < 0) break
    if (dt <= durationMs) out.push({ click, progress: dt / durationMs })
  }
  return out
}

export interface FollowPath {
  stepMs: number
  xs: Float32Array
  ys: Float32Array
}

/**
 * Pre-computes where a "follow the cursor" camera should look at every `stepMs`.
 * The camera only moves when the cursor leaves a dead zone around the current
 * focus, and it moves with exponential smoothing – a calm, Screen-Studio-like pan.
 * Computing this once makes preview and export perfectly deterministic.
 */
export function buildFollowPath(
  samples: CursorSample[],
  settings: Pick<CursorSettings, 'followSmoothing' | 'followDeadZone' | 'offsetMs'>,
  durationMs: number,
  stepMs = 1000 / 60
): FollowPath {
  const steps = Math.max(1, Math.ceil(durationMs / stepMs) + 1)
  const xs = new Float32Array(steps)
  const ys = new Float32Array(steps)
  const tau = 60 + Math.max(0, Math.min(1, settings.followSmoothing)) * 640
  const alpha = 1 - Math.exp(-stepMs / tau)
  const dead = Math.max(0, settings.followDeadZone)

  const first = cursorAt(samples, settings.offsetMs) ?? { x: 0.5, y: 0.5 }
  let cx = first.x
  let cy = first.y
  for (let i = 0; i < steps; i++) {
    const t = i * stepMs + settings.offsetMs
    const cur = cursorAt(samples, t)
    if (cur) {
      const dx = cur.x - cx
      const dy = cur.y - cy
      const dist = Math.hypot(dx, dy)
      if (dist > dead) {
        const k = (dist - dead) / dist
        cx += dx * k * alpha
        cy += dy * k * alpha
      }
    }
    xs[i] = cx
    ys[i] = cy
  }
  return { stepMs, xs, ys }
}

export function followAt(path: FollowPath, t: number): Point {
  const n = path.xs.length
  if (n === 0) return { x: 0.5, y: 0.5 }
  const f = Math.max(0, t / path.stepMs)
  const i = Math.min(n - 1, Math.floor(f))
  const j = Math.min(n - 1, i + 1)
  const k = Math.min(1, f - i)
  return {
    x: path.xs[i] + (path.xs[j] - path.xs[i]) * k,
    y: path.ys[i] + (path.ys[j] - path.ys[i]) * k
  }
}
