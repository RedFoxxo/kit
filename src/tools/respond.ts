import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Result } from '../figma/http.js'
import { parseFileKey, parseNodeId } from '../figma/refs.js'
import type { FigmaFile } from '../figma/store.js'
import { paginate } from '../format/page.js'
import type { ToolContext } from './types.js'

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] }
}

/** Lines, paged to the response budget. */
export function lines(all: string[], offset?: number): CallToolResult {
  return text(paginate(all, offset ?? 0))
}

export function failure(summary: string, error?: Extract<Result<unknown>, { ok: false }>): CallToolResult {
  const parts = [summary]
  if (error) {
    parts.push(`status: ${error.status}`, `message: ${error.message}`)
    if (error.retryAfter) parts.push(`retryAfter: ${error.retryAfter}s`)
  }
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true }
}

export const fileArg = z.string().describe('Figma file URL or file key')
export const offsetArg = z.number().int().min(0).optional().describe('Line to start from, when a previous answer said [more: …]')

/** Loads the file named by a URL or key, or explains why it cannot. */
export async function openFile(
  ctx: ToolContext,
  file: string,
  signal?: AbortSignal,
): Promise<{ ok: true; file: FigmaFile } | { ok: false; error: CallToolResult }> {
  const key = parseFileKey(file)
  if (!key) return { ok: false, error: failure(`Not a Figma file URL or key: ${file}`) }
  const loaded = await ctx.files.get(key, signal)
  if (!loaded.ok) return { ok: false, error: failure(`Could not load file ${key}`, loaded) }
  return { ok: true, file: loaded.data }
}

/** Node ids from ids or URLs, checked against the file. */
export function resolveIds(file: FigmaFile, inputs: string[]): { ids: string[]; problems: string[] } {
  const ids: string[] = []
  const problems: string[] = []
  for (const input of inputs) {
    const id = parseNodeId(input)
    if (!id) problems.push(`not a node id: ${input}`)
    else if (!file.node(id)) problems.push(`no node ${id} in "${file.name}"`)
    else if (!ids.includes(id)) ids.push(id)
  }
  return { ids, problems }
}

/** Header every file-level answer starts with, so the reader knows which snapshot it saw. */
export function fileHeader(file: FigmaFile): string {
  return `${file.name} · key ${file.key} · version ${file.version} · modified ${file.lastModified}`
}
