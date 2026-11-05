import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/bridge/bridge.js'
import { readBridge } from '../src/tools/read/bridge.js'
import { context, textOf } from './fixture.js'

// Ports away from the real range, so a running kit does not interfere.
const PORTS = [47380, 47381]
const bridges: Bridge[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await Promise.all(bridges.splice(0).map((b) => b.stop()))
})

async function started(ports = PORTS): Promise<Bridge> {
  const bridge = new Bridge()
  bridges.push(bridge)
  await bridge.start(ports)
  return bridge
}

/** A fake plugin: answers `info`, echoes `echo`, fails anything else. */
async function plugin(port: number, fileName = 'Sample App'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`)
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

  it('refuses web pages with a real origin', async () => {
    const bridge = await started()
    const { promise, resolve } = Promise.withResolvers<number | undefined>()
    const req = request({
      host: '127.0.0.1',
      port: bridge.port,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://evil.example', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
    })
    req.on('upgrade', () => resolve(101))
    req.on('response', (res) => resolve(res.statusCode))
    req.on('error', () => resolve(undefined))
    req.end()
    expect(await promise).not.toBe(101)
    expect(bridge.connections.size).toBe(0)
  })
})
