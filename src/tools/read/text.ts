import { z } from 'zod'
import type { FigmaFile } from '../../figma/store.js'
import { cleanText, fold, isVisible, textsOf } from '../../format/nodes.js'
import { fileArg, fileHeader, lines, offsetArg, openFile, resolveIds } from '../respond.js'
import { defineTool } from '../types.js'

export interface ScreenText {
  id: string
  type: string
  name: string
  where: string
  texts: string[]
}

/**
 * One line per screen. With three or more screens, text found on most of them
 * (header, footer, menu) is printed once up front and left out of each screen.
 */
export function screenTextLines(screens: ScreenText[]): string[] {
  const out: string[] = []
  let shared = new Set<string>()
  if (screens.length >= 3) {
    const counts = new Map<string, number>()
    for (const s of screens) for (const t of s.texts) counts.set(t, (counts.get(t) ?? 0) + 1)
    const threshold = Math.max(3, Math.ceil(screens.length / 2))
    shared = new Set([...counts].filter(([, n]) => n >= threshold).map(([t]) => t))
    if (shared.size > 0) out.push(`Shared by most screens, left out below: ${[...shared].join(' · ')}`)
  }
  for (const s of screens) {
    const own = s.texts.filter((t) => !shared.has(t))
    out.push(`## ${s.id} ${s.type} "${s.name}"${s.where ? ` — ${s.where}` : ''}`)
    out.push(own.length > 0 ? own.join(' · ') : '(no own text)')
  }
  return out
}

export const readFrameText = defineTool({
  name: 'read_frame_text',
  description:
    'Visible text of screens or any nodes, in reading order, joined by " · ". The cheapest way to know what a screen shows: prefer it to renders. Header/footer text repeated across 3+ screens is printed once.',
  input: {
    file: fileArg,
    ids: z.array(z.string()).min(1).describe('Node ids (80:5478 or 80-5478) or node URLs'),
    offset: offsetArg,
  },
  async handler({ file, ids, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const resolved = resolveIds(f, ids)
    const screens = resolved.ids.map((id) => {
      const node = f.node(id)!
      return { id, type: node.type, name: node.name.trim(), where: f.where(id), texts: textsOf(node) }
    })
    return lines([fileHeader(f), ...resolved.problems.map((p) => `! ${p}`), ...screenTextLines(screens)], offset)
  },
})

export const readSearch = defineTool({
  name: 'read_search',
  description:
    'Find screens by text or layer name (case and accent insensitive). Returns matches grouped by screen with ids, to read next with read_frame_text.',
  input: {
    file: fileArg,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional().describe('Max matches (default 50)'),
    offset: offsetArg,
  },
  async handler({ file, query, limit, offset }, ctx, signal) {
    const opened = await openFile(ctx, file, signal)
    if (!opened.ok) return opened.error
    const f = opened.file
    const out = [fileHeader(f), ...searchLines(f, query, limit ?? 50)]
    return lines(out, offset)
  },
})

function searchLines(f: FigmaFile, query: string, limit: number): string[] {
  const needle = fold(query.trim())
  const byScreen = new Map<string, string[]>()
  let matches = 0
  let more = 0
  for (const node of f.all()) {
    if (!isVisible(node) || node.type === 'DOCUMENT') continue
    const inText = node.type === 'TEXT' && node.characters !== undefined && fold(node.characters).includes(needle)
    const inName = !inText && fold(node.name).includes(needle)
    if (!inText && !inName) continue
    if (matches >= limit) {
      more++
      continue
    }
    matches++
    const screen = f.frameOf(node.id)
    const key = screen?.id ?? '(page level)'
    const hit = inText
      ? `TEXT ${node.id} "${cleanText(node.characters!, 120)}"`
      : `${node.type} ${node.id} named "${cleanText(node.name, 120)}"`
    byScreen.set(key, [...(byScreen.get(key) ?? []), hit])
  }
  if (matches === 0) return [`No text or layer name contains "${query}".`]
  const out: string[] = []
  for (const [screenId, hits] of byScreen) {
    const screen = f.node(screenId)
    out.push(screen ? `## ${screen.id} ${screen.type} "${screen.name.trim()}" — ${f.where(screen.id)}` : `## ${screenId}`)
    out.push(...hits.map((h) => `- ${h}`))
  }
  if (more > 0) out.push(`[${more} more matches not shown; raise limit or narrow the query]`)
  return out
}
