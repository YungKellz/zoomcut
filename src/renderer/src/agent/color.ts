const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** "#abc" / "#AABBCC" -> "#aabbcc"; null when it is not a hex color. */
export function normalizeHex(value: string): string | null {
  const s = value.trim()
  if (!HEX_COLOR.test(s)) return null
  const h = s.slice(1).toLowerCase()
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h)
}

/**
 * An opaque CSS color as "#rrggbb", or null when it is not one. The editor's color fields work
 * with hex only (and the text box background mixes its opacity into a hex color), so named,
 * rgb() and hsl() colors an agent may send are converted: the canvas parses them and serializes
 * an opaque color back as "#rrggbb". Without a DOM (unit tests) only hex is understood.
 */
export function cssColorToHex(value: string): string | null {
  const hex = normalizeHex(value)
  if (hex) return hex
  const s = value.trim()
  if (s === '' || s.length > 64 || typeof document === 'undefined') return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  // an unparsable value leaves fillStyle untouched: two different sentinels tell "parsed" from "ignored"
  for (const sentinel of ['#010203', '#030201']) {
    ctx.fillStyle = sentinel
    ctx.fillStyle = s
    if (ctx.fillStyle !== sentinel) return ctx.fillStyle.startsWith('#') ? normalizeHex(ctx.fillStyle) : null
  }
  return null
}
