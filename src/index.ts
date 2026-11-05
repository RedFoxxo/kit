#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig } from './config.js'
import { createHttp } from './figma/http.js'
import { FileStore } from './figma/store.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command !== undefined) {
    process.stderr.write(`kit: unknown command "${command}". Usage: kit (MCP server on stdio)\n`)
    process.exit(1)
  }
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
  const server = createServer({ http, files: new FileStore(http, config.cacheDir) })
  await server.connect(new StdioServerTransport())
  process.stderr.write('kit: ready on stdio\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`kit: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
