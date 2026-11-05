import { VERSION } from '../version.js'

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; retryAfter?: number }

export interface Http {
  /** GET a Figma API path (e.g. `/v1/files/KEY/meta`) and parse JSON. */
  json<T>(path: string, signal?: AbortSignal): Promise<Result<T>>
  /** GET an absolute URL (rendered images) as bytes. Sends no token. */
  bytes(url: string, signal?: AbortSignal): Promise<Result<{ data: Buffer; type: string }>>
}

type Fetch = typeof fetch

export function createHttp(opts: { token: string; apiBase: string }, fetchImpl: Fetch = fetch): Http {
  const redact = (text: string): string => text.split(opts.token).join('***')
  const userAgent = `kit/${VERSION}`

  async function failure(response: Response): Promise<{ ok: false; status: number; message: string; retryAfter?: number }> {
    const body = redact(await response.text().catch(() => ''))
    let message = body.slice(0, 300) || response.statusText
    try {
      const parsed = JSON.parse(body) as { err?: string; message?: string }
      message = parsed.err ?? parsed.message ?? message
    } catch {
      // Not JSON: keep the raw (redacted, shortened) body.
    }
    const retry = Number(response.headers.get('retry-after'))
    return {
      ok: false,
      status: response.status,
      message: hint(response.status, message),
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    }
  }

  return {
    async json<T>(path: string, signal?: AbortSignal): Promise<Result<T>> {
      try {
        const response = await fetchImpl(`${opts.apiBase}${path}`, {
          headers: { 'X-Figma-Token': opts.token, 'User-Agent': userAgent },
          ...(signal ? { signal } : {}),
        })
        if (!response.ok) return failure(response)
        return { ok: true, data: (await response.json()) as T }
      } catch (error) {
        return { ok: false, status: 0, message: redact(error instanceof Error ? error.message : String(error)) }
      }
    },
    async bytes(url: string, signal?: AbortSignal) {
      try {
        const response = await fetchImpl(url, signal ? { signal } : {})
        if (!response.ok) return failure(response)
        const type = response.headers.get('content-type') ?? 'application/octet-stream'
        return { ok: true, data: { data: Buffer.from(await response.arrayBuffer()), type } }
      } catch (error) {
        return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function hint(status: number, message: string): string {
  if (status === 403) return `${message} (check that FIGMA_TOKEN is valid, has the needed scopes and can open this file)`
  if (status === 404) return `${message} (wrong file key or node id, or the token cannot see the file)`
  if (status === 429) return `${message} (Figma rate limit; wait before retrying)`
  return message
}
