#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Bridge } from './bridge/bridge.js'
import { ConfigError, loadConfig } from './config.js'
import { createHttp } from './figma/http.js'
import { FileStore } from './figma/store.js'
import { createServer } from './server.js'

/**
 * `kit plugin`: copies the Figma plugin to a fixed folder (~/.kit/plugin), so
 * it is imported in Figma once and survives npx cache changes. Prints the
 * manifest path on stdout.
 */
async function installPlugin(): Promise<void> {
  const source = fileURLToPath(new URL('../plugin/', import.meta.url))
  const target = join(homedir(), '.kit', 'plugin')
  await mkdir(target, { recursive: true })
  for (const name of ['manifest.json', 'code.js', 'ui.html']) await copyFile(join(source, name), join(target, name))
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
  const http = createHttp(config)
  const bridge = new Bridge()
  await bridge.start()
  process.stderr.write(bridge.port ? `kit: bridge on port ${bridge.port}\n` : `kit: bridge off: ${bridge.problem}\n`)
  const server = createServer({ http, files: new FileStore(http, config.cacheDir), bridge })
  await server.connect(new StdioServerTransport())
  process.stderr.write('kit: ready on stdio\n')
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command === 'plugin') return installPlugin()
  if (command === undefined) return serve()
  process.stderr.write(`kit: unknown command "${command}". Usage: kit (MCP server on stdio) | kit plugin\n`)
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`kit: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
