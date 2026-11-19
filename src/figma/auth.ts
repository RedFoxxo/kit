import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** How kit authenticates its requests to Figma's REST API. */
export interface Auth {
  /** What the user set up, for error hints ("FIGMA_TOKEN", "the Figma sign-in"). */
  readonly label: string
  /** The header for the next request, or why there is none. */
  header(signal?: AbortSignal): Promise<{ ok: true; name: string; value: string } | { ok: false; message: string }>
  /**
   * Figma refused a request sent with the header `value`. Resolves true when a
   * newer credential is ready, so the request is worth sending once more.
   */
  rejected(value: string, signal?: AbortSignal): Promise<boolean>
  /** Strings that must never appear in an answer or a log. */
  secrets(): string[]
}

/** A personal access token from FIGMA_TOKEN. */
export function tokenAuth(token: string): Auth {
  return {
    label: 'FIGMA_TOKEN',
    header: async () => ({ ok: true, name: 'X-Figma-Token', value: token }),
    rejected: async () => false,
    secrets: () => [token],
  }
}

/** Scopes kit asks for; the OAuth app must have all of them. */
export const SCOPES = ['current_user:read', 'file_content:read', 'file_metadata:read', 'file_comments:read', 'file_comments:write']
/** Loopback port of the sign-in callback; the app's redirect URL is `http://127.0.0.1:7390/callback`. */
export const CALLBACK_PORT = 7390
const DAY_MS = 24 * 60 * 60 * 1000
/** Figma's documented default lifetime, for an answer without `expires_in`. */
const DEFAULT_LIFETIME_S = 90 * 24 * 60 * 60
/**
 * How long `login` waits for the browser before answering with the link; the
 * sign-in keeps waiting in the background. Short, because a started browser
 * launcher does not prove a page opened.
 */
const LOGIN_WAIT_MS = 30_000
/** How long a started sign-in accepts the browser's callback. */
const LOGIN_TTL_MS = 10 * 60_000

const NOT_SIGNED_IN = 'Not signed in to Figma. Call auth_login: it opens Figma in the browser to sign in.'
const EXPIRED = 'The Figma sign-in expired or was revoked. Call auth_login to sign in again.'

interface Stored {
  clientId: string
  accessToken: string
  refreshToken: string
  /** Epoch ms when kit renews the access token: a day before it expires, or halfway for a short-lived one. */
  refreshAt: number
}

type Fetch = typeof fetch

export interface OAuthOptions {
  clientId: string
  clientSecret: string
  /** Where the sign-in is kept, readable by the user only. */
  file: string
  apiBase?: string
  authorizeUrl?: string
  port?: number
  /** Opens a URL in the browser; resolves false when no browser could be started. */
  open?: (url: string) => Promise<boolean>
  fetch?: Fetch
  now?: () => number
  loginWaitMs?: number
}

interface Pending {
  url: string
  done: Promise<string>
}

/**
 * Figma OAuth with the user's own app (FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET):
 * browser sign-in with PKCE and a loopback callback, the tokens in one file
 * shared by every kit process of the user, refreshed before they expire.
 */
export class OAuth implements Auth {
  readonly label = 'the Figma sign-in'
  private readonly apiBase: string
  private readonly authorizeUrl: string
  private readonly port: number
  private readonly fetch: Fetch
  private readonly now: () => number
  private readonly open: (url: string) => Promise<boolean>
  private readonly loginWaitMs: number
  private stored: Stored | undefined
  private expired = false
  private refreshing: Promise<boolean> | undefined
  private pending: Pending | undefined

  constructor(private readonly opts: OAuthOptions) {
    this.apiBase = opts.apiBase ?? 'https://api.figma.com'
    this.authorizeUrl = opts.authorizeUrl ?? 'https://www.figma.com/oauth'
    this.port = opts.port ?? CALLBACK_PORT
    this.fetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.open = opts.open ?? openBrowser
    this.loginWaitMs = opts.loginWaitMs ?? LOGIN_WAIT_MS
  }

  get redirectUri(): string {
    return `http://127.0.0.1:${this.port}/callback`
  }

  secrets(): string[] {
    return [this.opts.clientSecret, this.stored?.accessToken, this.stored?.refreshToken].filter((s): s is string => !!s)
  }

  async header(signal?: AbortSignal): Promise<{ ok: true; name: string; value: string } | { ok: false; message: string }> {
    // Another kit process may have signed in or refreshed since.
    if (!this.stored) await this.load()
    if (!this.stored) return { ok: false, message: this.expired ? EXPIRED : NOT_SIGNED_IN }
    if (this.now() >= this.stored.refreshAt) {
      await this.refresh(this.stored.accessToken, signal)
      if (!this.stored) return { ok: false, message: EXPIRED }
    }
    return { ok: true, name: 'Authorization', value: `Bearer ${this.stored.accessToken}` }
  }

  async rejected(value: string, signal?: AbortSignal): Promise<boolean> {
    const token = value.replace(/^Bearer /, '')
    await this.load()
    if (!this.stored) return false
    if (this.stored.accessToken !== token) return true
    // A 403 also means "this token can't open that file": only refresh a token Figma no longer accepts.
    if ((await this.whoami(value, signal)) !== undefined) return false
    return this.refresh(token, signal)
  }

  /**
   * Signs in through the browser, or reports the account already signed in.
   * Answers once the browser comes back, or after a wait with the link to
   * open; a later call picks up the same sign-in.
   */
  async login(force: boolean, signal?: AbortSignal): Promise<string> {
    if (!force && !this.pending) {
      await this.load()
      if (this.stored) {
        const auth = await this.header(signal)
        const who = auth.ok ? await this.whoami(auth.value, signal) : undefined
        if (who) return `Already signed in to Figma as ${who}. Use force to sign in with another account.`
      }
    }
    let pending = this.pending
    let opened = true
    if (!pending) {
      const started = await this.start()
      if (typeof started === 'string') return started
      pending = started
      opened = await this.open(pending.url)
    }
    if (!opened) return `Could not open a browser. Ask the user to open this link and sign in, then call auth_login again:\n${pending.url}`
    const waited = await waitFor(pending.done, this.loginWaitMs, signal)
    if (waited === undefined) {
      return `Still waiting for the user to finish signing in to Figma in the browser. If no page opened, ask them to open this link, then call auth_login again:\n${pending.url}`
    }
    return waited
  }

  private async start(): Promise<Pending | string> {
    const state = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const url = `${this.authorizeUrl}?${new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES.join(' '),
      state,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`

    const { promise: done, resolve: finish } = Promise.withResolvers<string>()
    /** Set once Figma's answer arrived: a reload or a second request must not exchange the code again. */
    let received = false
    const server = createServer((req, res) => {
      const query = URL.parse(req.url ?? '/', this.redirectUri)
      if (query?.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const page = (status: number, message: string) =>
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>kit</title><p>${message}</p>`)
      if (query.searchParams.get('state') !== state) {
        page(400, 'This sign-in link is out of date. Go back to your AI tool and ask it to sign in to Figma again.')
        return
      }
      if (received) {
        page(409, 'kit already received this sign-in. Go back to your AI tool.')
        return
      }
      received = true
      const code = query.searchParams.get('code')
      if (!code) {
        page(400, 'Figma did not sign you in. Go back to your AI tool and try again.')
        close(`Figma did not sign in: ${query.searchParams.get('error') ?? 'no code'}. Call auth_login to try again.`)
        return
      }
      // Figma's code expires 30 seconds after it is issued: exchange it now.
      this.exchange(code, verifier).then(
        async (result) => {
          page(result.ok ? 200 : 502, result.ok ? 'Signed in to Figma. You can close this tab.' : 'Signing in to Figma failed. Go back to your AI tool for details.')
          close(result.ok ? await this.signedIn() : `Signing in to Figma failed: ${this.redact(result.message)}`)
        },
        (error: unknown) => {
          page(502, 'Signing in to Figma failed. Go back to your AI tool for details.')
          close(`Signing in to Figma failed: ${this.redact(error instanceof Error ? error.message : String(error))}`)
        },
      )
    })
    const timer = setTimeout(() => close('The Figma sign-in timed out. Call auth_login to try again.'), LOGIN_TTL_MS)
    timer.unref()
    const close = (result: string) => {
      clearTimeout(timer)
      server.close()
      if (this.pending?.done === done) this.pending = undefined
      finish(result)
    }

    const listening = await listen(server, this.port)
    // A sign-in left waiting must not keep the process alive.
    server.unref()
    if (listening !== true) {
      clearTimeout(timer)
      return listening === 'EADDRINUSE'
        ? `Port ${this.port} is busy, probably with a sign-in started by another kit session. Ask the user to finish that one in the browser (or wait 10 minutes), then call auth_login again.`
        : `Could not wait for the sign-in on port ${this.port}: ${listening}`
    }
    this.pending = { url, done }
    return this.pending
  }

  private async signedIn(): Promise<string> {
    const auth = await this.header()
    const who = auth.ok ? await this.whoami(auth.value) : undefined
    return `Signed in to Figma${who ? ` as ${who}` : ''}.`
  }

  private async exchange(code: string, verifier: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const answer = await this.tokenCall('/v1/oauth/token', {
      redirect_uri: this.redirectUri,
      code,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    })
    if (!answer.ok) return answer
    const { access_token, refresh_token, expires_in } = answer.data
    if (!access_token || !refresh_token) return { ok: false, message: 'Figma answered without tokens' }
    await this.save({
      clientId: this.opts.clientId,
      accessToken: access_token,
      refreshToken: refresh_token,
      refreshAt: this.refreshAt(expires_in),
    })
    return { ok: true }
  }

  /** Replaces the access token `stale`; true when a newer one is ready. One refresh at a time per process. */
  private refresh(stale: string, signal?: AbortSignal): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        // Another process may have refreshed already: Figma keeps one access token per user and app.
        await this.load()
        if (!this.stored) return false
        if (this.stored.accessToken !== stale) return true
        const answer = await this.tokenCall('/v1/oauth/refresh', { refresh_token: this.stored.refreshToken }, signal)
        if (!answer.ok) {
          // Refused, not just busy (408, 429): the refresh token is dead and only a new sign-in helps.
          if (answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
            await this.forget()
            this.expired = true
          }
          return false
        }
        const { access_token, refresh_token, expires_in } = answer.data
        if (!access_token) return false
        await this.save({
          ...this.stored,
          accessToken: access_token,
          refreshToken: refresh_token ?? this.stored.refreshToken,
          refreshAt: this.refreshAt(expires_in),
        })
        return true
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  private async tokenCall(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; data: { access_token?: string; refresh_token?: string; expires_in?: number } } | { ok: false; status: number; message: string }> {
    try {
      const response = await this.fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
        ...(signal ? { signal } : {}),
      })
      const body = await response.text()
      if (!response.ok) return { ok: false, status: response.status, message: this.redact(`${response.status} ${body.slice(0, 300)}`) }
      return { ok: true, data: JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number } }
    } catch (error) {
      return { ok: false, status: 0, message: this.redact(error instanceof Error ? error.message : String(error)) }
    }
  }

  /** The signed-in user as "handle (email)", or undefined when Figma refuses the token. */
  private async whoami(header: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.fetch(`${this.apiBase}/v1/me`, { headers: { Authorization: header }, ...(signal ? { signal } : {}) })
      if (!response.ok) return undefined
      const me = (await response.json()) as { handle?: string; email?: string }
      return [me.handle, me.email ? `(${me.email})` : undefined].filter(Boolean).join(' ') || 'an unnamed user'
    } catch {
      return undefined
    }
  }

  private async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.opts.file, 'utf8')) as Partial<Stored>
      const valid =
        data.clientId === this.opts.clientId && typeof data.accessToken === 'string' && typeof data.refreshToken === 'string' && typeof data.refreshAt === 'number'
      this.stored = valid ? (data as Stored) : undefined
      if (valid) this.expired = false
    } catch {
      this.stored = undefined
    }
  }

  private async save(stored: Stored): Promise<void> {
    await mkdir(dirname(this.opts.file), { recursive: true, mode: 0o700 })
    const temp = `${this.opts.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(stored), { mode: 0o600 })
    await rename(temp, this.opts.file)
    this.stored = stored
    this.expired = false
  }

  private async forget(): Promise<void> {
    await rm(this.opts.file, { force: true })
    this.stored = undefined
  }

  private redact(text: string): string {
    return this.secrets().reduce((out, secret) => out.split(secret).join('***'), text)
  }

  private refreshAt(expiresIn: number | undefined): number {
    const lifetime = (expiresIn ?? DEFAULT_LIFETIME_S) * 1000
    return this.now() + Math.max(lifetime - DAY_MS, lifetime / 2)
  }
}

function listen(server: Server, port: number): Promise<true | string> {
  const { promise, resolve } = Promise.withResolvers<true | string>()
  server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
  server.listen(port, '127.0.0.1', () => resolve(true))
  return promise
}

/** The promise's value, or undefined after `ms` or on abort. The promise keeps running either way. */
function waitFor<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  const { promise, resolve } = Promise.withResolvers<T | undefined>()
  const timer = setTimeout(() => resolve(undefined), ms)
  const abort = () => resolve(undefined)
  signal?.addEventListener('abort', abort, { once: true })
  work.then((value) => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    resolve(value)
  })
  return promise
}

/** Opens the URL in the default browser without a shell, so `&` in the URL stays literal. */
export function openBrowser(url: string): Promise<boolean> {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  const { promise, resolve } = Promise.withResolvers<boolean>()
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  } catch {
    resolve(false)
  }
  return promise
}
