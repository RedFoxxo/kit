# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal) and is reported to
MCP clients in the server handshake. The kit bridge plugin has its own
`PROTOCOL` number (`src/bridge/bridge.ts`, `plugin/code.js`).

## 1.2.0 — 2026-11-19

- **Run `kit plugin` again after updating** (`npx -y @redfoxxo/kit@1 plugin`),
  then close and relaunch kit bridge in Figma. The plugin now proves itself
  with a key that `kit plugin` writes into its copy (kept in
  `~/.kit/bridge.key`, readable by you only). Before, any website could open
  a hidden sandboxed frame, connect to kit as if it were the plugin, receive
  the edits and images kit sends, and put its own text into tool answers.
  `read_bridge` says when kit refused a plugin without the key. The bridge
  also refuses requests for host names other than `localhost`, `127.0.0.1`
  and `[::1]` (DNS rebinding), and messages sent in endless fragments.
- Images from a URL are capped at 20 MB while downloading, and renders at
  32 MB, instead of being read whole first. A failed image download reports
  only its status, not the page it returned.
- A refresh that Figma rate-limits (429) or times out (408) no longer deletes
  the sign-in; kit keeps the token and tries again later.
- The sign-in exchanges Figma's code once when the browser opens the callback
  twice (a reload), instead of reporting a failed sign-in.
- File snapshots and renders are cached in folders only you can open.
- The tool list is about 1,900 bytes (~470 tokens) smaller: no JSON Schema
  draft URL, no safe-integer bounds on integers, shorter `file` and `offset`
  descriptions. Tools, parameters and answers are unchanged.
- Dependencies: `zod` 4.6.7 (fixes GHSA-mrhx-c7xc-m3w5),
  `@modelcontextprotocol/sdk` 1.32.2.

## 1.1.0 — 2026-11-13

- Browser sign-in with your own Figma OAuth app (`FIGMA_CLIENT_ID`,
  `FIGMA_CLIENT_SECRET`): `auth_login` opens Figma's sign-in page and waits
  for the loopback callback on `127.0.0.1:7390` (PKCE). The tokens are kept
  in `~/.kit/auth.json`, shared by every kit session, refreshed a day before
  they expire (halfway, for short-lived ones) and after Figma refuses them.
  When the sign-in can't be renewed, tools ask for `auth_login` again.
  `FIGMA_TOKEN` keeps working.
- New `auth_` tool tier for kit's own sign-in.

## 1.0.0 — 2026-11-05

- Read tools: `read_outline`, `read_frame_text`, `read_search`,
  `read_comments`, `read_structure`, `read_styles`, `read_render`.
- File snapshots cached on disk per version; renders cached per version.
- Answers paged at 20,000 characters with an `offset` to continue.
- Bridge to the "kit bridge" Figma plugin over a loopback WebSocket
  (ports 7380–7389), `read_bridge` status and `kit plugin` to install the plugin.
- Write tools through the plugin: `write_props` (texts, paints, effects,
  auto layout, styles, component properties), `write_create` (nested trees in
  one call), `delete_nodes`, `exec_run`; each call is one undo step in Figma.
- `write_comment` posts comments and replies through the REST API.
- `read_render` exports live through the plugin when it runs in the file.
- Reads made before Figma's API shows a plugin edit are flagged as stale.
- An outdated plugin is refused with instructions to update it.
- `read_bridge` lists the selected nodes, so "what I selected" can be read or
  edited by id.
- `read_styles` includes local variables with a value per mode, read through
  the plugin (Figma's REST variables API needs an Enterprise plan).
- Images from a file path or URL as node fills (`image` prop); kit reads them,
  since the plugin has no file or network access.
- Mixed text styles with `textRanges` (by substring or character range).
- `write_create` builds components and variant sets; `component: true` turns
  an existing node into a component.
- `select: true` selects the created or changed nodes and brings them into view.
