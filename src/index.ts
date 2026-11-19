#!/usr/bin/env node
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Bridge } from './bridge/bridge.js'
import { bridgeKey, installPlugin } from './bridge/setup.js'
import { BRIDGE_KEY_FILE, ConfigError, KIT_DIR, loadConfig } from './config.js'
import { type Auth, OAuth, tokenAuth } from './figma/auth.js'
import { createHttp } from './figma/http.js'
import { FileStore } from './figma/store.js'
import { createServer } from './server.js'
import { authLogin } from './tools/auth.js'
import { allTools } from './tools/index.js'

/**
 * `kit plugin`: copies the Figma plugin to a fixed folder (~/.kit/plugin), so
 * it is imported in Figma once and survives npx cache changes. Prints the
 * manifest path on stdout.
 */
async function plugin(): Promise<void> {
  const target = join(KIT_DIR, 'plugin')
  await installPlugin(target, await bridgeKey(BRIDGE_KEY_FILE))
  process.stderr.write('In Figma desktop: Plugins → Development → Import plugin from manifest…, then pick:\n')
  process.stdout.write(`${join(target, 'manifest.json')}\n`)
}

async function serve(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
  const { credentials } = config
  let oauth: OAuth | undefined
  let auth: Auth
  if (credentials.kind === 'oauth') auth = oauth = new OAuth({ ...credentials, file: config.authFile, apiBase: config.apiBase })
  else auth = tokenAuth(credentials.token)
  const http = createHttp({ auth, apiBase: config.apiBase })
  let bridge: Bridge
  try {
    bridge = new Bridge(await bridgeKey(BRIDGE_KEY_FILE))
    await bridge.start()
  } catch (error) {
    // Reading and comments work without the bridge.
    bridge = new Bridge('')
    bridge.problem = `cannot read or create ${BRIDGE_KEY_FILE}: ${error instanceof Error ? error.message : String(error)}`
  }
  process.stderr.write(bridge.port ? `kit: bridge on port ${bridge.port}\n` : `kit: bridge off: ${bridge.problem}\n`)
  const server = createServer(
    { http, files: new FileStore(http, config.cacheDir), bridge, ...(oauth ? { oauth } : {}) },
    oauth ? [...allTools(), authLogin] : allTools(),
  )
  await server.connect(new StdioServerTransport())
  process.stderr.write('kit: ready on stdio\n')
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command === 'plugin') return plugin()
  if (command === undefined) return serve()
  process.stderr.write(`kit: unknown command "${command}". Usage: kit (MCP server on stdio) | kit plugin\n`)
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`kit: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
