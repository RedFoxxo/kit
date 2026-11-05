import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { Http } from '../figma/http.js'
import type { FileStore } from '../figma/store.js'

export type Tier = 'read' | 'write' | 'delete' | 'exec'

export const TIERS: readonly Tier[] = ['read', 'write', 'delete', 'exec']

export interface ToolContext {
  http: Http
  files: FileStore
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** Registered without a `kit_` prefix; the tier prefix is the permission contract. */
  name: string
  description: string
  input: S
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext, signal?: AbortSignal) => Promise<CallToolResult>
}

/** Keeps the handler's argument type tied to its schema. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}

export function tierOf(name: string): Tier | undefined {
  const prefix = name.split('_', 1)[0]
  return TIERS.find((t) => t === prefix)
}
