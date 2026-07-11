/**
 * DataTab — Import/Export data management. (The `'DataSettingsTab'`
 * logger label below is kept stable across this rename as its telemetry
 * namespace.)
 *
 * Provides:
 *  - Import: select .md files to create pages from Logseq/Markdown content
 *  - Export: download all pages as a ZIP of Markdown files
 */

import { Download, FileUp, FolderUp, Library, Upload, Vault } from 'lucide-react'
import type React from 'react'
import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/lib/app-error'
import { enexNoteToMarkdown, parseEnex, sanitizeNoteTitleToFilename } from '@/lib/enex-import'
import { downloadBlob, exportGraphAsZip } from '@/lib/export-graph'
import { formatBytes } from '@/lib/format'
import { scanAttachmentRefs } from '@/lib/import-attachments'
import { jexNoteToMarkdown, parseJex } from '@/lib/jex-import'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  type BibliographyFormat,
  importBibliography,
  importMarkdown,
  resolvePageByAlias,
  type VaultFile,
} from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

/**
 * Extract a user-facing reason from a failed import. The backend rejects
 * with the serialised `AppError` wire shape (`{ kind, message }`); its
 * `message` is already sanitized to a generic string for internal errors
 * but carries the real text for `Validation` failures (e.g.
 * "space_id does not refer to a live space block"). Reuse the project's
 * {@link isAppError} guard rather than hand-rolling a shape check; fall
 * back to `Error.message`/`String()` for non-IPC throws. (#1935)
 */
function importErrorReason(err: unknown): string {
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
function vaultRelativePath(webkitRelativePath: string | undefined): string {
  // jsdom (and a plain `.md` pick) may leave `webkitRelativePath` empty or
  // undefined; treat both as the file's own basename-less root.
  const slashed = (webkitRelativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const firstSlash = slashed.indexOf('/')
  // No slash ⇒ a top-level file with no folder prefix; keep as-is.
  return firstSlash === -1 ? slashed : slashed.slice(firstSlash + 1)
}

/** Final path segment (basename) of a `/`-separated path. */
function basename(path: string): string {
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
interface VaultIndex {
  byPath: Map<string, File>
  byBase: Map<string, File>
}

/**
 * Index a folder pick's `FileList` for attachment matching. Non-markdown
 * assets and markdown files alike are indexed (a markdown file is never a
 * scanned ref, so including it is harmless). The first file wins on a basename
 * collision so the lookup is deterministic.
 */
function indexVaultFiles(files: File[]): VaultIndex {
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
function resolveVaultRef(reference: string, index: VaultIndex): File | undefined {
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
async function collectVaultFiles(content: string, index: VaultIndex): Promise<VaultFile[] | null> {
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
 * Aggregated outcome of a (possibly multi-file) import run, rendered by the
 * result panel. Unlike the backend `ImportResult` (one page), this carries
 * hard `failures` separately from soft `warnings` (#1928) so the UI can show
 * distinct, actionable messaging for files that did not import at all.
 */
interface FailedFile {
  /** Source filename (basename) that threw and produced no page. */
  name: string
  /**
   * User-facing reason extracted from the thrown error (#1935). Empty
   * string when no reason could be derived, in which case the list falls
   * back to the reason-less `data.importFailedFile` label.
   */
  reason: string
}

interface ImportRunResult {
  /** Page title (single file) or null for the multi-file placeholder. */
  pageTitle: string | null
  /**
   * #2513 — whether the import unit is a NOTE (Evernote `.enex`, one page per
   * note) rather than a FILE (`.md`/folder). Drives the "N notes" vs "N files"
   * wording in the multi-unit result-panel title.
   */
  notes: boolean
  fileCount: number
  blocksCreated: number
  propertiesSet: number
  /** Soft, per-file parse warnings; the file still imported. */
  warnings: string[]
  /** Files that threw and produced no page, with their failure reason. */
  failures: FailedFile[]
  /**
   * #1927 — the last successfully-imported page's title, so the result
   * panel / success toast can offer a "View" action that navigates to it.
   * `null` when nothing imported.
   */
  navTitle: string | null
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
function sanitizeSpaceNameForFilename(name: string): string {
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
function inferBibliographyFormat(filename: string): BibliographyFormat | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.bib')) return 'bibtex'
  if (lower.endsWith('.json')) return 'csl-json'
  return null
}

/**
 * #1454 — outcome of a bibliography import, rendered by its own result
 * panel. camelCase mirror of the backend `ImportBibliographyResult` wire
 * shape (see `importBibliography` in `src/lib/tauri.ts`); kept separate from
 * {@link ImportRunResult} because a bibliography import is a single-IPC run
 * with page/entry counts, not the markdown importer's per-file block loop.
 */
interface BibliographyImportOutcome {
  pagesCreated: number
  entriesSkipped: number
  warnings: string[]
}

/**
 * #1454 — presentational result region for a bibliography import. Mirrors
 * the markdown import-result region's live-region + warnings-panel pattern
 * (#1928 / #1929) but with page/entry counts instead of a per-file block
 * summary. Extracted from `DataTab` to keep the parent's cyclomatic
 * complexity under the lint budget.
 */
function BibliographyResultPanel({
  result,
}: {
  result: BibliographyImportOutcome
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className="import-result mt-3 text-xs space-y-1"
      data-testid="bib-import-result"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level status wrapper holding the summary <p> and the <details> list, same as the markdown import-result region; <output> is inline-level and would change the block flow
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <p className="text-status-done-foreground" data-testid="bib-import-summary">
        {t('data.importBibliographyResult', {
          count: result.pagesCreated,
          skipped: result.entriesSkipped,
        })}
      </p>
      {result.warnings.length > 0 && (
        <details data-testid="bib-import-warnings">
          <summary className="cursor-pointer text-status-pending-foreground">
            <span data-testid="bib-import-warnings-heading">
              {t('data.importWarningsHeading', { count: result.warnings.length })}
            </span>
          </summary>
          <ul
            className="mt-1 space-y-0.5 max-h-40 overflow-y-auto"
            data-testid="bib-import-warning-list"
          >
            {result.warnings.map((warning, i) => (
              <li
                // Warnings are free-form strings and may repeat, so
                // index-qualify the key to keep it stable+unique.
                // oxlint-disable-next-line react/no-array-index-key -- warning strings are free-form and may duplicate; the list is render-only (no reorder/insert), so the positional index is a stable, unique key
                key={`bib-warn-${i}-${warning}`}
                className="text-status-pending-foreground"
                data-testid="bib-import-warning-item"
              >
                {warning}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function DataTab(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // #1927 — second hidden input carrying `webkitdirectory` so the user
  // can pick a whole folder/vault. The plain `fileInputRef` above keeps
  // its `.md`-only single-file/multi-file behaviour; this one populates
  // `file.webkitRelativePath` to drive the #1446 folder→namespace mapping.
  const folderInputRef = useRef<HTMLInputElement>(null)
  // #2510 — dedicated hidden `webkitdirectory` input for the "Import Obsidian
  // vault" affordance. It drives the exact SAME `handleFileImport` folder
  // pipeline as `folderInputRef` (an Obsidian vault IS a folder of `.md` files);
  // the separate, explicitly-named button/input just makes Obsidian support
  // discoverable. No behavioural fork on the FE — the backend already resolves
  // Obsidian wikilinks/`^block-id` anchors unconditionally on import.
  const obsidianVaultInputRef = useRef<HTMLInputElement>(null)
  // #1282 — hidden input for the Evernote `.enex` importer. Kept separate
  // from the `.md`/folder inputs since each `.enex` file expands into one
  // page PER note (ENML → Markdown), a different iteration unit than a file.
  const enexInputRef = useRef<HTMLInputElement>(null)
  // #1454 — hidden input for the bibliography importer (`.bib` BibTeX /
  // `.json` CSL-JSON). Separate from the `.md`/folder/enex inputs: it is a
  // single-file pick handled by one `import_bibliography` IPC (the backend
  // iterates the entries), so none of the per-file loop machinery applies.
  const bibInputRef = useRef<HTMLInputElement>(null)
  // #2513 (part 2) — hidden input for the Joplin `.jex` importer. Kept separate
  // from the other inputs since a `.jex` archive expands into one page PER note
  // (like `.enex`), a different iteration unit than a file.
  const jexInputRef = useRef<HTMLInputElement>(null)
  // #1927 — abort flag checked between files so a large vault import can
  // be stopped. A ref (not state) so the running loop reads the latest
  // value without re-subscribing/re-rendering each tick.
  const cancelRef = useRef(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportRunResult | null>(null)
  // #1454 — bibliography import outcome, rendered by its own summary +
  // warnings panel below the markdown importer's result region.
  const [bibResult, setBibResult] = useState<BibliographyImportOutcome | null>(null)
  // Whether the failure/warning detail list is expanded past the first N
  // entries. Reset on each new import run.
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  // Per-file progress for multi-file imports — shows
  // `t('data.importingProgress', { index, total, name })` while the loop runs.
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null)
  const [currentFileName, setCurrentFileName] = useState('')
  const [totalFiles, setTotalFiles] = useState(0)
  // Cumulative blocks created and bytes processed across files
  // already imported in the current run. Surfaced as a secondary line so
  // a multi-file run with one large file still shows forward motion
  // between file-index ticks.
  const [blocksProcessed, setBlocksProcessed] = useState(0)
  const [bytesProcessed, setBytesProcessed] = useState(0)
  // #128 — per-block progress streamed from the
  // backend over a Channel for the file currently being imported. Lets a
  // single large file show forward motion (blocks N of M) instead of a
  // stalled file-level bar. Reset at the start of each file.
  const [currentFileBlocksDone, setCurrentFileBlocksDone] = useState(0)
  const [currentFileBlocksTotal, setCurrentFileBlocksTotal] = useState(0)
  const [exporting, setExporting] = useState(false)
  // Stable id wires the disabled-button's
  // `aria-describedby` to the visible `t('data.importSpaceNotReady')`
  // hint, so screen-reader users hear WHY the button is unactionable.
  // The hint also fixes the mobile/touch path: the `title` attribute
  // alone is invisible on `pointer:coarse` (no hover) and is suppressed
  // on disabled buttons in most browsers (`pointer-events: none`).
  const importHintId = useId()

  // #1927 — navigate to a just-imported page. The backend `ImportResult`
  // carries only the page title (no id), so resolve the title→id through
  // `resolvePageByAlias` (a page's title is one of its aliases), scoped to
  // the target space, then reuse the app's `navigateToPage` action. No-op
  // if the title can't be resolved (e.g. the page was renamed out from
  // under us) — the import itself already succeeded.
  const goToImportedPage = useCallback(
    async (title: string, spaceId: string) => {
      try {
        const hit = await resolvePageByAlias({ alias: title, spaceId })
        if (hit) {
          const [pageId, resolvedTitle] = hit
          navigateToPage(pageId, resolvedTitle ?? title)
        }
      } catch (err) {
        logger.error(
          'DataSettingsTab',
          `navigate to imported page failed: ${title}`,
          undefined,
          err,
        )
      }
    },
    [navigateToPage],
  )

  const handleFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      // `import_markdown` now requires a space_id;
      // the backend rejects empty / unknown ULIDs with
      // `AppError::Validation`. The Choose-Files button is disabled
      // when `currentSpaceId` is null (see the `disabled` prop below),
      // so this branch is defensive: if some unexpected race fires the
      // change handler before the store hydrates, we surface a toast
      // instead of letting the IPC error bubble up.
      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      setImporting(true)
      setImportResult(null)
      setBlocksProcessed(0)
      setBytesProcessed(0)
      // #1927 — clear any stale abort flag from a previous run before the
      // loop starts so the Cancel button only affects THIS import.
      cancelRef.current = false
      const fileArray = Array.from(files)
      setTotalFiles(fileArray.length)

      // #1925 — only a folder/vault pick (`webkitdirectory`) carries sibling
      // assets: the browser populates `webkitRelativePath` for folder picks and
      // leaves it empty for the plain `.md` multi-file pick. When ANY file has a
      // relative path we treat the run as a vault import and index the whole
      // FileList so each markdown's referenced attachments can be matched and
      // shipped. A single-file (non-folder) import has no siblings — documented
      // limitation — so `vaultIndex` stays null and `vaultFiles` is omitted.
      // A non-empty `webkitRelativePath` is the folder-pick marker; a plain
      // `.md` pick (and jsdom's `new File`) leaves it empty/undefined.
      const isVaultImport = fileArray.some(
        (f) => typeof f.webkitRelativePath === 'string' && f.webkitRelativePath.length > 0,
      )
      const vaultIndex = isVaultImport ? indexVaultFiles(fileArray) : null

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      // Soft, per-file parse warnings reported by the backend (malformed
      // YAML, dropped properties, …). The file still imported.
      const allWarnings: string[] = []
      // Hard failures: a file that threw and produced no page. Tracked
      // SEPARATELY from warnings (#1928) so we can show distinct messaging,
      // gate the success toast, and offer a retry of just the failed subset.
      // Each entry carries the failure reason (#1935) so the panel can show
      // WHY the file failed, not just THAT it failed.
      const failedFiles: FailedFile[] = []
      let succeededFiles = 0
      let lastTitle = ''
      // #1927 — true once the user hits Cancel mid-loop.
      let cancelled = false

      for (const [i, file] of fileArray.entries()) {
        // #1927 — check the abort flag BETWEEN files. The currently
        // in-flight `importMarkdown` (if any) still completes, but no
        // further files are started; we report how many imported.
        if (cancelRef.current) {
          cancelled = true
          break
        }
        setCurrentFileIndex(i + 1)
        setCurrentFileName(file.name)
        // #128 — reset per-block progress for the new file.
        setCurrentFileBlocksDone(0)
        setCurrentFileBlocksTotal(0)
        try {
          const content = await file.text()
          // #1446 Part B — when importing a folder/vault (a `webkitdirectory`
          // pick), pass the file's relative path so the backend maps the
          // folder hierarchy to the page's namespace (`a/b/API.md` → namespace
          // `a/b/API`), the inverse of the namespaced export. A plain file pick
          // has an empty `webkitRelativePath`, so we fall back to the basename.
          const importPath = file.webkitRelativePath || file.name
          // #1925 — on a vault/folder import, pre-scan this markdown for
          // attachment refs and read only the matched sibling files' bytes to
          // ship alongside the content. A single-file import (no `vaultIndex`)
          // has no siblings, so `vaultFiles` stays null (documented limitation).
          const vaultFiles =
            vaultIndex == null ? null : await collectVaultFiles(content, vaultIndex)
          const result = await importMarkdown(
            content,
            importPath,
            activeSpaceId,
            (update) => {
              // #128 — drive the intra-file block bar from the streamed
              // events. `complete` arrives after the backend commits; we
              // leave the bar full and let the file-loop advance.
              switch (update.kind) {
                case 'started': {
                  setCurrentFileBlocksDone(0)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'progress': {
                  setCurrentFileBlocksDone(update.blocks_done)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'complete': {
                  setCurrentFileBlocksDone(update.blocks_created)
                  break
                }
              }
            },
            vaultFiles,
          )
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          succeededFiles += 1
          lastTitle = result.page_title
        } catch (err) {
          // #1935 — a whole-file import failure is a real ERROR (not a
          // recoverable warning), and the message MUST be per-file
          // distinct: the logger's rate-limiter keys on `module:message`
          // (logger.ts), so a constant message would suppress every
          // failure after the 5th in a multi-file/vault import. Putting
          // the filename IN the message string keeps each key unique.
          logger.error(
            'DataSettingsTab',
            `file import failed: ${file.name}`,
            { fileName: file.name },
            err,
          )
          // Record the failing filename + reason separately from soft
          // warnings so the result panel can list, explain (#1935), and
          // retry it, and so the success toast can be suppressed when
          // nothing imported (#1928).
          failedFiles.push({ name: file.name, reason: importErrorReason(err) })
        }
        // Count bytes regardless of success — the user has waited on
        // this file either way, so the secondary line should reflect
        // forward progress through the selection.
        totalBytes += file.size
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      // #1927 — the title to navigate to after a successful import. We
      // resolve it to a page id lazily in the View action (the result
      // carries no page_id), so the toast/panel only need the title.
      const navTitle = totalBlocks > 0 ? lastTitle : null

      setImportResult({
        pageTitle: fileArray.length === 1 ? lastTitle : null,
        notes: false,
        fileCount: fileArray.length,
        blocksCreated: totalBlocks,
        propertiesSet: totalProps,
        warnings: allWarnings,
        failures: failedFiles,
        navTitle,
      })
      setDetailsExpanded(false)
      setCurrentFileIndex(null)
      setCurrentFileName('')
      setTotalFiles(0)
      setCurrentFileBlocksDone(0)
      setCurrentFileBlocksTotal(0)
      setImporting(false)
      cancelRef.current = false

      // Reset file input before any async toast handler so a retry can
      // re-open the picker without a stale value.
      e.target.value = ''

      // #1927 — success toasts offer a "View" action so the user can jump
      // straight to what they imported. Resolves the page title to an id
      // via the same alias resolver SearchPanel/[[-picker use.
      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        // #1927 — user aborted mid-loop. Report how many imported before
        // cancel rather than a generic success/error.
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // Nothing imported — either every file failed or all files were
        // empty. Never fire a success toast here (#1928); surface an error.
        notify.error(
          failedFiles.length > 0
            ? t('data.importAllFailed', { count: failedFiles.length })
            : t('data.importNoContent'),
        )
      } else if (failedFiles.length > 0) {
        // Partial failure: some files imported, some did not. Report the
        // failures with a retry affordance rather than a green success toast.
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          fileInputRef.current?.click(),
        )
      } else {
        notify.success(t('data.importedMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, goToImportedPage],
  )

  // #1282 — Evernote `.enex` import. Frontend-only: each picked `.enex` file
  // is parsed in the browser (`parseEnex`), and each note it contains is
  // converted to Markdown (`enexNoteToMarkdown`) and handed to the SAME
  // `importMarkdown` IPC as the `.md` path — one note → one page. A single
  // file therefore expands into many import units. Progress/notify/error
  // handling mirrors `handleFileImport`; a note has no sibling assets so
  // `vaultFiles` is always omitted (attachment ingestion is deferred).
  const handleEnexImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      setImporting(true)
      setImportResult(null)
      setBlocksProcessed(0)
      setBytesProcessed(0)
      cancelRef.current = false

      const fileArray = Array.from(files)
      const failedFiles: FailedFile[] = []
      // #2513 — a parse failure fires its OWN per-file toast below. Count them
      // so the end-of-run summary only fires when there is MORE to say (a note
      // that failed to import, or nothing to import at all) rather than
      // double-toasting on top of the per-file errors, mirroring the `.md`
      // path (which has no per-file toasts, so never double-toasts).
      let parseFailures = 0
      // Flatten every note across every picked file into a single unit list
      // (name = page filename, content = composed markdown, vaultFiles =
      // decoded `<en-media>` attachments to ingest — #2513). A file that fails
      // to parse is recorded as a failure and surfaced immediately, mirroring
      // the per-file error pattern the `.md` path uses.
      const units: { name: string; content: string; vaultFiles: VaultFile[] | null }[] = []
      for (const file of fileArray) {
        try {
          const xml = await file.text()
          for (const note of parseEnex(xml)) {
            // #2513 — ship each note's referenced attachments as `vaultFiles`,
            // the SAME plumbing the folder import uses; the backend matches the
            // `![](path)` refs in `content` to these bytes and ingests them.
            const vaultFiles: VaultFile[] | null =
              note.attachments.length > 0
                ? note.attachments.map((a) => ({
                    path: a.path,
                    bytes: Array.from(a.bytes),
                  }))
                : null
            units.push({
              name: `${sanitizeNoteTitleToFilename(note.title)}.md`,
              content: enexNoteToMarkdown(note),
              vaultFiles,
            })
          }
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `enex parse failed: ${file.name}`,
            { fileName: file.name },
            err,
          )
          notify.error(t('data.importEnexParseFailed', { name: file.name }))
          failedFiles.push({ name: file.name, reason: importErrorReason(err) })
          parseFailures += 1
        }
      }

      setTotalFiles(units.length)

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      const allWarnings: string[] = []
      let succeededFiles = 0
      let lastTitle = ''
      let cancelled = false

      for (const [i, unit] of units.entries()) {
        if (cancelRef.current) {
          cancelled = true
          break
        }
        setCurrentFileIndex(i + 1)
        setCurrentFileName(unit.name)
        setCurrentFileBlocksDone(0)
        setCurrentFileBlocksTotal(0)
        try {
          const result = await importMarkdown(
            unit.content,
            unit.name,
            activeSpaceId,
            (update) => {
              switch (update.kind) {
                case 'started': {
                  setCurrentFileBlocksDone(0)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'progress': {
                  setCurrentFileBlocksDone(update.blocks_done)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'complete': {
                  setCurrentFileBlocksDone(update.blocks_created)
                  break
                }
              }
            },
            // #2513 — decoded `<en-media>` attachment bytes for this note (or
            // null when the note embeds none), ingested via the SAME
            // vault-attachment path a folder import uses.
            unit.vaultFiles,
          )
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          succeededFiles += 1
          lastTitle = result.page_title
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `enex note import failed: ${unit.name}`,
            { fileName: unit.name },
            err,
          )
          failedFiles.push({ name: unit.name, reason: importErrorReason(err) })
        }
        // Approximate byte progress from the composed markdown length.
        totalBytes += unit.content.length
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      const navTitle = totalBlocks > 0 ? lastTitle : null

      setImportResult({
        pageTitle: units.length === 1 ? lastTitle : null,
        notes: true,
        fileCount: units.length,
        blocksCreated: totalBlocks,
        propertiesSet: totalProps,
        warnings: allWarnings,
        failures: failedFiles,
        navTitle,
      })
      setDetailsExpanded(false)
      setCurrentFileIndex(null)
      setCurrentFileName('')
      setTotalFiles(0)
      setCurrentFileBlocksDone(0)
      setCurrentFileBlocksTotal(0)
      setImporting(false)
      cancelRef.current = false

      e.target.value = ''

      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // #2513 — nothing imported. Each PARSE failure already fired its own
        // per-file error toast above (`importEnexParseFailed`), so the summary
        // fallback must only fire when there is MORE to say: a note that PARSED
        // but failed to import (no per-file toast), or a genuinely empty
        // selection. When every failure was a parse failure we stay silent
        // here and let the per-file toasts stand — this is the `.md` path's
        // "no double toast" behaviour (that path has no per-file toasts at
        // all, so its summary is always the only toast).
        const noteImportFailures = failedFiles.length - parseFailures
        if (noteImportFailures > 0) {
          notify.error(t('data.importAllFailed', { count: failedFiles.length }))
        } else if (failedFiles.length === 0) {
          notify.error(t('data.importNoContent'))
        }
      } else if (failedFiles.length > 0) {
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          enexInputRef.current?.click(),
        )
      } else {
        // #2513 — each unit is a NOTE (not a file), so label the aggregate
        // toast "notes" rather than reusing the file-worded `.md` string.
        notify.success(t('data.importedNotesMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, goToImportedPage],
  )

  // #2513 (part 2) — Joplin `.jex` import. Frontend-only: the picked `.jex`
  // tar archive is unpacked in the browser (`parseJex`), and each note it
  // contains is composed to Markdown (`jexNoteToMarkdown`) and handed to the
  // SAME `importMarkdown` IPC as the `.md`/`.enex` paths — one note → one page.
  // Referenced resources ship as `vaultFiles` (the folder-import attachment
  // path), and internal note links are preserved as `[[wikilinks]]`. Progress /
  // notify / error handling mirrors `handleEnexImport`, including the #2513
  // (part 4) single-summary-toast gating.
  const handleJexImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      setImporting(true)
      setImportResult(null)
      setBlocksProcessed(0)
      setBytesProcessed(0)
      cancelRef.current = false

      const fileArray = Array.from(files)
      const failedFiles: FailedFile[] = []
      // #2513 — a parse failure fires its OWN per-file toast; count them so the
      // end-of-run summary only fires when there is MORE to say, mirroring the
      // `.enex` path's no-double-toast gating.
      let parseFailures = 0
      // Soft warnings surfaced in the result panel (e.g. skipped encrypted items).
      const preWarnings: string[] = []
      // Flatten every note across every picked archive into a single unit list.
      const units: { name: string; content: string; vaultFiles: VaultFile[] | null }[] = []
      for (const file of fileArray) {
        try {
          const buf = await file.arrayBuffer()
          const { notes, skipped } = parseJex(new Uint8Array(buf))
          // An archive that yields no notes is treated as a parse failure so the
          // user gets an explicit "not a valid Joplin export" toast rather than a
          // silent no-op (mirrors the `.enex` malformed-file behaviour).
          if (notes.length === 0) {
            throw new Error('no importable notes found in archive')
          }
          if (skipped > 0) preWarnings.push(t('data.importJexSkipped', { count: skipped }))
          for (const note of notes) {
            const vaultFiles: VaultFile[] | null =
              note.attachments.length > 0
                ? note.attachments.map((a) => ({ path: a.path, bytes: Array.from(a.bytes) }))
                : null
            units.push({
              name: `${sanitizeNoteTitleToFilename(note.title)}.md`,
              content: jexNoteToMarkdown(note),
              vaultFiles,
            })
          }
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `jex parse failed: ${file.name}`,
            { fileName: file.name },
            err,
          )
          notify.error(t('data.importJexParseFailed', { name: file.name }))
          failedFiles.push({ name: file.name, reason: importErrorReason(err) })
          parseFailures += 1
        }
      }

      setTotalFiles(units.length)

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      const allWarnings: string[] = [...preWarnings]
      let succeededFiles = 0
      let lastTitle = ''
      let cancelled = false

      for (const [i, unit] of units.entries()) {
        if (cancelRef.current) {
          cancelled = true
          break
        }
        setCurrentFileIndex(i + 1)
        setCurrentFileName(unit.name)
        setCurrentFileBlocksDone(0)
        setCurrentFileBlocksTotal(0)
        try {
          const result = await importMarkdown(
            unit.content,
            unit.name,
            activeSpaceId,
            (update) => {
              switch (update.kind) {
                case 'started': {
                  setCurrentFileBlocksDone(0)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'progress': {
                  setCurrentFileBlocksDone(update.blocks_done)
                  setCurrentFileBlocksTotal(update.blocks_total)
                  break
                }
                case 'complete': {
                  setCurrentFileBlocksDone(update.blocks_created)
                  break
                }
              }
            },
            unit.vaultFiles,
          )
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          succeededFiles += 1
          lastTitle = result.page_title
        } catch (err) {
          logger.error(
            'DataSettingsTab',
            `jex note import failed: ${unit.name}`,
            { fileName: unit.name },
            err,
          )
          failedFiles.push({ name: unit.name, reason: importErrorReason(err) })
        }
        totalBytes += unit.content.length
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      const navTitle = totalBlocks > 0 ? lastTitle : null

      setImportResult({
        pageTitle: units.length === 1 ? lastTitle : null,
        notes: true,
        fileCount: units.length,
        blocksCreated: totalBlocks,
        propertiesSet: totalProps,
        warnings: allWarnings,
        failures: failedFiles,
        navTitle,
      })
      setDetailsExpanded(false)
      setCurrentFileIndex(null)
      setCurrentFileName('')
      setTotalFiles(0)
      setCurrentFileBlocksDone(0)
      setCurrentFileBlocksTotal(0)
      setImporting(false)
      cancelRef.current = false

      e.target.value = ''

      const viewAction =
        navTitle != null
          ? {
              label: t('data.importViewAction'),
              onClick: () => {
                void goToImportedPage(navTitle, activeSpaceId)
              },
            }
          : undefined

      if (cancelled) {
        notify(t('data.importCancelled', { count: succeededFiles }))
      } else if (totalBlocks === 0) {
        // #2513 — nothing imported. Each PARSE failure already fired its own
        // per-file toast, so the summary fallback only fires when there is MORE
        // to say (a note that PARSED but failed to import, or an empty
        // selection), mirroring the `.enex` path's no-double-toast gating.
        const noteImportFailures = failedFiles.length - parseFailures
        if (noteImportFailures > 0) {
          notify.error(t('data.importAllFailed', { count: failedFiles.length }))
        } else if (failedFiles.length === 0) {
          notify.error(t('data.importNoContent'))
        }
      } else if (failedFiles.length > 0) {
        notify.retry(t('data.importFailuresHeading', { count: failedFiles.length }), () =>
          jexInputRef.current?.click(),
        )
      } else {
        // Each unit is a NOTE (one page per note), so label it "notes".
        notify.success(t('data.importedNotesMessage', { totalBlocks, count: succeededFiles }), {
          action: viewAction,
        })
      }
    },
    [t, goToImportedPage],
  )

  // #1454 — bibliography import (`.bib` BibTeX / `.json` CSL-JSON). A single
  // file maps to a single `import_bibliography` IPC: the backend parses the
  // entries and creates one reference page per entry, so there is no
  // per-file/per-note loop here. Format is inferred from the extension
  // (`inferBibliographyFormat`); the wrapper's `format: null` auto-detect is
  // deliberately unused since the picker guarantees a filename. Space
  // gating, toasts, and error extraction (#1935 `importErrorReason`) mirror
  // `handleFileImport`.
  const handleBibliographyImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Defensive space guard — the button is disabled while
      // `currentSpaceId` is null, same as the markdown importer.
      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        notify.error(t('data.importSpaceNotReady'))
        e.target.value = ''
        return
      }

      const format = inferBibliographyFormat(file.name)
      if (format == null) {
        // The `accept` filter should make this unreachable from the picker,
        // but drag-drop / OS quirks can still hand us an arbitrary file.
        notify.error(t('data.importBibliographyUnsupported', { name: file.name }))
        e.target.value = ''
        return
      }

      const content = await file.text()
      if (content.trim().length === 0) {
        // Empty-file guard: never fire an IPC that can only produce
        // "0 entries" — surface the reason immediately instead.
        notify.error(t('data.importBibliographyEmpty', { name: file.name }))
        e.target.value = ''
        return
      }

      setImporting(true)
      setBibResult(null)
      try {
        const result = await importBibliography(content, format, activeSpaceId)
        setBibResult({
          pagesCreated: result.pages_created,
          entriesSkipped: result.entries_skipped,
          warnings: result.warnings,
        })
        notify.success(
          t('data.importBibliographyResult', {
            count: result.pages_created,
            skipped: result.entries_skipped,
          }),
        )
      } catch (err) {
        // #1935 — filename-distinct message keys the logger rate-limiter per
        // file, and the extracted reason (Validation errors carry real text)
        // is surfaced on the toast rather than a generic failure.
        logger.error(
          'DataSettingsTab',
          `bibliography import failed: ${file.name}`,
          { fileName: file.name },
          err,
        )
        const reason = importErrorReason(err)
        notify.error(
          reason
            ? t('data.importFailedFileDetail', { name: file.name, reason })
            : t('data.importFailedFile', { name: file.name }),
        )
      } finally {
        setImporting(false)
        e.target.value = ''
      }
    },
    [t],
  )

  const handleExportAll = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportGraphAsZip(currentSpaceId)
      const date = new Date().toISOString().slice(0, 10)
      // Include the active space name so a ZIP downloaded weeks
      // ago can still be matched to the space it came from. Skip the
      // `<spaceName>-` segment when no space is active or the sanitized
      // name is empty (e.g. an all-emoji name) to avoid double-dashes.
      const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId)
      const sanitizedSpaceName = sanitizeSpaceNameForFilename(activeSpace?.name ?? '')
      const spacePart = sanitizedSpaceName.length > 0 ? `${sanitizedSpaceName}-` : ''
      downloadBlob(blob, `agaric-export-${spacePart}${date}.zip`)
      notify.success(t('data.exportSuccess'))
    } catch (err) {
      logger.error('DataSettingsTab', 'export failed', undefined, err)
      notify.error(t('data.exportFailed'))
    }
    setExporting(false)
  }, [t, currentSpaceId, availableSpaces])

  // #1927 — name of the space an import will land in, for the target
  // label below the controls. `null` when no space is active (the
  // not-ready hint covers that case instead).
  const currentSpaceName =
    currentSpaceId == null
      ? null
      : (availableSpaces.find((s) => s.id === currentSpaceId)?.name ?? null)

  // Shared gating props for every import affordance (Choose Files / Import
  // Folder / #2510 Import Obsidian vault / Import Evernote). `import_markdown`
  // requires a live `space_id`, so each button is disabled until a space is
  // active and, when gated, points at the visible + AT-announced not-ready
  // hint. Hoisted (rather than repeated inline per button) so the four buttons
  // stay identical and the render's cyclomatic complexity does not scale with
  // the affordance count.
  const importGated = currentSpaceId == null
  const importDisabled = importing || importGated
  const importGatedTitle = importGated ? t('data.importSpaceNotReady') : undefined
  const importGatedDescribedBy = importGated ? importHintId : undefined

  return (
    <div className="data-settings-tab space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle
            className="import-panel-title flex items-center gap-2"
            data-testid="import-panel-title"
          >
            <Upload className="h-4 w-4" />
            {t('data.importTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">{t('data.importDesc')}</p>
          <div className="flex flex-wrap gap-2">
            <input
              type="file"
              accept=".md"
              multiple
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileImport}
              data-testid="import-file-input"
              aria-label={t('data.importButton')}
            />
            {/* #1927 — second, separate input carrying `webkitdirectory`
                so the OS opens a folder picker. This is what populates
                `file.webkitRelativePath`, the only way the #1446
                folder→namespace mapping can ever trigger; the `.md`-only
                input above never sets it. `webkitdirectory` is not in the
                React DOM typings, so spread it as a lowercased attribute. */}
            <input
              type="file"
              {...{ webkitdirectory: '', directory: '' }}
              ref={folderInputRef}
              className="hidden"
              onChange={handleFileImport}
              data-testid="import-folder-input"
              aria-label={t('data.importFolderButton')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              // `import_markdown` now requires a
              // valid `space_id`; gate the button on the SpaceStore
              // having an active space so we never call the IPC with
              // an empty string. On the rare first-boot path before
              // hydration, `currentSpaceId` is null and the button
              // stays disabled. The visible hint below + the `title`
              // attribute surface WHY (the disabled button itself
              // can't fire hover events on most browsers because
              // `disabled:pointer-events-none`, so we don't rely on
              // the tooltip alone).
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
            >
              <Upload className="h-3.5 w-3.5" />{' '}
              {importing ? t('data.importingMessage') : t('data.importButton')}
            </Button>
            {/* #1927 — folder/vault import affordance. Same gating + flow
                as the files button; only the source input differs. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
              data-testid="import-folder-button"
            >
              <FolderUp className="h-3.5 w-3.5" /> {t('data.importFolderButton')}
            </Button>
            {/* #2510 — dedicated "Import Obsidian vault" affordance. A vault is
                a folder pick, so it reuses the SAME `webkitdirectory` input +
                `handleFileImport` flow as the generic folder button; the
                explicit Obsidian label/icon makes the (already-working)
                Obsidian support discoverable. `webkitdirectory` is not in the
                React DOM typings, so spread it as a lowercased attribute. */}
            <input
              type="file"
              {...{ webkitdirectory: '', directory: '' }}
              ref={obsidianVaultInputRef}
              className="hidden"
              onChange={handleFileImport}
              data-testid="import-obsidian-input"
              aria-label={t('data.importObsidianButton')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => obsidianVaultInputRef.current?.click()}
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
              data-testid="import-obsidian-button"
            >
              <Vault className="h-3.5 w-3.5" /> {t('data.importObsidianButton')}
            </Button>
            {/* #1282 — Evernote `.enex` import affordance. Same gating + flow
                as the files button; each note in the picked file(s) becomes a
                page via the shared `importMarkdown` IPC. */}
            <input
              type="file"
              accept=".enex"
              multiple
              ref={enexInputRef}
              className="hidden"
              onChange={handleEnexImport}
              data-testid="import-enex-input"
              aria-label={t('data.importEnexButton')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => enexInputRef.current?.click()}
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
              data-testid="import-enex-button"
            >
              <FileUp className="h-3.5 w-3.5" /> {t('data.importEnexButton')}
            </Button>
            {/* #2513 (part 2) — Joplin `.jex` import affordance. Same gating +
                flow as the Evernote button; each note in the picked archive
                becomes a page via the shared `importMarkdown` IPC. */}
            <input
              type="file"
              accept=".jex"
              multiple
              ref={jexInputRef}
              className="hidden"
              onChange={handleJexImport}
              data-testid="import-jex-input"
              aria-label={t('data.importJexButton')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => jexInputRef.current?.click()}
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
              data-testid="import-jex-button"
            >
              <FileUp className="h-3.5 w-3.5" /> {t('data.importJexButton')}
            </Button>
            {/* #1454 — bibliography import affordance. Same gating + flow as
                the other import buttons; a single `.bib`/`.json` pick maps to
                one `import_bibliography` IPC (one page per entry). */}
            <input
              type="file"
              accept=".bib,.json"
              ref={bibInputRef}
              className="hidden"
              onChange={handleBibliographyImport}
              data-testid="import-bib-input"
              aria-label={t('data.importBibliographyButton')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => bibInputRef.current?.click()}
              disabled={importDisabled}
              title={importGatedTitle}
              aria-describedby={importGatedDescribedBy}
              data-testid="import-bib-button"
            >
              <Library className="h-3.5 w-3.5" /> {t('data.importBibliographyButton')}
            </Button>
            {/* #1927 — Cancel is only shown while a run is in flight. It
                sets the abort flag the file loop checks between files. */}
            {importing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  cancelRef.current = true
                }}
                data-testid="import-cancel-button"
              >
                {t('data.importCancelButton')}
              </Button>
            )}
          </div>
          {/* #1927 — surface the import target so the destination space is
              never silent. Only meaningful once a space is active (the
              not-ready hint covers the null case). */}
          {currentSpaceId != null && currentSpaceName != null && (
            <p className="text-xs text-muted-foreground mt-2" data-testid="import-target-space">
              {t('data.importTargetSpace', { name: currentSpaceName })}
            </p>
          )}
          {currentSpaceId == null && (
            // Visible inline hint on the
            // pre-bootstrap disabled state. `role="status"` +
            // `aria-live="polite"` so screen readers announce the
            // reason once the SpaceStore hydration kicks the user
            // into this branch; `aria-describedby` on the disabled
            // Button above also points here.
            <p
              id={importHintId}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role lives on a <p> referenced by aria-describedby on the disabled Button; swapping to <output> would lose paragraph semantics and is not a valid p replacement
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground mt-2"
              data-testid="import-space-not-ready-hint"
            >
              {t('data.importSpaceNotReady')}
            </p>
          )}
          {currentFileIndex !== null && (
            <>
              <p
                className="text-xs text-muted-foreground mt-2"
                data-testid="import-progress"
                aria-live="polite"
              >
                {t('data.importingProgress', {
                  index: currentFileIndex,
                  total: totalFiles,
                  name: currentFileName,
                })}
              </p>
              {/* secondary line showing cumulative blocks and
                  bytes processed so far. Hidden on the very first file
                  (before any IPC has returned) to avoid showing
                  "0 blocks · 0 B" — once at least one file completes,
                  this gives a visible forward motion even if the next
                  file is large and slow. */}
              {(blocksProcessed > 0 || bytesProcessed > 0) && (
                <p
                  className="text-xs text-muted-foreground mt-1"
                  data-testid="import-progress-detail"
                >
                  {t('data.importingProgressDetail', {
                    blocks: blocksProcessed,
                    bytes: formatBytes(bytesProcessed),
                  })}
                </p>
              )}
              {/* paired progress bar so users get a visual signal
                  alongside the textual "Importing N of M" message. No
                  design-system Progress primitive yet — use the native
                  <progress> element. */}
              <progress
                className="w-full h-1 mt-2"
                data-testid="import-progress-bar"
                aria-label={t('data.importFileProgressLabel')}
                value={currentFileIndex}
                max={totalFiles}
              />
              {/* #128 () — intra-file per-block
                  progress streamed over a Channel. Shown only once the
                  backend reports a block count (>0) for the current file,
                  so a small / headings-only file doesn't flash an empty
                  bar. Gives forward motion within a single large file. */}
              {currentFileBlocksTotal > 0 && (
                <>
                  <p
                    className="text-xs text-muted-foreground mt-1"
                    data-testid="import-block-progress"
                    aria-live="polite"
                  >
                    {t('data.importingBlocks', {
                      done: currentFileBlocksDone,
                      total: currentFileBlocksTotal,
                    })}
                  </p>
                  <progress
                    className="w-full h-1 mt-1"
                    data-testid="import-block-progress-bar"
                    aria-label={t('data.importBlockProgressLabel')}
                    value={currentFileBlocksDone}
                    max={currentFileBlocksTotal}
                  />
                </>
              )}
            </>
          )}
          {importResult &&
            (() => {
              // Derive presentation flags. `allFailed` (nothing imported, at
              // least one hard failure) drives the error-toned state instead
              // of a silent "0 blocks" line (#1928).
              const {
                failures,
                warnings,
                blocksCreated,
                propertiesSet,
                fileCount,
                pageTitle,
                navTitle,
                notes,
              } = importResult
              const allFailed = blocksCreated === 0 && failures.length > 0
              const hasDetail = failures.length > 0 || warnings.length > 0
              // Cap the at-rest list; the toggle reveals the rest.
              const PREVIEW = 5
              const shownFailures = detailsExpanded ? failures : failures.slice(0, PREVIEW)
              const shownWarnings = detailsExpanded ? warnings : warnings.slice(0, PREVIEW)
              const truncated = failures.length > PREVIEW || warnings.length > PREVIEW
              const title =
                pageTitle ??
                t(notes ? 'data.importResultNotesTitle' : 'data.importResultFilesTitle', {
                  count: fileCount,
                })
              return (
                <div
                  className="import-result mt-3 text-xs space-y-1"
                  data-testid="import-result"
                  // Announce the outcome once the progress region clears
                  // (#1929), mirroring the not-ready hint pattern above.
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level status wrapper holding the summary <p> and the <details> list; <output> is inline-level and would change the block flow of the result region
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {allFailed ? (
                    <p className="text-destructive" data-testid="import-result-error">
                      {t('data.importAllFailed', { count: failures.length })}
                    </p>
                  ) : (
                    <p className="text-status-done-foreground">
                      {t('data.importResultSummary', { title, count: blocksCreated })}
                      {propertiesSet > 0 &&
                        `, ${t('data.importResultProperties', { count: propertiesSet })}`}
                    </p>
                  )}
                  {/* #1927 — post-import navigation: jump to what was
                      imported (single file → that page; multi-file → the
                      last imported page in the target space). */}
                  {navTitle != null && currentSpaceId != null && (
                    <button
                      type="button"
                      className="underline text-status-done-foreground"
                      data-testid="import-view-button"
                      onClick={() => {
                        void goToImportedPage(navTitle, currentSpaceId)
                      }}
                    >
                      {t('data.importViewAction')}
                    </button>
                  )}
                  {hasDetail && (
                    <details data-testid="import-result-details">
                      <summary className="cursor-pointer text-status-pending-foreground">
                        {failures.length > 0 && (
                          <span className="text-destructive" data-testid="import-failures-heading">
                            {t('data.importFailuresHeading', { count: failures.length })}
                          </span>
                        )}
                        {failures.length > 0 && warnings.length > 0 && ' · '}
                        {warnings.length > 0 && (
                          <span data-testid="import-warnings-heading">
                            {t('data.importWarningsHeading', { count: warnings.length })}
                          </span>
                        )}
                      </summary>
                      <ul
                        className="mt-1 space-y-0.5 max-h-40 overflow-y-auto"
                        data-testid="import-result-detail-list"
                      >
                        {shownFailures.map(({ name, reason }, i) => (
                          <li
                            // A vault import can surface the same basename
                            // from different folders, so index-qualify.
                            // oxlint-disable-next-line react/no-array-index-key -- failure basenames can duplicate across folders; the list is render-only (no reorder/insert), so the positional index is a stable, unique key
                            key={`fail-${i}-${name}`}
                            className="text-destructive"
                            data-testid="import-failure-item"
                          >
                            {/* #1935 — show WHY the file failed when a reason
                                was extracted; fall back to the reason-less
                                label otherwise. */}
                            {reason
                              ? t('data.importFailedFileDetail', { name, reason })
                              : t('data.importFailedFile', { name })}
                          </li>
                        ))}
                        {shownWarnings.map((warning, i) => (
                          <li
                            // Warnings are free-form strings and may repeat, so
                            // index-qualify the key to keep it stable+unique.
                            // oxlint-disable-next-line react/no-array-index-key -- warning strings are free-form and may duplicate; the list is render-only (no reorder/insert), so the positional index is a stable, unique key
                            key={`warn-${i}-${warning}`}
                            className="text-status-pending-foreground"
                            data-testid="import-warning-item"
                          >
                            {warning}
                          </li>
                        ))}
                      </ul>
                      {truncated && (
                        <button
                          type="button"
                          className="mt-1 underline text-muted-foreground"
                          data-testid="import-details-toggle"
                          onClick={() => setDetailsExpanded((v) => !v)}
                        >
                          {detailsExpanded ? t('data.importShowLess') : t('data.importShowAll')}
                        </button>
                      )}
                    </details>
                  )}
                </div>
              )
            })()}
          {/* #1454 — bibliography import outcome (summary + warnings). */}
          {bibResult && <BibliographyResultPanel result={bibResult} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle
            className="export-panel-title flex items-center gap-2"
            data-testid="export-panel-title"
          >
            <Download className="h-4 w-4" />
            {t('data.exportTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">{t('data.exportDesc')}</p>
          <Button variant="outline" size="sm" disabled={exporting} onClick={handleExportAll}>
            <Download className="h-3.5 w-3.5" />{' '}
            {exporting ? t('data.exporting') : t('data.exportButton')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
