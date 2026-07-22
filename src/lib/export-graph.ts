import JSZip from 'jszip'

import { parseAttachmentRef } from '@/lib/attachment-ref'
import { logger } from '@/lib/logger'
import {
  exportPageMarkdown,
  listAllPagesInSpace,
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
 * Sanitize ONE path segment: trim it, strip illegal-per-segment characters,
 * neutralize path-traversal segments (`.` / `..` / any all-dots segment), and
 * fall back to `Untitled` when nothing usable remains. The namespace separator
 * `/` is handled by the caller (split into segments) and never reaches here.
 *
 * Neutralizing a dots-only segment is a SECURITY requirement, not cosmetics: a
 * page titled `../../etc/passwd` would otherwise emit a ZIP entry
 * `../../etc/passwd.md`, a classic Zip-Slip path that escapes the extraction
 * root when the archive is unpacked by a naive tool. A leading empty segment
 * (absolute `/etc/...`) is already dropped by the caller's `filter`.
 */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(ILLEGAL_SEGMENT_CHARS_RE, '_').trim()
  // A segment that is empty or consists solely of dots (`.`, `..`, `...`) is a
  // traversal/relative-path token, not a usable folder name — replace it.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return 'Untitled'
  return cleaned
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
 * Export all pages as a ZIP of markdown files.
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
 * referenced attachment's bytes are emitted under `assets/` and the markdown
 * link is rewritten to a relative path (`![alt](../assets/<file>)`) so the
 * exported image renders in other tools (#1490 residual).
 *
 * `spaceId` (Phase 4) — only pages in the active space are
 * included in the export. The caller (DataTab) guards on a null active
 * space and short-circuits to an empty export before reaching this
 * function, since listAllPagesInSpace now requires an active
 * SpaceScope (#2248) rather than accepting an empty-string sentinel.
 */
export async function exportGraphAsZip(spaceId: string | null): Promise<Blob> {
  const zip = new JSZip()

  // Load every page in the space.  `listAllPagesInSpace` returns every
  // page in one query (no pagination, no clamp) — bounded by the
  // space's intrinsic page count, which is what the export needs.
  // b1 — required-active: with no active space there is nothing to
  // export, so short-circuit to an empty page set (yielding an empty
  // zip) instead of dispatching a Global scope the backend rejects.
  const pages = spaceId == null ? [] : await listAllPagesInSpace(spaceId)

  // Cache of emitted assets keyed by attachment id, so an image referenced from
  // multiple pages is written once and every page links to the same file.
  // `null` marks an attachment we already failed to emit (skip silently next time).
  const emittedAssets = new Map<string, string | null>()

  // Export each page to markdown. Per-page failures are logged and skipped so a
  // single broken page does not reject the whole export — partial output is more
  // useful than none.
  const seen = new Set<string>()
  for (const page of pages) {
    let md: string
    try {
      md = await exportPageMarkdown(page.id)
    } catch (err) {
      logger.warn('export-graph', 'page export failed', { pageId: page.id }, err)
      continue
    }

    // Namespace `/` → nested folders, sanitizing per segment; dedup true
    // collisions (same full path) with a ULID suffix on the final segment.
    // `seen` is tracked case-insensitively (#2723) so 'API' and 'api' don't
    // emit distinct entries that clash at extraction on case-insensitive
    // filesystems (Windows/macOS). The suffixed candidate is RE-CHECKED
    // against `seen` (#2723): a ULID's first 8 chars are entirely within its
    // 10-char timestamp component, so pages minted in the same ~256ms window
    // (e.g. a bulk import's single chunk transaction) can share that prefix.
    // When the id-suffixed candidate still collides, keep appending an
    // incrementing counter until it's unique, so a 3rd+ same-path page is
    // never silently dropped instead of overwriting the ZIP entry.
    let zipPath = titleToZipPath(page.content ?? 'Untitled')
    if (seen.has(zipPath.toLowerCase())) {
      const base = `${zipPath}_${page.id.slice(0, 8)}`
      let candidate = base
      let suffixCounter = 2
      while (seen.has(candidate.toLowerCase())) {
        candidate = `${base}-${suffixCounter}`
        suffixCounter += 1
      }
      zipPath = candidate
    }
    seen.add(zipPath.toLowerCase())

    // #1490 / #2961 — rewrite `attachment:<id>` refs (both inline image links
    // AND block-scoped file links) to portable asset paths, emitting the
    // bytes into `assets/`. Done per page because the relative `../` prefix
    // depends on this page's namespace depth.
    md = await rewriteAttachmentRefs(md, zip, emittedAssets, relativePrefixForDepth(zipPath))

    zip.file(`${zipPath}.md`, md)
  }

  return zip.generateAsync({ type: 'blob' })
}

/**
 * Rewrite every `attachment:<id>` ref in `md` — both inline image links
 * (`![alt](attachment:<id>)`) and block-scoped file links
 * (`[label](attachment:<id>)`, #2961) — to a portable relative path into the
 * ZIP's `assets/` folder, emitting the attachment's bytes there once per id
 * (#1490). An attachment whose bytes/metadata cannot be read is left as its
 * original ref (nothing dropped) and logged. `relPrefix` climbs from the
 * page's folder depth back to the ZIP root so the link resolves.
 */
async function rewriteAttachmentRefs(
  md: string,
  zip: JSZip,
  emittedAssets: Map<string, string | null>,
  relPrefix: string,
): Promise<string> {
  // Collect the distinct attachment ids referenced in this page's markdown
  // (url is now capture group 3 — group 1 is the optional leading `!`).
  const ids = new Set<string>()
  for (const m of md.matchAll(ATTACHMENT_REF_RE)) {
    const id = parseAttachmentRef(m[3] ?? '')
    if (id != null) ids.add(id)
  }
  if (ids.size === 0) return md

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
      zip.file(`${ASSETS_DIR}/${assetName}`, bytes)
      emittedAssets.set(id, `${ASSETS_DIR}/${assetName}`)
    } catch (err) {
      logger.warn('export-graph', 'attachment export failed', { attachmentId: id }, err)
      emittedAssets.set(id, null)
    }
  }

  // Rewrite each ref to a portable relative path; leave un-emittable ones as-is.
  // The captured `!` prefix (group 1) is preserved verbatim so image refs stay
  // images and plain file links stay plain links — the backend never emits a
  // stray `!` immediately before a non-image link, so this is safe in practice.
  return md.replace(ATTACHMENT_REF_RE, (match, bang: string, alt: string, url: string) => {
    const id = parseAttachmentRef(url)
    if (id == null) return match
    const assetPath = emittedAssets.get(id)
    return assetPath == null ? match : `${bang}[${alt}](${relPrefix}${assetPath})`
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
