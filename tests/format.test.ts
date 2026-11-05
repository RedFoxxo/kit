import { describe, expect, it } from 'vitest'
import { parseFileKey, parseNodeId } from '../src/figma/refs.js'
import { paginate } from '../src/format/page.js'
import { textsOf } from '../src/format/nodes.js'
import { screenTextLines } from '../src/tools/read/text.js'
import { imageTokens } from '../src/tools/read/render.js'
import { KEY, sampleFile } from './fixture.js'

describe('refs', () => {
  it('reads keys and node ids from the URLs Figma shares', () => {
    expect(parseFileKey(`https://www.figma.com/design/${KEY}/Sportemocracy-App?node-id=78-6673`)).toBe(KEY)
    expect(parseFileKey(`https://www.figma.com/design/${KEY}/X/branch/BrAnChKey12/Y`)).toBe('BrAnChKey12')
    expect(parseFileKey('not a url')).toBeUndefined()
    expect(parseNodeId(`https://www.figma.com/design/${KEY}/X?node-id=78-6673&t=abc`)).toBe('78:6673')
    expect(parseNodeId('I12:3;45:6')).toBe('I12:3;45:6')
    expect(parseNodeId('Home')).toBeUndefined()
  })
})

describe('paginate', () => {
  it('pages at line boundaries and says how to continue', () => {
    const all = Array.from({ length: 10 }, (_, i) => `line ${i}`.padEnd(9, '.'))
    const first = paginate(all, 0, 30)
    expect(first.split('\n').slice(0, -1)).toEqual(all.slice(0, 3))
    expect(first).toContain('offset=3')
    expect(paginate(all, 9, 30)).toBe(all[9])
  })

  it('shortens a single line over the budget instead of looping', () => {
    expect(paginate(['x'.repeat(50)], 0, 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('text', () => {
  it('reads visible text top to bottom, left to right', () => {
    const home = sampleFile().document.children![0]!.children![0]!.children![0]!
    expect(textsOf(home)).toEqual(['Prossimi allenamenti', 'Società', 'Calendario', 'Apri', 'Contattaci'])
  })

  it('prints text shared by most screens once', () => {
    const screens = ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'FRAME', name: id, where: '', texts: ['Footer', `own ${id}`] }))
    screens[3]!.texts = ['own d']
    const out = screenTextLines(screens)
    expect(out[0]).toBe('Shared by most screens, left out below: Footer')
    expect(out).toContain('own a')
    expect(out.filter((l) => l.includes('Footer'))).toHaveLength(1)
  })

  it('keeps everything when only two screens are read', () => {
    const screens = ['a', 'b'].map((id) => ({ id, type: 'FRAME', name: id, where: '', texts: ['Footer'] }))
    expect(screenTextLines(screens).filter((l) => l === 'Footer')).toHaveLength(2)
  })
})

describe('imageTokens', () => {
  it('follows the downscale for large images', () => {
    expect(imageTokens(1000, 750)).toBe(1000)
    expect(imageTokens(4000, 3000)).toBeLessThanOrEqual(1534)
  })
})
