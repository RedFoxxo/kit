import { afterEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/bridge/bridge.js'
import { readRender } from '../src/tools/read/render.js'
import { readFrameText } from '../src/tools/read/text.js'
import { writeComment } from '../src/tools/write/comment.js'
import { deleteNodes, execRun, writeCreate, writeProps } from '../src/tools/write/edit.js'
import { KEY, context, sampleFile, textOf } from './fixture.js'

const PORTS = [47390]
const bridges: Bridge[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await Promise.all(bridges.splice(0).map((b) => b.stop()))
})

/** A plugin in file `fileName`/`fileKey` that records requests and answers like the real one; `protocol: null` plays an old plugin. */
async function setup(fileKey: string | null, fileName = 'Sample App', protocol: number | null = 2) {
  const bridge = new Bridge()
  bridges.push(bridge)
  await bridge.start(PORTS)
  const requests: { method: string; params: unknown }[] = []
  const ws = new WebSocket(`ws://localhost:${bridge.port}`)
  clients.push(ws)
  ws.onmessage = (event) => {
    const { id, method, params } = JSON.parse(String(event.data))
    requests.push({ method, params })
    const reply = (result: unknown) => ws.send(JSON.stringify({ id, result }))
    if (method === 'info') reply({ fileKey, fileName, page: { id: '0:1', name: 'WebApp' }, user: 'Ada', selection: 0, pluginVersion: '0.1.0', protocol: protocol ?? undefined })
    else if (method === 'props') reply({ changed: [{ id: '2:3', type: 'TEXT', name: 'Società' }], errors: ['9:9: no node 9:9'] })
    else if (method === 'create') reply({ changed: [{ id: '5:1', type: 'FRAME', name: 'Card', depth: 0 }, { id: '5:2', type: 'TEXT', name: 'Title', depth: 1 }], errors: [] })
    else if (method === 'delete') reply({ changed: [], errors: ['9:9: no node 9:9'] })
    else if (method === 'render') reply({ data: Buffer.from('LIVE').toString('base64'), width: 400, height: 300, name: 'Card' })
    else if (method === 'exec') ws.send(JSON.stringify({ id, error: 'boom is not defined' }))
  }
  const { promise, resolve } = Promise.withResolvers<void>()
  ws.onopen = () => resolve()
  await promise
  const ctx = { ...(await context()), bridge }
  return { ctx, requests }
}

describe('write tools', () => {
  it('send edits to the plugin in that file and report only what changed', async () => {
    const { ctx, requests } = await setup(KEY)
    const out = await writeProps.handler({ file: KEY, edits: [{ id: '2-3', props: { text: 'Gruppi' } }, { id: '9:9', props: {} }] }, ctx)
    expect(requests.at(-1)).toEqual({ method: 'props', params: { edits: [{ id: '2:3', props: { text: 'Gruppi' } }, { id: '9:9', props: {} }] } })
    expect(textOf(out)).toBe('1 node(s) changed in "Sample App" (one undo step):\n- 2:3 TEXT "Società"\n! 9:9: no node 9:9')
    expect(out.isError).toBeUndefined()
  })

  it('match a plugin without file key by the file name', async () => {
    const { ctx, requests } = await setup(null)
    await deleteNodes.handler({ file: KEY, ids: ['2:3'] }, ctx)
    expect(requests.map((r) => r.method)).toContain('delete')
  })

  it('refuse to edit when the plugin runs in another file', async () => {
    const { ctx, requests } = await setup('OTHERKEY1234', 'Other')
    const out = await writeProps.handler({ file: KEY, edits: [{ id: '2:3', props: { text: 'x' } }] }, ctx)
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('Running in: "Other" (OTHERKEY1234)')
    expect(requests.map((r) => r.method)).not.toContain('props')
  })

  it('mark a call where every item failed as an error', async () => {
    const { ctx } = await setup(KEY)
    expect((await deleteNodes.handler({ file: KEY, ids: ['9:9'] }, ctx)).isError).toBe(true)
  })

  it('check the file version again after an edit', async () => {
    const { ctx } = await setup(KEY)
    await ctx.files.get(KEY)
    await writeProps.handler({ file: KEY, edits: [{ id: '2:3', props: { text: 'x' } }] }, ctx)
    const metaCalls = () => ctx.http.calls.filter((c) => c.endsWith('/meta')).length
    const before = metaCalls()
    await ctx.files.get(KEY)
    expect(metaCalls()).toBe(before + 1)
  })

  it('flag reads that do not show a plugin edit yet, until the API catches up', async () => {
    const { ctx } = await setup(KEY)
    await ctx.files.get(KEY)
    await writeProps.handler({ file: KEY, edits: [{ id: '2:3', props: { text: 'x' } }] }, ctx)
    const behind = await readFrameText.handler({ file: KEY, ids: ['2:1'] }, ctx)
    expect(textOf(behind)).toContain('does not show your latest plugin edits yet')
    ctx.http.routes[`/v1/files/${KEY}/meta`] = { file: { name: 'Sample App', version: 'v2' } }
    ctx.http.routes[`/v1/files/${KEY}`] = sampleFile('v2')
    expect(textOf(await readFrameText.handler({ file: KEY, ids: ['2:1'] }, ctx))).not.toContain('does not show')
  })

  it('refuse an outdated plugin and say how to update it', async () => {
    const { ctx, requests } = await setup(KEY, 'Sample App', null)
    const out = await writeProps.handler({ file: KEY, edits: [{ id: '2:3', props: { text: 'x' } }] }, ctx)
    expect(textOf(out)).toContain('is outdated (protocol 1, kit needs 2). Run `kit plugin`')
    expect(requests.map((r) => r.method)).not.toContain('props')
  })

  it('report nodes created inside others indented under their parent', async () => {
    const { ctx, requests } = await setup(KEY)
    const nodes = [{ type: 'FRAME' as const, props: { name: 'Card' }, children: [{ type: 'TEXT' as const, props: { text: 'Title' } }] }]
    const out = await writeCreate.handler({ file: KEY, nodes }, ctx)
    expect(requests.at(-1)).toEqual({ method: 'create', params: { nodes } })
    expect(textOf(out)).toBe('2 node(s) created in "Sample App" (one undo step):\n- 5:1 FRAME "Card"\n  - 5:2 TEXT "Title"')
  })

  it('render live through the plugin, without the REST image API', async () => {
    const { ctx } = await setup(KEY)
    const out = await readRender.handler({ file: KEY, id: '2-1', maxEdge: 400 }, ctx)
    expect(textOf(out)).toContain('400×300 png (live)')
    expect(out.content[1]).toMatchObject({ type: 'image', data: Buffer.from('LIVE').toString('base64') })
    expect(ctx.http.calls.some((c) => c.startsWith('/v1/images'))).toBe(false)
  })

  it('return plugin errors from exec_run', async () => {
    const { ctx } = await setup(KEY)
    const out = await execRun.handler({ file: KEY, code: 'return boom' }, ctx)
    expect(out.isError).toBe(true)
    expect(textOf(out)).toBe('Plugin error: boom is not defined')
  })
})

describe('write_comment', () => {
  it('pins a comment to a node, or replies to a thread', async () => {
    const ctx = await context()
    expect(textOf(await writeComment.handler({ file: KEY, message: 'Manca la durata', node: '2-3' }, ctx))).toBe('Comment #777 posted on 2-3.')
    expect(ctx.http.calls.at(-1)).toBe(`POST /v1/files/${KEY}/comments {"message":"Manca la durata","client_meta":{"node_id":"2:3","node_offset":{"x":0,"y":0}}}`)
    await writeComment.handler({ file: KEY, message: 'Ok', replyTo: '#12' }, ctx)
    expect(ctx.http.calls.at(-1)).toBe(`POST /v1/files/${KEY}/comments {"message":"Ok","comment_id":"12"}`)
  })

  it('refuses an unknown node before posting', async () => {
    const ctx = await context()
    const out = await writeComment.handler({ file: KEY, message: 'x', node: '99:9' }, ctx)
    expect(out.isError).toBe(true)
    expect(ctx.http.calls.some((c) => c.startsWith('POST'))).toBe(false)
  })
})
