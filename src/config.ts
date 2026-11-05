import { homedir } from 'node:os'
import { join } from 'node:path'

export class ConfigError extends Error {}

export interface Config {
  /** Figma personal access token. Never logged or returned. */
  token: string
  apiBase: string
  /** Where file snapshots and renders are cached, one folder per file key. */
  cacheDir: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.FIGMA_TOKEN?.trim()
  if (!token) {
    throw new ConfigError(
      'kit: FIGMA_TOKEN is required: a Figma personal access token with the scopes file_content:read, file_metadata:read and file_comments:read.',
    )
  }
  const cacheDir = env.KIT_CACHE_DIR?.trim() || join(homedir(), '.kit', 'cache')
  return { token, apiBase: 'https://api.figma.com', cacheDir }
}
