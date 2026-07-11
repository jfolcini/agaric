/**
 * Frontend-only Joplin `.jex` importer (#2513, part 2).
 *
 * A Joplin export (`.jex`) is a plain **tar archive** (USTAR) whose members are:
 *  - one `<id>.md` file per Joplin *item* — a note, notebook (folder), resource,
 *    tag, … — carrying the item's Markdown content followed by a trailing block
 *    of `key: value` metadata lines (the last of which is `type_:`), and
 *  - the raw resource binaries under `resources/<id>.<ext>`.
 *
 * This module is PURE (no IPC, no Tauri): it unpacks the tar in the browser,
 * classifies each item by its `type_` metadata (`1` note, `2` folder, `4`
 * resource), converts each note into composed importer Markdown, and returns
 * plain {@link JexNote} records. The caller (DataTab) hands each note's markdown
 * to the EXISTING `importMarkdown` IPC — one note → one page — exactly as the
 * `.enex` path does. The markdown importer already resolves `[[wikilinks]]`,
 * folder→namespace and YAML frontmatter, so we only PRODUCE markdown here.
 *
 * Joplin item bodies are ALREADY Markdown (unlike ENEX's ENML), so no
 * Turndown/DOM pass is needed. Two Joplin-specific reference forms are rewritten
 * text-side (Joplin uses `:/<32-hex-id>` for both):
 *  - **Resource embeds/links** `![alt](:/<resId>)` / `[label](:/<resId>)` → the
 *    resource's ingested vault path (`![alt](path)` / `[label](path)`), with the
 *    decoded bytes shipped on {@link JexNote.attachments} as `importMarkdown`'s
 *    `vaultFiles` — the SAME vault-attachment path a folder import (and the
 *    `.enex` importer, #2513 part 1) uses, so the backend ingests the bytes and
 *    canonicalizes the ref to `attachment:<id>`.
 *  - **Internal note links** `[label](:/<noteId>)` → an Agaric `[[Target Title]]`
 *    wikilink when the target note exists in the archive (best-effort link
 *    preservation); an unresolved `:/id` is left untouched as a stable
 *    placeholder rather than producing a broken embed.
 *
 * Folders are mapped to namespaces: a note under `Projects/Roadmap` lands as the
 * namespaced page `Projects/Roadmap/<title>`, mirroring the folder→namespace
 * convention a `.md` folder import uses (the importer treats `/` in the page
 * name as a namespace separator).
 *
 * GRACEFUL DEGRADATION: a malformed/partial archive never crashes the whole
 * import — an item whose metadata can't be parsed, or an encrypted item
 * (`encryption_applied: 1`), is skipped and counted in {@link JexParseResult.skipped}.
 * Tags (`type_: 5/6`) and other known-but-unimported item kinds are ignored
 * silently. The caller degrades per-note failures like the `.md`/`.enex` path.
 *
 * OUT OF SCOPE (still open on #2513): advanced ENML fidelity (part 3).
 */

/** A decoded resource attachment referenced by a note (#2513, part 2). */
export interface JexResource {
  /** Vault-relative path used both as the markdown embed target and shipped `VaultFile.path`. */
  path: string
  /** Raw resource bytes as stored under `resources/<id>.<ext>` in the tar. */
  bytes: Uint8Array
  /** The resource's declared MIME type (best-effort), e.g. `image/png`. */
  mime: string
}

/** A single parsed Joplin note, ready to compose into importer markdown. */
export interface JexNote {
  /**
   * Page title — the note's title prefixed with its folder namespace path when
   * the note lives inside notebook(s), e.g. `Projects/Roadmap`. `/` is the
   * importer's namespace separator, so this drives folder→namespace mapping.
   */
  title: string
  /** The note body Markdown, with Joplin `:/id` refs rewritten (no frontmatter). */
  markdown: string
  /** `created_time` as epoch milliseconds, or null when absent/unparseable. */
  createdMs: number | null
  /** `updated_time` as epoch milliseconds, or null when absent/unparseable. */
  updatedMs: number | null
  /**
   * Decoded resources referenced by this note's body (first-referenced order),
   * shipped as `importMarkdown`'s `vaultFiles`. Empty when the note embeds none.
   */
  attachments: JexResource[]
}

/** Outcome of parsing a `.jex` archive: the notes plus a skipped-item count. */
export interface JexParseResult {
  /** Notes (`type_: 1`) converted to composed-ready records. */
  notes: JexNote[]
  /**
   * Count of items skipped without importing — encrypted items and items whose
   * metadata could not be parsed. Tags and other known-but-unimported kinds are
   * NOT counted (they are simply ignored). Surfaced by the caller as a warning.
   */
  skipped: number
}

/** Placeholder title for a note whose first line (title) is empty. */
export const UNTITLED_PLACEHOLDER = 'Untitled'

/** Matches a Joplin item reference `:/<32-hex-id>` inside a markdown (image) link. */
const JOPLIN_REF_RE = /(!?)\[([^\]]*)\]\(:\/([0-9a-fA-F]{32})\)/g

// ---------------------------------------------------------------------------
// Minimal inline USTAR tar reader.
//
// The repo bundles no tar dependency, and the USTAR format is simple enough to
// read inline: a sequence of 512-byte header blocks, each followed by the
// member's data padded up to a 512-byte boundary. We only need the member name
// (offset 0, 100 bytes; plus the `prefix` field at 345 for long paths), the
// octal size (offset 124, 12 bytes) and the type flag (offset 156). Directory
// entries and extended-header records (pax/GNU) are skipped — Joplin's member
// names (`<32-hex>.md`, `resources/<32-hex>.<ext>`) are always short USTAR
// names, so no long-name handling is required for a real export.
// ---------------------------------------------------------------------------

/** One extracted tar member. */
interface TarEntry {
  name: string
  data: Uint8Array
}

/** Read an octal-ASCII numeric tar header field (whitespace/NUL padded). */
function readOctalField(block: Uint8Array, offset: number, length: number): number {
  let str = ''
  for (let i = offset; i < offset + length; i++) {
    const c = block[i]
    if (c === undefined || c === 0 || c === 0x20) continue
    str += String.fromCharCode(c)
  }
  if (str.length === 0) return 0
  const value = Number.parseInt(str, 8)
  return Number.isNaN(value) ? 0 : value
}

/** Read a NUL-terminated ASCII string tar header field. */
function readStringField(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && block[end] !== 0) end++
  return new TextDecoder('utf-8').decode(block.subarray(offset, end))
}

/**
 * Parse a USTAR archive into its file members. Non-regular entries
 * (directories, symlinks, pax/GNU extended headers) are skipped; the two
 * trailing all-zero blocks terminate the scan. A truncated final block ends the
 * scan gracefully rather than throwing (partial-archive tolerance).
 */
function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  const BLOCK = 512
  let offset = 0
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    // A wholly-zero header block marks end-of-archive.
    let allZero = true
    for (let i = 0; i < BLOCK; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const name = readStringField(header, 0, 100)
    const prefix = readStringField(header, 345, 155)
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
    const size = readOctalField(header, 124, 12)
    const typeFlagByte = header[156] ?? 0
    // '0' (0x30) and NUL (0x00) both denote a regular file; '7' is contiguous.
    const isRegular = typeFlagByte === 0 || typeFlagByte === 0x30 || typeFlagByte === 0x37

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (isRegular && name.length > 0 && dataEnd <= archive.length) {
      entries.push({ name: fullName, data: archive.subarray(dataStart, dataEnd) })
    }
    // Advance past the header + data, rounded up to the next 512 boundary.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

// ---------------------------------------------------------------------------
// Joplin item (de)serialization.
// ---------------------------------------------------------------------------

/** A Joplin item split into its content lines and trailing metadata props. */
interface JoplinItem {
  /** Content lines above the metadata block (line 0 is the title, for a note). */
  contentLines: string[]
  /** Parsed `key: value` metadata (`id`, `parent_id`, `type_`, …). */
  props: Record<string, string>
}

/**
 * Split a Joplin item file into its content lines and metadata, mirroring
 * Joplin's own `unserialize`: walk the lines from the BOTTOM collecting the
 * trailing run of `key: value` metadata lines; the first blank line reached
 * ends the metadata block, and everything above it is the content. Returns null
 * when no `type_` metadata is present (not a recognizable Joplin item).
 */
function unserialize(text: string): JoplinItem | null {
  const lines = text.split('\n')
  // Drop trailing blank lines (a file-final newline) so the from-bottom walk
  // starts on the last metadata line rather than mistaking a trailing empty
  // line for the metadata/content separator.
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop()
  const props: Record<string, string> = {}
  let readingProps = true
  let separatorIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (readingProps) {
      const trimmed = line.trim()
      if (trimmed === '') {
        // Blank line ends the metadata block; the content is everything above.
        readingProps = false
        separatorIndex = i
        continue
      }
      const colon = trimmed.indexOf(':')
      if (colon < 0) {
        // A non-`key: value` line inside the trailing block — treat everything
        // from here up as content (defensive; a well-formed item won't hit this).
        readingProps = false
        separatorIndex = i + 1
        continue
      }
      const key = trimmed.slice(0, colon).trim()
      const value = trimmed.slice(colon + 1).trim()
      if (key.length > 0) props[key] = value
    }
  }
  if (!('type_' in props)) return null
  const contentLines = separatorIndex >= 0 ? lines.slice(0, separatorIndex) : []
  return { contentLines, props }
}

/** Strip leading blank lines and trailing whitespace from a note body. */
function normalizeBody(lines: string[]): string {
  let start = 0
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++
  return lines.slice(start).join('\n').replace(/\s+$/, '')
}

/** Parse a Joplin ISO-8601 (or epoch-ms) timestamp to epoch ms, or null. */
function parseJoplinTime(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const ms = Date.parse(raw.trim())
  return Number.isNaN(ms) ? null : ms
}

// ---------------------------------------------------------------------------
// Resource path naming (mirrors the `.enex` importer's approach).
// ---------------------------------------------------------------------------

/** Map a resource MIME type to a filename extension (best-effort). */
function mimeToExt(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'text/plain': 'txt',
  }
  if (mime in known) return known[mime] ?? 'bin'
  const sub = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]+/gi, '').toLowerCase()
  return sub.length > 0 && sub.length <= 5 ? sub : 'bin'
}

/** Basename-only, control-char-free filename (no path traversal). */
function sanitizeResourceName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  let out = ''
  for (const ch of base) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && cp >= 0x20) out += ch
  }
  return out.trim()
}

/** Metadata for one Joplin resource item (`type_: 4`). */
interface ResourceMeta {
  mime: string
  ext: string
  title: string
}

/**
 * Build the archive-wide `resourceId → JexResource` index, keyed by lowercase
 * id, from the decoded resource binaries and their metadata. A binary with no
 * matching metadata item still gets a deterministic `<id>.<ext>` name (ext from
 * the tar filename); filename collisions across distinct resources are
 * disambiguated with a short id prefix so both survive as distinct vault files.
 */
function indexResources(
  binaries: Map<string, { bytes: Uint8Array; ext: string }>,
  metas: Map<string, ResourceMeta>,
): Map<string, JexResource> {
  const byId = new Map<string, JexResource>()
  const usedPaths = new Set<string>()
  for (const [id, { bytes, ext: fileExt }] of binaries) {
    const meta = metas.get(id)
    const mime = meta?.mime && meta.mime.length > 0 ? meta.mime : 'application/octet-stream'
    const ext =
      fileExt.length > 0 ? fileExt : meta?.ext && meta.ext.length > 0 ? meta.ext : mimeToExt(mime)
    const title = sanitizeResourceName(meta?.title ?? '')
    let candidate: string
    if (title.length > 0) {
      candidate = /\.[^./\\]+$/.test(title) ? title : `${title}.${ext}`
    } else {
      candidate = `${id}.${ext}`
    }
    if (usedPaths.has(candidate)) {
      const dot = candidate.lastIndexOf('.')
      const stem = dot === -1 ? candidate : candidate.slice(0, dot)
      const suffix = dot === -1 ? '' : candidate.slice(dot)
      candidate = `${stem}-${id.slice(0, 8)}${suffix}`
    }
    usedPaths.add(candidate)
    byId.set(id, { path: candidate, bytes, mime })
  }
  return byId
}

// ---------------------------------------------------------------------------
// Folder namespace resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve a Joplin folder id to a `/`-joined namespace path by walking its
 * `parent_id` chain up to the root. Guards against cycles and pathological
 * depth. Returns '' for the root (no parent) or an unknown folder.
 */
function resolveFolderPath(
  folderId: string,
  folders: Map<string, { title: string; parentId: string }>,
): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let current = folderId
  let depth = 0
  while (current.length > 0 && !seen.has(current) && depth < 64) {
    seen.add(current)
    depth++
    const folder = folders.get(current)
    if (folder === undefined) break
    const title = folder.title.replace(/\s+/g, ' ').trim()
    if (title.length > 0) parts.unshift(title)
    current = folder.parentId
  }
  return parts.join('/')
}

// ---------------------------------------------------------------------------
// Top-level parse.
// ---------------------------------------------------------------------------

/** A note item pending body rewrite (needs the archive-wide id maps first). */
interface RawNote {
  id: string
  title: string
  /** Parent notebook id, for folder→namespace resolution. */
  parentId: string
  body: string
  createdMs: number | null
  updatedMs: number | null
}

/** Tar members split into decoded item `.md` texts and resource binaries. */
interface SplitMembers {
  itemTexts: string[]
  resourceBinaries: Map<string, { bytes: Uint8Array; ext: string }>
}

/** Split tar members into item `.md` files and `resources/<id>.<ext>` binaries. */
function splitMembers(entries: TarEntry[]): SplitMembers {
  const itemTexts: string[] = []
  const resourceBinaries = new Map<string, { bytes: Uint8Array; ext: string }>()
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (name.startsWith('resources/')) {
      const base = name.slice('resources/'.length)
      if (base.length === 0 || base.includes('/')) continue
      const dot = base.lastIndexOf('.')
      const id = (dot === -1 ? base : base.slice(0, dot)).toLowerCase()
      const ext = dot === -1 ? '' : base.slice(dot + 1)
      if (id.length > 0) resourceBinaries.set(id, { bytes: entry.data, ext })
    } else if (name.endsWith('.md') && !name.includes('/')) {
      itemTexts.push(new TextDecoder('utf-8').decode(entry.data))
    }
  }
  return { itemTexts, resourceBinaries }
}

/** Items classified by `type_` metadata, plus a skipped-item count. */
interface ClassifiedItems {
  rawNotes: RawNote[]
  folders: Map<string, { title: string; parentId: string }>
  resourceMetas: Map<string, ResourceMeta>
  skipped: number
}

/** Classify each item `.md` text into notes / folders / resource metadata. */
function classifyItems(itemTexts: string[]): ClassifiedItems {
  const rawNotes: RawNote[] = []
  const folders = new Map<string, { title: string; parentId: string }>()
  const resourceMetas = new Map<string, ResourceMeta>()
  let skipped = 0

  for (const text of itemTexts) {
    const item = unserialize(text)
    // No `type_` (unrecognizable) or encrypted → skip with a count.
    if (item === null || item.props['encryption_applied'] === '1') {
      skipped++
      continue
    }
    const { props, contentLines } = item
    const id = (props['id'] ?? '').toLowerCase()
    const firstLine = (contentLines[0] ?? '').trim()
    if (props['type_'] === '1') {
      rawNotes.push({
        id,
        title: firstLine.length > 0 ? firstLine : UNTITLED_PLACEHOLDER,
        parentId: (props['parent_id'] ?? '').toLowerCase(),
        body: normalizeBody(contentLines.slice(1)),
        createdMs: parseJoplinTime(props['user_created_time'] ?? props['created_time']),
        updatedMs: parseJoplinTime(props['user_updated_time'] ?? props['updated_time']),
      })
    } else if (props['type_'] === '2' && id.length > 0) {
      folders.set(id, { title: firstLine, parentId: (props['parent_id'] ?? '').toLowerCase() })
    } else if (props['type_'] === '4' && id.length > 0) {
      resourceMetas.set(id, {
        mime: props['mime'] ?? '',
        ext: props['file_extension'] ?? '',
        title: firstLine,
      })
    }
    // Tags (5), note-tag links (6), settings, … — known but not imported.
  }
  return { rawNotes, folders, resourceMetas, skipped }
}

/**
 * Rewrite a note body's Joplin `:/id` references: resource refs → the ingested
 * vault path (collecting the shipped {@link JexResource} into `attachments`),
 * internal note links → a `[[Target]]` wikilink, and any unresolved ref left
 * untouched as a stable placeholder.
 */
function rewriteNoteBody(
  body: string,
  resourcesById: Map<string, JexResource>,
  noteTitleById: Map<string, string>,
  attachments: JexResource[],
): string {
  return body.replace(JOPLIN_REF_RE, (match, bang: string, label: string, refIdRaw: string) => {
    const refId = refIdRaw.toLowerCase()
    const resource = resourcesById.get(refId)
    if (resource !== undefined) {
      if (!attachments.some((a) => a.path === resource.path)) attachments.push(resource)
      return `${bang}[${label}](${resource.path})`
    }
    const targetTitle = noteTitleById.get(refId)
    // Preserve an internal note link as an Agaric wikilink (best-effort).
    if (targetTitle !== undefined) return `[[${targetTitle}]]`
    return match
  })
}

/**
 * Parse a Joplin `.jex` archive (raw tar bytes) into {@link JexNote}s.
 *
 * Never throws on a malformed/partial archive: an unreadable tar yields no
 * members (→ empty notes), and per-item parse failures / encrypted items are
 * counted in {@link JexParseResult.skipped} rather than aborting the run.
 */
export function parseJex(archive: Uint8Array): JexParseResult {
  const { itemTexts, resourceBinaries } = splitMembers(readTar(archive))
  const { rawNotes, folders, resourceMetas, skipped } = classifyItems(itemTexts)
  const resourcesById = indexResources(resourceBinaries, resourceMetas)

  // Build note-id → page-title (namespaced) for internal link resolution.
  const noteTitleById = new Map<string, string>()
  for (const raw of rawNotes) {
    if (raw.id.length > 0) noteTitleById.set(raw.id, pageTitleFor(raw, folders))
  }

  // Rewrite each note body's `:/id` refs and collect its attachments.
  const notes: JexNote[] = rawNotes.map((raw) => {
    const attachments: JexResource[] = []
    const markdown = rewriteNoteBody(raw.body, resourcesById, noteTitleById, attachments)
    return {
      title: pageTitleFor(raw, folders),
      markdown,
      createdMs: raw.createdMs,
      updatedMs: raw.updatedMs,
      attachments,
    }
  })

  return { notes, skipped }
}

/**
 * Compose a note's namespaced page title from its folder chain: the resolved
 * `parent_id` namespace path prefixed onto the note title (`Folder/Sub/Title`),
 * or just the title for a root-level note. `/` is the importer's namespace
 * separator, so this is what drives folder→namespace mapping.
 */
function pageTitleFor(
  raw: RawNote,
  folders: Map<string, { title: string; parentId: string }>,
): string {
  const namespace = resolveFolderPath(raw.parentId, folders)
  return namespace.length > 0 ? `${namespace}/${raw.title}` : raw.title
}

/**
 * Sanitize a note's page title for use as the import filename. Mirrors the
 * `.enex` importer: KEEP `/` (namespace separator), collapse whitespace, and
 * fall back to {@link UNTITLED_PLACEHOLDER} for an empty result.
 */
export function sanitizeNoteTitleToFilename(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : UNTITLED_PLACEHOLDER
}

/**
 * Compose the final Markdown handed to `importMarkdown` for a note:
 *  1. a YAML frontmatter block (`created`/`updated` ISO strings when known,
 *     plus `source: joplin`), and
 *  2. the note body (with `:/id` refs already rewritten).
 */
export function jexNoteToMarkdown(note: JexNote): string {
  const frontmatter: string[] = ['---']
  if (note.createdMs !== null) {
    frontmatter.push(`created: "${new Date(note.createdMs).toISOString()}"`)
  }
  if (note.updatedMs !== null) {
    frontmatter.push(`updated: "${new Date(note.updatedMs).toISOString()}"`)
  }
  frontmatter.push('source: joplin')
  frontmatter.push('---')

  const sections: string[] = [frontmatter.join('\n')]
  if (note.markdown.length > 0) sections.push(note.markdown)
  return `${sections.join('\n\n')}\n`
}
