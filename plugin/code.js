// kit bridge, plugin side: runs requests from kit with the Plugin API.
// The UI iframe holds the WebSocket; this file has no network access.
const VERSION = '0.1.0'
// Bump with PROTOCOL in src/bridge/bridge.ts whenever methods or their parameters change.
const PROTOCOL = 2
const DEFAULT_FONT = { family: 'Inter', style: 'Regular' }

figma.showUI(__html__, { width: 260, height: 110, themeColors: true })

function hexPaint(hex) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex).trim())
  if (!m) throw new Error(`not a color: ${hex}`)
  const n = parseInt(m[1], 16)
  return {
    type: 'SOLID',
    color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 },
    opacity: m[2] ? parseInt(m[2], 16) / 255 : 1,
  }
}

const paints = (value) => (Array.isArray(value) ? value : [value]).map((p) => (typeof p === 'string' ? hexPaint(p) : p))
const summary = (n) => ({ id: n.id, type: n.type, name: n.name })

/** Effects from shorthand ({ type: 'drop' | 'inner' | 'glow' | 'blur' | 'background-blur', color, x, y, radius, spread }) or Figma's own shape. */
function effects(value) {
  return (Array.isArray(value) ? value : [value]).map((e) => {
    if (/^[A-Z_]+$/.test(e.type)) return e
    if (e.type === 'blur' || e.type === 'background-blur') {
      return { type: e.type === 'blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: e.radius ?? 8, visible: true }
    }
    const p = hexPaint(e.color ?? '#00000040')
    const glow = e.type === 'glow'
    return {
      type: e.type === 'inner' ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { ...p.color, a: p.opacity },
      offset: { x: glow ? 0 : (e.x ?? 0), y: glow ? 0 : (e.y ?? 4) },
      radius: e.radius ?? (glow ? 16 : 8),
      spread: e.spread ?? 0,
      visible: true,
      blendMode: 'NORMAL',
    }
  })
}

async function nodeById(id) {
  const n = await figma.getNodeByIdAsync(id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

/** Fonts used by a text node must be loaded before any text change. */
async function loadFonts(n) {
  if (n.type !== 'TEXT') throw new Error(`${n.id} is ${n.type}, not TEXT`)
  const fonts = n.characters.length > 0 ? n.getRangeAllFontNames(0, n.characters.length) : [n.fontName]
  for (const f of fonts) if (f !== figma.mixed) await figma.loadFontAsync(f)
}

async function localStyle(kind, name) {
  const list =
    kind === 'paint' ? await figma.getLocalPaintStylesAsync() : kind === 'text' ? await figma.getLocalTextStylesAsync() : await figma.getLocalEffectStylesAsync()
  const s = list.find((x) => x.id === name || x.name === name)
  if (!s) throw new Error(`no ${kind} style "${name}"`)
  return s
}

const PLAIN = new Set([
  'name', 'visible', 'locked', 'x', 'y', 'rotation', 'opacity', 'blendMode', 'cornerRadius', 'strokeWeight', 'strokeAlign',
  'itemSpacing', 'counterAxisSpacing', 'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutSizingHorizontal',
  'layoutSizingVertical', 'layoutWrap', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'clipsContent', 'constraints', 'arcData',
])
const TEXT_PLAIN = new Set(['fontSize', 'textAlignHorizontal', 'textAutoResize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration'])

async function apply(n, props) {
  for (const [k, v] of Object.entries(props)) {
    if (PLAIN.has(k)) n[k] = v
    else if (TEXT_PLAIN.has(k)) {
      await loadFonts(n)
      n[k] = v
    } else if (k === 'text') {
      await loadFonts(n)
      n.characters = String(v)
    } else if (k === 'fontName') {
      await figma.loadFontAsync(v)
      await loadFonts(n)
      n.fontName = v
    } else if (k === 'width') n.resize(v, n.height)
    else if (k === 'height') n.resize(n.width, v)
    else if (k === 'padding') {
      const [t, r, b, l] = Array.isArray(v) ? (v.length === 2 ? [v[0], v[1], v[0], v[1]] : v) : [v, v, v, v]
      Object.assign(n, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l })
    } else if (k === 'fills') n.fills = paints(v)
    else if (k === 'effects') n.effects = effects(v)
    else if (k === 'strokes') n.strokes = paints(v)
    else if (k === 'fillStyle') await n.setFillStyleIdAsync((await localStyle('paint', v)).id)
    else if (k === 'strokeStyle') await n.setStrokeStyleIdAsync((await localStyle('paint', v)).id)
    else if (k === 'effectStyle') await n.setEffectStyleIdAsync((await localStyle('effect', v)).id)
    else if (k === 'textStyle') {
      const s = await localStyle('text', v)
      await figma.loadFontAsync(s.fontName)
      await n.setTextStyleIdAsync(s.id)
    } else if (k === 'componentProperties') n.setProperties(v)
    else if (k === 'parent') (await nodeById(String(v))).appendChild(n)
    else if (k === 'index') n.parent.insertChild(v, n)
    else throw new Error(`unknown property "${k}"`)
  }
  // Turning on auto layout makes a frame hug its content, which would undo an
  // explicit width or height. A size given without its own sizing mode stays fixed.
  if ('layoutMode' in n && n.layoutMode !== 'NONE') {
    const w = 'width' in props && !('layoutSizingHorizontal' in props)
    const h = 'height' in props && !('layoutSizingVertical' in props)
    if (w) n.layoutSizingHorizontal = 'FIXED'
    if (h) n.layoutSizingVertical = 'FIXED'
    if (w || h) n.resize(w ? props.width : n.width, h ? props.height : n.height)
  }
}

async function make(spec) {
  if (spec.type === 'FRAME') return figma.createFrame()
  if (spec.type === 'SECTION') return figma.createSection()
  if (spec.type === 'RECTANGLE') return figma.createRectangle()
  if (spec.type === 'ELLIPSE') return figma.createEllipse()
  if (spec.type === 'TEXT') {
    await figma.loadFontAsync(DEFAULT_FONT)
    const t = figma.createText()
    t.fontName = DEFAULT_FONT
    return t
  }
  if (spec.type === 'INSTANCE') {
    const component = spec.componentKey ? await figma.importComponentByKeyAsync(spec.componentKey) : await nodeById(spec.componentId)
    if (component.type !== 'COMPONENT') throw new Error(`${component.id} is ${component.type}, not COMPONENT`)
    return component.createInstance()
  }
  throw new Error(`cannot create ${spec.type}`)
}

/** Runs each item, collecting per-item errors, and makes the whole call one undo step. */
async function each(items, label, fn) {
  const changed = []
  const errors = []
  for (const item of items) {
    try {
      changed.push(await fn(item))
    } catch (error) {
      errors.push(`${label(item)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  figma.commitUndo()
  return { changed, errors }
}

const methods = {
  async info() {
    return {
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      user: figma.currentUser ? figma.currentUser.name : null,
      selection: figma.currentPage.selection.length,
      pluginVersion: VERSION,
      protocol: PROTOCOL,
    }
  },
  props: ({ edits }) =>
    each(edits, (e) => e.id, async (e) => {
      const n = await nodeById(e.id)
      await apply(n, e.props)
      return summary(n)
    }),
  async create({ parent, nodes }) {
    const target = parent ? await nodeById(parent) : figma.currentPage
    const changed = []
    const errors = []
    // A spec may carry `children`, built inside it, so a whole tree is one call and one undo step.
    const build = async (spec, into, depth) => {
      let n
      try {
        n = await make(spec)
        into.appendChild(n)
        await apply(n, spec.props || {})
      } catch (error) {
        if (n) n.remove()
        const name = spec.props && spec.props.name ? ` "${spec.props.name}"` : ''
        errors.push(`${spec.type}${name}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      changed.push({ ...summary(n), depth })
      for (const child of spec.children || []) await build(child, n, depth + 1)
    }
    for (const spec of nodes) await build(spec, target, 0)
    figma.commitUndo()
    return { changed, errors }
  },
  delete: ({ ids }) =>
    each(ids, (id) => id, async (id) => {
      const n = await nodeById(id)
      const s = summary(n)
      n.remove()
      return s
    }),
  async exec({ code }) {
    const run = new Function('figma', `return (async () => {\n${code}\n})()`)
    const value = await run(figma)
    figma.commitUndo()
    return { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }
  },
  /** A picture of the node as it is now in the editor, longest side `maxEdge`. */
  async render({ id, maxEdge, format }) {
    const n = await nodeById(id)
    if (!('exportAsync' in n) || !('width' in n)) throw new Error(`${n.id} (${n.type}) cannot be exported`)
    const scale = Math.min(2, maxEdge / Math.max(n.width, n.height))
    const bytes = await n.exportAsync({ format: format === 'jpg' ? 'JPG' : 'PNG', constraint: { type: 'SCALE', value: scale } })
    return { data: figma.base64Encode(bytes), width: Math.round(n.width * scale), height: Math.round(n.height * scale), name: n.name }
  },
}

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== 'request') return
  const { port, id, method, params } = msg
  const handler = methods[method]
  try {
    if (!handler) throw new Error(`unknown method "${method}"`)
    const result = await handler(params || {})
    figma.ui.postMessage({ type: 'response', port, id, result })
  } catch (error) {
    figma.ui.postMessage({ type: 'response', port, id, error: error instanceof Error ? error.message : String(error) })
  }
}
