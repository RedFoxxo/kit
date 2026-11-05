import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PROTOCOL, type Connection, type PluginInfo } from '../bridge/bridge.js'
import { parseFileKey } from '../figma/refs.js'
import { failure, lines } from './respond.js'
import type { ToolContext } from './types.js'

/** A change the plugin reports: the nodes it touched and per-item errors. */
export interface PluginChange {
  /** `depth` > 0 for nodes created inside another node of the same call. */
  changed: { id: string; type: string; name: string; depth?: number }[]
  errors: string[]
}

/**
 * The plugin connection running in the file named by `file`. Matched by file
 * key; when the plugin cannot read the key, by the file name REST reports.
 * Never guesses between files.
 */
export async function pluginFor(
  ctx: ToolContext,
  file: string,
  signal?: AbortSignal,
): Promise<{ ok: true; connection: Connection; key: string } | { ok: false; error: CallToolResult }> {
  const key = parseFileKey(file)
  if (!key) return { ok: false, error: failure(`Not a Figma file URL or key: ${file}`) }
  const bridge = ctx.bridge
  if (bridge.port === undefined) return { ok: false, error: failure(`Bridge not listening: ${bridge.problem ?? 'not started'}`) }

  const open: { connection: Connection; info: PluginInfo }[] = []
  for (const connection of bridge.connections) {
    const info = connection.info ?? (await connection.request<PluginInfo>('info', {}, 5_000).catch(() => undefined))
    if (info) {
      connection.info = info
      open.push({ connection, info })
    }
  }
  const pick = (connection: Connection, info: PluginInfo) =>
    (info.protocol ?? 1) === PROTOCOL
      ? ({ ok: true, connection, key } as const)
      : ({
          ok: false,
          error: failure(
            `The kit bridge plugin in "${info.fileName}" is outdated (protocol ${info.protocol ?? 1}, kit needs ${PROTOCOL}). Run \`kit plugin\`, then close and relaunch the plugin in Figma.`,
          ),
        } as const)
  const byKey = open.find((o) => o.info.fileKey === key)
  if (byKey) return pick(byKey.connection, byKey.info)

  const keyless = open.filter((o) => o.info.fileKey === null)
  if (keyless.length > 0) {
    const loaded = await ctx.files.get(key, signal)
    const byName = loaded.ok ? keyless.filter((o) => o.info.fileName === loaded.data.name) : []
    if (byName.length === 1) return pick(byName[0]!.connection, byName[0]!.info)
  }

  const list = open.map((o) => `"${o.info.fileName}" (${o.info.fileKey ?? 'key not available'})`).join(', ')
  return {
    ok: false,
    error: failure(
      open.length === 0
        ? 'No plugin connected. Open the file in Figma desktop and run Plugins → Development → kit bridge.'
        : `The kit bridge plugin is not running in file ${key}. Running in: ${list}. Run the plugin in that file.`,
    ),
  }
}

/** Runs a change in the plugin and reports it in a few lines. Clears the read cache, which is now stale. */
export async function change(ctx: ToolContext, file: string, method: string, params: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const target = await pluginFor(ctx, file, signal)
  if (!target.ok) return target.error
  let result: PluginChange
  try {
    result = await target.connection.request<PluginChange>(method, params, 120_000)
  } catch (error) {
    return failure(`Plugin error: ${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.files.forget(target.key)
  const out = [`${result.changed.length} node(s) ${method === 'delete' ? 'deleted' : method === 'create' ? 'created' : 'changed'} in "${target.connection.info?.fileName ?? target.key}" (one undo step):`]
  out.push(...result.changed.map((n) => `${'  '.repeat(n.depth ?? 0)}- ${n.id} ${n.type} "${n.name}"`))
  out.push(...result.errors.map((e) => `! ${e}`))
  return { ...lines(out), ...(result.changed.length === 0 && result.errors.length > 0 ? { isError: true } : {}) }
}
