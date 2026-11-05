import { PROTOCOL, type PluginInfo } from '../../bridge/bridge.js'
import { lines } from '../respond.js'
import { defineTool } from '../types.js'

export const readBridge = defineTool({
  name: 'read_bridge',
  description:
    'Status of the kit bridge plugin, which editing needs: the files open in Figma with the plugin running, their current page, the selected nodes (ids to read or edit "what I selected"), and the round trip time.',
  input: {},
  async handler(_args, ctx) {
    const bridge = ctx.bridge
    if (bridge.port === undefined) return lines([`Bridge not listening: ${bridge.problem ?? 'not started'}.`])
    const out = [`Bridge listening on port ${bridge.port}.`]
    if (bridge.connections.size === 0) {
      out.push('No plugin connected. In Figma open the file, then Plugins → Development → kit bridge (import it once from the manifest kit prints with `kit plugin`).')
      return lines(out)
    }
    for (const c of bridge.connections) {
      const started = Date.now()
      try {
        const info = await c.request<PluginInfo>('info', {}, 5_000)
        c.info = info
        out.push(
          `- "${info.fileName}" key ${info.fileKey ?? '(not available)'} · page ${info.page.id} "${info.page.name}" · ${info.selection} selected · user ${info.user ?? '?'} · plugin ${info.pluginVersion} · ${Date.now() - started} ms${(info.protocol ?? 1) === PROTOCOL ? '' : ' · OUTDATED: run `kit plugin`, then relaunch the plugin'}`,
        )
        for (const n of info.selected ?? []) out.push(`  · selected ${n.id} ${n.type} "${n.name}"${n.width !== undefined ? ` ${n.width}×${n.height}` : ''}`)
        if (info.selected && info.selection > info.selected.length) out.push(`  · (+${info.selection - info.selected.length} more selected)`)
      } catch (error) {
        out.push(`- a plugin connected since ${c.since.toISOString()} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return lines(out)
  },
})
