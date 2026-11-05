# Changelog

## 0.1.0 (unreleased)

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
