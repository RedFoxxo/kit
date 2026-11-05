import type { Color, FigmaNode, Paint } from '../figma/types.js'

/** Visible unless Figma says `visible: false`. */
export function isVisible(node: FigmaNode): boolean {
  return node.visible !== false
}

export function hex(color: Color, opacity = 1): string {
  const channel = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase()
  const alpha = (color.a ?? 1) * opacity
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha < 0.995 ? channel(alpha) : ''}`
}

/** `#RRGGBB` for a solid paint, the gradient/image type otherwise. */
export function paint(p: Paint): string {
  return p.type === 'SOLID' && p.color ? hex(p.color, p.opacity ?? 1) : p.type.toLowerCase()
}

export function size(node: FigmaNode): string {
  const box = node.absoluteBoundingBox
  return box ? `${Math.round(box.width)}×${Math.round(box.height)}` : ''
}

/** Text with whitespace collapsed, shortened past `max` characters. */
export function cleanText(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Visible text of a subtree in reading order (top to bottom, then left to
 * right, rows within 8px treated as one), each distinct string once.
 */
export function textsOf(root: FigmaNode): string[] {
  const found: { text: string; x: number; y: number }[] = []
  const walk = (node: FigmaNode) => {
    if (!isVisible(node)) return
    if (node.type === 'TEXT' && node.characters) {
      const text = cleanText(node.characters)
      if (text) found.push({ text, x: node.absoluteBoundingBox?.x ?? 0, y: node.absoluteBoundingBox?.y ?? 0 })
    }
    node.children?.forEach(walk)
  }
  walk(root)
  found.sort((a, b) => Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x)
  return [...new Set(found.map((f) => f.text))]
}

/** Lowercase without accents, for matching user queries against design text. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}
