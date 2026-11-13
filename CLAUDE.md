# CLAUDE.md

Guidance for working in this repository.

## What this is

**kit** is an MCP server for Figma that keeps the assistant's context small.
It runs on the user's machine (stdio), reads files through Figma's REST API
with a browser sign-in (the user's own OAuth app) or a personal access token,
and edits them through the "kit bridge" Figma
plugin (`plugin/`) connected over a loopback WebSocket, because the REST API
cannot change nodes.

kit is generic: it must not mention or depend on any other plugin, tool or
company workflow.

## Token budget rules

These are the reason kit exists. Every change must keep them:

- **Few tools.** The tool list is sent with every request. `tests/tools.test.ts`
  caps names, descriptions and schemas at 12,000 characters.
- **Text first.** Answers are plain text lines, not JSON trees. A page is at
  most `PAGE_CHARS` (20,000) characters; longer answers end with a
  `[more: …; offset=N]` footer, never a cut in the middle of a line.
- **Pictures last.** `read_render` is the only tool returning an image. It is
  size-capped and states its token cost.
- **Download once.** `FileStore` checks the version with `/meta` (at most once
  a minute per file) and downloads the file only when the version changed;
  snapshots and renders are cached on disk by version.

## Stack

- TypeScript (strict), ESM, Node `>=22.12`
- `@modelcontextprotocol/sdk` (stdio), `zod` for input schemas, `vitest`
- No other runtime dependencies. Add a library only for a need the standard
  library cannot meet, and ask first. Versions are pinned exactly.

Before every commit run `npm run typecheck`, `npm test` and `npm run build`.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` | one way | The user's Figma OAuth app: browser sign-in with `auth_login`, tokens in `~/.kit/auth.json` (mode 600). Wins over `FIGMA_TOKEN`. **Never** log or return the secret or the tokens |
| `FIGMA_TOKEN` | other way | Personal access token. **Never** log or return it (`http.ts` redacts it from errors) |
| `KIT_CACHE_DIR` | no | Cache folder, default `~/.kit/cache` |

## Sign-in rules

- Figma requires the client secret on token exchange and refresh, so kit
  never ships one: the user brings their own app.
- The callback listens on `127.0.0.1:7390` (`CALLBACK_PORT`), outside the
  bridge's 7380–7389; the app's redirect URL must match it exactly.
- Figma keeps one access token per user and app, and a refresh kills the old
  one. Several kit sessions share `auth.json`: before refreshing, and when
  Figma refuses a token, re-read the file first.
- A 403 also means "this token can't open that file". Refresh only when
  `/v1/me` refuses the token too.

## Architecture

```
src/
  index.ts          bootstrap: `kit` (stdio server, starts the bridge) and `kit plugin` (copies plugin/ to ~/.kit/plugin)
  server.ts         tool registration; tier prefix check and MCP annotations
  config.ts         env loading
  figma/
    auth.ts         tokenAuth (FIGMA_TOKEN) and OAuth: browser sign-in with PKCE and a loopback callback, shared token file, refresh
    http.ts         the request functions: auth header, one retry after a refresh, redaction, Result
    refs.ts         file keys and node ids from URLs
    store.ts        FileStore (version check, disk cache) and FigmaFile (parent index, screen of a node)
    types.ts        the subset of Figma's REST shapes kit reads
  format/
    page.ts         response paging
    nodes.ts        colors, sizes, text in reading order, accent folding
  tools/
    types.ts, respond.ts, index.ts
    auth.ts         auth_login, registered only with an OAuth app
    plugin.ts       pick the plugin running in the named file (refuses an outdated one), run a change, report it
    read/           read_outline, read_frame_text, read_search, read_comments,
                    read_structure, read_styles (variables through the plugin), read_render (live through the plugin when it runs in the file), read_bridge (with the selection)
    write/          edit.ts: write_props, write_create (nested children, components, variant sets), delete_nodes, exec_run;
                    images.ts: reads image files and URLs into base64 for the plugin; comment.ts: write_comment (REST)
  bridge/
    ws.ts           minimal RFC 6455 server: loopback only, origin "null" or none, text frames
    bridge.ts       ports 7380–7389 (first free), connections, request/response by id with timeout
plugin/             the Figma plugin, plain JS: manifest.json, code.js (Plugin API methods), ui.html (WebSocket)
```

## Bridge rules

- The plugin connects to every port in the range, so several kit sessions can
  share one Figma. A kit session edits only the plugin whose file key (or,
  when Figma hides it, file name) matches the file in the call. Never guess.
- Every plugin method that changes the document ends with `figma.commitUndo()`,
  so one tool call is one undo step, and answers with `{ changed, errors }`.
- After a change, `FileStore.forget` drops the in-memory snapshot. Figma's REST
  API shows plugin edits only seconds later, so until it reports a newer
  version, reads are marked `stale` and the answer header says so.
- `PROTOCOL` in `src/bridge/bridge.ts` and in `plugin/code.js` must match. Bump
  both whenever a plugin method or its parameters change: kit then refuses the
  old plugin and tells the user to run `kit plugin` and relaunch it.
- `PORTS` in `src/bridge/bridge.ts`, `PORTS` in `plugin/ui.html` and
  `devAllowedDomains` in `plugin/manifest.json` must list the same ports.
- `plugin/code.js` runs inside Figma. `tests/fake-figma.ts` runs it in Node
  against a fake `figma` that keeps the rules kit depends on (fonts loaded
  before text changes, removed nodes, variants must be components); still try
  a change by hand in a scratch file before relying on it.
- The plugin has no file or network access: the server reads images and sends
  their bytes.
- Figma runs plugin code on its main thread: one call that creates hundreds of
  nodes can take over a minute. Requests time out after 120 s, but the work
  may still finish; the timeout message says to check the file before retrying.

Tool names carry their tier as prefix (`read_`, `write_`, `delete_`, `exec_`,
`auth_` for kit's own sign-in, which changes no design).
Clients build approval rules on it, so a tool's prefix must match what it does.

A "screen" is a node directly on a page or in a section that is not a section
itself (`FigmaFile.frameOf`).

## Tests

`tests/fixture.ts` builds a small file and a fake HTTP layer that records
calls. Bridge and write tests start a real bridge on ports 47380+ and connect
a fake plugin with Node's `WebSocket`. Plugin tests (`tests/plugin.test.ts`)
run `plugin/code.js` on `tests/fake-figma.ts`. Sign-in tests
(`tests/auth.test.ts`) run `OAuth` against a fake Figma `fetch` with a
temporary `auth.json` and a real loopback callback, one port per test from
47395 (a started sign-in holds its port). Tests check behavior a user
would notice: what an answer contains, what is left out, paging, which plugin
gets a change, what ends up in the document, and how many requests are made.
