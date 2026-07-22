import JSZip from 'jszip'

import { flushActiveDraft } from '@/lib/active-draft-flush'
import { ATTACHMENT_REF_SCHEME, parseAttachmentRef } from '@/lib/attachment-ref'
import { logger } from '@/lib/logger'
import {
  exportPageMarkdown,
  listAllPagesInSpace,
  listSpaces,
  readAttachment,
  readAttachmentMeta,
} from '@/lib/tauri'

/**
 * Characters that are illegal in a path SEGMENT on common filesystems
 * (Windows being the strictest). Note `/` is deliberately NOT in this class:
 * a namespaced page title (`Project/Backend/API`) uses `/` as the namespace
 * separator, which we map to nested folders (#1446 Part A). Only the genuinely
 * illegal-per-segment characters are sanitized.
 */
const ILLEGAL_SEGMENT_CHARS_RE = /[\\:*?"<>|]/g

/**
 * The folder inside the export ZIP that holds emitted attachment bytes (#1490,
 * #2961). Both inline images and block-scoped file attachments are stored as
 * `attachment:<id>` refs that are not portable, so on export we write each
 * referenced attachment here and rewrite the markdown link to a relative path
 * into this folder so the exported link (image or plain file link) renders in
 * other tools.
 */
const ASSETS_DIR = 'assets'

/**
 * Matches BOTH an inline-image link (`![alt](attachment:<id>)`) and a plain
 * file link (`[label](attachment:<id>)`) whose URL is an internal
 * `attachment:<id>` ref. Group 1 is the optional leading `!` (present for
 * images, absent for block-scoped file attachments), group 2 is the
 * alt/label text, group 3 is the `attachment:<id>` URL.
 */
const ATTACHMENT_REF_RE = /(!?)\[([^\]]*)\]\((attachment:[^)\s]+)\)/g

/**
 * Windows device names reserved case-insensitively regardless of extension
 * (`CON`, `con.txt`, `Nul.md` are all invalid on Windows) — matched against
 * the segment's basename (the part before its first `.`), not the whole
 * string, so `CON.tar.gz` is still caught via its `CON` basename.
 */
const RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Escape a segment whose basename is a Windows-reserved device name by
 * suffixing the basename with `_`, preserving whatever extension followed
 * (`CON` → `CON_`, `CON.txt` → `CON_.txt`, `nul.md` → `nul_.md`). Segments
 * whose basename isn't reserved are returned unchanged.
 */
function escapeReservedDeviceName(name: string): string {
  const dotIndex = name.indexOf('.')
  const basename = dotIndex === -1 ? name : name.slice(0, dotIndex)
  const rest = dotIndex === -1 ? '' : name.slice(dotIndex)
  if (!RESERVED_DEVICE_NAME_RE.test(basename.trimEnd())) return name
  return `${basename}_${rest}`
}

/**
 * Sanitize ONE path segment: trim it, strip illegal-per-segment characters,
 * neutralize path-traversal segments (`.` / `..` / any all-dots segment),
 * trim trailing dots/spaces, escape Windows-reserved device names, and fall
 * back to `Untitled` when nothing usable remains. The namespace separator `/`
 * is handled by the caller (split into segments) and never reaches here.
 *
 * Neutralizing a dots-only segment is a SECURITY requirement, not cosmetics: a
 * page titled `../../etc/passwd` would otherwise emit a ZIP entry
 * `../../etc/passwd.md`, a classic Zip-Slip path that escapes the extraction
 * root when the archive is unpacked by a naive tool. A leading empty segment
 * (absolute `/etc/...`) is already dropped by the caller's `filter`.
 *
 * Trailing dots/spaces are trimmed (Windows silently strips them on write, so
 * `Notes.` and `Notes` would otherwise collide or resolve to a different name
 * than written) and a Windows-reserved device basename (`CON`, `NUL`, `COM1`,
 * …) is escaped, since a file by that exact name (with or without extension)
 * is invalid/dangerous to create on Windows. Both run BEFORE the final
 * empty→fallback check so a segment that trims down to nothing (e.g. a name
 * made entirely of dots and spaces) still falls back to `Untitled`.
 */
export function sanitizeSegment(segment: string): string {
  let cleaned = segment.replace(ILLEGAL_SEGMENT_CHARS_RE, '_').trim()
  // A segment that is empty or consists solely of dots (`.`, `..`, `...`) is a
  // traversal/relative-path token, not a usable folder name — replace it.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return 'Untitled'

  cleaned = cleaned.replace(/[. ]+$/, '')
  if (cleaned.length === 0) return 'Untitled'

  return escapeReservedDeviceName(cleaned)
}

/**
 * Map a page title to its ZIP-relative path WITHOUT the `.md` extension,
 * splitting the namespace on `/` into nested folders (#1446 Part A). Each
 * segment is sanitized independently so the namespace hierarchy survives the
 * round-trip (`Project/Backend/API` → `Project/Backend/API`), fixing the prior
 * data-loss bug that flattened `/` to `_`. Empty segments (leading/trailing or
 * doubled slashes) are dropped.
 */
function titleToZipPath(title: string): string {
  const segments = title
    .split('/')
    .map((s) => sanitizeSegment(s))
    .filter((s) => s.length > 0)
  return segments.length > 0 ? segments.join('/') : 'Untitled'
}

/**
 * Number of `../` hops needed to climb from a `.md` file at `zipPath` back to
 * the ZIP root, so an asset link resolves regardless of namespace depth. A page
 * at `Project/Backend/API.md` lives two folders deep, so its assets link is
 * `../../assets/<file>`.
 */
function relativePrefixForDepth(zipPath: string): string {
  const depth = zipPath.split('/').length - 1
  return '../'.repeat(depth)
}

/**
 * Return `base`, or a disambiguated variant, so a caller can add distinct
 * entries to a flat namespace tracked case-insensitively in `seen`. If
 * `base` is not already in `seen` it is returned as-is. Otherwise it is
 * first suffixed with the first 8 chars of `id` (the shared-prefix window
 * ULIDs minted in the same ~256ms bulk-import chunk can collide on, #2723);
 * if THAT still collides, an incrementing counter is appended until unique.
 * Whichever name is returned is added to `seen` (case-folded) before
 * returning, so callers never re-add it themselves.
 *
 * Shared by the page path-collision dedup inside {@link exportSpacePagesIntoZip}
 * (originally inline here, #1490/#2723) and the all-spaces exporter's
 * space-folder-name dedup (#2964) — both need the exact same "same name
 * twice must never overwrite one of them" guarantee.
 */
function disambiguate(base: string, id: string, seen: Set<string>): string {
  let candidate = base
  if (seen.has(candidate.toLowerCase())) {
    const withId = `${base}_${id.slice(0, 8)}`
    candidate = withId
    let suffixCounter = 2
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${withId}-${suffixCounter}`
      suffixCounter += 1
    }
  }
  seen.add(candidate.toLowerCase())
  return candidate
}

/**
 * Map a space's display name to a filesystem-safe top-level ZIP folder name
 * for {@link exportAllSpacesAsZip} (#2964). Unlike a page title, a space
 * name is never namespaced, so any `/` it happens to contain is flattened to
 * `_` (not treated as a nesting separator, unlike {@link titleToZipPath})
 * before the usual per-segment sanitization (`sanitizeSegment`) runs.
 */
function spaceNameToFolderName(name: string): string {
  return sanitizeSegment(name.replaceAll('/', '_'))
}

/**
 * Result of {@link exportGraphAsZip} (#2965). `skippedPages` and
 * `skippedAttachments` let the caller distinguish a fully-successful export
 * from a partial one — the ZIP-building loop below never rejects on a
 * per-page or per-attachment failure (partial output is more useful than
 * none), but silently reporting SUCCESS regardless is misleading: the user
 * has no way to learn that something was dropped. `skippedAttachments`
 * counts DISTINCT attachment ids that could not be read/emitted (an
 * attachment referenced from several pages that fails is counted once, not
 * once per referencing page).
 */
export interface ExportGraphResult {
  blob: Blob
  /** Pages successfully written to the ZIP. */
  exportedPages: number
  /** Pages whose `export_page_markdown` call failed and were dropped. */
  skippedPages: number
  /** Distinct attachment ids that could not be read/emitted. */
  skippedAttachments: number
}

/** One line of the `export-report.txt` skip ledger — see {@link buildExportReport}. */
interface SkippedPageEntry {
  title: string
}
interface SkippedAttachmentEntry {
  attachmentId: string
  /** ZIP path of a page that references this attachment (first one seen). */
  referencedIn: string
}

/**
 * Render the plain-text `export-report.txt` written into the ZIP whenever
 * anything was skipped (#2965). Kept dead simple (no counts-in-docs style
 * table, just a flat list) since this is a one-shot artifact, not a
 * long-lived doc.
 */
function buildExportReport(
  skippedPages: SkippedPageEntry[],
  skippedAttachments: SkippedAttachmentEntry[],
): string {
  const lines: string[] = [
    'Agaric export report',
    '',
    'Some items could not be exported and were skipped. Everything else in',
    'this ZIP exported normally.',
    '',
  ]
  if (skippedPages.length > 0) {
    lines.push(`Skipped pages (${skippedPages.length}):`)
    for (const p of skippedPages) lines.push(`  - ${p.title}`)
    lines.push('')
  }
  if (skippedAttachments.length > 0) {
    lines.push(`Skipped attachments (${skippedAttachments.length}):`)
    for (const a of skippedAttachments) {
      lines.push(`  - ${a.attachmentId} (referenced in ${a.referencedIn}.md)`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Per-space accumulation returned by {@link exportSpacePagesIntoZip}. */
interface SpaceExportAccumulation {
  exportedPages: number
  skippedPageEntries: SkippedPageEntry[]
  skippedAttachmentEntries: SkippedAttachmentEntry[]
}

/**
 * Export every page of `spaceId` into `zip`, with every entry's path
 * prefixed by `pathPrefix` — `''` for {@link exportGraphAsZip}'s top-level
 * single-space layout, or `"<folder>/"` for {@link exportAllSpacesAsZip}'s
 * per-space folder (#2964). This holds the exact page-export /
 * attachment-rewrite / collision-dedup logic `exportGraphAsZip` has always
 * run (#1490/#2723/#2965) — extracted so the all-spaces exporter can reuse
 * it verbatim once per space instead of duplicating it. `exportGraphAsZip`
 * itself is unchanged by this extraction: it calls this helper with
 * `pathPrefix: ''`, which reproduces its prior inline behavior byte-for-byte.
 *
 * Each page becomes a `.md` file whose path mirrors its namespace: the title is
 * split on `/` into nested folders (`Project/Backend/API` → `Project/Backend/
 * API.md`), so the hierarchy round-trips (#1446 Part A). True filename
 * collisions (same full path, case-insensitively) are deduped with a
 * ULID-derived suffix that is re-checked and, if still colliding, extended
 * with an incrementing counter until unique (#2723) — no entry is ever
 * silently overwritten in the output ZIP.
 *
 * Inline images (`attachment:<id>` refs, #1434) are not portable, so each
 * referenced attachment's bytes are emitted under `<pathPrefix>assets/` and the
 * markdown link is rewritten to a relative path (`![alt](../assets/<file>)`) so
 * the exported image renders in other tools (#1490 residual).
 *
 * Per-page/attachment failures are caught and skipped (partial output beats
 * none) but are COUNTED and returned via `skippedPageEntries` /
 * `skippedAttachmentEntries` (#2965) rather than silently disappearing —
 * callers combine these into their own `export-report.txt`.
 */
async function exportSpacePagesIntoZip(
  zip: JSZip,
  spaceId: string,
  pathPrefix: string,
): Promise<SpaceExportAccumulation> {
  // `listAllPagesInSpace` returns every page in one query (no pagination, no
  // clamp) — bounded by the space's intrinsic page count, which is what the
  // export needs.
  const pages = await listAllPagesInSpace(spaceId)

  // Cache of emitted assets keyed by attachment id, so an image referenced from
  // multiple pages is written once and every page links to the same file.
  // `null` marks an attachment we already failed to emit (skip silently next time).
  const emittedAssets = new Map<string, string | null>()
  // First page (zip path) each failed attachment id was seen in — for the report.
  const skippedAttachmentSeenIn = new Map<string, string>()

  // Export each page to markdown. Per-page failures are logged and skipped so a
  // single broken page does not reject the whole export — partial output is more
  // useful than none.
  const seen = new Set<string>()
  let exportedPages = 0
  const skippedPageEntries: SkippedPageEntry[] = []
  for (const page of pages) {
    let md: string
    try {
      md = await exportPageMarkdown(page.id)
    } catch (err) {
      logger.warn('export-graph', 'page export failed', { pageId: page.id }, err)
      skippedPageEntries.push({ title: `${pathPrefix}${page.content ?? page.id}` })
      continue
    }

    // Namespace `/` → nested folders, sanitizing per segment; dedup true
    // collisions (same full path, case-insensitively so 'API'/'api' don't
    // clash at extraction on case-insensitive filesystems) via `disambiguate`
    // (#1490/#2723 — see its doc comment for the suffix/counter scheme).
    const zipPath = disambiguate(titleToZipPath(page.content ?? 'Untitled'), page.id, seen)

    // #1490 / #2961 — rewrite `attachment:<id>` refs (both inline image links
    // AND block-scoped file links) to portable asset paths, emitting the
    // bytes into `<pathPrefix>assets/`. Done per page because the relative
    // `../` prefix depends on this page's namespace depth.
    const rewritten = await rewriteAttachmentRefs(
      md,
      zip,
      emittedAssets,
      relativePrefixForDepth(zipPath),
      pathPrefix,
    )
    md = rewritten.md
    for (const attachmentId of rewritten.skippedAttachmentIds) {
      if (!skippedAttachmentSeenIn.has(attachmentId)) {
        skippedAttachmentSeenIn.set(attachmentId, `${pathPrefix}${zipPath}`)
      }
    }

    zip.file(`${pathPrefix}${zipPath}.md`, md)
    exportedPages += 1
  }

  const skippedAttachmentEntries: SkippedAttachmentEntry[] = Array.from(
    skippedAttachmentSeenIn,
    ([attachmentId, referencedIn]) => ({ attachmentId, referencedIn }),
  )

  return { exportedPages, skippedPageEntries, skippedAttachmentEntries }
}

/**
 * Export all pages of the active space as a ZIP of markdown files.
 *
 * `spaceId` (Phase 4) — only pages in the active space are
 * included in the export. The caller (DataTab) guards on a null active
 * space and short-circuits to an empty export before reaching this
 * function, since listAllPagesInSpace now requires an active
 * SpaceScope (#2248) rather than accepting an empty-string sentinel.
 *
 * #2965 — per-page/attachment failures are still caught and skipped (partial
 * output beats none), but are now COUNTED and returned instead of silently
 * disappearing behind an unconditional success; when anything was skipped an
 * `export-report.txt` listing what and where is also written into the ZIP.
 *
 * #2964 — the page-export/attachment-rewrite/dedup logic itself now lives in
 * {@link exportSpacePagesIntoZip} (called here with `pathPrefix: ''`, which
 * reproduces this function's prior behavior exactly) so
 * {@link exportAllSpacesAsZip} can reuse it per space instead of duplicating it.
 */
export async function exportGraphAsZip(spaceId: string | null): Promise<ExportGraphResult> {
  const zip = new JSZip()

  // #2969 — flush the focused block's pending debounced content commit (if
  // any) before reading ANY page's markdown below, so a just-typed run of
  // keystrokes isn't silently missing from the export.
  await flushActiveDraft()

  // b1 — required-active: with no active space there is nothing to
  // export, so short-circuit to an empty accumulation (yielding an empty
  // zip) instead of dispatching a Global scope the backend rejects.
  const emptyAccumulation: SpaceExportAccumulation = {
    exportedPages: 0,
    skippedPageEntries: [],
    skippedAttachmentEntries: [],
  }
  const { exportedPages, skippedPageEntries, skippedAttachmentEntries } =
    spaceId == null ? emptyAccumulation : await exportSpacePagesIntoZip(zip, spaceId, '')

  if (skippedPageEntries.length > 0 || skippedAttachmentEntries.length > 0) {
    zip.file('export-report.txt', buildExportReport(skippedPageEntries, skippedAttachmentEntries))
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return {
    blob,
    exportedPages,
    skippedPages: skippedPageEntries.length,
    skippedAttachments: skippedAttachmentEntries.length,
  }
}

/** Result of {@link exportAllSpacesAsZip} (#2964). */
export interface ExportAllSpacesResult {
  blob: Blob
  /** Number of spaces enumerated by `listSpaces()`. `0` means the vault has
   * no spaces at all — the caller (DataTab) surfaces a distinct "nothing to
   * export" message for this case instead of silently downloading an empty
   * ZIP with no signal. */
  spaceCount: number
  /** Pages successfully written to the ZIP, summed across every space. */
  exportedPages: number
  /** Pages whose `export_page_markdown` call failed and were dropped, summed
   * across every space. */
  skippedPages: number
  /** Distinct attachment ids that could not be read/emitted, summed across
   * every space (an attachment is per-space-scoped, so the same id in two
   * different spaces counts twice — they are genuinely distinct files). */
  skippedAttachments: number
}

/**
 * Export EVERY space's pages into a single ZIP, one top-level folder per
 * space (#2964) — the whole-vault counterpart to `exportGraphAsZip`, which
 * only ever sees the active space. Reuses {@link exportSpacePagesIntoZip} once
 * per space (the same page-export/attachment-rewrite/collision-dedup logic,
 * #1490/#2723/#2965) so this is genuinely additive over the single-space path,
 * not a parallel reimplementation.
 *
 * Folder names are a filesystem-safe form of each space's display name
 * ({@link spaceNameToFolderName}); two spaces whose names sanitize to the same
 * folder name are disambiguated with the exact id-suffix scheme page-title
 * collisions already use ({@link disambiguate}), so one space's pages can never
 * be silently merged into another's folder.
 *
 * See {@link ExportAllSpacesResult.spaceCount} for the zero-spaces contract.
 */
export async function exportAllSpacesAsZip(): Promise<ExportAllSpacesResult> {
  const zip = new JSZip()

  // #2969 — see exportGraphAsZip: flush before reading ANY page's markdown.
  await flushActiveDraft()

  const spaces = await listSpaces()

  const folderNamesSeen = new Set<string>()
  let exportedPages = 0
  const allSkippedPages: SkippedPageEntry[] = []
  const allSkippedAttachments: SkippedAttachmentEntry[] = []

  for (const space of spaces) {
    const folder = disambiguate(spaceNameToFolderName(space.name), space.id, folderNamesSeen)
    const {
      exportedPages: spaceExportedPages,
      skippedPageEntries,
      skippedAttachmentEntries,
    } = await exportSpacePagesIntoZip(zip, space.id, `${folder}/`)
    exportedPages += spaceExportedPages
    allSkippedPages.push(...skippedPageEntries)
    allSkippedAttachments.push(...skippedAttachmentEntries)
  }

  if (allSkippedPages.length > 0 || allSkippedAttachments.length > 0) {
    zip.file('export-report.txt', buildExportReport(allSkippedPages, allSkippedAttachments))
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return {
    blob,
    spaceCount: spaces.length,
    exportedPages,
    skippedPages: allSkippedPages.length,
    skippedAttachments: allSkippedAttachments.length,
  }
}

/**
 * Collect the distinct attachment ids referenced in a page's markdown via
 * `attachment:<id>` refs (url is capture group 3 — group 1 is the optional
 * leading `!` that marks an inline image vs. a block-scoped file link).
 */
function collectAttachmentIds(md: string): Set<string> {
  const ids = new Set<string>()
  for (const m of md.matchAll(ATTACHMENT_REF_RE)) {
    const id = parseAttachmentRef(m[3] ?? '')
    if (id != null) ids.add(id)
  }
  return ids
}

/** Return shape of {@link rewriteAttachmentRefs} — see #2965. */
interface RewriteAttachmentRefsResult {
  md: string
  /** Distinct attachment ids referenced by THIS page that could not be
   * read/emitted (deduped within the page; the caller dedupes globally
   * across pages for the returned `skippedAttachments` count). */
  skippedAttachmentIds: string[]
}

/**
 * Rewrite every `attachment:<id>` ref in `md` — both inline image links
 * (`![alt](attachment:<id>)`) and block-scoped file links
 * (`[label](attachment:<id>)`, #2961) — to a portable relative path into the
 * ZIP's `assets/` folder, emitting the attachment's bytes there once per id
 * (#1490). An attachment whose bytes/metadata cannot be read is left as its
 * original ref (nothing dropped) and logged, and its id is reported back via
 * `skippedAttachmentIds` (#2965) so the caller can count/report it instead of
 * the failure disappearing behind an unconditional export success. `relPrefix`
 * climbs from the page's folder depth back to the ZIP root (or, for the
 * all-spaces exporter, back to the space's own top-level folder — see
 * {@link exportSpacePagesIntoZip}) so the link resolves. `assetsPathPrefix`
 * (default `''`) is prepended to the ZIP entry the bytes are written under
 * (`<assetsPathPrefix>assets/<file>`), so a per-space folder's assets land
 * nested inside that same folder rather than at the ZIP root (#2964); it does
 * NOT affect `relPrefix`, since the relative `../` hop count between a page
 * and its assets is unchanged by an outer folder both are nested under.
 */
async function rewriteAttachmentRefs(
  md: string,
  zip: JSZip,
  emittedAssets: Map<string, string | null>,
  relPrefix: string,
  assetsPathPrefix = '',
): Promise<RewriteAttachmentRefsResult> {
  const ids = collectAttachmentIds(md)
  if (ids.size === 0) return { md, skippedAttachmentIds: [] }

  // Emit each not-yet-emitted attachment's bytes once, caching the asset's
  // ZIP-relative path (or `null` on failure) so a repeat ref reuses it.
  for (const id of ids) {
    if (emittedAssets.has(id)) continue
    try {
      const meta = await readAttachmentMeta(id)
      const bytes = await readAttachment(id)
      // Prefix the asset filename with the attachment id so two attachments
      // sharing a filename (e.g. `image.png`) never collide in `assets/`.
      // #2961 — the asset name is a single FLAT segment, so collapse any path
      // separator in the stored filename to `_` BEFORE sanitizing. Without
      // this, a filename like `../../evil` (settable via `rename_attachment`,
      // which has no traversal check, and syncable from a peer device) would
      // produce a ZIP entry `assets/<id>__../../evil` that escapes the assets
      // root on naive extraction (Zip-Slip). `sanitizeSegment` strips `\` and
      // neutralizes dots-only segments but does NOT strip `/`; this widened as
      // a concern once #2961 began routing arbitrary uploaded files (not just
      // auto-named pasted images) through this writer. See follow-up issue for
      // the backend rename-validation root cause.
      const flatName = meta.filename.replaceAll('/', '_')
      const safeName = sanitizeSegment(flatName) || 'attachment'
      const assetName = `${id}__${safeName}`
      zip.file(`${assetsPathPrefix}${ASSETS_DIR}/${assetName}`, bytes)
      emittedAssets.set(id, `${ASSETS_DIR}/${assetName}`)
    } catch (err) {
      logger.warn('export-graph', 'attachment export failed', { attachmentId: id }, err)
      emittedAssets.set(id, null)
    }
  }

  // Rewrite each ref to a portable relative path; leave un-emittable ones as-is
  // (and note them in `skippedAttachmentIds`, deduped within this page — #2965).
  // The captured `!` prefix (group 1) is preserved verbatim so image refs stay
  // images and plain file links stay plain links — the backend never emits a
  // stray `!` immediately before a non-image link, so this is safe in practice.
  const skippedAttachmentIds = new Set<string>()
  const rewritten = md.replace(
    ATTACHMENT_REF_RE,
    (match, bang: string, alt: string, url: string) => {
      const id = parseAttachmentRef(url)
      if (id == null) return match
      const assetPath = emittedAssets.get(id)
      if (assetPath == null) {
        skippedAttachmentIds.add(id)
        return match
      }
      return `${bang}[${alt}](${relPrefix}${assetPath})`
    },
  )
  return { md: rewritten, skippedAttachmentIds: Array.from(skippedAttachmentIds) }
}

/**
 * Rewrite every `attachment:<id>` ref in `md` to a portable form for a BARE
 * single-page copy (#2967) — the "Export as Markdown" clipboard action,
 * which (unlike `exportGraphAsZip`) has no accompanying `assets/` folder to
 * write attachment bytes into. There is nowhere to put a link that still
 * resolves once the markdown is pasted elsewhere, so the best available
 * portable stand-in is the attachment's own original filename (resolved via
 * `readAttachmentMeta`, the same lookup `rewriteAttachmentRefs` uses) — it
 * tells the reader what was there even though it no longer links to it.
 *
 * DESIGN NOTE — flagged, not silently decided: this is a genuine trade-off
 * (the alternatives are embedding the bytes as a base64 data URI, which
 * would bloat every clipboard paste, or dropping a footnote-style "not
 * exported" marker). The filename stand-in was chosen as the minimal, safe
 * fix — it removes the dead Agaric-only `attachment:` scheme without
 * inventing new markdown conventions. Revisit if users report it as
 * confusing.
 *
 * The ONE invariant this function guarantees unconditionally: the returned
 * markdown never contains `attachment:` — an attachment whose metadata can't
 * be resolved (deleted, IPC failure, …) is stripped down to its bare
 * alt/label text (no link, no dead scheme) rather than left as the original
 * ref, since a clipboard copy has no later retry path the way a per-page ZIP
 * export failure does. A ref whose id fails `parseAttachmentRef`'s shape
 * check (malformed/hostile — never emitted by the backend, but the regex
 * that finds candidate refs is looser than the id-shape validator) gets the
 * SAME bare-text treatment: `rewriteAttachmentRefs` (ZIP path) may leave such
 * a ref untouched since a ZIP entry is inert, but a clipboard paste is not, so
 * this function never leaves the dead scheme in place regardless of why the
 * id didn't resolve.
 */
export async function resolveAttachmentRefsForCopy(md: string): Promise<string> {
  // Bail out on the literal scheme substring, NOT on `collectAttachmentIds`'s
  // result — a ref whose id fails shape validation is excluded from `ids`
  // (so `ids.size` alone can be 0 even though the dead scheme is present) and
  // still needs to reach the final `.replace()` pass below to be stripped.
  if (!md.includes(ATTACHMENT_REF_SCHEME)) return md
  const ids = collectAttachmentIds(md)

  const resolved = new Map<string, string | null>()
  for (const id of ids) {
    try {
      const meta = await readAttachmentMeta(id)
      // Flatten any path separator in the stored filename (settable via
      // `rename_attachment`, which has no traversal check) so the stand-in
      // never reads as a nested path — mirrors `rewriteAttachmentRefs`'s
      // `flatName` handling for the same reason (#2961).
      resolved.set(id, meta.filename.replaceAll('/', '_'))
    } catch (err) {
      logger.warn('export-graph', 'attachment resolve failed', { attachmentId: id }, err)
      resolved.set(id, null)
    }
  }

  return md.replace(ATTACHMENT_REF_RE, (_match, bang: string, alt: string, url: string) => {
    const id = parseAttachmentRef(url)
    if (id == null) return alt
    const filename = resolved.get(id)
    return filename == null ? alt : `${bang}[${alt}](${filename})`
  })
}

/**
 * Trigger a browser download of a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
