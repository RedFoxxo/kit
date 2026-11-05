# kit

A token-lean [MCP](https://modelcontextprotocol.io) server for Figma. It reads
designs as compact text so an AI assistant can understand a file without
filling its context with screenshots and raw JSON, and it edits designs
through a small Figma plugin. Pictures are available, but only on demand and
size-capped.

On a real 33-screen file, reading the outline, the text of every screen, all
comments, one layer tree, the styles and one small render cost about 40K
characters (~12K tokens) in total. The thirteen tool definitions add about
9K characters to every request.

## Tools

| Tool | What it does |
|---|---|
| `read_outline` | Pages, sections and screens with ids and sizes. Start here |
| `read_frame_text` | Visible text of screens in reading order; header/footer text shared by 3+ screens printed once |
| `read_search` | Screens containing a text or layer name (case and accent insensitive) |
| `read_comments` | Comment threads with the screen each is pinned to, filterable by node |
| `read_structure` | One line per layer: size, auto layout, fills, strokes, radius, text style, component |
| `read_styles` | Styles with values, components and component sets with keys |
| `read_render` | A picture of one node, longest side 1024px by default, with its token cost; live from Figma when the plugin runs in the file |
| `read_bridge` | Files open in Figma with the plugin running |
| `write_props` | Change texts and properties of existing nodes (plugin) |
| `write_create` | Create frames, sections, shapes, texts and component instances, nested trees in one call (plugin) |
| `write_comment` | Post a comment or a reply (REST, no plugin needed) |
| `delete_nodes` | Delete nodes (plugin) |
| `exec_run` | Run JavaScript with the full Figma Plugin API (plugin) |

Read answers are plain text under ~20K characters; longer ones end with
`[more: …; call again with offset=N]` instead of being cut. Edits answer with
the changed nodes only, and every edit call is one undo step in Figma. Figma's
API shows plugin edits a few seconds late; reads made in that window say so.

Tool names start with their tier (`read_`, `write_`, `delete_`, `exec_`), so
client approval rules can allow reads, ask before writes and block `exec_run`.

## Setup

1. Create a Figma personal access token (Figma → Settings → Security →
   Personal access tokens) with the scopes `file_content:read`,
   `file_metadata:read`, `file_comments:read` and, for `write_comment`,
   `file_comments:write`.
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

### Editing: the kit bridge plugin

Figma's REST API cannot change designs, so edits go through a plugin running
in Figma desktop. It talks to kit over a WebSocket on `localhost`
(ports 7380–7389) and connects to every kit session running on the machine.

1. Run `npx -y @redfoxxo/kit@0 plugin`. It copies the plugin to `~/.kit/plugin`
   and prints the manifest path.
2. In Figma desktop: Plugins → Development → Import plugin from manifest…, and
   pick that path. Once per machine.
3. Open the file to edit and run Plugins → Development → kit bridge. Keep its
   window open while the assistant works.

`read_bridge` shows what is connected. Edits go only to the plugin running in
the file named in the call; kit never guesses between open files.

## Caching and rate limits

Figma's REST API limits how often a file can be downloaded. kit asks Figma for
the file's version (a cheap call, at most once a minute per file) and downloads
the file only when the version changed. The snapshot is kept on disk, so a new
session reuses it. Renders are cached per version too. After an edit, the next
read checks the version again.

## License

MIT
