import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

/**
 * Just enough of Figma's Plugin API to run plugin/code.js in Node. It keeps
 * Figma's rules that matter to kit: text needs its fonts loaded, removed nodes
 * stay removed, variants must be components.
 */
export class FakeNode {
  /** Props the plugin sets that the fake does not model (padding, opacity, …). */
  [key: string]: unknown
  children: FakeNode[] = []
  parent: FakeNode | undefined
  removed = false
  name: string
  width = 100
  height = 100
  fills: unknown[] = []
  strokes: unknown[] = []
  effects: unknown[] = []
  layoutMode = 'NONE'
  layoutSizingHorizontal = 'FIXED'
  layoutSizingVertical = 'FIXED'
  characters = ''
  fontName = { family: 'Inter', style: 'Regular' }
  /** setRange* calls, as [method, start, end, value]. */
  ranges: [string, number, number, unknown][] = []

  constructor(
    private readonly fake: FakeFigma,
    readonly id: string,
    readonly type: string,
  ) {
    this.name = type.charAt(0) + type.slice(1).toLowerCase()
    fake.nodes.set(id, this)
    if (type === 'TEXT') {
      // Figma refuses text changes until every font of the node is loaded.
      const guard = (key: 'characters' | 'fontName') => {
        let value = this[key]
        Object.defineProperty(this, key, {
          get: () => value,
          set: (v) => {
            fake.needFont(this.fontName)
            if (key === 'fontName') fake.needFont(v)
            value = v
          },
        })
      }
      guard('characters')
      guard('fontName')
      for (const m of ['FontName', 'FontSize', 'Fills', 'TextDecoration', 'TextCase', 'LetterSpacing', 'Hyperlink']) {
        this[`setRange${m}`] = (s: number, e: number, v: unknown) => {
          fake.needFont(this.fontName)
          if (m === 'FontName') fake.needFont(v as { family: string; style: string })
          this.ranges.push([m, s, e, v])
        }
      }
    }
  }

  appendChild(child: FakeNode): void {
    child.detach()
    child.parent = this
    this.children.push(child)
  }

  insertChild(index: number, child: FakeNode): void {
    child.detach()
    child.parent = this
    this.children.splice(index, 0, child)
  }

  detach(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = undefined
  }

  remove(): void {
    this.detach()
    this.removed = true
  }

  resize(w: number, h: number): void {
    this.width = w
    this.height = h
  }

  getRangeAllFontNames(): { family: string; style: string }[] {
    return [this.fontName]
  }

  createInstance(): FakeNode {
    return this.fake.create('INSTANCE')
  }
}

export class FakeFigma {
  nodes = new Map<string, FakeNode>()
  loadedFonts = new Set<string>()
  posted: { id: number; result?: unknown; error?: string }[] = []
  /** `figma.ui`; the plugin sets `onmessage` on it when it loads. */
  ui: { postMessage: (m: { id: number; result?: unknown; error?: string }) => void; onmessage?: (m: unknown) => Promise<void> }
  undoSteps = 0
  zoomedTo: string[] = []
  variables: { collections: unknown[]; variables: unknown[] } = { collections: [], variables: [] }
  private next = 1
  page: FakeNode
  /** The `figma` global the plugin sees. */
  api: Record<string, unknown>

  constructor() {
    this.page = new FakeNode(this, '0:1', 'PAGE')
    this.page.name = 'Page 1'
    this.page.selection = []
    const self = this
    this.ui = { postMessage: (m) => void this.posted.push(m) }
    const ui = this.ui
    this.api = {
      mixed: Symbol('mixed'),
      fileKey: 'KEY123',
      root: { name: 'Test file' },
      currentUser: { name: 'Ada' },
      get currentPage() {
        return self.page
      },
      ui,
      showUI: () => undefined,
      getNodeByIdAsync: async (id: string) => {
        const n = this.nodes.get(id)
        return n && !n.removed ? n : null
      },
      loadFontAsync: async (f: { family: string; style: string }) => {
        if (f.family === 'Missing') throw new Error(`font ${f.family} ${f.style} not available`)
        this.loadedFonts.add(`${f.family}/${f.style}`)
      },
      createFrame: () => this.create('FRAME'),
      createComponent: () => this.create('COMPONENT'),
      createSection: () => this.create('SECTION'),
      createRectangle: () => this.create('RECTANGLE'),
      createEllipse: () => this.create('ELLIPSE'),
      createText: () => this.create('TEXT'),
      createImage: (bytes: Uint8Array) => ({ hash: `img-${bytes.length}` }),
      base64Decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
      base64Encode: (b: Uint8Array) => Buffer.from(b).toString('base64'),
      combineAsVariants: (parts: FakeNode[], parent: FakeNode) => {
        if (parts.some((p) => p.type !== 'COMPONENT')) throw new Error('combineAsVariants needs components')
        const set = this.create('COMPONENT_SET')
        parent.appendChild(set)
        for (const p of parts) set.appendChild(p)
        return set
      },
      createComponentFromNode: (n: FakeNode) => {
        const c = this.create('COMPONENT')
        c.name = n.name
        const parent = n.parent!
        const index = parent.children.indexOf(n)
        for (const child of [...n.children]) c.appendChild(child)
        n.remove()
        parent.insertChild(index, c)
        return c
      },
      commitUndo: () => this.undoSteps++,
      viewport: { scrollAndZoomIntoView: (ns: FakeNode[]) => (this.zoomedTo = ns.map((n) => n.id)) },
      variables: {
        getLocalVariableCollectionsAsync: async () => this.variables.collections,
        getLocalVariablesAsync: async () => this.variables.variables,
      },
    }
    const context = createContext({ figma: this.api, __html__: '', console })
    runInContext(readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8'), context)
  }

  create(type: string): FakeNode {
    return new FakeNode(this, `9:${this.next++}`, type)
  }

  needFont(f: { family: string; style: string }): void {
    if (!this.loadedFonts.has(`${f.family}/${f.style}`)) throw new Error(`font ${f.family} ${f.style} not loaded`)
  }

  /** Sends a request as kit does and returns the plugin's answer. */
  async call<T = PluginChangeResult>(method: string, params: unknown = {}): Promise<T> {
    const id = this.posted.length + 1
    await this.ui.onmessage!({ type: 'request', port: 7380, id, method, params })
    const answer = this.posted.find((p) => p.id === id)!
    if (answer.error !== undefined) throw new Error(answer.error)
    // Shape of the plugin's answer per method, as kit reads it.
    return answer.result as T
  }

  node(id: string): FakeNode {
    return this.nodes.get(id)!
  }
}

export interface PluginChangeResult {
  changed: { id: string; type: string; name: string; depth?: number }[]
  errors: string[]
}
