/** File key from a Figma URL (`/file/`, `/design/`, `/proto/`, `/board/`) or a bare key. */
export function parseFileKey(input: string): string | undefined {
  const text = input.trim()
  const fromUrl = /figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/.exec(text)
  if (fromUrl) {
    // Branch URLs: /design/KEY/branch/BRANCH_KEY/... — the branch is the file to read.
    const branch = /\/branch\/([A-Za-z0-9]+)/.exec(text)
    return branch?.[1] ?? fromUrl[1]
  }
  return /^[A-Za-z0-9]{10,}$/.test(text) ? text : undefined
}

/** Node id from `80:5478`, `80-5478` (URL form), an instance id like `I1:2;3:4`, or a URL with `node-id`. */
export function parseNodeId(input: string): string | undefined {
  let text = input.trim()
  const param = /[?&]node-id=([^&#]+)/.exec(text)
  if (param?.[1]) text = decodeURIComponent(param[1])
  if (/^I?\d+[:-]\d+(?:;\d+[:-]\d+)*$/.test(text)) return text.replace(/-/g, ':')
  return undefined
}

/** Link to a node, in the form Figma's "Copy link" produces. */
export function nodeUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/design/${fileKey}/?node-id=${nodeId.replace(/:/g, '-')}`
}
