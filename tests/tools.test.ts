import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allTools } from '../src/tools/index.js'
import { readComments } from '../src/tools/read/comments.js'
import { readOutline } from '../src/tools/read/outline.js'
import { readRender } from '../src/tools/read/render.js'
import { readStructure, readStyles } from '../src/tools/read/structure.js'
import { readFrameText, readSearch } from '../src/tools/read/text.js'
import { tierOf } from '../src/tools/types.js'
import { KEY, context, textOf } from './fixture.js'

const URL = `https://www.figma.com/design/${KEY}/Sample?node-id=0-1`

describe('read_outline', () => {
  it('lists sections and screens without their contents, counting loose layers', async () => {
    const out = textOf(await readOutline.handler({ file: URL }, await context()))
    expect(out).toContain('PAGE 0:1 "WebApp"')
    expect(out).toContain('    FRAME 2:1 "1. Home" 1600×1200')
    expect(out).not.toContain('2:2')
    expect(out).toContain('(+1 loose layers')
  })

  it('names the pages when the requested one does not exist', async () => {
    const out = textOf(await readOutline.handler({ file: KEY, page: 'Mobile' }, await context()))
    expect(out).toContain('No page "Mobile". Pages: 0:1 "WebApp"')
  })
})

describe('read_frame_text', () => {
  it('reads several screens and reports unknown ids', async () => {
    const out = textOf(await readFrameText.handler({ file: KEY, ids: ['2-1', '3:1', '4:1', '99:9'] }, await context()))
    expect(out).toContain('! no node 99:9')
    expect(out).toContain('Shared by most screens, left out below: Contattaci')
    expect(out).toContain('## 2:1 FRAME "1. Home" — WebApp › Review 2\nProssimi allenamenti · Società · Calendario · Apri')
  })
})

describe('read_search', () => {
  it('matches text without accents and groups by screen', async () => {
    const out = textOf(await readSearch.handler({ file: KEY, query: 'SOCIETA' }, await context()))
    expect(out).toContain('## 2:1 FRAME "1. Home"')
    expect(out).toContain('- TEXT 2:3 "Società"')
  })

  it('skips hidden layers', async () => {
    const out = textOf(await readSearch.handler({ file: KEY, query: 'segreto' }, await context()))
    expect(out).toContain('No text or layer name contains')
  })
})

describe('read_comments', () => {
  const comments = {
    comments: [
      { id: '1', message: 'Manca durata', created_at: '2026-10-14T10:00:00Z', user: { handle: 'Lorenzo' }, client_meta: { node_id: '2:6' } },
      { id: '2', message: 'Ok', created_at: '2026-10-15T10:00:00Z', parent_id: '1', user: { handle: 'Ada' } },
      { id: '3', message: 'Altro', created_at: '2026-10-16T10:00:00Z', client_meta: { node_id: '3:2' } },
      { id: '4', message: 'Chiuso', created_at: '2026-10-17T10:00:00Z', resolved_at: '2026-10-18', client_meta: { node_id: '2:2' } },
    ],
  }

  it('keeps comments inside the requested screens, with replies, without resolved threads', async () => {
    const ctx = await context(undefined, { [`/v1/files/${KEY}/comments`]: comments })
    const out = textOf(await readComments.handler({ file: KEY, ids: ['2:1'] }, ctx))
    expect(out).toContain('[2:6 in 2:1 "1. Home"] Lorenzo 2026-10-14 (#1): Manca durata')
    expect(out).toContain('  ↳ Ada 2026-10-15 (#2): Ok')
    expect(out).not.toContain('Altro')
    expect(out).not.toContain('Chiuso')
  })
})

describe('read_structure', () => {
  it('describes layout and style and stops at the depth limit', async () => {
    const out = textOf(await readStructure.handler({ file: KEY, id: '2:5', depth: 1 }, await context()))
    expect(out).toContain('FRAME 2:5 "Card" · 400×300 · auto-col gap 8 pad 16 · fill Brand/Primary')
    expect(out).toContain('INSTANCE 2:7 "Button" · component "Button"')
    expect(out).toContain('(+1 children; read_structure on 2:7 for more)')
  })

  it('caps the number of layers', async () => {
    const out = textOf(await readStructure.handler({ file: KEY, id: '2:1', maxNodes: 2 }, await context()))
    expect(out).toMatch(/\[\d+ more layers not shown/)
  })
})

describe('read_styles', () => {
  it('reads a style value from a node using it', async () => {
    const out = textOf(await readStyles.handler({ file: KEY }, await context()))
    expect(out).toContain('FILL "Brand/Primary" #FFFFFF')
    expect(out).toContain('COMPONENT 9:1 "Button" key ck')
  })
})

describe('read_render', () => {
  it('scales to the requested edge and serves repeats from the cache', async () => {
    const ctx = await context(undefined, { [`/v1/images/${KEY}`]: { images: { '2:1': 'https://img/1.png' } } })
    const first = await readRender.handler({ file: KEY, id: '2:1', maxEdge: 800 }, ctx)
    expect(textOf(first)).toContain('800×600 png')
    expect(ctx.http.calls.find((c) => c.startsWith(`/v1/images/`))).toContain('scale=0.500')
    const before = ctx.http.calls.length
    const again = await readRender.handler({ file: KEY, id: '2:1', maxEdge: 800 }, ctx)
    expect(again.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(ctx.http.calls.length).toBe(before)
  })
})

describe('tool set', () => {
  it('has a tier prefix on every tool and stays small in the prompt', () => {
    const tools = allTools()
    for (const t of tools) expect(tierOf(t.name), t.name).toBeDefined()
    const prompt = tools.map((t) => t.name + t.description + JSON.stringify(z.toJSONSchema(z.object(t.input)))).join('')
    // ~3K tokens: every request carries the tool list.
    expect(prompt.length).toBeLessThan(12_000)
  })
})
