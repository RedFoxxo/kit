import { describe, expect, it } from 'vitest'
import { FileStore } from '../src/figma/store.js'
import { KEY, context, sampleFile } from './fixture.js'

const META = `/v1/files/${KEY}/meta`
const FILE = `/v1/files/${KEY}`

describe('FileStore', () => {
  it('downloads a file once per version', async () => {
    let now = 0
    const ctx = await context()
    const files = new FileStore(ctx.http, ctx.dir, () => now)

    await files.get(KEY)
    now = 61_000
    await files.get(KEY)
    expect(ctx.http.calls.filter((c) => c === FILE)).toHaveLength(1)

    ctx.http.routes[META] = { file: { name: 'x', version: 'v2' } }
    ctx.http.routes[FILE] = sampleFile('v2')
    now = 122_000
    const updated = await files.get(KEY)
    expect(updated.ok && updated.data.version).toBe('v2')
    expect(ctx.http.calls.filter((c) => c === FILE)).toHaveLength(2)
  })

  it('makes no request while the last check is recent', async () => {
    let now = 0
    const ctx = await context()
    const files = new FileStore(ctx.http, ctx.dir, () => now)
    await files.get(KEY)
    const before = ctx.http.calls.length
    now = 59_000
    await files.get(KEY)
    expect(ctx.http.calls.length).toBe(before)
  })

  it('reuses the disk snapshot in a new session', async () => {
    const ctx = await context()
    await new FileStore(ctx.http, ctx.dir).get(KEY)
    ctx.http.calls.length = 0
    const again = await new FileStore(ctx.http, ctx.dir).get(KEY)
    expect(again.ok).toBe(true)
    expect(ctx.http.calls).toEqual([META])
  })

  it('keeps the loaded file when the version check fails', async () => {
    let now = 0
    const ctx = await context()
    const files = new FileStore(ctx.http, ctx.dir, () => now)
    await files.get(KEY)
    ctx.http.routes[META] = new Error('boom')
    now = 61_000
    const result = await files.get(KEY)
    expect(result.ok).toBe(true)
    expect(ctx.http.calls.filter((c) => c === FILE)).toHaveLength(1)
  })

  it('reports a failed download', async () => {
    const ctx = await context()
    ctx.http.routes[FILE] = new Error('denied')
    const result = await new FileStore(ctx.http, ctx.dir).get(KEY)
    expect(result.ok).toBe(false)
  })
})

describe('FigmaFile', () => {
  it('finds the screen and location of a nested node', async () => {
    const ctx = await context()
    const loaded = await ctx.files.get(KEY)
    if (!loaded.ok) throw new Error('load failed')
    expect(loaded.data.frameOf('2:8')?.id).toBe('2:1')
    expect(loaded.data.where('2:8')).toBe('WebApp › Review 2')
    expect(loaded.data.frameOf('1:1')).toBeUndefined()
  })
})
