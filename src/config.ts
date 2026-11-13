import { homedir } from 'node:os'
import { join } from 'node:path'

export class ConfigError extends Error {}

export type Credentials =
  /** Figma personal access token. Never logged or returned. */
  | { kind: 'token'; token: string }
  /** The user's own Figma OAuth app; kit signs in through the browser. The secret is never logged or returned. */
  | { kind: 'oauth'; clientId: string; clientSecret: string }

export interface Config {
  credentials: Credentials
  apiBase: string
  /** Where file snapshots and renders are cached, one folder per file key. */
  cacheDir: string
  /** Where the OAuth sign-in is kept. */
  authFile: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.FIGMA_CLIENT_ID?.trim()
  const clientSecret = env.FIGMA_CLIENT_SECRET?.trim()
  const token = env.FIGMA_TOKEN?.trim()
  let credentials: Credentials
  if (clientId && clientSecret) credentials = { kind: 'oauth', clientId, clientSecret }
  else if (clientId || clientSecret) throw new ConfigError('kit: set both FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET, or neither.')
  else if (token) credentials = { kind: 'token', token }
  else {
    throw new ConfigError(
      'kit: set FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET (a Figma OAuth app, to sign in through the browser), or FIGMA_TOKEN (a personal access token with the scopes file_content:read, file_metadata:read and file_comments:read).',
    )
  }
  const kitDir = join(homedir(), '.kit')
  return {
    credentials,
    apiBase: 'https://api.figma.com',
    cacheDir: env.KIT_CACHE_DIR?.trim() || join(kitDir, 'cache'),
    authFile: join(kitDir, 'auth.json'),
  }
}
