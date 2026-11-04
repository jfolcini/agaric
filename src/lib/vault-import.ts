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
 * {@link restoreSpaceFile} is the one step here that writes: an export's space
 * file must land before its first note.
 */

import { isAppError, unwrap } from '@/lib/app-error'
import { type VaultFile, commands } from '@/lib/bindings'
import { type EnexNote, enexNoteToMarkdown, sanitizeNoteTitleToFilename } from '@/lib/enex-import'
import { t } from '@/lib/i18n'
import { NOTE_EXTENSIONS, scanAttachmentRefs } from '@/lib/import-attachments'
import { type JexNote, jexNoteToMarkdown } from '@/lib/jex-import'
import { logger } from '@/lib/logger'
import { isNotionExport, notionToMarkdown, stripNotionIds } from '@/lib/notion-import'
import { orgToMarkdown } from '@/lib/org-import'
import { listAllPropertyDefs } from '@/lib/property-save-utils'

/**
 * Source format accepted by the `import_bibliography` command (#1454).
 * `'bibtex'` for `.bib` files, `'csl-json'` for CSL-JSON `.json` files.
 * Passing `null` as the command's `format` asks the backend to auto-detect
 * from the content.
 */
export type BibliographyFormat = 'bibtex' | 'csl-json'

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
 * leading `./`; the BE expects vault-root-relative `path`s.
 */
export function vaultRelativePath(webkitRelativePath: string | undefined): string {
  // jsdom (and a plain `.md` pick) may leave `webkitRelativePath` empty or
  // undefined; treat both as the file's own basename-less root.
  const slashed = (webkitRelativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  // No slash ⇒ a top-level file with no folder prefix; `indexOf` is -1 and it is kept as-is.
  return slashed.slice(slashed.indexOf('/') + 1)
}

/**
 * The page title the backend gives a note filed at `path`: no `.md`, each
 * segment trimmed, empty ones dropped. Mirrors `folder_path_to_namespace_title`.
 */
export function pathTitle(path: string): string {
  return (path.endsWith('.md') ? path.slice(0, -'.md'.length) : path)
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/')
}

/** A path with a segment that starts with `.` (`.obsidian/`, `.agaric/`, `.DS_Store`). */
const HIDDEN_PATH_RE = /(?:^|\/)\./

/** Where an export keeps, below a space's folder, what its files cannot carry (#6277 decision 8). */
export const SPACE_FILE_PATH = '.agaric/space.json'

/**
 * The contents of {@link SPACE_FILE_PATH}: the space's own property
 * definitions, and the title of each file whose path does not read back as it
 * ({@link pathTitle}), keyed by that path.
 */
export interface SpaceFile {
  propertyDefinitions: { key: string; value_type: string; options: string | null }[]
  titles: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `text` as a {@link SpaceFile}, or a thrown `TypeError` when it is not one. */
function parseSpaceFile(text: string): SpaceFile {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || !Array.isArray(value['propertyDefinitions'])) {
    throw new TypeError('not a space file')
  }
  const propertyDefinitions = value['propertyDefinitions'].map((def: unknown) => {
    if (
      !isRecord(def) ||
      typeof def['key'] !== 'string' ||
      typeof def['value_type'] !== 'string' ||
      (def['options'] !== null && typeof def['options'] !== 'string')
    ) {
      throw new TypeError('not a property definition')
    }
    return { key: def['key'], value_type: def['value_type'], options: def['options'] }
  })
  const titles = value['titles']
  if (!isRecord(titles) || !Object.values(titles).every((title) => typeof title === 'string')) {
    throw new TypeError('not a space file')
  }
  return { propertyDefinitions, titles: titles as Record<string, string> }
}

/**
 * Restore a folder pick's {@link SPACE_FILE_PATH} into `spaceId`: create each
 * definition the space lacks (one it has is left alone), so the notes' typed
 * values land typed, and answer the recorded titles by path. Each failure is
 * logged and answered as a warning; the notes import either way.
 */
export async function restoreSpaceFile(
  files: readonly File[],
  spaceId: string,
): Promise<{ titles: ReadonlyMap<string, string>; warnings: string[] }> {
  const file = files.find(
    (f) =>
      f.webkitRelativePath !== '' && vaultRelativePath(f.webkitRelativePath) === SPACE_FILE_PATH,
  )
  if (file === undefined) return { titles: new Map(), warnings: [] }
  let space: SpaceFile
  try {
    space = parseSpaceFile(await file.text())
  } catch (err) {
    logger.warn('vault-import', 'space file unreadable', undefined, err)
    return {
      titles: new Map(),
      warnings: [t('data.importSpaceFileFailed', { reason: importErrorReason(err) })],
    }
  }
  const warnings: string[] = []
  try {
    const existing = new Set((await listAllPropertyDefs(spaceId)).map((def) => def.key))
    for (const def of space.propertyDefinitions.filter(({ key }) => !existing.has(key))) {
      try {
        unwrap(await commands.createPropertyDef(spaceId, def.key, def.value_type, def.options))
      } catch (err) {
        logger.warn('vault-import', 'property definition restore failed', { key: def.key }, err)
        warnings.push(
          t('data.importPropertyDefFailed', { key: def.key, reason: importErrorReason(err) }),
        )
      }
    }
  } catch (err) {
    logger.warn('vault-import', 'property definitions unreadable', undefined, err)
    warnings.push(t('data.importSpaceFileFailed', { reason: importErrorReason(err) }))
  }
  return { titles: new Map(Object.entries(space.titles)), warnings }
}

/** Final path segment (basename) of a `/`-separated path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * A vault-folder file pick, indexed for attachment matching (#1925).
 *
 * `byPath` is keyed by the vault-root-relative path (exact-match, the precise
 * resolution); `byBase` holds every file of each basename, in pick order, for
 * the Obsidian `![[img.png]]` fallback.
 */
export interface VaultIndex {
  byPath: Map<string, File>
  byBase: Map<string, File[]>
}

/**
 * Index a folder pick's `FileList` for attachment matching. Non-markdown
 * assets and markdown files alike are indexed (a markdown file is never a
 * scanned ref, so including it is harmless). The first file wins on a path
 * collision so the lookup is deterministic.
 */
export function indexVaultFiles(files: File[]): VaultIndex {
  const byPath = new Map<string, File>()
  const byBase = new Map<string, File[]>()
  for (const file of files) {
    const rel = vaultRelativePath(file.webkitRelativePath)
    if (!byPath.has(rel)) byPath.set(rel, file)
    const base = basename(rel)
    byBase.set(base, [...(byBase.get(base) ?? []), file])
  }
  return { byPath, byBase }
}

/**
 * The `/`-separated `path` read from the folder `dir`, both relative to the
 * vault root: empty and `.` segments dropped and each `..` climbing one
 * folder. Null when a `..` would climb above the vault root. Mirrors
 * `resolve_vault_path`.
 */
export function resolveVaultPath(dir: string, path: string): string | null {
  const segments: string[] = []
  for (const segment of [...dir.split('/'), ...path.split('/')]) {
    if (segment === '..') {
      if (segments.pop() === undefined) return null
    } else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  return segments.join('/')
}

/**
 * The files one scanned attachment ref may name, in the backend
 * `match_vault_file` order: the path read from the note's folder `noteDir`,
 * else the vault-root path, else the first two files of its basename. The
 * backend takes the first of a basename tie and warns, so a tie ships.
 */
export function resolveVaultRef(reference: string, noteDir: string, index: VaultIndex): File[] {
  const want = reference.replace(/\\/g, '/')
  for (const dir of [noteDir, '']) {
    const path = resolveVaultPath(dir, want)
    const file = path === null ? undefined : index.byPath.get(path)
    if (file) return [file]
  }
  // Two are enough for the backend's warning; every same-named file of a large
  // export could pass the import's attachment budget.
  return (index.byBase.get(basename(want)) ?? []).slice(0, 2)
}

/**
 * Collect the referenced sibling files for one markdown document into the
 * `VaultFile[]` IPC payload (#1925). Pre-scans `content` for attachment refs,
 * resolves each against the picked-folder index from the note's folder
 * `noteDir`, and reads ONLY the matched files' bytes (a ref with no matching
 * file is omitted — the backend warns).
 *
 * Returns `null` when there is nothing to ship (no refs, or none resolved) so
 * the wrapper sends `null` ⇒ the pre-#1925 behaviour. Reading is async (
 * `File.arrayBuffer`), so matched files are read in parallel.
 */
export async function collectVaultFiles(
  content: string,
  noteDir: string,
  index: VaultIndex,
): Promise<VaultFile[] | null> {
  const refs = scanAttachmentRefs(content)

  // Resolve refs to distinct files (a ref may resolve to a file already picked
  // up by another ref — dedup by path so we read each once).
  const matched = new Map<string, File>()
  for (const ref of refs) {
    for (const file of resolveVaultRef(ref, noteDir, index)) {
      matched.set(vaultRelativePath(file.webkitRelativePath), file)
    }
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
    .replace(/^-|-$/g, '')
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
 *   `importMarkdown` filename (namespace mapping), any sibling `vaultFiles`, and
 *   the `vaultNotes` its `[[Name]]` links may name.
 *   For `.md` this reads the `File` (and collects vault siblings) on demand, so
 *   a cancel between files avoids reading later files; for note-based formats
 *   the content is already composed and `load` just returns it.
 */
export interface ImportUnit {
  name: string
  bytes: number
  load: () => Promise<{
    content: string
    path: string
    vaultFiles: VaultFile[] | null
    vaultNotes: string[] | null
  }>
}

/** `[[Name` — the name a wiki-link opens with, before any `#anchor` or `|label`. */
const WIKILINK_NAME_RE = /\[\[([^\]|#\n]+)/g

/**
 * The paths of the notes in `notesByName` (keyed by lowercased file stem) that
 * a `[[Name]]` or `![[Name]]` in `content` may name (#5740). The backend
 * writes such a link with the note's title and picks between notes of one
 * name, so every note of a matching name ships. A loose scan, like
 * {@link scanAttachmentRefs}: a path the backend then finds no link for is
 * harmless.
 */
function linkedNotePaths(content: string, notesByName: Map<string, string[]>): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(WIKILINK_NAME_RE)) {
    for (const path of notesByName.get((match[1] as string).trim().toLowerCase()) ?? []) {
      paths.add(path)
    }
  }
  return [...paths]
}

/** A file a note may embed or link, never counted as skipped: an image or a PDF. */
const ATTACHMENT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|pdf)$/i

/** The extension of `name` among {@link NOTE_EXTENSIONS}, or null. */
function noteExtension(name: string): string | null {
  const lower = name.toLowerCase()
  return NOTE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null
}

/** Whether a pick is a Notion export, as the names of its Markdown files tell. */
export function isNotionPick(files: readonly File[]): boolean {
  const mdNames = files.filter((file) => noteExtension(file.name) === '.md')
  return isNotionExport(mdNames.map((file) => file.name))
}

/**
 * The files of a pick that imported as nothing: neither a note, nor a file a
 * note may embed or link, nor one a note did (`attached`, vault-relative paths),
 * nor hidden (`.obsidian/`, `.DS_Store`). A Notion export's database tables
 * are counted apart, as `databases`, since each row of one is also a page of
 * the export; Notion writes each as `X.csv` and again as `X_all.csv`.
 */
export function skippedFiles(
  files: readonly File[],
  notion: boolean,
  attached: ReadonlySet<string>,
): { other: number; databases: number } {
  let other = 0
  const databases = new Set<string>()
  for (const file of files) {
    const path = file.webkitRelativePath || file.name
    if (noteExtension(file.name) !== null || ATTACHMENT_RE.test(file.name)) continue
    if (HIDDEN_PATH_RE.test(path) || attached.has(vaultRelativePath(path))) continue
    if (notion && file.name.toLowerCase().endsWith('.csv')) {
      databases.add(path.replace(/_all\.csv$/i, '.csv'))
    } else other++
  }
  return { other, databases: databases.size }
}

/**
 * The filename `importMarkdown` gets for a note, ending in `.md`, the only
 * extension the backend takes off a title. #1446 Part B — a folder/vault pick
 * carries `webkitRelativePath`, whose path below the picked folder the backend
 * maps `a/b/API.md` → namespace `a/b/API`; the picked folder's own name is no
 * part of any title, so a restored export titles its pages as they were
 * (#6277 decision 8). A plain file pick has an empty `webkitRelativePath`, so
 * fall back to the basename. A Notion export's ids leave every segment.
 */
function importPath(file: File, extension: string, notion: boolean): string {
  const path = vaultRelativePath(file.webkitRelativePath) || file.name
  const md = `${path.slice(0, path.length - extension.length)}.md`
  return notion ? stripNotionIds(md) : md
}

/** `path` with its file name replaced by `title`, as an Org `#+TITLE` names the page. */
function retitle(path: string, title: string): string {
  return `${path.slice(0, path.lastIndexOf('/') + 1)}${sanitizeNoteTitleToFilename(title)}.md`
}

/**
 * Folder/vault/file producer: one unit per note, a file with one of the
 * {@link NOTE_EXTENSIONS} outside any hidden folder, so a folder pick's other
 * files are attachments only (#5740). Content is read lazily inside `load` (so
 * a cancel avoids reading not-yet-reached files), `path` is the folder-relative
 * path for the #1446 namespace mapping (basename fallback for a plain pick),
 * or the title `titles` records for it (#6277 decision 8), and vault siblings
 * and the notes a file links are collected only when a `vaultIndex` is
 * present. An Org file is converted, and a Notion export's pages lose the ids
 * in their names and links (#6032).
 */
export function mdFilesToUnits(
  files: File[],
  vaultIndex: VaultIndex | null,
  notion: boolean,
  titles: ReadonlyMap<string, string> = new Map(),
): ImportUnit[] {
  const notes = files.flatMap((file) => {
    const extension = noteExtension(file.name)
    const relative = vaultRelativePath(file.webkitRelativePath)
    if (extension === null || HIDDEN_PATH_RE.test(relative)) return []
    const title = titles.get(relative)
    const path = title === undefined ? importPath(file, extension, notion) : `${title}.md`
    return [{ file, extension, path }]
  })
  const notesByName = new Map<string, string[]>()
  for (const { path } of notes) {
    const name = basename(path).slice(0, -'.md'.length).toLowerCase()
    notesByName.set(name, [...(notesByName.get(name) ?? []), path])
  }
  return notes.map(({ file, extension, path: filePath }) => ({
    name: file.name,
    // Count bytes from the file size (known without reading) so a load
    // failure still advances the byte counter, matching the pre-refactor loop.
    bytes: file.size,
    load: async () => {
      const text = await file.text()
      let content = text
      let path = filePath
      if (extension === '.org') {
        const org = orgToMarkdown(text)
        content = org.markdown
        if (org.title !== null && org.title !== '') path = retitle(path, org.title)
      } else if (notion && extension === '.md') {
        content = notionToMarkdown(text, basename(path).slice(0, -'.md'.length))
      }
      // #1925 — on a vault/folder import, ship matched sibling bytes; a
      // single-file import (no index) has no siblings. A folder note always
      // ships its note names, even none: that marks it as a folder's, whose
      // references into other notes wait for `link_import_anchors`.
      const notePath = vaultRelativePath(file.webkitRelativePath)
      const noteDir = notePath.slice(0, Math.max(notePath.lastIndexOf('/'), 0))
      const vaultFiles =
        vaultIndex == null ? null : await collectVaultFiles(content, noteDir, vaultIndex)
      const vaultNotes = vaultIndex == null ? null : linkedNotePaths(content, notesByName)
      return { content, path, vaultFiles, vaultNotes }
    },
  }))
}

/**
 * Build a note's `vaultFiles` payload from its decoded attachments, converting
 * each `Uint8Array` to the `number[]` the IPC wire shape needs (#2899). Kept
 * as its own step (rather than inline in the `*ToUnits` producers below) so it
 * can be called LAZILY from `load()` — the expensive part (one `number[]` per
 * attachment byte, plus JSON-serialization on the IPC boundary) then happens
 * only for the note currently being imported, not for every note up front.
 */
function attachmentsToVaultFiles(
  attachments: readonly { path: string; bytes: Uint8Array }[],
): VaultFile[] | null {
  return attachments.length > 0
    ? attachments.map((a) => ({ path: a.path, bytes: Array.from(a.bytes) }))
    : null
}

/**
 * Evernote producer: one {@link ImportUnit} per parsed note. The composed
 * markdown is produced eagerly (so `bytes` reflects its length, matching the
 * pre-refactor `unit.content.length` byte accounting), and any decoded
 * `<en-media>` attachments ship as `vaultFiles` through the SAME plumbing the
 * folder import uses (#2513). Note filenames use the Evernote title sanitizer.
 *
 * #2899 — the `Uint8Array` → `number[]` conversion happens inside `load()`,
 * NOT here, so a large `.enex` doesn't materialize every note's attachment
 * bytes as `number[]` up front (peak memory stays O(one note's attachments),
 * not O(all notes')). The parsed `note.attachments` (already-decoded
 * `Uint8Array`s from `parseEnex`) are captured by the closure and converted
 * only when this unit's `load()` runs, right before its `invoke`.
 */
export function enexNotesToUnits(notes: EnexNote[]): ImportUnit[] {
  return notes.map((note) => {
    const name = `${sanitizeNoteTitleToFilename(note.title)}.md`
    const content = enexNoteToMarkdown(note)
    return {
      name,
      bytes: content.length,
      load: () =>
        Promise.resolve({
          content,
          path: name,
          vaultFiles: attachmentsToVaultFiles(note.attachments),
          vaultNotes: null,
        }),
    }
  })
}

/**
 * Joplin producer: one {@link ImportUnit} per parsed note. Mirrors
 * {@link enexNotesToUnits} — content composed eagerly, resources shipped as
 * `vaultFiles`, and (#2899) the `number[]` conversion deferred into `load()`
 * for the same peak-memory reason. The filename is the note's title as
 * `parseJex` built it, each notebook and note name already sanitized, so the
 * `/` between them is the namespace.
 *
 * A note link is written `[[Title]]`, and one to a title holding a `|` reads as
 * that page only once it exists, else it splits on the `|` (#5160 D10), so
 * those notes import first. Such a note linking to another one imported after
 * it still splits.
 */
export function jexNotesToUnits(notes: JexNote[]): ImportUnit[] {
  const piped = (note: JexNote) => Number(note.title.includes('|'))
  const ordered = notes.toSorted((a, b) => piped(b) - piped(a))
  return ordered.map((note) => {
    const name = `${note.title}.md`
    const content = jexNoteToMarkdown(note)
    return {
      name,
      bytes: content.length,
      load: () =>
        Promise.resolve({
          content,
          path: name,
          vaultFiles: attachmentsToVaultFiles(note.attachments),
          vaultNotes: null,
        }),
    }
  })
}
