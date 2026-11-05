import { z } from 'zod'
import { parseNodeId } from '../../figma/refs.js'
import { failure, fileArg, openFile, text } from '../respond.js'
import { defineTool } from '../types.js'

export const writeComment = defineTool({
  name: 'write_comment',
  description: 'Post a comment on a file, pinned to a node, or reply to a thread. Works without the plugin. Needs the file_comments:write token scope.',
  input: {
    file: fileArg,
    message: z.string().min(1),
    node: z.string().optional().describe('Node id or URL to pin the comment to'),
    replyTo: z.string().optional().describe('Comment id (#123 in read_comments) to reply to'),
  },
  async handler({ file, message, node, replyTo }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const body: Record<string, unknown> = { message }
    if (replyTo) body.comment_id = replyTo.replace(/^#/, '')
    else if (node) {
      const id = parseNodeId(node)
      if (!id || !f.node(id)) return failure(`No node ${node} in "${f.name}"`)
      body.client_meta = { node_id: id, node_offset: { x: 0, y: 0 } }
    }
    const posted = await ctx.http.post<{ id: string }>(`/v1/files/${f.key}/comments`, body, signal)
    if (!posted.ok) return failure('Comment not posted', posted)
    return text(`Comment #${posted.data.id} posted${replyTo ? ` in reply to #${body.comment_id}` : node ? ` on ${node}` : ''}.`)
  },
})
