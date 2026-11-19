import { request } from 'node:http'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/bridge/bridge.js'
import { Socket } from '../src/bridge/ws.js'
import { readBridge } from '../src/tools/read/bridge.js'
import { context, textOf } from './fixture.js'

// Ports away from the real range, so a running kit does not interfere.
const PORTS = [47380, 47381]
const KEY = 'test-bridge-key'
const bridges: Bridge[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await Promise.all(bridges.splice(0).map((b) => b.stop()))
})

async function started(ports = PORTS): Promise<Bridge> {
  const bridge = new Bridge(KEY)
  bridges.push(bridge)
  await bridge.start(ports)
  return bridge
}

/** A fake plugin: answers `info`, echoes `echo`, fails anything else. */
async function plugin(port: number, fileName = 'Sample App', key = KEY): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/?key=${key}`)
  clients.push(ws)
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.method === 'info') {
      ws.send(JSON.stringify({ id: msg.id, result: { fileKey: 'KEY123', fileName, page: { id: '0:1', name: 'WebApp' }, user: 'Ada', selection: 2, pluginVersion: '0.1.0', protocol: 3 } }))
    } else if (msg.method === 'echo') ws.send(JSON.stringify({ id: msg.id, result: msg.params }))
    else ws.send(JSON.stringify({ id: msg.id, error: `unknown method "${msg.method}"` }))
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error('connect failed'))
  await promise
  return ws
}

describe('bridge', () => {
  it('reports a connected plugin with its file', async () => {
    const bridge = await started()
    await plugin(bridge.port!)
    const ctx = { ...(await context()), bridge }
    const out = textOf(await readBridge.handler({}, ctx))
    expect(out).toContain(`Bridge listening on port ${PORTS[0]}.`)
    expect(out).toContain('- "Sample App" key KEY123 · page 0:1 "WebApp" · 2 selected · user Ada')
  })

  it('carries messages of every frame length both ways', async () => {
    const bridge = await started()
    await plugin(bridge.port!)
    const connection = [...bridge.connections][0]!
    for (const size of [10, 300, 70_000]) {
      const text = 'x'.repeat(size)
      expect(await connection.request('echo', { text })).toEqual({ text })
    }
    await expect(connection.request('nope')).rejects.toThrow('unknown method "nope"')
  })

  it('moves to the next port when one is taken', async () => {
    const first = await started()
    const second = await started()
    expect([first.port, second.port]).toEqual(PORTS)
    const third = await started()
    expect(third.port).toBeUndefined()
    expect(third.problem).toContain('in use')
  })

  it('forgets a plugin that disconnects and fails its pending calls', async () => {
    const bridge = await started()
    const ws = await plugin(bridge.port!)
    const connection = [...bridge.connections][0]!
    ws.onmessage = () => {}
    const pending = connection.request('echo', {}, 2_000)
    ws.close()
    await expect(pending).rejects.toThrow('plugin disconnected')
    expect(bridge.connections.size).toBe(0)
  })

  it('refuses web pages with a real origin, even with the key', async () => {
    const bridge = await started()
    expect(await handshake(bridge.port!, { Origin: 'https://evil.example' })).not.toBe(101)
    expect(bridge.connections.size).toBe(0)
  })

  it('refuses a client without the key, such as a sandboxed page posing as the plugin, and says how to update the plugin', async () => {
    const bridge = await started()
    // A sandboxed iframe on any website sends origin "null", like the plugin does.
    expect(await handshake(bridge.port!, { Origin: 'null' }, '/')).toBe(403)
    expect(await handshake(bridge.port!, { Origin: 'null' }, '/?key=guess')).toBe(403)
    expect(await handshake(bridge.port!, { Origin: 'null' })).toBe(101)
    expect(bridge.refused).toBe(2)

    const idle = await started([PORTS[1]!])
    idle.refused = 1
    const out = textOf(await readBridge.handler({}, { ...(await context()), bridge: idle }))
    expect(out).toContain('1 connection refused')
    expect(out).toContain('kit plugin')
  })

  it('refuses a request for another host name (DNS rebinding)', async () => {
    const bridge = await started()
    expect(await handshake(bridge.port!, { Host: `evil.example:${bridge.port}` })).toBe(403)
    expect(await handshake(bridge.port!, { Host: `127.0.0.1:${bridge.port}` })).toBe(101)
  })
})

describe('WebSocket frames', () => {
  /** A socket on a stream whose readable side plays the client. */
  function socket(maxMessage: number) {
    const stream = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() })
    const s = new Socket(stream, maxMessage)
    const messages: string[] = []
    s.onMessage = (text) => messages.push(text)
    let closed = false
    s.onClose = () => (closed = true)
    return { stream, messages, closed: () => closed }
  }
  const frame = (opcode: number, fin: boolean, payload: string) => Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length]), Buffer.from(payload)])

  it('joins fragments into one message', async () => {
    const s = socket(100)
    s.stream.push(Buffer.concat([frame(0x1, false, 'hel'), frame(0x0, false, 'lo '), frame(0x0, true, 'kit')]))
    await expect.poll(() => s.messages).toEqual(['hello kit'])
  })

  it('closes the connection when fragments add up to more than the largest message', async () => {
    const s = socket(100)
    s.stream.push(frame(0x1, false, 'x'.repeat(60)))
    s.stream.push(frame(0x0, false, 'x'.repeat(60)))
    s.stream.push(frame(0x0, true, 'x'))
    await expect.poll(() => s.closed()).toBe(true)
    expect(s.messages).toEqual([])
  })
})

/** The status of a WebSocket handshake with the key and a loopback host unless `headers` or `path` say otherwise. */
function handshake(port: number, headers: Record<string, string>, path = `/?key=${KEY}`): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>()
  const req = request({
    host: '127.0.0.1',
    port,
    path,
    headers: { Host: `localhost:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers },
  })
  req.on('upgrade', (_res, stream) => {
    stream.destroy()
    resolve(101)
  })
  req.on('response', (res) => resolve(res.statusCode))
  req.on('error', () => resolve(undefined))
  req.end()
  return promise
}
