# kit

A token-lean [MCP](https://modelcontextprotocol.io) server for Figma. It reads
designs as compact text so an AI assistant can understand a file without
filling its context with screenshots and raw JSON. Pictures are available, but
only on demand and size-capped.

On a real 33-screen file, reading the outline, the text of every screen, all
comments, one layer tree, the styles and one small render cost about 40K
characters (~12K tokens) in total.

## Tools

| Tool | What it returns |
|---|---|
| `read_outline` | Pages, sections and screens with ids and sizes. Start here |
| `read_frame_text` | Visible text of screens in reading order; header/footer text shared by 3+ screens printed once |
| `read_search` | Screens containing a text or layer name (case and accent insensitive) |
| `read_comments` | Comment threads with the screen each is pinned to, filterable by node |
| `read_structure` | One line per layer: size, auto layout, fills, strokes, radius, text style, component |
| `read_styles` | Styles with values, components and component sets with keys |
| `read_render` | A picture of one node, longest side 1024px by default, with its token cost |

Every answer is plain text under ~20K characters. Longer answers end with
`[more: …; call again with offset=N]` instead of being cut.

## Setup

1. Create a Figma personal access token (Figma → Settings → Security →
   Personal access tokens) with the scopes `file_content:read`,
   `file_metadata:read` and `file_comments:read`.
2. Store it as `FIGMA_TOKEN` in your environment, never in a config file.
3. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "kit": { "command": "npx", "args": ["-y", "@redfoxxo/kit@0"], "env": { "FIGMA_TOKEN": "${FIGMA_TOKEN}" } }
     }
   }
   ```

| Variable | Required | Purpose |
|---|---|---|
| `FIGMA_TOKEN` | yes | Personal access token. Never logged or returned |
| `KIT_CACHE_DIR` | no | Cache folder, default `~/.kit/cache` |

## Caching and rate limits

Figma's REST API limits how often a file can be downloaded. kit asks Figma for
the file's version (a cheap call, at most once a minute per file) and downloads
the file only when the version changed. The snapshot is kept on disk, so a new
session reuses it. Renders are cached per version too.

## License

MIT
