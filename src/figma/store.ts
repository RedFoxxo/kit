import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Http, Result } from './http.js'
import type { FigmaNode, FileResponse, MetaResponse } from './types.js'

/** A file snapshot with a parent index, so any node's page, section and frame are found without a request. */
export class FigmaFile {
  readonly key: string
  readonly name: string
  readonly version: string
  readonly lastModified: string
  readonly raw: FileResponse
  /** True when edits made through the plugin are not in this REST snapshot yet. */
  stale = false
  private readonly nodes = new Map<string, FigmaNode>()
  private readonly parents = new Map<string, string>()

  constructor(key: string, raw: FileResponse) {
    this.key = key
    this.name = raw.name
    this.version = raw.version
    this.lastModified = raw.lastModified
    this.raw = raw
    const stack: FigmaNode[] = [raw.document]
    while (stack.length > 0) {
      const node = stack.pop()!
      this.nodes.set(node.id, node)
      for (const child of node.children ?? []) {
        this.parents.set(child.id, node.id)
        stack.push(child)
      }
    }
  }

  get pages(): FigmaNode[] {
    return this.raw.document.children ?? []
  }

  node(id: string): FigmaNode | undefined {
    return this.nodes.get(id)
  }

  parent(id: string): FigmaNode | undefined {
    const parentId = this.parents.get(id)
    return parentId === undefined ? undefined : this.nodes.get(parentId)
  }

  /** Every node in the file, depth-first. */
  all(): IterableIterator<FigmaNode> {
    return this.nodes.values()
  }

  /**
   * The screen a node belongs to: its outermost ancestor (or itself) that sits
   * directly on a page or in a section and is not a section itself.
   */
  frameOf(id: string): FigmaNode | undefined {
    let current = this.nodes.get(id)
    while (current) {
      const parent = this.parent(current.id)
      if (!parent) return undefined
      if ((parent.type === 'CANVAS' || parent.type === 'SECTION') && current.type !== 'SECTION') return current
      current = parent
    }
    return undefined
  }

  /** `Page › Section` path above a node, without the node itself. */
  where(id: string): string {
    const names: string[] = []
    let parent = this.parent(id)
    while (parent && parent.type !== 'DOCUMENT') {
      if (parent.type === 'CANVAS' || parent.type === 'SECTION') names.unshift(parent.name.trim())
      parent = this.parent(parent.id)
    }
    return names.join(' › ')
  }
}

/** Same version for this long: no request at all. */
const RECHECK_MS = 60_000

/**
 * Loads files once per version. The cheap `meta` call tells the version; the
 * full file is fetched only when it changed and is kept on disk, so a new
 * session or another tool call does not download it again.
 */
export class FileStore {
  private readonly memory = new Map<string, { file: FigmaFile; checkedAt: number }>()
  /** Snapshot version as it was before a plugin edit, per file, until REST reports a newer one. */
  private readonly edited = new Map<string, string>()

  constructor(
    private readonly http: Http,
    private readonly cacheDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, signal?: AbortSignal): Promise<Result<FigmaFile>> {
    const cached = this.memory.get(key)
    if (cached && this.now() - cached.checkedAt < RECHECK_MS) return { ok: true, data: cached.file }

    const meta = await this.http.json<MetaResponse>(`/v1/files/${key}/meta`, signal)
    // `version` only moves at Figma's save checkpoints; `last_touched_at` moves on every edit. Together they name a snapshot.
    const version = meta.ok ? [meta.data.file.version, meta.data.file.last_touched_at].filter(Boolean).join('@') || undefined : undefined
    // REST shows plugin edits only after a few seconds; until then it still reports the version from before the edit.
    const behind = version !== undefined && this.edited.get(key) === version
    if (!behind) this.edited.delete(key)
    const settle = (raw: FileResponse) => {
      const file = this.remember(key, raw)
      file.stale = behind
      if (behind) this.memory.delete(key)
      return file
    }
    if (cached && (version === undefined ? !meta.ok : version === cached.file.version)) {
      // Unchanged, or the version cannot be checked right now: keep what we have.
      cached.checkedAt = this.now()
      return { ok: true, data: cached.file }
    }

    if (version !== undefined) {
      const fromDisk = await this.readDisk(key, version)
      if (fromDisk) return { ok: true, data: settle(fromDisk) }
    }

    const fetched = await this.http.json<FileResponse>(`/v1/files/${key}`, signal)
    if (!fetched.ok) return fetched
    // Key the snapshot by the version meta reported, so the next check matches it.
    const raw = { ...fetched.data, version: version ?? fetched.data.version }
    await this.writeDisk(key, raw)
    return { ok: true, data: settle(raw) }
  }

  /** Call after an edit made through the plugin: the next read checks the version again and flags a snapshot that is still from before the edit. */
  forget(key: string): void {
    const before = this.memory.get(key)?.file.version
    if (before !== undefined && !this.edited.has(key)) this.edited.set(key, before)
    this.memory.delete(key)
  }

  /** Folder for this file's cached data (renders live here too). */
  dir(key: string): string {
    return join(this.cacheDir, key)
  }

  private remember(key: string, raw: FileResponse): FigmaFile {
    const file = new FigmaFile(key, raw)
    this.memory.set(key, { file, checkedAt: this.now() })
    return file
  }

  private snapshotPath(key: string, version: string): string {
    return join(this.dir(key), `${version.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  private async readDisk(key: string, version: string): Promise<FileResponse | undefined> {
    try {
      return JSON.parse(await readFile(this.snapshotPath(key, version), 'utf8')) as FileResponse
    } catch {
      return undefined
    }
  }

  /** Writes the snapshot and drops older versions of the same file. Cache failures never fail a call. */
  private async writeDisk(key: string, raw: FileResponse): Promise<void> {
    try {
      const dir = this.dir(key)
      await mkdir(dir, { recursive: true })
      const path = this.snapshotPath(key, raw.version)
      for (const entry of await readdir(dir)) {
        if (entry.endsWith('.json') && join(dir, entry) !== path) await rm(join(dir, entry), { force: true })
      }
      await rm(join(dir, 'renders'), { recursive: true, force: true })
      await writeFile(path, JSON.stringify(raw))
    } catch {
      // A read-only or full disk only costs a re-download next time.
    }
  }
}
