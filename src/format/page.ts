/** Characters per tool response (~5K tokens). Bigger results are paged, never cut mid-line. */
export const PAGE_CHARS = 20_000

/**
 * Lines from `offset` until the character budget, with a footer telling how
 * to get the rest. A single line longer than the budget is shortened.
 */
export function paginate(lines: string[], offset = 0, limit = PAGE_CHARS): string {
  const out: string[] = []
  let used = 0
  let index = offset
  for (; index < lines.length; index++) {
    let line = lines[index]!
    if (line.length > limit) line = `${line.slice(0, limit - 1)}…`
    if (out.length > 0 && used + line.length + 1 > limit) break
    out.push(line)
    used += line.length + 1
  }
  if (index < lines.length) {
    out.push(`[more: lines ${offset + 1}–${index} of ${lines.length} shown; call again with offset=${index}]`)
  }
  return out.join('\n')
}
