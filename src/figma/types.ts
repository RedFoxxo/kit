/** The subset of Figma's REST node shape kit reads. Unknown fields are ignored. */
export interface Color {
  r: number
  g: number
  b: number
  a?: number
}

export interface Paint {
  type: string
  visible?: boolean
  opacity?: number
  color?: Color
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TypeStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  lineHeightPx?: number
  letterSpacing?: number
  textCase?: string
}

export interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  children?: FigmaNode[]
  characters?: string
  absoluteBoundingBox?: Rect | null
  fills?: Paint[]
  strokes?: Paint[]
  strokeWeight?: number
  cornerRadius?: number
  opacity?: number
  style?: TypeStyle
  /** Style ids by role (`fill`, `text`, `effect`, `stroke`, `grid`). */
  styles?: Record<string, string>
  effects?: { type: string; visible?: boolean; radius?: number }[]
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  itemSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  layoutSizingHorizontal?: string
  layoutSizingVertical?: string
  componentId?: string
}

export interface StyleMeta {
  key: string
  name: string
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID' | string
  description?: string
}

export interface ComponentMeta {
  key: string
  name: string
  description?: string
  componentSetId?: string
}

/** `GET /v1/files/:key` */
export interface FileResponse {
  name: string
  lastModified: string
  version: string
  document: FigmaNode
  styles?: Record<string, StyleMeta>
  components?: Record<string, ComponentMeta>
  componentSets?: Record<string, ComponentMeta>
}

/** `GET /v1/files/:key/meta` */
export interface MetaResponse {
  file: { name: string; version?: string; last_touched_at?: string }
}

export interface CommentResponse {
  comments: {
    id: string
    message: string
    created_at: string
    resolved_at?: string | null
    parent_id?: string
    user?: { handle?: string }
    client_meta?: { node_id?: string } | null
  }[]
}
