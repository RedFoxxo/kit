import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeKey, installPlugin } from '../src/bridge/setup.js'

describe('bridge key', () => {
  it('is created once, readable by the user only, and shared by concurrent kit processes', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kit-key-')), '.kit', 'bridge.key')
    const keys = await Promise.all([bridgeKey(file), bridgeKey(file), bridgeKey(file)])
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await readFile(file, 'utf8')).toBe(keys[0])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await bridgeKey(file)).toBe(keys[0])
  })
})

describe('kit plugin', () => {
  it('copies the plugin with the key written into its window', async () => {
    const target = join(await mkdtemp(join(tmpdir(), 'kit-plugin-')), 'plugin')
    await installPlugin(target, 'the-key')
    const ui = await readFile(join(target, 'ui.html'), 'utf8')
    expect(ui).toContain("const KEY = 'the-key'")
    expect(ui).toContain('?key=${encodeURIComponent(KEY)}')
    expect(await readFile(join(target, 'code.js'), 'utf8')).toContain('const PROTOCOL')
    expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toMatchObject({ id: 'kit-bridge' })
  })
})
