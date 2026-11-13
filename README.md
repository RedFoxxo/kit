# kit

A token-lean [MCP](https://modelcontextprotocol.io) server for Figma. It reads
designs as compact text so an AI assistant can understand a file without
filling its context with screenshots and raw JSON, and it edits designs
through a small Figma plugin. Pictures are available, but only on demand and
size-capped.

On a real 33-screen file, reading the outline, the text of every screen, all
comments, one layer tree, the styles and one small render cost about 40K
characters (~12K tokens) in total. The thirteen tool definitions add about
11K characters to every request (fourteen with `auth_login`, still about 11K).

## Tools

| Tool | What it does |
|---|---|
| `read_outline` | Pages, sections and screens with ids and sizes. Start here |
| `read_frame_text` | Visible text of screens in reading order; header/footer text shared by 3+ screens printed once |
| `read_search` | Screens containing a text or layer name (case and accent insensitive) |
| `read_comments` | Comment threads with the screen each is pinned to, filterable by node |
| `read_structure` | One line per layer: size, auto layout, fills, strokes, radius, text style, component |
| `read_styles` | Variables per collection and mode (plugin), styles with values, components and component sets with keys |
| `read_render` | A picture of one node, longest side 1024px by default, with its token cost; live from Figma when the plugin runs in the file |
| `read_bridge` | Files open in Figma with the plugin running, and the nodes selected in each |
| `write_props` | Change texts (mixed styles too), paints, images, effects, layout and component properties; turn a node into a component (plugin) |
| `write_create` | Create frames, sections, shapes, texts, components, variant sets and instances, nested trees in one call (plugin) |
| `write_comment` | Post a comment or a reply (REST, no plugin needed) |
| `delete_nodes` | Delete nodes (plugin) |
| `exec_run` | Run JavaScript with the full Figma Plugin API (plugin) |
| `auth_login` | Sign in to Figma in the browser; `force` switches account. Only with an OAuth app |

Read answers are plain text under ~20K characters; longer ones end with
`[more: …; call again with offset=N]` instead of being cut. Edits answer with
the changed nodes only, and every edit call is one undo step in Figma. Figma's
API shows plugin edits a few seconds late; reads made in that window say so.

Tool names start with their tier (`read_`, `write_`, `delete_`, `exec_`,
`auth_`), so client approval rules can allow reads, ask before writes and block
`exec_run`.

## Setup

kit authenticates in one of two ways: a browser sign-in through your own
Figma OAuth app, or a personal access token.

### Browser sign-in (OAuth app)

Users sign in once per machine in the browser; kit renews the sign-in by
itself, so nobody copies tokens or replaces expired ones.

1. At [figma.com/developers/apps](https://www.figma.com/developers/apps),
   create an app owned by your team or organization. A **private** app needs no
   review by Figma, and only members of that team or organization can sign in.
2. Add the redirect URL `http://127.0.0.1:7390/callback` and the scopes
   `current_user:read`, `file_content:read`, `file_metadata:read`,
   `file_comments:read` and `file_comments:write`, then publish it. Figma
   stops on its own page, without returning to kit, when these don't match:
   `Invalid scopes for app` means a scope is missing, `Invalid redirect uri`
   that the redirect URL differs (it must match exactly, including
   `127.0.0.1`, the port and `/callback`). Fix the app and publish again.
3. Give kit the app's client ID and secret as `FIGMA_CLIENT_ID` and
   `FIGMA_CLIENT_SECRET`. Figma asks for the secret on every token exchange
   and refresh, so it has to be on the user's machine: share it only with
   the people the app is for.
4. The first time, ask the assistant to sign in to Figma. `auth_login` opens
   Figma's sign-in page and answers once the user is back, or after 30 seconds
   with the link to open by hand (the sign-in keeps waiting for 10 minutes);
   any tool answers "Not signed in" until then.

The sign-in is kept in `~/.kit/auth.json`, readable by the user only, and
shared by every kit session. kit refreshes the access token a day before it
expires (Figma's last 90 days), or halfway through the life of a shorter one.
When Figma no longer accepts it (the user revoked the app, for example), tools
say so and ask for `auth_login` again.

- **Switch account:** ask for `auth_login` with `force`.
- **Sign out:** delete `~/.kit/auth.json`, then restart your AI tool (a
  running kit keeps the token it already loaded). To also cut kit's access on
  Figma's side, remove the app from the connected apps in your Figma account
  settings.
- **No browser on the machine (SSH, containers):** Figma sends the browser
  back to `127.0.0.1:7390` on the machine running kit, so the browser must run
  there too. After 30 seconds `auth_login` answers with the link; open it in
  a browser on that machine, or use `FIGMA_TOKEN` instead.
- **`Port 7390 is busy`:** another kit session is already waiting for a
  sign-in. Finish that one, or wait up to 10 minutes for it to expire.

### Personal access token

1. Create a Figma personal access token (Figma → Settings → Security →
   Personal access tokens) with the scopes `file_content:read`,
   `file_metadata:read`, `file_comments:read` and, for `write_comment`,
   `file_comments:write`.
2. Store it as `FIGMA_TOKEN` in your environment, never in a config file.
   Figma tokens expire; create a new one when kit reports a `403`.

### Add the server to your MCP client

```json
{
  "mcpServers": {
    "kit": { "command": "npx", "args": ["-y", "@redfoxxo/kit@1"], "env": { "FIGMA_TOKEN": "${FIGMA_TOKEN}" } }
  }
}
```

For the browser sign-in, set `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET` in
`env` instead of `FIGMA_TOKEN`.

| Variable | Required | Purpose |
|---|---|---|
| `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` | one of the two ways | Your Figma OAuth app; enables `auth_login`. Wins over `FIGMA_TOKEN`. The secret is never logged or returned |
| `FIGMA_TOKEN` | one of the two ways | Personal access token. Never logged or returned |
| `KIT_CACHE_DIR` | no | Cache folder, default `~/.kit/cache` |

### Editing: the kit bridge plugin

Figma's REST API cannot change designs, so edits go through a plugin running
in Figma desktop. It talks to kit over a WebSocket on `localhost`
(ports 7380–7389) and connects to every kit session running on the machine.

1. Run `npx -y @redfoxxo/kit@1 plugin`. It copies the plugin to `~/.kit/plugin`
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
