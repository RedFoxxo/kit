import { z } from 'zod'
import { failure, fileArg, text } from '../respond.js'
import { defineTool } from '../types.js'
import { change, pluginFor } from '../plugin.js'

const props = z
  .record(z.string(), z.unknown())
  .describe(
    'Any of: name, visible, locked, x, y, width, height, rotation, opacity, text, fontSize, fontName {family,style}, textAlignHorizontal, textAutoResize, lineHeight, letterSpacing, textCase, fills/strokes (hex "#RRGGBB[AA]" or Figma paints, gradients included), strokeWeight, strokeAlign, cornerRadius, effects ([{type: drop|inner|glow|blur|background-blur, color, x, y, radius, spread}]), fillStyle/strokeStyle/textStyle/effectStyle (style name), layoutMode, itemSpacing, padding (n or [t,r,b,l]), primaryAxisAlignItems, counterAxisAlignItems, layoutSizingHorizontal/Vertical, layoutWrap, layoutGrow, layoutPositioning, clipsContent, constraints, arcData, componentProperties, parent (node id), index. width/height stay fixed under auto layout unless a sizing mode is given',
  )

const NEEDS_PLUGIN = 'Needs the kit bridge plugin running in that file (read_bridge).'

export const writeProps = defineTool({
  name: 'write_props',
  description: `Change texts and properties of existing nodes, several in one call (one undo step). Answers with the changed nodes only. ${NEEDS_PLUGIN}`,
  input: {
    file: fileArg,
    edits: z.array(z.object({ id: z.string(), props })).min(1),
  },
  handler: ({ file, edits }, ctx, signal) => change(ctx, file, 'props', { edits: edits.map((e) => ({ ...e, id: e.id.replace(/-/g, ':') })) }, signal),
})

interface NodeSpec {
  type: 'FRAME' | 'SECTION' | 'RECTANGLE' | 'ELLIPSE' | 'TEXT' | 'INSTANCE'
  componentKey?: string | undefined
  componentId?: string | undefined
  props?: Record<string, unknown> | undefined
  children?: NodeSpec[] | undefined
}

const nodeSpec: z.ZodType<NodeSpec> = z.object({
  type: z.enum(['FRAME', 'SECTION', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'INSTANCE']),
  componentKey: z.string().optional(),
  componentId: z.string().optional(),
  props: props.optional(),
  get children() {
    return z.array(nodeSpec).optional().describe('Nodes created inside this one')
  },
})

export const writeCreate = defineTool({
  name: 'write_create',
  description: `Create nodes under a parent (default: the current page): FRAME, SECTION, RECTANGLE, ELLIPSE, TEXT, or INSTANCE of a component (componentKey from read_styles, or componentId). Nest \`children\` to build a whole tree in one call. ${NEEDS_PLUGIN}`,
  input: {
    file: fileArg,
    parent: z.string().optional().describe('Parent node id'),
    nodes: z.array(nodeSpec).min(1),
  },
  handler: ({ file, parent, nodes }, ctx, signal) => change(ctx, file, 'create', { parent: parent?.replace(/-/g, ':'), nodes }, signal),
})

export const deleteNodes = defineTool({
  name: 'delete_nodes',
  description: `Delete nodes (one undo step in Figma). ${NEEDS_PLUGIN}`,
  input: { file: fileArg, ids: z.array(z.string()).min(1) },
  handler: ({ file, ids }, ctx, signal) => change(ctx, file, 'delete', { ids: ids.map((id) => id.replace(/-/g, ':')) }, signal),
})

/** Longest exec answer; the code is not re-run to page through it. */
const EXEC_CHARS = 20_000

export const execRun = defineTool({
  name: 'exec_run',
  description: `Run JavaScript in the plugin with the full Figma Plugin API (\`figma\`), for what the other tools cannot do. The body of an async function: \`return\` a small JSON-serializable value, not nodes. Keep each call small (a few hundred nodes); build big designs in several calls. ${NEEDS_PLUGIN}`,
  input: { file: fileArg, code: z.string().min(1) },
  async handler({ file, code }, ctx, signal) {
    const target = await pluginFor(ctx, file, signal)
    if (!target.ok) return target.error
    try {
      const { value } = await target.connection.request<{ value: unknown }>('exec', { code }, 120_000)
      ctx.files.forget(target.key)
      const json = JSON.stringify(value) ?? 'null'
      return text(json.length > EXEC_CHARS ? `${json.slice(0, EXEC_CHARS)}… [${json.length} chars; return less]` : json)
    } catch (error) {
      return failure(`Plugin error: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
