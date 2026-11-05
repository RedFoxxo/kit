import { z } from 'zod'
import type { FigmaNode } from '../../figma/types.js'
import { fold, isVisible, size } from '../../format/nodes.js'
import { fileArg, fileHeader, lines, offsetArg, openFile } from '../respond.js'
import { defineTool } from '../types.js'

const CONTAINERS: Record<string, true> = { CANVAS: true, SECTION: true }
/** Node types listed as screens; anything else beside them is an annotation. */
const LISTED: Record<string, true> = {
  CANVAS: true,
  SECTION: true,
  FRAME: true,
  COMPONENT: true,
  COMPONENT_SET: true,
  INSTANCE: true,
  GROUP: true,
}

export const readOutline = defineTool({
  name: 'read_outline',
  description:
    'Start here. Pages, sections and screens (top-level frames) of a file with ids, names and sizes; screen contents are not expanded. Cheap: text only.',
  input: {
    file: fileArg,
    page: z.string().optional().describe('Only this page (name or id)'),
    offset: offsetArg,
  },
  async handler({ file, page, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const wanted = page === undefined ? undefined : fold(page.trim())
    const pages = f.pages.filter((p) => wanted === undefined || p.id === page?.trim() || fold(p.name.trim()) === wanted)
    if (pages.length === 0) {
      return lines([fileHeader(f), `No page "${page}". Pages: ${f.pages.map((p) => `${p.id} "${p.name}"`).join(', ')}`])
    }

    const out = [fileHeader(f)]
    const walk = (node: FigmaNode, depth: number) => {
      const hidden = isVisible(node) ? '' : ' hidden'
      const container = CONTAINERS[node.type] === true
      const dims = container ? '' : ` ${size(node)}`
      out.push(`${'  '.repeat(depth)}${node.type === 'CANVAS' ? 'PAGE' : node.type} ${node.id} "${node.name.trim()}"${dims}${hidden}`)
      if (!container) return
      const children = node.children ?? []
      // Loose shapes and text next to screens are annotations; count them instead of listing.
      for (const child of children) if (LISTED[child.type]) walk(child, depth + 1)
      const loose = children.filter((c) => !LISTED[c.type]).length
      if (loose > 0) out.push(`${'  '.repeat(depth + 1)}(+${loose} loose layers: shapes, text, images)`)
    }
    pages.forEach((p) => walk(p, 0))
    return lines(out, offset)
  },
})
