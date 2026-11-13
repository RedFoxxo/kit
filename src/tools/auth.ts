import { z } from 'zod'
import { failure, text } from './respond.js'
import { defineTool } from './types.js'

/** Registered only when kit runs with an OAuth app (FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET). */
export const authLogin = defineTool({
  name: 'auth_login',
  description:
    'Sign in to Figma in the browser: opens Figma\'s sign-in page and answers once the user is back (or with the link, if they are not). Call it when a tool says the user is not signed in or the sign-in expired.',
  input: {
    force: z.boolean().optional().describe('Sign in again even when signed in, e.g. to switch account'),
  },
  async handler({ force }, ctx, signal) {
    if (!ctx.oauth) return failure('kit uses FIGMA_TOKEN; browser sign-in needs FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET.')
    return text(await ctx.oauth.login(force ?? false, signal))
  },
})
