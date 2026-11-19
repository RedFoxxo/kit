import { randomBytes } from 'node:crypto'
import { chmod, copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stands for the key in plugin/ui.html until `kit plugin` writes the real one. */
const KEY_PLACEHOLDER = "const KEY = 'KIT_BRIDGE_KEY'"

/**
 * The secret kit and its plugin share (~/.kit/bridge.key, readable by the
 * user only), created on first use. The plugin sends it when it connects, so
 * a web page, which cannot read the user's files, cannot pose as the plugin.
 */
export async function bridgeKey(file: string): Promise<string> {
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) return existing.trim()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, randomBytes(32).toString('base64url'), { mode: 0o600 })
  try {
    // A link fails when the file exists: of several kit processes starting at once, the first one's key wins, written in full.
    await link(temp, file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  } finally {
    await rm(temp, { force: true })
  }
  const key = (await readFile(file, 'utf8')).trim()
  if (!key) throw new Error(`${file} is empty; delete it, then run \`kit plugin\` again`)
  return key
}

/** `kit plugin`: copies the Figma plugin to `target` with `key` written into its window, which holds the connection. */
export async function installPlugin(target: string, key: string): Promise<void> {
  const source = fileURLToPath(new URL('../../plugin/', import.meta.url))
  await mkdir(target, { recursive: true })
  for (const name of ['manifest.json', 'code.js']) await copyFile(join(source, name), join(target, name))
  const ui = await readFile(join(source, 'ui.html'), 'utf8')
  if (!ui.includes(KEY_PLACEHOLDER)) throw new Error('plugin/ui.html has no key placeholder')
  const page = join(target, 'ui.html')
  await writeFile(page, ui.replace(KEY_PLACEHOLDER, `const KEY = '${key}'`))
  // An earlier copy may have been created readable by everyone.
  await chmod(page, 0o600)
}
