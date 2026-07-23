/**
 * useImportRunner — the shared import-runner state machine extracted from
 * `DataTab.tsx` (#2898 / #2932).
 *
 * The `.md`/folder/vault, Evernote `.enex`, and Joplin `.jex` importers all
 * ran the SAME bookkeeping — progress counters, the `cancelRef` abort flag,
 * per-unit failure accumulation, the streamed per-block `onProgress` handler,
 * and the final result/summary construction. They differ ONLY in how each
 * per-item unit is produced (see the `*ToUnits` producers in
 * `@/lib/vault-import`). This hook owns the identical machinery so each
 * format's handler becomes thin wiring: `begin()`, build its `ImportUnit[]`,
 * `await run(...)`, then dispatch its own (format-specific) summary toast.
 *
 * Cancellation semantics are preserved EXACTLY: the abort flag is checked
 * BETWEEN units, an in-flight `importMarkdown` still completes, and the
 * cancelled run reports how many units imported before the abort.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import { importMarkdown, resolvePageByAlias } from '@/lib/tauri'
import { type ImportUnit, importErrorReason } from '@/lib/vault-import'
import { useTabsStore } from '@/stores/tabs'

/** A file/note that threw and produced no page, with its failure reason. */
export interface FailedFile {
  /** Source filename (basename) that threw and produced no page. */
  name: string
  /**
   * User-facing reason extracted from the thrown error (#1935). Empty
   * string when no reason could be derived, in which case the list falls
   * back to the reason-less `data.importFailedFile` label.
   */
  reason: string
}

/**
 * Aggregated outcome of a (possibly multi-file) import run, rendered by the
 * result panel. Unlike the backend `ImportResult` (one page), this carries
 * hard `failures` separately from soft `warnings` (#1928) so the UI can show
 * distinct, actionable messaging for files that did not import at all.
 */
export interface ImportRunResult {
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

/** Options for a single {@link UseImportRunner.run}. */
export interface RunOptions {
  /** The change event whose input is reset (`value = ''`) after the run. */
  event: React.ChangeEvent<HTMLInputElement>
  /** Target space ULID (already guarded non-null by the caller). */
  activeSpaceId: string
  /** The per-item units to import, in order. */
  units: ImportUnit[]
  /** #2513 — NOTE-based (`.enex`/`.jex`) vs FILE-based (`.md`) wording. */
  notes: boolean
  /**
   * Per-unit ERROR log label, kept per-format to preserve the exact
   * (slightly divergent) messages the three handlers used: `'file import
   * failed'`, `'enex note failed'`, `'jex note import failed'`.
   */
  loggerFailLabel: string
  /** Soft warnings seeded before the loop (e.g. `.jex` skipped-item count). */
  initialWarnings?: string[]
  /** Failures seeded before the loop (e.g. `.enex`/`.jex` parse failures). */
  initialFailures?: FailedFile[]
}

/** What a completed {@link UseImportRunner.run} returns to the caller. */
export interface RunOutcome {
  totalBlocks: number
  succeededFiles: number
  /** The combined seeded + per-unit failures (what the result panel showed). */
  failedFiles: FailedFile[]
  cancelled: boolean
  navTitle: string | null
}

export interface UseImportRunner {
  importing: boolean
  /** Exposed for the single-IPC bibliography importer, which shares the gate. */
  setImporting: (value: boolean) => void
  importResult: ImportRunResult | null
  detailsExpanded: boolean
  setDetailsExpanded: React.Dispatch<React.SetStateAction<boolean>>
  currentFileIndex: number | null
  currentFileName: string
  totalFiles: number
  blocksProcessed: number
  bytesProcessed: number
  currentFileBlocksDone: number
  currentFileBlocksTotal: number
  /** Reset progress/result state and clear the abort flag. Call before a run. */
  begin: () => void
  /** Set the abort flag; the loop breaks before the next unit. */
  cancel: () => void
  /** Drive the shared import loop; resolves with the aggregate outcome. */
  run: (opts: RunOptions) => Promise<RunOutcome>
  /** #1927 — resolve a page title→id and navigate (used by the View action). */
  goToImportedPage: (title: string, spaceId: string) => Promise<void>
}

export function useImportRunner(): UseImportRunner {
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  // #1927 — abort flag checked between files so a large vault import can
  // be stopped. A ref (not state) so the running loop reads the latest
  // value without re-subscribing/re-rendering each tick.
  const cancelRef = useRef(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportRunResult | null>(null)
  // Whether the failure/warning detail list is expanded past the first N
  // entries. Reset on each new import run.
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  // Per-file progress for multi-file imports.
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null)
  const [currentFileName, setCurrentFileName] = useState('')
  const [totalFiles, setTotalFiles] = useState(0)
  // Cumulative blocks created and bytes processed across files already
  // imported in the current run (secondary progress line).
  const [blocksProcessed, setBlocksProcessed] = useState(0)
  const [bytesProcessed, setBytesProcessed] = useState(0)
  // #128 — per-block progress streamed from the backend over a Channel for
  // the file currently being imported. Reset at the start of each file.
  const [currentFileBlocksDone, setCurrentFileBlocksDone] = useState(0)
  const [currentFileBlocksTotal, setCurrentFileBlocksTotal] = useState(0)

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

  const begin = useCallback(() => {
    setImporting(true)
    setImportResult(null)
    setBlocksProcessed(0)
    setBytesProcessed(0)
    // #1927 — clear any stale abort flag from a previous run before the
    // loop starts so the Cancel button only affects THIS import.
    cancelRef.current = false
  }, [])

  const cancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  const run = useCallback(
    async ({
      event,
      activeSpaceId,
      units,
      notes,
      loggerFailLabel,
      initialWarnings,
      initialFailures,
    }: RunOptions): Promise<RunOutcome> => {
      setTotalFiles(units.length)

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      const allWarnings: string[] = initialWarnings ? [...initialWarnings] : []
      // Hard failures: units that threw and produced no page. Seeded with any
      // parse failures the caller recorded, then extended per import failure.
      const failedFiles: FailedFile[] = initialFailures ? [...initialFailures] : []
      let succeededFiles = 0
      let lastTitle = ''
      // #1927 — true once the user hits Cancel mid-loop.
      let cancelled = false

      for (const [i, unit] of units.entries()) {
        // #1927 — check the abort flag BETWEEN units. The currently in-flight
        // `importMarkdown` (if any) still completes, but no further units are
        // started; we report how many imported.
        if (cancelRef.current) {
          cancelled = true
          break
        }
        setCurrentFileIndex(i + 1)
        setCurrentFileName(unit.name)
        // #128 — reset per-block progress for the new file.
        setCurrentFileBlocksDone(0)
        setCurrentFileBlocksTotal(0)
        try {
          const { content, path, vaultFiles } = await unit.load()
          const result = await importMarkdown(
            content,
            path,
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
          // #1935 — a whole-unit import failure is a real ERROR (not a
          // recoverable warning), and the message MUST be per-unit distinct:
          // the logger's rate-limiter keys on `module:message` (logger.ts),
          // so a constant message would suppress every failure after the 5th
          // in a multi-unit import. Putting the name IN the message keeps each
          // key unique.
          logger.error(
            'DataSettingsTab',
            `${loggerFailLabel}: ${unit.name}`,
            { fileName: unit.name },
            err,
          )
          failedFiles.push({ name: unit.name, reason: importErrorReason(err) })
        }
        // Count bytes regardless of success — the user has waited on this unit
        // either way, so the secondary line reflects forward progress.
        totalBytes += unit.bytes
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      // #1927 — the title to navigate to after a successful import. We resolve
      // it to a page id lazily in the View action (the result carries no
      // page_id), so the toast/panel only need the title.
      const navTitle = totalBlocks > 0 ? lastTitle : null

      setImportResult({
        pageTitle: units.length === 1 ? lastTitle : null,
        notes,
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

      // Reset file input before any async toast handler so a retry can
      // re-open the picker without a stale value.
      event.target.value = ''

      return { totalBlocks, succeededFiles, failedFiles, cancelled, navTitle }
    },
    [],
  )

  return {
    importing,
    setImporting,
    importResult,
    detailsExpanded,
    setDetailsExpanded,
    currentFileIndex,
    currentFileName,
    totalFiles,
    blocksProcessed,
    bytesProcessed,
    currentFileBlocksDone,
    currentFileBlocksTotal,
    begin,
    cancel,
    run,
    goToImportedPage,
  }
}
