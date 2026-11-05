import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { failure, fileArg, openFile, resolveIds, text } from '../respond.js'
import { defineTool } from '../types.js'

/** Image tokens as Anthropic counts them: pixels / 750 (images over ~1.15 MP are downscaled first). */
export function imageTokens(width: number, height: number): number {
  const scale = Math.min(1, Math.sqrt(1_150_000 / (width * height)), 1568 / Math.max(width, height))
  return Math.ceil((width * scale * (height * scale)) / 750)
}

export const readRender = defineTool({
  name: 'read_render',
  description:
    'Picture of one node. Costly: an image stays in context for the rest of the conversation (~1.4K tokens at 1024px). Use only for layout questions text cannot answer; render the smallest child that shows it, not whole screens.',
  input: {
    file: fileArg,
    id: z.string().describe('Node id or node URL'),
    maxEdge: z.number().int().min(64).max(2048).optional().describe('Longest side in pixels (default 1024)'),
    format: z.enum(['png', 'jpg']).optional().describe('png (default) for UI, jpg for photos'),
  },
  async handler({ file, id, maxEdge, format }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const resolved = resolveIds(f, [id])
    const nodeId = resolved.ids[0]
    if (!nodeId) return failure(resolved.problems.join('\n'))
    const box = f.node(nodeId)!.absoluteBoundingBox
    if (!box || box.width <= 0 || box.height <= 0) return failure(`Node ${nodeId} has no size to render`)

    const edge = maxEdge ?? 1024
    const fmt = format ?? 'png'
    const scale = Math.min(2, Math.max(0.01, edge / Math.max(box.width, box.height)))
    const scaleText = scale.toFixed(3)
    const width = Math.round(box.width * scale)
    const height = Math.round(box.height * scale)

    // Renders are cached per file version; a new version clears them (FileStore.writeDisk).
    const dir = join(ctx.files.dir(f.key), 'renders')
    const path = join(dir, `${f.version.replace(/[^A-Za-z0-9._-]/g, '_')}_${nodeId.replace(/[^A-Za-z0-9]/g, '-')}_${scaleText}.${fmt}`)
    let data: Buffer | undefined = await readFile(path).catch(() => undefined)
    if (!data) {
      const query = `ids=${encodeURIComponent(nodeId)}&scale=${scaleText}&format=${fmt}`
      const images = await ctx.http.json<{ images: Record<string, string | null> }>(`/v1/images/${f.key}?${query}`, signal)
      if (!images.ok) return failure(`Could not render ${nodeId}`, images)
      const url = images.data.images[nodeId]
      if (!url) return failure(`Figma returned no image for ${nodeId} (empty or invisible node)`)
      const download = await ctx.http.bytes(url, signal)
      if (!download.ok) return failure(`Could not download the render of ${nodeId}`, download)
      const bytes = download.data.data
      data = bytes
      await mkdir(dir, { recursive: true })
        .then(() => writeFile(path, bytes))
        .catch(() => undefined)
    }

    const note = text(`${nodeId} "${f.node(nodeId)!.name.trim()}" ${width}×${height} ${fmt}, ~${imageTokens(width, height)} tokens`)
    return {
      content: [...note.content, { type: 'image', data: data.toString('base64'), mimeType: fmt === 'png' ? 'image/png' : 'image/jpeg' }],
    }
  },
})
