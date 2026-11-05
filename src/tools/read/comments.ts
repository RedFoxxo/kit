import { z } from 'zod'
import type { FigmaFile } from '../../figma/store.js'
import type { CommentResponse } from '../../figma/types.js'
import { cleanText } from '../../format/nodes.js'
import { failure, fileArg, fileHeader, lines, offsetArg, openFile, resolveIds } from '../respond.js'
import { defineTool } from '../types.js'

type Comment = CommentResponse['comments'][number]

export const readComments = defineTool({
  name: 'read_comments',
  description:
    'Comment threads of a file, newest first, each with the screen it is pinned to. Filter by node ids to get only comments on those nodes or inside them.',
  input: {
    file: fileArg,
    ids: z.array(z.string()).optional().describe('Only comments on these nodes or their children'),
    resolved: z.boolean().optional().describe('Include resolved threads (default false)'),
    offset: offsetArg,
  },
  async handler({ file, ids, resolved, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const response = await ctx.http.json<CommentResponse>(`/v1/files/${f.key}/comments`, signal)
    if (!response.ok) return failure('Could not read comments', response)

    const scope = ids ? resolveIds(f, ids) : undefined
    const out = [fileHeader(f), ...(scope?.problems.map((p) => `! ${p}`) ?? [])]
    out.push(...commentLines(f, response.data.comments, { within: scope?.ids, resolved: resolved ?? false }))
    return lines(out, offset)
  },
})

export function commentLines(
  f: FigmaFile,
  comments: Comment[],
  opts: { within?: string[] | undefined; resolved: boolean },
): string[] {
  const replies = new Map<string, Comment[]>()
  for (const c of comments) if (c.parent_id) replies.set(c.parent_id, [...(replies.get(c.parent_id) ?? []), c])
  const isInside = (nodeId: string | undefined) => {
    if (!opts.within) return true
    for (let id: string | undefined = nodeId; id; id = f.parent(id)?.id) if (opts.within.includes(id)) return true
    return false
  }
  const roots = comments
    .filter((c) => !c.parent_id && (opts.resolved || !c.resolved_at) && isInside(c.client_meta?.node_id ?? undefined))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  if (roots.length === 0) return ['No comments.']

  const out: string[] = []
  for (const c of roots) {
    const nodeId = c.client_meta?.node_id
    const screen = nodeId ? f.frameOf(nodeId) ?? f.node(nodeId) : undefined
    const on = nodeId ? `${nodeId}${screen ? ` in ${screen.id} "${screen.name.trim()}"` : ''}` : 'canvas'
    const thread = (replies.get(c.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at))
    for (const [i, x] of [c, ...thread].entries()) {
      const lead = i === 0 ? `[${on}]` : '  ↳'
      const state = i === 0 && c.resolved_at ? ' (resolved)' : ''
      out.push(`${lead} ${x.user?.handle ?? '?'} ${x.created_at.slice(0, 10)} (#${x.id}): ${cleanText(x.message, 600)}${state}`)
    }
  }
  return out
}
