import { VERSION } from '../version.js'
import type { Auth } from './auth.js'

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; retryAfter?: number }

export interface Http {
  /** GET a Figma API path (e.g. `/v1/files/KEY/meta`) and parse JSON. */
  json<T>(path: string, signal?: AbortSignal): Promise<Result<T>>
  /** POST JSON to a Figma API path and parse the JSON answer. */
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>>
  /** GET an absolute URL (rendered images) as bytes. Sends no token. */
  bytes(url: string, signal?: AbortSignal): Promise<Result<{ data: Buffer; type: string }>>
}

type Fetch = typeof fetch

export function createHttp(opts: { auth: Auth; apiBase: string }, fetchImpl: Fetch = fetch): Http {
  const { auth } = opts
  const redact = (text: string): string => auth.secrets().reduce((out, secret) => out.split(secret).join('***'), text)

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
      message: hint(response.status, message, auth.label),
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    }
  }

  /** Sends an authenticated request; when Figma refuses the credential and a newer one is ready, sends it once more. */
  async function call<T>(path: string, init: RequestInit & { headers?: Record<string, string> }, signal?: AbortSignal): Promise<Result<T>> {
    try {
      for (let attempt = 0; ; attempt++) {
        const credential = await auth.header(signal)
        if (!credential.ok) return { ok: false, status: 401, message: credential.message }
        const response = await fetchImpl(`${opts.apiBase}${path}`, {
          ...init,
          headers: { ...init.headers, [credential.name]: credential.value, 'User-Agent': `kit/${VERSION}` },
          ...(signal ? { signal } : {}),
        })
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          if (await auth.rejected(credential.value, signal)) {
            await response.body?.cancel()
            continue
          }
          // The credential could not be renewed: say what to do instead of Figma's bare refusal.
          const after = await auth.header(signal)
          if (!after.ok) {
            await response.body?.cancel()
            return { ok: false, status: 401, message: after.message }
          }
        }
        if (!response.ok) return failure(response)
        return { ok: true, data: (await response.json()) as T }
      }
    } catch (error) {
      return { ok: false, status: 0, message: redact(error instanceof Error ? error.message : String(error)) }
    }
  }

  return {
    json: <T>(path: string, signal?: AbortSignal) => call<T>(path, {}, signal),
    post: <T>(path: string, body: unknown, signal?: AbortSignal) =>
      call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal),
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

function hint(status: number, message: string, credential: string): string {
  if (status === 403) return `${message} (check that ${credential} is valid, has the needed scopes and can open this file)`
  if (status === 404) return `${message} (wrong file key or node id, or ${credential} cannot see the file)`
  if (status === 429) return `${message} (Figma rate limit; wait before retrying)`
  return message
}
