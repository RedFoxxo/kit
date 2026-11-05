import { listen, type Socket } from './ws.js'

/** Ports kit tries in order; the plugin connects to every kit listening in this range. Keep in sync with plugin/. */
export const PORTS = [7380, 7381, 7382, 7383, 7384, 7385, 7386, 7387, 7388, 7389] as const

/** Plugin methods and parameters this kit expects; must equal PROTOCOL in plugin/code.js. */
export const PROTOCOL = 2

/** What the plugin reports about the file it runs in. */
export interface PluginInfo {
  fileKey: string | null
  fileName: string
  page: { id: string; name: string }
  user: string | null
  selection: number
  pluginVersion: string
  /** Missing in plugins older than protocol 2. */
  protocol?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class Connection {
  info: PluginInfo | undefined
  readonly since = new Date()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly socket: Socket) {
    socket.onMessage = (text) => this.receive(text)
  }

  /** Runs a method in the plugin; rejects on plugin error, timeout or disconnect. */
  request<T>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`plugin did not answer "${method}" within ${timeoutMs / 1000}s; it may still be running in Figma, so check the file before retrying`))
    }, timeoutMs)
    this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  dropAll(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('plugin disconnected'))
    }
    this.pending.clear()
  }

  private receive(text: string): void {
    let msg: { id?: number; result?: unknown; error?: string }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error !== undefined) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }
}

/** The plugin connections of this kit process. */
export class Bridge {
  readonly connections = new Set<Connection>()
  port: number | undefined
  /** Why the bridge is not listening, when it is not. */
  problem: string | undefined
  private server: { close(): Promise<void> } | undefined

  async start(ports: readonly number[] = PORTS): Promise<void> {
    for (const port of ports) {
      try {
        this.server = await listen(port, (socket) => this.accept(socket))
        this.port = port
        this.problem = undefined
        return
      } catch {
        // Port taken (another kit, another app): try the next.
      }
    }
    this.problem = `ports ${ports[0]}–${ports[ports.length - 1]} are all in use`
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.dropAll()
    await this.server?.close()
  }

  private accept(socket: Socket): void {
    const connection = new Connection(socket)
    this.connections.add(connection)
    socket.onClose = () => {
      connection.dropAll()
      this.connections.delete(connection)
    }
    connection.request<PluginInfo>('info').then(
      (info) => (connection.info = info),
      () => undefined,
    )
  }
}
