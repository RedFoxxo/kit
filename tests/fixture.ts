import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Http, Result } from '../src/figma/http.js'
import { FileStore } from '../src/figma/store.js'
import type { FigmaNode, FileResponse } from '../src/figma/types.js'
import type { ToolContext } from '../src/tools/types.js'

export const KEY = 'Uf0Jb2M1xIqob6m37jDSrH'

export function text(id: string, characters: string, x: number, y: number, extra: Partial<FigmaNode> = {}): FigmaNode {
  return { id, name: characters.slice(0, 20), type: 'TEXT', characters, absoluteBoundingBox: { x, y, width: 100, height: 20 }, ...extra }
}

export function frame(id: string, name: string, children: FigmaNode[], extra: Partial<FigmaNode> = {}): FigmaNode {
  return { id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1600, height: 1200 }, children, ...extra }
}

const footer = (id: string) => text(`${id}:f`, 'Contattaci', 0, 1100)

/** WebApp page with a section of three screens sharing a footer, plus a loose annotation. */
export function sampleFile(version = 'v1'): FileResponse {
  return {
    name: 'Sample App',
    lastModified: '2026-10-14T14:33:37Z',
    version,
    styles: { 'S:1': { key: 'k1', name: 'Brand/Primary', styleType: 'FILL' } },
    components: { '9:1': { key: 'ck', name: 'Button' } },
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'WebApp',
          type: 'CANVAS',
          children: [
            {
              id: '1:1',
              name: 'Review 2',
              type: 'SECTION',
              children: [
                frame('2:1', '1. Home', [
                  text('2:2', 'Prossimi allenamenti', 0, 100),
                  text('2:3', 'Società', 300, 102),
                  text('2:4', 'Segreto', 0, 50, { visible: false }),
                  {
                    id: '2:5',
                    name: 'Card',
                    type: 'FRAME',
                    layoutMode: 'VERTICAL',
                    itemSpacing: 8,
                    paddingTop: 16,
                    paddingRight: 16,
                    paddingBottom: 16,
                    paddingLeft: 16,
                    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
                    styles: { fill: 'S:1' },
                    absoluteBoundingBox: { x: 0, y: 200, width: 400, height: 300 },
                    children: [
                      text('2:6', 'Calendario', 0, 210),
                      { id: '2:7', name: 'Button', type: 'INSTANCE', componentId: '9:1', children: [text('2:8', 'Apri', 0, 260)] },
                    ],
                  },
                  footer('2:1'),
                ]),
                frame('3:1', '2. Gruppi', [text('3:2', 'Gruppi', 0, 100), footer('3:1')]),
                frame('4:1', '3. Atleti', [text('4:2', 'Atleti', 0, 100), footer('4:1')]),
              ],
            },
            { id: '5:1', name: 'Nota', type: 'TEXT', characters: 'Nota del designer' },
          ],
        },
      ],
    },
  }
}

export interface FakeHttp extends Http {
  calls: string[]
  routes: Record<string, unknown>
}

/** Answers from `routes` by path; anything else is a 404. Records every call. */
export function fakeHttp(routes: Record<string, unknown>): FakeHttp {
  const calls: string[] = []
  return {
    calls,
    routes,
    async json<T>(path: string): Promise<Result<T>> {
      calls.push(path)
      const route = routes[path.split('?')[0]!]
      if (route instanceof Error) return { ok: false, status: 500, message: route.message }
      if (route === undefined) return { ok: false, status: 404, message: 'Not found' }
      return { ok: true, data: structuredClone(route) as T }
    },
    async bytes(url: string) {
      calls.push(url)
      return { ok: true, data: { data: Buffer.from('PNGDATA'), type: 'image/png' } }
    },
  }
}

export async function context(file: FileResponse = sampleFile(), extra: Record<string, unknown> = {}): Promise<ToolContext & { http: FakeHttp; dir: string }> {
  const http = fakeHttp({
    [`/v1/files/${KEY}/meta`]: { file: { name: file.name, version: file.version } },
    [`/v1/files/${KEY}`]: file,
    ...extra,
  })
  const dir = await mkdtemp(join(tmpdir(), 'kit-test-'))
  return { http, files: new FileStore(http, dir), dir }
}

export function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}
