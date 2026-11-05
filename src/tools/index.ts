import { readComments } from './read/comments.js'
import { readOutline } from './read/outline.js'
import { readRender } from './read/render.js'
import { readStructure, readStyles } from './read/structure.js'
import { readFrameText, readSearch } from './read/text.js'
import type { ToolDef } from './types.js'

export type AnyToolDef = ToolDef<any>

/** Every tool kit registers, in registration order. Keep the list short: each tool costs prompt tokens on every request. */
export function allTools(): AnyToolDef[] {
  return [readOutline, readFrameText, readSearch, readComments, readStructure, readStyles, readRender]
}
