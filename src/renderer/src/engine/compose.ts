import type { Project, TextOverlay } from '@shared/types'
import { GRADIENT_PRESETS } from '@shared/defaults'
import { cameraAt, viewportOf, type Camera } from './camera'
import { activeClicks, cursorAt, type FollowPath } from './cursor'

export interface OutputSize {
  outW: number
  outH: number
  contentW: number
  contentH: number
  pad: number
}

/**
 * Output geometry for a given scale of the source crop. `fit` shrinks the result to
 * fit a preview area. Export sizes are rounded to even numbers for H.264.
 */
export function outputSize(project: Project, scale: number, fit?: { maxW: number; maxH: number }): OutputSize {
  const { width, height } = project.recording
  const crop = project.crop
  let contentW = Math.max(16, crop.w * width * scale)
  let contentH = Math.max(16, crop.h * height * scale)
  const p = Math.max(0, project.frame.padding)
  let pad = p * contentH
  let outW = contentW + pad * 2
  let outH = contentH + pad * 2
  if (fit) {
    const k = Math.min(1, fit.maxW / outW, fit.maxH / outH)
    contentW *= k
    contentH *= k
    pad *= k
    outW *= k
    outH *= k
  }
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
  outW = even(outW)
  outH = even(outH)
  pad = Math.round(pad)
  contentW = outW - pad * 2
  contentH = outH - pad * 2
  return { outW, outH, contentW, contentH, pad }
}

export interface ComposeOptions {
  disableZoom?: boolean
  disableFrame?: boolean
  disableCursor?: boolean
  disableTexts?: boolean
  camera?: Camera
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

export const TRANSPARENT_BACKGROUND = 'transparent'

function fillBackground(ctx: CanvasRenderingContext2D, background: string, w: number, h: number): void {
  if (background === TRANSPARENT_BACKGROUND) return // canvas was cleared: keep the alpha
  const preset = GRADIENT_PRESETS[background]
  if (preset) {
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, preset[0])
    g.addColorStop(1, preset[1])
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = background
  }
  ctx.fillRect(0, 0, w, h)
}

export function textIsActive(overlay: TextOverlay, t: number): boolean {
  return t >= overlay.start && t < overlay.end
}

export interface TextLayout {
  x: number
  y: number
  w: number
  h: number
  lines: string[]
  lineHeight: number
  fontPx: number
  padX: number
  padY: number
}

export function textFont(overlay: TextOverlay, fontPx: number): string {
  return `${overlay.bold ? '700' : '500'} ${fontPx}px Inter, "Segoe UI", system-ui, -apple-system, sans-serif`
}

export function layoutText(ctx: CanvasRenderingContext2D, overlay: TextOverlay, outW: number, outH: number): TextLayout {
  const fontPx = Math.max(8, overlay.fontSize * outH)
  ctx.font = textFont(overlay, fontPx)
  const lines = overlay.text.split('\n')
  const lineHeight = fontPx * 1.25
  const padX = fontPx * 0.55
  const padY = fontPx * 0.32
  let maxW = 0
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line || ' ').width)
  const w = maxW + padX * 2
  const h = lines.length * lineHeight + padY * 2
  return {
    x: overlay.x * outW - w / 2,
    y: overlay.y * outH - h / 2,
    w,
    h,
    lines,
    lineHeight,
    fontPx,
    padX,
    padY
  }
}

function drawText(ctx: CanvasRenderingContext2D, overlay: TextOverlay, t: number, outW: number, outH: number): void {
  // the fade never takes longer than half of the overlay, so short texts stay readable
  const anim = Math.max(1, Math.min(overlay.animationMs, (overlay.end - overlay.start) / 2))
  let alpha = 1
  let scale = 1
  if (overlay.animation !== 'none' && overlay.animationMs > 0) {
    const inP = Math.min(1, (t - overlay.start) / anim)
    const outP = Math.min(1, (overlay.end - t) / anim)
    alpha = Math.max(0, Math.min(inP, outP))
    if (overlay.animation === 'pop') {
      const e = 1 - Math.pow(1 - alpha, 3)
      scale = 0.9 + 0.1 * e
    }
  }
  if (alpha <= 0) return

  const layout = layoutText(ctx, overlay, outW, outH)
  ctx.save()
  ctx.globalAlpha = alpha
  const cx = layout.x + layout.w / 2
  const cy = layout.y + layout.h / 2
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  ctx.translate(-cx, -cy)

  if (overlay.backgroundOpacity > 0) {
    ctx.fillStyle = hexToRgba(overlay.background, overlay.backgroundOpacity)
    roundedRectPath(ctx, layout.x, layout.y, layout.w, layout.h, overlay.cornerRadius * (outH / 1080))
    ctx.fill()
  }

  ctx.font = textFont(overlay, layout.fontPx)
  ctx.fillStyle = overlay.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = overlay.align
  const textX =
    overlay.align === 'left'
      ? layout.x + layout.padX
      : overlay.align === 'right'
        ? layout.x + layout.w - layout.padX
        : layout.x + layout.w / 2
  layout.lines.forEach((line, i) => {
    const y = layout.y + layout.padY + layout.lineHeight * (i + 0.5)
    ctx.fillText(line, textX, y)
  })
  ctx.restore()
}

/**
 * Draws one frame of the final video: background/padding, the (zoomed) source crop,
 * the cursor highlight with click ripples and the text overlays.
 * `source` is whatever holds the frame at source time `tSrc`: a <video>, a VideoFrame
 * or a canvas with the full recording resolution `srcW` × `srcH`.
 */
export function composeFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  project: Project,
  tSrc: number,
  size: OutputSize,
  followPath: FollowPath | null,
  opts: ComposeOptions = {}
): void {
  const { outW, outH, contentW, contentH, pad } = size
  const frame = project.frame
  const crop = project.crop

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, outW, outH)
  if (!opts.disableFrame) fillBackground(ctx, frame.background, outW, outH)
  else {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, outW, outH)
  }

  const cam = opts.camera ?? (opts.disableZoom ? { cx: 0.5, cy: 0.5, scale: 1 } : cameraAt(project, tSrc, followPath))
  const vp = viewportOf(cam)
  const cropPxX = crop.x * srcW
  const cropPxY = crop.y * srcH
  const cropPxW = crop.w * srcW
  const cropPxH = crop.h * srcH
  const sx = cropPxX + vp.x * cropPxW
  const sy = cropPxY + vp.y * cropPxH
  const sw = vp.w * cropPxW
  const sh = vp.h * cropPxH

  const radius = opts.disableFrame ? 0 : frame.cornerRadius * (contentH / 1080)
  if (!opts.disableFrame && frame.shadow && pad > 0) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = pad * 0.9
    ctx.shadowOffsetY = pad * 0.25
    ctx.fillStyle = '#000'
    roundedRectPath(ctx, pad, pad, contentW, contentH, radius)
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  roundedRectPath(ctx, pad, pad, contentW, contentH, radius)
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, sx, sy, sw, sh, pad, pad, contentW, contentH)

  if (!opts.disableCursor) {
    const cs = project.cursor
    const data = project.cursorData
    const tCursor = tSrc + cs.offsetMs
    const toContent = (px: number, py: number): { x: number; y: number } => ({
      x: pad + (((px - crop.x) / crop.w - vp.x) / vp.w) * contentW,
      y: pad + (((py - crop.y) / crop.h - vp.y) / vp.h) * contentH
    })
    const unit = contentH / 1080
    if (cs.clicks && data.clicks.length) {
      for (const { click, progress } of activeClicks(data.clicks, tCursor, cs.clickDurationMs)) {
        const p = toContent(click.x, click.y)
        const color = click.button === 'right' ? cs.rightClickColor : cs.clickColor
        const r = (cs.clickRadius * unit) * (0.35 + 0.65 * progress)
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.strokeStyle = hexToRgba(color, (1 - progress) * 0.95)
        ctx.lineWidth = Math.max(1.5, 3 * unit * (1 - progress * 0.5))
        ctx.stroke()
        ctx.fillStyle = hexToRgba(color, (1 - progress) * 0.18)
        ctx.fill()
      }
    }
    if (cs.highlight) {
      const cur = cursorAt(data.samples, tCursor)
      if (cur) {
        const p = toContent(cur.x, cur.y)
        const r = cs.highlightRadius * unit
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fillStyle = hexToRgba(cs.highlightColor, cs.highlightOpacity)
        ctx.fill()
        if (cs.highlightOutline) {
          ctx.strokeStyle = hexToRgba(cs.highlightColor, Math.min(1, cs.highlightOpacity + 0.45))
          ctx.lineWidth = Math.max(1, 2 * unit)
          ctx.stroke()
        }
      }
    }
  }
  ctx.restore()

  if (!opts.disableTexts) {
    for (const overlay of project.texts) {
      if (textIsActive(overlay, tSrc)) drawText(ctx, overlay, tSrc, outW, outH)
    }
  }
  ctx.restore()
}
