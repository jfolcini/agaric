/**
 * Pure, React-free logic for the Data-settings importers (extracted from
 * `DataTab.tsx`). Two groups live here:
 *
 *  1. Path/name/format helpers that mirror the backend matching rules
 *     (`match_vault_file`) and the export-filename sanitizer.
 *  2. Per-format **unit producers** — the pure transform from a picked
 *     `File` / parsed note into the {@link ImportUnit} the shared import
 *     runner drives. Keeping these here (no React, no state) makes them
 *     independently unit-testable.
 *
 * The stateful progress/summary bookkeeping lives in the
 * `useImportRunner` hook, which consumes the {@link ImportUnit}s produced here.
 */

import { isAppError } from '@/lib/app-error'
import { type EnexNote, enexNoteToMarkdown, sanitizeNoteTitleToFilename } from '@/lib/enex-import'
import { scanAttachmentRefs } from '@/lib/import-attachments'
import { type JexNote, jexNoteToMarkdown } from '@/lib/jex-import'
import type { BibliographyFormat, VaultFile } from '@/lib/tauri'

/**
 * Extract a user-facing reason from a failed import. The backend rejects
 * with the serialised `AppError` wire shape (`{ kind, message }`); its
 * `message` is already sanitized to a generic string for internal errors
 * but carries the real text for `Validation` failures (e.g.
 * "space_id does not refer to a live space block"). Reuse the project's
 * {@link isAppError} guard rather than hand-rolling a shape check; fall
 * back to `Error.message`/`String()` for non-IPC throws. (#1935)
 */
export function importErrorReason(err: unknown): string {
  if (isAppError(err)) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Normalize a path to the vault-root-relative, `/`-separated form the backend
 * matches against (#1925). Strips the leading top-folder segment of a
 * `webkitRelativePath` (the browser always prefixes the chosen folder name,
 * e.g. `MyVault/assets/a.png` → `assets/a.png`), backslashes → `/`, and a
 * leading `./`. Mirrors the `norm` helper in `match_vault_file`, plus the
 * top-folder strip the FE owns (the BE expects vault-root-relative `path`s).
 */
export function vaultRelativePath(webkitRelativePath: string | undefined): string {
  // jsdom (and a plain `.md` pick) may leave `webkitRelativePath` empty or
  // undefined; treat both as the file's own basename-less root.
  const slashed = (webkitRelativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const firstSlash = slashed.indexOf('/')
  // No slash ⇒ a top-level file with no folder prefix; keep as-is.
  return firstSlash === -1 ? slashed : slashed.slice(firstSlash + 1)
}

/** Final path segment (basename) of a `/`-separated path. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * A vault-folder file pick, indexed for attachment matching (#1925).
 *
 * `byPath` is keyed by the vault-root-relative path (exact-match, the precise
 * resolution); `byBase` is keyed by basename for the Obsidian `![[img.png]]`
 * fallback. Matching order mirrors the backend's `match_vault_file`:
 * relative-path equality first, then basename. On a basename collision the
 * FIRST file wins (deterministic), matching the backend's ambiguity rule —
 * shipping one candidate is enough since the BE re-matches by the same rule.
 */
export interface VaultIndex {
  byPath: Map<string, File>
  byBase: Map<string, File>
}

/**
 * Index a folder pick's `FileList` for attachment matching. Non-markdown
 * assets and markdown files alike are indexed (a markdown file is never a
 * scanned ref, so including it is harmless). The first file wins on a basename
 * collision so the lookup is deterministic.
 */
export function indexVaultFiles(files: File[]): VaultIndex {
  const byPath = new Map<string, File>()
  const byBase = new Map<string, File>()
  for (const file of files) {
    const rel = vaultRelativePath(file.webkitRelativePath)
    if (!byPath.has(rel)) byPath.set(rel, file)
    const base = basename(rel)
    if (!byBase.has(base)) byBase.set(base, file)
  }
  return { byPath, byBase }
}

/**
 * Resolve one scanned attachment ref against the vault index, mirroring the
 * backend `match_vault_file` order: exact vault-relative path, then basename.
 */
export function resolveVaultRef(reference: string, index: VaultIndex): File | undefined {
  const want = reference.replace(/\\/g, '/').replace(/^\.\//, '')
  return index.byPath.get(want) ?? index.byBase.get(basename(want))
}

/**
 * Collect the referenced sibling files for one markdown document into the
 * `VaultFile[]` IPC payload (#1925). Pre-scans `content` for attachment refs,
 * resolves each against the picked-folder index, and reads ONLY the matched
 * files' bytes (a ref with no matching file is omitted — the backend warns).
 *
 * Returns `null` when there is nothing to ship (no refs, or none resolved) so
 * the wrapper sends `null` ⇒ the pre-#1925 behaviour. Reading is async (
 * `File.arrayBuffer`), so matched files are read in parallel.
 */
export async function collectVaultFiles(
  content: string,
  index: VaultIndex,
): Promise<VaultFile[] | null> {
  const refs = scanAttachmentRefs(content)
  if (refs.length === 0) return null

  // Resolve refs to distinct files (a ref may resolve to a file already picked
  // up by another ref — dedup by the file object so we read each once).
  const matched = new Map<string, File>()
  for (const ref of refs) {
    const file = resolveVaultRef(ref, index)
    if (file) matched.set(vaultRelativePath(file.webkitRelativePath), file)
  }
  if (matched.size === 0) return null

  const vaultFiles = await Promise.all(
    [...matched].map(async ([path, file]) => {
      const buf = await file.arrayBuffer()
      return { path, bytes: Array.from(new Uint8Array(buf)) } satisfies VaultFile
    }),
  )
  return vaultFiles
}

/**
 * Sanitize a space's display name for use inside an export
 * filename. Lowercases, collapses any run of non-alphanumeric characters
 * (whitespace, punctuation, emoji, …) into a single `-`, and trims
 * leading/trailing dashes so we never emit `agaric-export--2025-01-01.zip`.
 *
 *   "Personal"        -> "personal"
 *   "My Project"      -> "my-project"
 *   "🌟 Star Space"   -> "star-space"
 *   "Work / Home!!!"  -> "work-home"
 */
export function sanitizeSpaceNameForFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Map a picked bibliography file's extension to the `import_bibliography`
 * `format` param (#1454): `.bib` → BibTeX, `.json` → CSL-JSON. Returns `null`
 * for any other extension so the handler can reject before reading the file.
 * The backend also accepts `format: null` (content auto-detect), but with a
 * filename in hand the extension is authoritative — the hidden input filters
 * the picker to exactly these two extensions, so `null` here only happens on
 * a defensive path (e.g. a drag-drop bypassing the `accept` filter).
 */
export function inferBibliographyFormat(filename: string): BibliographyFormat | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.bib')) return 'bibtex'
  if (lower.endsWith('.json')) return 'csl-json'
  return null
}

/**
 * One unit of work for the shared import runner. Each format's producer turns
 * its source (a picked `.md` `File`, or a parsed `.enex`/`.jex` note) into a
 * uniform record the runner loops over.
 *
 * - `name` is the display/failure name (progress label, failure-list entry,
 *   logger key). For a folder `.md` pick this is the file's basename, distinct
 *   from the vault-relative `path` handed to the IPC.
 * - `bytes` is added to the cumulative byte counter regardless of whether the
 *   unit imports successfully (the user waited on it either way).
 * - `load()` yields the IPC payload lazily: `content`, the `path` passed as the
 *   `importMarkdown` filename (namespace mapping), and any sibling `vaultFiles`.
 *   For `.md` this reads the `File` (and collects vault siblings) on demand, so
 *   a cancel between files avoids reading later files; for note-based formats
 *   the content is already composed and `load` just returns it.
 */
export interface ImportUnit {
  name: string
  bytes: number
  load: () => Promise<{ content: string; path: string; vaultFiles: VaultFile[] | null }>
}

/**
 * Markdown/folder/vault producer. Content is read lazily inside `load` (so a
 * cancel avoids reading not-yet-reached files), `path` is the folder-relative
 * path for the #1446 namespace mapping (basename fallback for a plain pick),
 * and vault siblings are collected only when a `vaultIndex` is present.
 */
export function mdFilesToUnits(files: File[], vaultIndex: VaultIndex | null): ImportUnit[] {
  return files.map((file) => ({
    name: file.name,
    // Count bytes from the file size (known without reading) so a load
    // failure still advances the byte counter, matching the pre-refactor loop.
    bytes: file.size,
    load: async () => {
      const content = await file.text()
      // #1446 Part B — a folder/vault pick carries `webkitRelativePath`, so the
      // backend maps `a/b/API.md` → namespace `a/b/API`. A plain file pick has
      // an empty `webkitRelativePath`, so fall back to the basename.
      const path = file.webkitRelativePath || file.name
      // #1925 — on a vault/folder import, ship matched sibling bytes; a
      // single-file import (no index) has no siblings.
      const vaultFiles = vaultIndex == null ? null : await collectVaultFiles(content, vaultIndex)
      return { content, path, vaultFiles }
    },
  }))
}

/**
 * Evernote producer: one {@link ImportUnit} per parsed note. The composed
 * markdown is produced eagerly (so `bytes` reflects its length, matching the
 * pre-refactor `unit.content.length` byte accounting), and any decoded
 * `<en-media>` attachments ship as `vaultFiles` through the SAME plumbing the
 * folder import uses (#2513). Note filenames use the Evernote title sanitizer.
 */
export function enexNotesToUnits(notes: EnexNote[]): ImportUnit[] {
  return notes.map((note) => {
    const name = `${sanitizeNoteTitleToFilename(note.title)}.md`
    const content = enexNoteToMarkdown(note)
    const vaultFiles: VaultFile[] | null =
      note.attachments.length > 0
        ? note.attachments.map((a) => ({ path: a.path, bytes: Array.from(a.bytes) }))
        : null
    return { name, bytes: content.length, load: async () => ({ content, path: name, vaultFiles }) }
  })
}

/**
 * Joplin producer: one {@link ImportUnit} per parsed note. Mirrors
 * {@link enexNotesToUnits} — content composed eagerly, resources shipped as
 * `vaultFiles`. Note that the filename uses the SAME Evernote-title sanitizer
 * (`sanitizeNoteTitleToFilename` from `@/lib/enex-import`) the pre-refactor
 * `.jex` handler used, preserving exact filename behaviour.
 */
export function jexNotesToUnits(notes: JexNote[]): ImportUnit[] {
  return notes.map((note) => {
    const name = `${sanitizeNoteTitleToFilename(note.title)}.md`
    const content = jexNoteToMarkdown(note)
    const vaultFiles: VaultFile[] | null =
      note.attachments.length > 0
        ? note.attachments.map((a) => ({ path: a.path, bytes: Array.from(a.bytes) }))
        : null
    return { name, bytes: content.length, load: async () => ({ content, path: name, vaultFiles }) }
  })
}
