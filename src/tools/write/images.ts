import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Http } from '../../figma/http.js'

/** Figma refuses bigger images; checked before anything is sent. */
const MAX_BYTES = 20 * 1024 * 1024

/** PNG, JPEG and GIF: what figma.createImage accepts. */
function imageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  return undefined
}

async function load(src: string, http: Http, signal?: AbortSignal): Promise<Buffer> {
  if (/^https?:\/\//i.test(src)) {
    const got = await http.bytes(src, signal)
    if (!got.ok) throw new Error(`cannot download ${src}: ${got.message}`)
    return got.data.data
  }
  const path = src.startsWith('~/') ? resolve(homedir(), src.slice(2)) : isAbsolute(src) ? src : resolve(src)
  return readFile(path).catch((error: unknown) => {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * Replaces every `image` prop in a props tree (`image: "path or URL"` or
 * `image: { src, scaleMode }`) with the bytes the plugin needs, because the
 * plugin itself has no file or network access. Throws on the first bad image,
 * so nothing is sent.
 */
export async function embedImages<T>(value: T, http: Http, signal?: AbortSignal): Promise<T> {
  if (Array.isArray(value)) return (await Promise.all(value.map((v) => embedImages(v, http, signal)))) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key !== 'image') {
      out[key] = await embedImages(inner, http, signal)
      continue
    }
    const spec = typeof inner === 'string' ? { src: inner } : (inner as { src?: unknown; scaleMode?: unknown })
    if (typeof spec.src !== 'string') throw new Error('image needs a file path or an http(s) URL')
    const data = await load(spec.src, http, signal)
    if (data.length > MAX_BYTES) throw new Error(`${spec.src} is ${Math.round(data.length / 1024 / 1024)} MB; Figma takes up to 20 MB`)
    if (!imageType(data)) throw new Error(`${spec.src} is not a PNG, JPEG or GIF`)
    out.image = { data: data.toString('base64'), scaleMode: typeof spec.scaleMode === 'string' ? spec.scaleMode : 'FILL' }
  }
  return out as T
}
