import { z } from 'zod'
import type { FigmaFile } from '../../figma/store.js'
import type { FigmaNode } from '../../figma/types.js'
import { cleanText, isVisible, paint, size } from '../../format/nodes.js'
import { fileArg, fileHeader, lines, offsetArg, openFile, resolveIds } from '../respond.js'
import { defineTool } from '../types.js'

/** One compact line of layout and style facts for a node. */
export function describe(f: FigmaFile, node: FigmaNode): string {
  const parts = [`${node.type} ${node.id} "${cleanText(node.name, 80)}"`]
  const dims = size(node)
  if (dims) parts.push(dims)
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((p) => p ?? 0)
    const padText = pad.every((p) => p === pad[0]) ? `${pad[0]}` : pad.join(',')
    const align = [node.primaryAxisAlignItems, node.counterAxisAlignItems].filter(Boolean).join('/')
    parts.push(`auto-${node.layoutMode === 'HORIZONTAL' ? 'row' : node.layoutMode === 'VERTICAL' ? 'col' : 'grid'} gap ${node.itemSpacing ?? 0} pad ${padText}${align ? ` ${align.toLowerCase()}` : ''}`)
  }
  const sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical]
  if (sizing.some((s) => s && s !== 'FIXED')) parts.push(`size ${sizing.map((s) => (s ?? 'FIXED').toLowerCase()).join('/')}`)
  const fills = (node.fills ?? []).filter((p) => p.visible !== false)
  const styleName = (role: string) => {
    const id = node.styles?.[role]
    return id ? f.raw.styles?.[id]?.name : undefined
  }
  if (fills.length > 0) parts.push(`fill ${styleName('fill') ?? fills.map(paint).join('+')}`)
  const strokes = (node.strokes ?? []).filter((p) => p.visible !== false)
  if (strokes.length > 0) parts.push(`stroke ${styleName('stroke') ?? strokes.map(paint).join('+')}/${node.strokeWeight ?? 1}`)
  if (node.cornerRadius) parts.push(`r${node.cornerRadius}`)
  if (node.opacity !== undefined && node.opacity < 1) parts.push(`opacity ${node.opacity.toFixed(2)}`)
  const effects = (node.effects ?? []).filter((e) => e.visible !== false)
  if (effects.length > 0) parts.push(`effect ${styleName('effect') ?? effects.map((e) => e.type.toLowerCase()).join('+')}`)
  if (node.type === 'TEXT') {
    const s = node.style ?? {}
    const font = styleName('text') ?? [s.fontFamily, s.fontSize, s.fontWeight].filter((v) => v !== undefined).join(' ')
    parts.push(`text "${cleanText(node.characters ?? '', 120)}" ${font}`)
  }
  if (node.componentId) {
    const component = f.raw.components?.[node.componentId]
    if (component) parts.push(`component "${component.name}"`)
  }
  if (!isVisible(node)) parts.push('hidden')
  return parts.join(' · ')
}

export const readStructure = defineTool({
  name: 'read_structure',
  description:
    'Layer tree of a node for implementing it: one line per layer with size, auto layout, fills, strokes, radius, text style and component. Hidden layers skipped. Bounded by depth and node count.',
  input: {
    file: fileArg,
    id: z.string().describe('Node id or node URL'),
    depth: z.number().int().min(1).max(12).optional().describe('Levels below the node (default 4)'),
    maxNodes: z.number().int().min(1).max(1000).optional().describe('Stop after this many lines (default 150)'),
    offset: offsetArg,
  },
  async handler({ file, id, depth, maxNodes, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const resolved = resolveIds(f, [id])
    const rootId = resolved.ids[0]
    if (!rootId) return lines([fileHeader(f), ...resolved.problems.map((p) => `! ${p}`)])
    const limitDepth = depth ?? 4
    const limitNodes = maxNodes ?? 150
    const out = [fileHeader(f), `in ${f.where(rootId) || 'document'}`]
    let shown = 0
    let skipped = 0
    const walk = (node: FigmaNode, level: number) => {
      if (shown >= limitNodes) {
        skipped++
        return
      }
      shown++
      out.push(`${'  '.repeat(level)}${describe(f, node)}`)
      const children = (node.children ?? []).filter(isVisible)
      if (children.length === 0) return
      if (level >= limitDepth) {
        out.push(`${'  '.repeat(level + 1)}(+${children.length} children; read_structure on ${node.id} for more)`)
        return
      }
      children.forEach((c) => walk(c, level + 1))
    }
    walk(f.node(rootId)!, 0)
    if (skipped > 0) out.push(`[${skipped} more layers not shown; raise maxNodes or read a child]`)
    return lines(out, offset)
  },
})

export const readStyles = defineTool({
  name: 'read_styles',
  description:
    "The file's design tokens as Figma styles (colors, text, effects, grids) with their values, and its components and component sets with keys.",
  input: { file: fileArg, offset: offsetArg },
  async handler({ file, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    return lines([fileHeader(f), ...styleLines(f)], offset)
  },
})

function styleLines(f: FigmaFile): string[] {
  // A style's value is read from the first node that uses it.
  const sample = new Map<string, FigmaNode>()
  for (const node of f.all()) for (const id of Object.values(node.styles ?? {})) if (!sample.has(id)) sample.set(id, node)

  const out: string[] = []
  const styles = Object.entries(f.raw.styles ?? {}).sort(([, a], [, b]) => a.styleType.localeCompare(b.styleType) || a.name.localeCompare(b.name))
  for (const [id, meta] of styles) {
    const node = sample.get(id)
    let value = '(unused in this file)'
    if (node && meta.styleType === 'FILL') value = (node.fills ?? []).map(paint).join('+')
    if (node && meta.styleType === 'TEXT') {
      const s = node.style ?? {}
      value = `${s.fontFamily ?? '?'} ${s.fontSize ?? '?'}/${s.lineHeightPx ? Math.round(s.lineHeightPx) : 'auto'} w${s.fontWeight ?? '?'}`
    }
    if (node && meta.styleType === 'EFFECT') value = (node.effects ?? []).map((e) => `${e.type.toLowerCase()}${e.radius ? ` ${e.radius}` : ''}`).join('+')
    if (node && meta.styleType === 'GRID') value = 'grid'
    out.push(`${meta.styleType} "${meta.name}" ${value}${meta.description ? ` — ${cleanText(meta.description, 120)}` : ''}`)
  }
  if (styles.length === 0) out.push('No styles.')

  const sets = f.raw.componentSets ?? {}
  const components = Object.entries(f.raw.components ?? {})
  const loose = components.filter(([, c]) => !c.componentSetId || !sets[c.componentSetId])
  for (const [setId, set] of Object.entries(sets)) {
    const variants = components.filter(([, c]) => c.componentSetId === setId).map(([, c]) => c.name)
    out.push(`COMPONENT_SET ${setId} "${set.name}" key ${set.key}: ${variants.join(' | ')}`)
  }
  for (const [id, c] of loose) out.push(`COMPONENT ${id} "${c.name}" key ${c.key}`)
  if (components.length === 0) out.push('No components.')
  return out
}
