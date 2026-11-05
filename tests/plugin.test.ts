import { describe, expect, it } from 'vitest'
import { FakeFigma } from './fake-figma.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')

describe('plugin: create', () => {
  it('builds a nested tree in one undo step and reports depth', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', {
      nodes: [{ type: 'FRAME', props: { name: 'Card' }, children: [{ type: 'TEXT', props: { text: 'Hi' } }, { type: 'RECTANGLE' }] }],
    })
    expect(r.changed.map((c) => [c.type, c.depth])).toEqual([['FRAME', 0], ['TEXT', 1], ['RECTANGLE', 1]])
    expect(figma.node(r.changed[0]!.id).children).toHaveLength(2)
    expect(figma.undoSteps).toBe(1)
  })

  it('removes a node whose props fail and keeps building its siblings', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', { nodes: [{ type: 'FRAME', props: { name: 'Bad', bogus: 1 } }, { type: 'FRAME', props: { name: 'Ok' } }] })
    expect(r.errors).toEqual(['FRAME "Bad": unknown property "bogus"'])
    expect(figma.page.children.map((c) => c.name)).toEqual(['Ok'])
  })

  it('keeps an explicit size fixed and hugs the unsized axis when auto layout is on', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', { nodes: [{ type: 'FRAME', props: { layoutMode: 'VERTICAL', width: 1440 } }] })
    const n = figma.node(r.changed[0]!.id)
    expect([n.width, n.layoutSizingHorizontal, n.layoutSizingVertical]).toEqual([1440, 'FIXED', 'HUG'])
  })

  it('leaves sizing alone on nodes without auto layout', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', { nodes: [{ type: 'FRAME' }] })
    const n = figma.node(r.changed[0]!.id)
    expect([n.layoutSizingHorizontal, n.layoutSizingVertical]).toEqual(['FIXED', 'FIXED'])
  })

  it('combines COMPONENT children into a variant set listed before them', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', {
      nodes: [{ type: 'COMPONENT_SET', props: { name: 'Pill' }, children: [{ type: 'COMPONENT', props: { name: 'State=Go' } }, { type: 'COMPONENT', props: { name: 'State=Hold' } }] }],
    })
    expect(r.changed.map((c) => `${c.depth} ${c.type} ${c.name}`)).toEqual(['0 COMPONENT_SET Pill', '1 COMPONENT State=Go', '1 COMPONENT State=Hold'])
    expect(figma.node(r.changed[0]!.id).children.map((c) => c.name)).toEqual(['State=Go', 'State=Hold'])
  })

  it('refuses variants that are not components', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', { nodes: [{ type: 'COMPONENT_SET', children: [{ type: 'FRAME' }] }] })
    expect(r.errors).toEqual(['COMPONENT_SET: children must be COMPONENT, got FRAME', 'COMPONENT_SET: no variants were created'])
    expect(figma.page.children).toHaveLength(0)
  })
})

describe('plugin: props', () => {
  it('turns a frame into a component and reports the new id', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'FRAME', props: { name: 'Button' }, children: [{ type: 'TEXT', props: { text: 'Go' } }] }] })
    const frameId = made.changed[0]!.id
    const r = await figma.call('props', { edits: [{ id: frameId, props: { component: true } }] })
    const component = figma.node(r.changed[0]!.id)
    expect([component.type, component.name, component.children.length]).toEqual(['COMPONENT', 'Button', 1])
    expect(figma.node(frameId).removed).toBe(true)
  })

  it('styles every occurrence of a word, or only the first', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'TEXT', props: { text: 'GO go GO' } }] })
    const id = made.changed[0]!.id
    await figma.call('props', {
      edits: [{ id, props: { textRanges: [{ text: 'GO', fontName: { family: 'Inter', style: 'Bold' } }, { text: 'GO', first: true, fills: '#FF0000' }] } }],
    })
    const ranges = figma.node(id).ranges.map(([m, s, e]) => `${m} ${s}-${e}`)
    expect(ranges).toEqual(['FontName 0-2', 'FontName 6-8', 'Fills 0-2'])
  })

  it('applies ranges to the new text when both change in one edit', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'TEXT', props: { text: 'old' } }] })
    const id = made.changed[0]!.id
    await figma.call('props', { edits: [{ id, props: { textRanges: [{ text: 'new', fontSize: 20 }], text: 'brand new' } }] })
    expect(figma.node(id).ranges).toEqual([['FontSize', 6, 9, 20]])
  })

  it('reports a range that is not in the text', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'TEXT', props: { text: 'abc' } }] })
    const r = await figma.call('props', { edits: [{ id: made.changed[0]!.id, props: { textRanges: [{ text: 'zz', fontSize: 9 }] } }] })
    expect(r.errors).toEqual([`${made.changed[0]!.id}: "zz" not found in the text`])
  })

  it('fills a node with an image sent as base64', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'RECTANGLE' }] })
    const id = made.changed[0]!.id
    await figma.call('props', { edits: [{ id, props: { image: { data: PNG, scaleMode: 'FIT' } } }] })
    expect(figma.node(id).fills).toEqual([{ type: 'IMAGE', imageHash: 'img-11', scaleMode: 'FIT' }])
  })

  it('expands effect shorthand', async () => {
    const figma = new FakeFigma()
    const made = await figma.call('create', { nodes: [{ type: 'FRAME', props: { effects: [{ type: 'glow', color: '#73FB9F80', radius: 20 }, { type: 'blur' }] } }] })
    expect(figma.node(made.changed[0]!.id).effects).toMatchObject([
      { type: 'DROP_SHADOW', offset: { x: 0, y: 0 }, radius: 20, color: { a: 128 / 255 } },
      { type: 'LAYER_BLUR', radius: 8 },
    ])
  })

  it('selects and shows the nodes marked select, once per call', async () => {
    const figma = new FakeFigma()
    const r = await figma.call('create', { nodes: [{ type: 'FRAME', props: { select: true } }, { type: 'FRAME' }, { type: 'FRAME', props: { select: true } }] })
    const ids = [r.changed[0]!.id, r.changed[2]!.id]
    expect(figma.zoomedTo).toEqual(ids)
    expect((figma.page.selection as { id: string }[]).map((n) => n.id)).toEqual(ids)
  })
})

describe('plugin: info and variables', () => {
  it('lists the selection, capped at 50, with the exact count', async () => {
    const figma = new FakeFigma()
    figma.page.selection = Array.from({ length: 60 }, () => figma.create('FRAME'))
    const info = await figma.call<{ selection: number; selected: unknown[]; protocol: number }>('info')
    expect([info.selection, info.selected.length, info.protocol]).toEqual([60, 50, 3])
  })

  it('reads variables per mode, with hex colors and aliases by name', async () => {
    const figma = new FakeFigma()
    figma.variables = {
      collections: [{ id: 'c1', name: 'Theme', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] }],
      variables: [
        { id: 'v1', name: 'brand', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 0.5 } } },
        { id: 'v2', name: 'button/bg', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'v1' }, m2: { type: 'VARIABLE_ALIAS', id: 'v1' } } },
        { id: 'v3', name: 'radius', resolvedType: 'FLOAT', variableCollectionId: 'c1', valuesByMode: { m1: 8, m2: 8 } },
      ],
    }
    expect(await figma.call('variables')).toEqual([
      {
        name: 'Theme',
        modes: ['Light', 'Dark'],
        variables: [
          { name: 'brand', type: 'COLOR', values: ['#FF0000', '#00000080'] },
          { name: 'button/bg', type: 'COLOR', values: ['→ brand', '→ brand'] },
          { name: 'radius', type: 'FLOAT', values: ['8', '8'] },
        ],
      },
    ])
  })
})
