import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { allTools, type AnyToolDef } from './tools/index.js'
import { tierOf, type ToolContext } from './tools/types.js'
import { VERSION } from './version.js'

/** Keys whose values are maps of names (parameters, definitions), not schema keywords. */
const NAME_MAPS: Record<string, true> = { properties: true, definitions: true }

/**
 * A JSON Schema without what costs prompt tokens and tells the model nothing:
 * the draft URL, the safe-integer bounds zod adds to every integer, and the
 * "any key, any value" spelling of a record, which `type: object` already says.
 */
function compact(schema: unknown, names = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => compact(s))
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!names) {
      if (key === '$schema') continue
      if ((key === 'maximum' && value === Number.MAX_SAFE_INTEGER) || (key === 'minimum' && value === Number.MIN_SAFE_INTEGER)) continue
      if (key === 'propertyNames' && JSON.stringify(value) === '{"type":"string"}') continue
      if (key === 'additionalProperties' && JSON.stringify(value) === '{}') continue
    }
    out[key] = compact(value, !names && NAME_MAPS[key] === true)
  }
  return out
}

export function createServer(ctx: ToolContext, tools: AnyToolDef[] = allTools()): McpServer {
  const server = new McpServer({ name: 'kit', version: VERSION })
  const listed: Tool[] = []

  for (const tool of tools) {
    const tier = tierOf(tool.name)
    if (!tier) throw new Error(`Tool "${tool.name}" has no tier prefix (read_/write_/delete_/exec_/auth_)`)
    if (listed.some((t) => t.name === tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`)
    const annotations = { readOnlyHint: tier === 'read', destructiveHint: tier !== 'read' && tier !== 'auth', openWorldHint: true }

    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations }, async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) =>
      tool.handler(args, ctx, extra?.signal),
    )
    listed.push({
      name: tool.name,
      description: tool.description,
      inputSchema: compact(z.toJSONSchema(z.object(tool.input), { target: 'draft-7', io: 'input' })) as Tool['inputSchema'],
      annotations,
    })
  }

  // The SDK's list is the same tools with the noise above, which every request would carry.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }))
  return server
}
