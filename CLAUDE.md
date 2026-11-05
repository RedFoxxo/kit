# CLAUDE.md

Guidance for working in this repository.

## What this is

**kit** is an MCP server for Figma that keeps the assistant's context small.
It runs on the user's machine (stdio) and reads files through Figma's REST API
with a personal access token. Writing to designs (phase 3) will go through a
Figma plugin connected over a local WebSocket, because the REST API cannot
change nodes.

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
| `FIGMA_TOKEN` | yes | Personal access token. **Never** log or return it (`http.ts` redacts it from errors) |
| `KIT_CACHE_DIR` | no | Cache folder, default `~/.kit/cache` |

## Architecture

```
src/
  index.ts          bootstrap (stdio)
  server.ts         tool registration; tier prefix check and MCP annotations
  config.ts         env loading
  figma/
    http.ts         the request functions: token header, redaction, Result
    refs.ts         file keys and node ids from URLs
    store.ts        FileStore (version check, disk cache) and FigmaFile (parent index, screen of a node)
    types.ts        the subset of Figma's REST shapes kit reads
  format/
    page.ts         response paging
    nodes.ts        colors, sizes, text in reading order, accent folding
  tools/
    types.ts, respond.ts, index.ts
    read/           read_outline, read_frame_text, read_search, read_comments,
                    read_structure, read_styles, read_render
```

Tool names carry their tier as prefix (`read_`, `write_`, `delete_`, `exec_`).
Clients build approval rules on it, so a tool's prefix must match what it does.

A "screen" is a node directly on a page or in a section that is not a section
itself (`FigmaFile.frameOf`).

## Tests

`tests/fixture.ts` builds a small file and a fake HTTP layer that records
calls. Tests check behavior a user would notice: what an answer contains, what
is left out, paging, and how many requests are made.
