import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { OAuth } from '../src/figma/auth.js'
import { createHttp } from '../src/figma/http.js'

const API = 'https://api.test'
/** A started sign-in holds its callback port for minutes, so each OAuth gets its own. */
let nextPort = 47395
const DAY = 24 * 60 * 60 * 1000

interface Call {
  path: string
  auth: string | null
  body: string
}

/**
 * A fake Figma API. `tokens` are the access tokens Figma accepts; the token
 * endpoints hand out the next one from `issue`, valid for `lifetime` seconds.
 */
function fakeFigma(opts: { tokens: string[]; issue?: string[]; lifetime?: number; refreshStatus?: number; fileStatus?: number }) {
  const lifetime = opts.lifetime ?? 90 * 86400
  const calls: Call[] = []
  const issue = [...(opts.issue ?? [])]
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({ path: url.pathname, auth: headers.get('authorization'), body: String(init?.body ?? '') })
    if (url.pathname === '/v1/oauth/token') return json(200, { access_token: issue.shift(), refresh_token: 'refresh-1', expires_in: lifetime })
    if (url.pathname === '/v1/oauth/refresh') {
      if (opts.refreshStatus) return json(opts.refreshStatus, { error: 'invalid refresh token refresh-1' })
      return json(200, { access_token: issue.shift(), expires_in: lifetime })
    }
    const token = headers.get('authorization')?.replace('Bearer ', '')
    if (!token || !opts.tokens.includes(token)) return json(403, { status: 403, err: 'Invalid token' })
    if (url.pathname === '/v1/me') return json(200, { handle: 'Ada', email: 'ada@example.com' })
    if (opts.fileStatus) return json(opts.fileStatus, { status: opts.fileStatus, err: 'File not shared' })
    return json(200, { name: 'File' })
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function authFile(stored?: { accessToken: string; refreshAt: number; clientId?: string }): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'kit-auth-')), 'auth.json')
  if (stored) await writeFile(file, JSON.stringify({ clientId: 'client', refreshToken: 'refresh-1', ...stored }))
  return file
}

function oauth(file: string, fetchImpl: typeof fetch, open: (url: string) => Promise<boolean> = async () => true) {
  return new OAuth({ clientId: 'client', clientSecret: 'shh-secret', file, apiBase: API, port: nextPort++, fetch: fetchImpl, open, loginWaitMs: 5_000 })
}

describe('OAuth sign-in', () => {
  it('signs in through the browser, keeps the tokens private and sends them as a bearer token', async () => {
    const figma = fakeFigma({ tokens: ['access-1'], issue: ['access-1'] })
    const file = await authFile()
    let authorize: URL | undefined
    const auth = oauth(file, figma.fetchImpl, async (url) => {
      authorize = new URL(url)
      // The user approves in the browser: Figma redirects to the callback.
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
      redirect.search = new URLSearchParams({ code: 'the-code', state: authorize.searchParams.get('state')! }).toString()
      void fetch(redirect)
      return true
    })

    expect(await auth.login(false)).toBe('Signed in to Figma as Ada (ada@example.com).')

    expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize?.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const exchange = figma.calls.find((c) => c.path === '/v1/oauth/token')!
    expect(exchange.auth).toBe(`Basic ${Buffer.from('client:shh-secret').toString('base64')}`)
    expect(new URLSearchParams(exchange.body).get('code')).toBe('the-code')
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBeTruthy()
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    const http = createHttp({ auth, apiBase: API }, figma.fetchImpl)
    expect(await http.json('/v1/files/KEY')).toEqual({ ok: true, data: { name: 'File' } })
    expect(figma.calls.at(-1)?.auth).toBe('Bearer access-1')
  })

  it('ignores a callback that does not carry the state it sent', async () => {
    const figma = fakeFigma({ tokens: [], issue: ['access-1'] })
    const file = await authFile()
    let status = 0
    const auth = oauth(file, figma.fetchImpl, async (url) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
      redirect.search = 'code=stolen&state=forged'
      status = (await fetch(redirect)).status
      return true
    })
    const answer = auth.login(false)
    await expect.poll(() => status).toBe(400)
    expect(figma.calls.some((c) => c.path === '/v1/oauth/token')).toBe(false)
    expect(await answer).toContain('Still waiting')
  }, 10_000)

  it('answers with the link when no browser can be opened', async () => {
    const figma = fakeFigma({ tokens: [] })
    const auth = oauth(await authFile(), figma.fetchImpl, async () => false)
    const answer = await auth.login(false)
    expect(answer).toContain('Could not open a browser')
    expect(answer).toContain('https://www.figma.com/oauth?client_id=client')
  })

  it('tells the user to sign in before any request when there is no sign-in', async () => {
    const figma = fakeFigma({ tokens: [] })
    const http = createHttp({ auth: oauth(await authFile(), figma.fetchImpl), apiBase: API }, figma.fetchImpl)
    const result = await http.json('/v1/files/KEY')
    expect(result).toMatchObject({ ok: false, status: 401 })
    expect(!result.ok && result.message).toContain('Call auth_login')
    expect(figma.calls).toEqual([])
  })
})

describe('OAuth tokens', () => {
  it('refreshes a token about to expire before using it', async () => {
    const figma = fakeFigma({ tokens: ['access-2'], issue: ['access-2'] })
    const file = await authFile({ accessToken: 'access-1', refreshAt: Date.now() - 1 })
    const http = createHttp({ auth: oauth(file, figma.fetchImpl), apiBase: API }, figma.fetchImpl)

    expect(await http.json('/v1/files/KEY')).toMatchObject({ ok: true })
    expect(figma.calls.map((c) => c.path)).toEqual(['/v1/oauth/refresh', '/v1/files/KEY'])
    expect(figma.calls[1]?.auth).toBe('Bearer access-2')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' })
  })

  it('picks up a token another kit process refreshed, without refreshing again', async () => {
    const tokens = ['access-1']
    const figma = fakeFigma({ tokens })
    const file = await authFile({ accessToken: 'access-1', refreshAt: Date.now() + 80 * DAY })
    const http = createHttp({ auth: oauth(file, figma.fetchImpl), apiBase: API }, figma.fetchImpl)
    expect(await http.json('/v1/files/KEY')).toMatchObject({ ok: true })

    // Figma keeps one access token per user and app: the other process's refresh killed access-1.
    await writeFile(file, JSON.stringify({ clientId: 'client', accessToken: 'access-2', refreshToken: 'refresh-1', refreshAt: Date.now() + 90 * DAY }))
    tokens.splice(0, 1, 'access-2')
    figma.calls.length = 0
    expect(await http.json('/v1/files/KEY')).toMatchObject({ ok: true })
    expect(figma.calls.map((c) => `${c.path} ${c.auth}`)).toEqual(['/v1/files/KEY Bearer access-1', '/v1/files/KEY Bearer access-2'])
  })

  it('does not refresh a valid token when only the file is off limits', async () => {
    const figma = fakeFigma({ tokens: ['access-1'], fileStatus: 403 })
    const file = await authFile({ accessToken: 'access-1', refreshAt: Date.now() + 80 * DAY })
    const result = await createHttp({ auth: oauth(file, figma.fetchImpl), apiBase: API }, figma.fetchImpl).json('/v1/files/KEY')
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(!result.ok && result.message).toContain('the Figma sign-in')
    expect(figma.calls.map((c) => c.path)).toEqual(['/v1/files/KEY', '/v1/me'])
  })

  it('asks for a new sign-in when Figma refuses the refresh token, without showing it', async () => {
    const figma = fakeFigma({ tokens: [], refreshStatus: 400 })
    const file = await authFile({ accessToken: 'access-1', refreshAt: Date.now() + 80 * DAY })
    const http = createHttp({ auth: oauth(file, figma.fetchImpl), apiBase: API }, figma.fetchImpl)

    const result = await http.json('/v1/files/KEY')
    expect(result).toMatchObject({ ok: false, status: 401 })
    expect(!result.ok && result.message).toContain('expired or was revoked. Call auth_login')
    await expect(readFile(file)).rejects.toThrow()
    figma.calls.length = 0
    const next = await http.json('/v1/files/KEY')
    expect(!next.ok && next.message).toContain('expired or was revoked. Call auth_login')
    expect(figma.calls).toEqual([])
    expect(JSON.stringify([result, next])).not.toMatch(/refresh-1|access-1|shh-secret/)
  })

  it('renews a short-lived token halfway through its life, not on every request', async () => {
    const figma = fakeFigma({ tokens: ['access-1', 'access-2'], issue: ['access-1', 'access-2'], lifetime: 3600 })
    let now = 1_000_000
    const file = await authFile({ accessToken: 'access-0', refreshAt: 0 })
    const auth = new OAuth({ clientId: 'client', clientSecret: 'shh-secret', file, apiBase: API, port: nextPort++, fetch: figma.fetchImpl, now: () => now })
    const http = createHttp({ auth, apiBase: API }, figma.fetchImpl)
    const paths = async () => {
      figma.calls.length = 0
      await http.json('/v1/files/KEY')
      return figma.calls.map((c) => c.path)
    }

    expect(await paths()).toEqual(['/v1/oauth/refresh', '/v1/files/KEY'])
    now += 1800_000 - 1
    expect(await paths()).toEqual(['/v1/files/KEY'])
    now += 1
    expect(await paths()).toEqual(['/v1/oauth/refresh', '/v1/files/KEY'])
  })

  it('ignores a sign-in made with another OAuth app', async () => {
    const figma = fakeFigma({ tokens: ['access-1'] })
    const file = await authFile({ accessToken: 'access-1', refreshAt: Date.now() + 80 * DAY, clientId: 'other-app' })
    const result = await createHttp({ auth: oauth(file, figma.fetchImpl), apiBase: API }, figma.fetchImpl).json('/v1/files/KEY')
    expect(!result.ok && result.message).toContain('Not signed in')
  })
})

describe('loadConfig', () => {
  it('prefers the OAuth app to a personal access token', () => {
    const config = loadConfig({ FIGMA_CLIENT_ID: 'id', FIGMA_CLIENT_SECRET: 'secret', FIGMA_TOKEN: 'figd_x' })
    expect(config.credentials).toEqual({ kind: 'oauth', clientId: 'id', clientSecret: 'secret' })
  })

  it('refuses half an OAuth app', () => {
    expect(() => loadConfig({ FIGMA_CLIENT_ID: 'id', FIGMA_TOKEN: 'figd_x' })).toThrow('set both FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET')
  })
})
