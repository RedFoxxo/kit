// kit bridge, plugin side: runs requests from kit with the Plugin API.
// The UI iframe holds the WebSocket; this file has no network access.
const VERSION = '1.0.0'
// Bump with PROTOCOL in src/bridge/bridge.ts whenever methods or their parameters change.
const PROTOCOL = 3
const DEFAULT_FONT = { family: 'Inter', style: 'Regular' }
/** Selected nodes listed by `info`; the count is always exact. */
const SELECTION_LIMIT = 50

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

/**
 * Character ranges a `textRanges` item targets: `start`/`end`, or every
 * (or the first, with `first: true`) occurrence of `text`.
 */
function rangesOf(characters, r) {
  if (typeof r.start === 'number') {
    const end = typeof r.end === 'number' ? r.end : characters.length
    if (r.start < 0 || end > characters.length || r.start >= end) throw new Error(`range ${r.start}–${end} outside the text (${characters.length} characters)`)
    return [[r.start, end]]
  }
  if (typeof r.text !== 'string' || r.text === '') throw new Error('a text range needs start/end or text')
  const found = []
  for (let i = characters.indexOf(r.text); i !== -1; i = characters.indexOf(r.text, i + r.text.length)) {
    found.push([i, i + r.text.length])
    if (r.first) break
  }
  if (found.length === 0) throw new Error(`"${r.text}" not found in the text`)
  return found
}

async function applyRanges(n, ranges) {
  await loadFonts(n)
  for (const r of ranges) {
    if (r.fontName) await figma.loadFontAsync(r.fontName)
    for (const [s, e] of rangesOf(n.characters, r)) {
      if (r.fontName) n.setRangeFontName(s, e, r.fontName)
      if (r.fontSize !== undefined) n.setRangeFontSize(s, e, r.fontSize)
      if (r.fills !== undefined) n.setRangeFills(s, e, paints(r.fills))
      if (r.textDecoration) n.setRangeTextDecoration(s, e, r.textDecoration)
      if (r.textCase) n.setRangeTextCase(s, e, r.textCase)
      if (r.letterSpacing !== undefined) n.setRangeLetterSpacing(s, e, r.letterSpacing)
      if (r.hyperlink !== undefined) n.setRangeHyperlink(s, e, r.hyperlink ? { type: 'URL', value: r.hyperlink } : null)
    }
  }
}

const PLAIN = new Set([
  'name', 'visible', 'locked', 'x', 'y', 'rotation', 'opacity', 'blendMode', 'cornerRadius', 'strokeWeight', 'strokeAlign',
  'itemSpacing', 'counterAxisSpacing', 'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutSizingHorizontal',
  'layoutSizingVertical', 'layoutWrap', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'clipsContent', 'constraints', 'arcData',
])
const TEXT_PLAIN = new Set(['fontSize', 'textAlignHorizontal', 'textAutoResize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration'])

/** Nodes to select and bring into view once the current call is done (`select: true`). */
let toSelect = []

/** Applies props; returns the node, which `component: true` replaces with a new component. */
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
    else if (k === 'image') {
      // kit has already read the file or URL and sends the bytes as base64.
      const image = figma.createImage(figma.base64Decode(v.data))
      n.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: v.scaleMode || 'FILL' }]
    } else if (k === 'fillStyle') await n.setFillStyleIdAsync((await localStyle('paint', v)).id)
    else if (k === 'strokeStyle') await n.setStrokeStyleIdAsync((await localStyle('paint', v)).id)
    else if (k === 'effectStyle') await n.setEffectStyleIdAsync((await localStyle('effect', v)).id)
    else if (k === 'textStyle') {
      const s = await localStyle('text', v)
      await figma.loadFontAsync(s.fontName)
      await n.setTextStyleIdAsync(s.id)
    } else if (k === 'componentProperties') n.setProperties(v)
    else if (k === 'parent') (await nodeById(String(v))).appendChild(n)
    else if (k === 'index') n.parent.insertChild(v, n)
    else if (k === 'textRanges' || k === 'component' || k === 'select') continue
    else throw new Error(`unknown property "${k}"`)
  }
  // Ranges after the loop, so they apply to the final text whatever the key order.
  if (props.textRanges) await applyRanges(n, props.textRanges)
  // Turning on auto layout makes a frame hug its content, which would undo an
  // explicit width or height. A size given without its own sizing mode stays fixed.
  if ('layoutMode' in n && n.layoutMode !== 'NONE') {
    const w = 'width' in props && !('layoutSizingHorizontal' in props)
    const h = 'height' in props && !('layoutSizingVertical' in props)
    if (w) n.layoutSizingHorizontal = 'FIXED'
    if (h) n.layoutSizingVertical = 'FIXED'
    if (w || h) n.resize(w ? props.width : n.width, h ? props.height : n.height)
  }
  if (props.component) {
    if (n.type === 'COMPONENT') throw new Error(`${n.id} is already a component`)
    n = figma.createComponentFromNode(n)
  }
  if (props.select) toSelect.push(n)
  return n
}

/**
 * A node created with auto layout hugs its content on any axis the props did
 * not size, as in the editor. Without this it keeps Figma's 100×100 default.
 */
function hugUnsized(n, props) {
  if (!('layoutMode' in n) || n.layoutMode === 'NONE') return
  if (!('width' in props) && !('layoutSizingHorizontal' in props)) n.layoutSizingHorizontal = 'HUG'
  if (!('height' in props) && !('layoutSizingVertical' in props)) n.layoutSizingVertical = 'HUG'
}

async function make(spec) {
  if (spec.type === 'FRAME') return figma.createFrame()
  if (spec.type === 'COMPONENT') return figma.createComponent()
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

// Errors thrown by the host API may come from another realm, where `instanceof Error` is false.
const message = (error) => (error && typeof error.message === 'string' ? error.message : String(error))

/** Ends a call that changed the document: one undo step, then select and show what was asked for. */
function finish() {
  const selected = toSelect.filter((n) => !n.removed)
  toSelect = []
  if (selected.length > 0) {
    figma.currentPage.selection = selected
    figma.viewport.scrollAndZoomIntoView(selected)
  }
  figma.commitUndo()
}

/** Runs each item, collecting per-item errors. */
async function each(items, label, fn) {
  const changed = []
  const errors = []
  for (const item of items) {
    try {
      changed.push(await fn(item))
    } catch (error) {
      errors.push(`${label(item)}: ${message(error)}`)
    }
  }
  finish()
  return { changed, errors }
}

/** A variable value as text: hex for colors, the variable name for aliases. */
function valueText(value, names) {
  if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') return `→ ${names.get(value.id) || value.id}`
  if (value && typeof value === 'object' && 'r' in value) {
    const ch = (x) => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase()
    return `#${ch(value.r)}${ch(value.g)}${ch(value.b)}${value.a !== undefined && value.a < 0.995 ? ch(value.a) : ''}`
  }
  return JSON.stringify(value)
}

const methods = {
  async info() {
    const selection = figma.currentPage.selection
    return {
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      user: figma.currentUser ? figma.currentUser.name : null,
      selection: selection.length,
      selected: selection.slice(0, SELECTION_LIMIT).map((n) => ({
        ...summary(n),
        width: 'width' in n ? Math.round(n.width) : undefined,
        height: 'height' in n ? Math.round(n.height) : undefined,
      })),
      pluginVersion: VERSION,
      protocol: PROTOCOL,
    }
  },
  props: ({ edits }) =>
    each(edits, (e) => e.id, async (e) => summary(await apply(await nodeById(e.id), e.props))),
  async create({ parent, nodes }) {
    const target = parent ? await nodeById(parent) : figma.currentPage
    const changed = []
    const errors = []
    // A spec may carry `children`, built inside it, so a whole tree is one call and one undo step.
    const build = async (spec, into, depth) => {
      if (spec.type === 'COMPONENT_SET') return buildSet(spec, into, depth)
      let n
      try {
        n = await make(spec)
        into.appendChild(n)
        n = await apply(n, spec.props || {})
        hugUnsized(n, spec.props || {})
      } catch (error) {
        if (n && !n.removed) n.remove()
        const name = spec.props && spec.props.name ? ` "${spec.props.name}"` : ''
        errors.push(`${spec.type}${name}: ${message(error)}`)
        return undefined
      }
      const entry = { ...summary(n), depth }
      changed.push(entry)
      for (const child of spec.children || []) await build(child, n, depth + 1)
      return entry
    }
    // Variants are built as components first, then combined; the set is listed before them.
    const buildSet = async (spec, into, depth) => {
      const at = changed.length
      const parts = []
      for (const child of spec.children || []) {
        if (child.type !== 'COMPONENT') {
          errors.push(`COMPONENT_SET: children must be COMPONENT, got ${child.type}`)
          continue
        }
        const entry = await build(child, into, depth + 1)
        if (entry) parts.push(await nodeById(entry.id))
      }
      if (parts.length === 0) {
        errors.push('COMPONENT_SET: no variants were created')
        return undefined
      }
      try {
        const set = figma.combineAsVariants(parts, into)
        await apply(set, spec.props || {})
        hugUnsized(set, spec.props || {})
        const entry = { ...summary(set), depth }
        changed.splice(at, 0, entry)
        return entry
      } catch (error) {
        errors.push(`COMPONENT_SET: ${message(error)}`)
        return undefined
      }
    }
    for (const spec of nodes) await build(spec, target, 0)
    finish()
    return { changed, errors }
  },
  delete: ({ ids }) =>
    each(ids, (id) => id, async (id) => {
      const n = await nodeById(id)
      const s = summary(n)
      n.remove()
      return s
    }),
  async variables() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    const variables = await figma.variables.getLocalVariablesAsync()
    const names = new Map(variables.map((v) => [v.id, v.name]))
    return collections.map((c) => ({
      name: c.name,
      modes: c.modes.map((m) => m.name),
      variables: variables
        .filter((v) => v.variableCollectionId === c.id)
        .map((v) => ({ name: v.name, type: v.resolvedType, values: c.modes.map((m) => valueText(v.valuesByMode[m.modeId], names)) })),
    }))
  },
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
    toSelect = []
    figma.ui.postMessage({ type: 'response', port, id, error: message(error) })
  }
}
