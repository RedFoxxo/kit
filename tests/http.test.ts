import { describe, expect, it } from 'vitest'
import { tokenAuth } from '../src/figma/auth.js'
import { createHttp } from '../src/figma/http.js'

const http = (fetchImpl: typeof fetch) => createHttp({ auth: tokenAuth('figd_secret'), apiBase: 'https://api.test' }, fetchImpl)

describe('http.bytes', () => {
  it('stops a download larger than the limit instead of holding it in memory', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const result = await http(async () => new Response(endless, { status: 200 })).bytes('https://img.test/big.png', undefined, 1024 * 1024)
    expect(result).toMatchObject({ ok: false, message: 'larger than 1 MB' })
    expect(pulled).toBeLessThan(40)
  })

  it('refuses a download whose declared size is over the limit before reading it', async () => {
    const result = await http(async () => new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } })).bytes(
      'https://img.test/big.png',
      undefined,
      1024 * 1024,
    )
    expect(result).toMatchObject({ ok: false, message: 'larger than 1 MB' })
  })

  it('reports a failed download without the body or a hint about the Figma credential', async () => {
    const result = await http(async () => new Response('internal secret page', { status: 403, statusText: 'Forbidden' })).bytes('http://10.0.0.1/admin')
    expect(result).toEqual({ ok: false, status: 403, message: '403 Forbidden' })
  })
})
