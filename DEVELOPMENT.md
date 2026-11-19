# Developing kit

`CLAUDE.md` holds the architecture, the token budget rules and the sign-in
and bridge rules. Read it before changing behaviour.

## Commands

```sh
npm ci
npm run typecheck   # src and tests
npm test            # unit tests, no network: fake Figma API, real loopback bridge and callback
npm run build       # compile to build/
```

Run all three before every commit. CI (`.github/workflows/ci.yml`) runs them
on pushes to `main` and `stable` and on pull requests.

## Trying the plugin by hand

`plugin/ui.html` in the repo has a placeholder instead of the bridge key, so
Figma cannot use the repo folder directly. Build, then run

```sh
node build/index.js plugin
```

to copy the plugin with your key to `~/.kit/plugin` (the path Figma imports),
and point your MCP client at `node /path/to/kit/build/index.js` instead of
`npx`. After changing `plugin/`, run it again and relaunch the plugin in
Figma. Try every change of `plugin/code.js` in a scratch file:
`tests/fake-figma.ts` keeps only the rules kit depends on.

## Releasing

1. Bump the version in `package.json` and `src/version.ts` (a test keeps them
   equal), and turn `## Unreleased` in `CHANGELOG.md` into
   `## X.Y.Z — YYYY-MM-DD`.
2. If a plugin method or its parameters changed, bump `PROTOCOL` in both
   `src/bridge/bridge.ts` and `plugin/code.js`.
3. Commit, tag `vX.Y.Z`, push both.
4. `npm publish` (needs the `@redfoxxo` npm sign-in; `prepublishOnly` runs
   typecheck, tests and build).
