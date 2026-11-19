# kit

A token-lean [MCP](https://modelcontextprotocol.io) server for Figma. It reads
designs as compact text, so an AI assistant can understand a file without
filling its context with screenshots and raw JSON, and it edits designs
through a small Figma plugin. Pictures are available, but only on demand and
size-capped.

On a real 33-screen file, reading the outline, the text of every screen, all
comments, one layer tree, the styles and one small render cost about 40K
characters (~12K tokens) in total. The tool definitions add about 9.5K
characters (~2.4K tokens) to every request. Releases are listed in
[CHANGELOG.md](CHANGELOG.md).

## Requirements

- Node.js 22.12 or newer (`npx` comes with it)
- A Figma account, and either a Figma OAuth app for browser sign-in or a
  personal access token (see below)
- For edits: the Figma desktop app. The browser version cannot run the
  development plugin edits go through

Nothing to download or build: your MCP client starts kit with `npx`, which
fetches [`@redfoxxo/kit`](https://www.npmjs.com/package/@redfoxxo/kit) from
npm on first use. `@1` keeps you on 1.x releases.

## Setup

kit reads its settings from environment variables, which your MCP client
passes to it:

| Variable | Required | Purpose |
|---|---|---|
| `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` | one of the two ways | Your Figma OAuth app: browser sign-in with `auth_login`. Wins over `FIGMA_TOKEN`. The secret is never logged or returned |
| `FIGMA_TOKEN` | one of the two ways | Personal access token. Never logged or returned |
| `KIT_CACHE_DIR` | no | Cache folder, default `~/.kit/cache` |

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
   and refresh and has no secret-less mode for desktop apps, so it has to be
   on the user's machine: share it only with the people the app is for.
   Someone else holding it can start sign-ins in your app's name, but Figma
   sends the user back only to the redirect URL above, on the user's own
   machine, and kit protects that step with PKCE and a random `state`.
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
   Figma tokens expire; create a new one when kit reports a `403` on every
   file.

### Claude Code

Register the server once for all your projects. `${FIGMA_TOKEN}` is read from
your environment when the server starts, so the token is not stored in the
config (for the browser sign-in, put `FIGMA_CLIENT_ID` and
`FIGMA_CLIENT_SECRET` in `env` instead):

```sh
claude mcp add-json kit --scope user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@redfoxxo/kit@1"],
  "env": { "FIGMA_TOKEN": "${FIGMA_TOKEN}" }
}'
```

Then add the permission rules to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__kit__read_*", "mcp__kit__auth_*"],
    "ask": ["mcp__kit__write_*", "mcp__kit__delete_*"],
    "deny": ["mcp__kit__exec_*"]
  }
}
```

Claude Code names MCP tools `mcp__<server>__<tool>`, so the server name must be
`kit` for these rules to match. Move `exec_` to `ask` if you want the
assistant to run plugin code at all. Check the connection with
`claude mcp get kit`, or `/mcp` inside a session.

### opencode

Add the server and the permission rules to `opencode.json` (global:
`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "kit": {
        "type": "local",
        "command": ["npx", "-y", "@redfoxxo/kit@1"],
        "environment": { "FIGMA_TOKEN": "{env:FIGMA_TOKEN}" }
      }
    }
  },
  "permissions": [
    { "action": "kit_read_*", "resource": "*", "effect": "allow" },
    { "action": "kit_auth_*", "resource": "*", "effect": "allow" },
    { "action": "kit_write_*", "resource": "*", "effect": "ask" },
    { "action": "kit_delete_*", "resource": "*", "effect": "ask" },
    { "action": "kit_exec_*", "resource": "*", "effect": "deny" }
  ]
}
```

opencode names MCP tools `<server>_<tool>`, so the server name must be `kit`
for these rules to match (`read_outline` becomes `kit_read_outline`). Restart
opencode after changing the file; `opencode mcp list` shows whether it
connected.

### Other MCP clients

Any client that starts local (stdio) servers works. Most accept an
`mcpServers` block like this one (Claude Desktop, Cursor, ...):

```json
{
  "mcpServers": {
    "kit": {
      "command": "npx",
      "args": ["-y", "@redfoxxo/kit@1"],
      "env": { "FIGMA_TOKEN": "${FIGMA_TOKEN}" }
    }
  }
}
```

Whether `${FIGMA_TOKEN}` is read from your environment depends on the client;
where it is not, the token ends up in that file, so keep the file private.

### Editing: the kit bridge plugin

Figma's REST API cannot change designs, so edits go through a plugin running
in Figma desktop. It talks to kit over a WebSocket on `localhost`
(ports 7380–7389) and connects to every kit session running on the machine.

1. Run `npx -y @redfoxxo/kit@1 plugin`. It copies the plugin to `~/.kit/plugin`,
   writes the bridge key into it, and prints the manifest path.
2. In Figma desktop: Plugins → Development → Import plugin from manifest…, and
   pick that path. Once per machine.
3. Open the file to edit and run Plugins → Development → kit bridge. Keep its
   window open while the assistant works.

`read_bridge` shows what is connected. Edits go only to the plugin running in
the file named in the call; kit never guesses between open files.

The plugin proves itself with a key from `~/.kit/bridge.key` (readable by you
only) that `kit plugin` writes into its copy, and kit refuses connections
without it, from websites, and for other host names. After updating kit, run
`kit plugin` again when `read_bridge` reports a refused connection or says the
plugin is outdated, then close and relaunch the plugin in Figma.

### Files kit keeps

| Path | What |
|---|---|
| `~/.kit/auth.json` | The browser sign-in (OAuth tokens), readable by you only |
| `~/.kit/bridge.key` | The key the kit bridge plugin sends, readable by you only |
| `~/.kit/plugin/` | The plugin copy Figma imports |
| `~/.kit/cache/` | File snapshots and renders per file version (`KIT_CACHE_DIR`) |

## Tools

Tool names start with their tier, so client approval rules can allow reads,
ask before changes and block `exec_run`:

- `read_`: reads only. `auth_`: kit's own sign-in, changes no design.
- `write_`, `delete_`: change the file. `exec_`: runs any code the assistant
  writes in the plugin, with full access to the open file.

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

What kit enforces:

- Read answers are plain text under ~20K characters; longer ones end with
  `[more: …; call again with offset=N]` instead of being cut.
- Edits answer with the changed nodes only, and every edit call is one undo
  step in Figma.
- Edits go only to the plugin running in the named file; an outdated plugin
  is refused with instructions to update it.
- Images for `image` props are read by kit (the plugin has no file or network
  access): PNG, JPEG or GIF, up to 20 MB, from a file path or an http(s) URL.

## Limitations

- Editing needs Figma desktop with the kit bridge plugin running in the file;
  reading and comments work without it.
- Figma's API shows plugin edits a few seconds late; reads made in that window
  say so.
- Variables are read through the plugin: Figma's REST variables API needs an
  Enterprise plan.
- Figma rate-limits file downloads. kit asks for the file's version (a cheap
  call, at most once a minute per file) and downloads the file only when it
  changed; snapshots and renders are kept on disk per version, so a new
  session reuses them.
- Plugin code runs on Figma's main thread: a call that creates hundreds of
  nodes can freeze the file for a minute. kit stops waiting after 120 seconds,
  but the work may still finish.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT
