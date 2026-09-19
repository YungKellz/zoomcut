import { protocol } from 'electron'
import { createReadStream, promises as fsp } from 'node:fs'
import { extname, normalize } from 'node:path'
import { Readable } from 'node:stream'

export const MEDIA_SCHEME = 'zc-media'

const allowedRoots: string[] = []

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.json': 'application/json'
}

export function allowMediaRoot(dir: string): void {
  allowedRoots.push(normalize(dir).toLowerCase().replace(/[\\/]+$/, ''))
}

export function encodeMediaPath(filePath: string): string {
  return Buffer.from(filePath, 'utf8').toString('base64url')
}

export function decodeMediaPath(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8')
}

function isAllowed(filePath: string): boolean {
  const n = normalize(filePath).toLowerCase()
  // the file must be *inside* an allowed root, not merely share its prefix
  return allowedRoots.some((root) => n === root || n.startsWith(root + '\\') || n.startsWith(root + '/'))
}

/**
 * Serves local media files to the renderer with HTTP range support, so that both
 * the <video> element and Mediabunny's UrlSource can seek inside large recordings
 * without loading them into memory.
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeMediaPath(url.pathname.replace(/^\/+/, ''))
      if (!isAllowed(filePath)) return new Response('Forbidden', { status: 403 })

      const stat = await fsp.stat(filePath)
      const size = stat.size
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      const baseHeaders: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Content-Type': type,
        'Cache-Control': 'no-store',
        // lets <video crossorigin="anonymous"> frames be read back from a canvas
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      }

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
      }

      const range = request.headers.get('range')
      const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : NaN
        let end = match[2] ? parseInt(match[2], 10) : NaN
        if (Number.isNaN(start)) {
          // suffix range: the last N bytes
          start = Math.max(0, size - end)
          end = size - 1
        } else if (Number.isNaN(end) || end >= size) {
          end = size - 1
        }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        }
        const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
        return new Response(stream, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1)
          }
        })
      }

      const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
      return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
    } catch (err) {
      console.error('[media protocol]', err)
      return new Response('Not found', { status: 404 })
    }
  })
}
