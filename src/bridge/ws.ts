import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

/** RFC 6455 handshake suffix. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Largest message accepted from a plugin (a big node tree as JSON). */
const MAX_MESSAGE = 64 * 1024 * 1024

/**
 * One WebSocket connection: text messages only, which is all the Figma plugin
 * sends. Minimal on purpose (no extensions, no subprotocols), so kit needs no
 * WebSocket dependency.
 */
export class Socket {
  onMessage: (text: string) => void = () => {}
  onClose: () => void = () => {}
  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private closed = false

  constructor(
    private readonly stream: Duplex,
    private readonly maxMessage = MAX_MESSAGE,
  ) {
    stream.on('data', (chunk: Buffer) => this.receive(chunk))
    // The client went away without a close frame: end our side too, or the half-open socket keeps the server from closing.
    stream.on('end', () => this.close())
    stream.on('close', () => this.finish())
    stream.on('error', () => this.finish())
  }

  send(text: string): void {
    if (this.closed) return
    const payload = Buffer.from(text, 'utf8')
    this.stream.write(Buffer.concat([header(0x1, payload.length), payload]))
  }

  close(): void {
    if (this.closed) return
    this.stream.write(header(0x8, 0))
    this.stream.end()
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]!
      const b1 = this.buffer[1]!
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (length > this.maxMessage) return this.close()
      const masked = (b1 & 0x80) !== 0
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
      this.frame(b0 & 0x0f, (b0 & 0x80) !== 0, payload)
      if (this.closed) return
    }
  }

  private frame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) return this.close()
    if (opcode === 0x9) {
      this.stream.write(Buffer.concat([header(0xa, payload.length), payload]))
      return
    }
    if (opcode === 0x1 || (opcode === 0x0 && this.fragments.length > 0)) {
      this.fragmentBytes += payload.length
      // Each frame is checked above; this bounds a message sent as endless fragments.
      if (this.fragmentBytes > this.maxMessage) return this.close()
      this.fragments.push(payload)
      if (!fin) return
      const text = Buffer.concat(this.fragments).toString('utf8')
      this.fragments = []
      this.fragmentBytes = 0
      this.onMessage(text)
    }
    // Binary frames and pongs are ignored.
  }
}

function header(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length])
  if (length < 65536) {
    const h = Buffer.alloc(4)
    h[0] = 0x80 | opcode
    h[1] = 126
    h.writeUInt16BE(length, 2)
    return h
  }
  const h = Buffer.alloc(10)
  h[0] = 0x80 | opcode
  h[1] = 127
  h.writeBigUInt64BE(BigInt(length), 2)
  return h
}

function sameKey(given: string | null, key: string): boolean {
  if (given === null) return false
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ListenOptions {
  /** Secret the plugin sends as `?key=`: `kit plugin` writes it into the plugin's copy of ui.html. */
  key: string
  onSocket: (socket: Socket) => void
  /** A loopback client with origin "null" or none, but without the key: an outdated plugin, or a page posing as one. */
  onRefused?: () => void
}

/**
 * Listens on loopback only (127.0.0.1, plus ::1 when available) and accepts
 * upgrades that name a loopback host, come without an origin or with origin
 * "null" (what a Figma plugin iframe sends), and carry the key. Websites are
 * refused by origin; a sandboxed iframe, which also sends "null", by the key,
 * which only the user's files hold.
 */
export async function listen(port: number, opts: ListenOptions): Promise<{ close(): Promise<void> }> {
  // Host headers a loopback client sends; anything else is DNS rebinding or not meant for kit.
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
  const upgrade = (req: IncomingMessage, stream: Duplex) => {
    const origin = req.headers.origin
    const accept = req.headers['sec-websocket-key']
    if ((origin !== undefined && origin !== 'null') || !hosts.includes(req.headers.host ?? '') || typeof accept !== 'string') {
      stream.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (!sameKey(URL.parse(req.url ?? '/', 'ws://localhost')?.searchParams.get('key') ?? null, opts.key)) {
      stream.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      opts.onRefused?.()
      return
    }
    const hash = createHash('sha1').update(accept + GUID).digest('base64')
    stream.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`)
    opts.onSocket(new Socket(stream))
  }
  const make = () => {
    const server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('kit bridge: WebSocket only\n')
    })
    server.on('upgrade', upgrade)
    return server
  }
  const bind = (server: Server, host: string) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
    return promise
  }

  const v4 = make()
  await bind(v4, '127.0.0.1')
  const servers = [v4]
  const v6 = make()
  // Browsers may resolve localhost to ::1 first; best effort, IPv4 is enough.
  await bind(v6, '::1').then(
    () => servers.push(v6),
    () => undefined,
  )
  return {
    close: async () => {
      for (const s of servers) {
        const { promise, resolve } = Promise.withResolvers<void>()
        s.close(() => resolve())
        s.closeAllConnections()
        await promise
      }
    },
  }
}
