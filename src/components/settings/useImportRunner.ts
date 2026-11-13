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

import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { unwrap } from '@/lib/app-error'
import { type ImportAnchor, type ImportMerge, commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { importMarkdown } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { PREFERENCES, writePreference } from '@/lib/preferences'
import { requireActiveScope } from '@/lib/space-scope'
import { type ImportUnit, importErrorReason } from '@/lib/vault-import'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'
import { useResolveStore } from '@/stores/resolve'
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
  /** Units that completed successfully before the run ended. */
  importedCount: number
  /** Whether the user stopped the run between units. */
  cancelled: boolean
  blocksCreated: number
  propertiesSet: number
  /** Existing pages files merged into (#6277 decision 7). */
  pagesUpdated: number
  /** Existing pages a file was merged into without a change. */
  pagesUnchanged: number
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

/** The units one run imports into one space. */
export interface RunGroup {
  /** Target space ULID. */
  spaceId: string
  /** The space's name, for a run of several spaces to say which one it asks about. */
  spaceName?: string | undefined
  /** The per-item units to import, in order. */
  units: ImportUnit[]
  /** Soft warnings seeded before the loop (e.g. `.jex` skipped-item count). */
  initialWarnings?: string[] | undefined
  /**
   * Soft warnings listed first but worked out after the loop, from the
   * vault-relative paths of the files the imported units attached (e.g. a
   * folder's skipped files).
   */
  finalWarnings?: ((attached: ReadonlySet<string>) => string[]) | undefined
}

/** Options for a single {@link UseImportRunner.run}. */
export type RunOptions = {
  /** The change event whose input is reset (`value = ''`) after the run. */
  event: React.ChangeEvent<HTMLInputElement>
  /** #2513 — NOTE-based (`.enex`/`.jex`) vs FILE-based (`.md`) wording. */
  notes: boolean
  /**
   * Per-unit ERROR log label, kept per-format to preserve the exact
   * (slightly divergent) messages the three handlers used: `'file import
   * failed'`, `'enex note failed'`, `'jex note import failed'`.
   */
  loggerFailLabel: string
  /** Failures seeded before the loop (e.g. `.enex`/`.jex` parse failures). */
  initialFailures?: FailedFile[]
} & (
  | (Omit<RunGroup, 'spaceId'> & {
      /** Target space ULID (already guarded non-null by the caller). */
      activeSpaceId: string
    })
  | {
      /**
       * Several spaces' units in one run, one result for all of them (#6554);
       * the run offers no page to view, as it has no one space.
       */
      groups: RunGroup[]
    }
)

/** What a completed {@link UseImportRunner.run} returns to the caller. */
export interface RunOutcome {
  totalBlocks: number
  /** Existing pages a merge changed, which may have added no block. */
  pagesUpdated: number
  /** Whether the run's only effect was pages re-imported without a change. */
  upToDate: boolean
  succeededFiles: number
  /** The combined seeded + per-unit failures (what the result panel showed). */
  failedFiles: FailedFile[]
  cancelled: boolean
  navTitle: string | null
}

/**
 * The existing pages a run would merge its files into, asked before it runs
 * (#6277 decision 7); `answer(true)` lets it run.
 */
export interface MergeQuestion {
  pages: ImportMerge[]
  /** The space the pages are in, when the run imports into several. */
  spaceName?: string | undefined
  answer: (go: boolean) => void
}

export interface UseImportRunner {
  importing: boolean
  /** The merge question the run waits on, if any. */
  mergeQuestion: MergeQuestion | null
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

/** Link a space's imported notes into one another; the warnings that gives. */
async function linkImported(
  spaceId: string,
  anchors: ImportAnchor[],
  deferred: string[],
): Promise<string[]> {
  if (deferred.length === 0) return []
  try {
    return unwrap(await commands.linkImportAnchors(spaceId, anchors, deferred))
  } catch (err) {
    logger.error('DataSettingsTab', 'linking the imported notes failed', undefined, err)
    return [t('data.importLinkingFailed', { reason: importErrorReason(err) })]
  }
}

function runGroups(opts: RunOptions): RunGroup[] {
  return 'groups' in opts ? opts.groups : [{ ...opts, spaceId: opts.activeSpaceId }]
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
  const [mergeQuestion, setMergeQuestion] = useState<MergeQuestion | null>(null)

  // Whether the user lets the run merge `units` into the existing pages of
  // their titles; true when there are none to ask about.
  const confirmMerges = useCallback(async ({ spaceId, spaceName, units }: RunGroup) => {
    const filenames: string[] = []
    // One file's text at a time: a Logseq or Org title is read from it.
    for (const unit of units) {
      if (unit.merges === undefined) continue
      filenames.push(typeof unit.merges === 'string' ? unit.merges : await unit.merges())
    }
    if (filenames.length === 0) return true
    const pages = unwrap(await commands.listImportMerges(spaceId, filenames))
    if (pages.length === 0) return true
    return new Promise<boolean>((resolve) => {
      setMergeQuestion({
        pages,
        spaceName,
        answer: (go) => {
          setMergeQuestion(null)
          resolve(go)
        },
      })
    })
  }, [])

  // Every space's merges are asked about before any page is written.
  const confirmAllMerges = useCallback(
    async (groups: readonly RunGroup[]) => {
      for (const group of groups) {
        if (!(await confirmMerges(group))) return false
      }
      return true
    },
    [confirmMerges],
  )

  // #1927 — navigate to a just-imported page. The run result keeps only the
  // page title (`navTitle`), so resolve the title→id through
  // `resolvePageByAlias` (a page's title is one of its aliases), scoped to
  // the target space, then reuse the app's `navigateToPage` action. No-op
  // if the title can't be resolved (e.g. the page was renamed out from
  // under us) — the import itself already succeeded.
  const goToImportedPage = useCallback(
    async (title: string, spaceId: string) => {
      try {
        const hit = unwrap(await commands.resolvePageByAlias(title, requireActiveScope(spaceId)))
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
    async (opts: RunOptions): Promise<RunOutcome> => {
      const { event, notes, loggerFailLabel, initialFailures } = opts
      const groups = runGroups(opts)
      const unitCount = groups.reduce((sum, group) => sum + group.units.length, 0)
      setTotalFiles(unitCount)

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      let pagesUpdated = 0
      let pagesUnchanged = 0
      const allWarnings: string[] = groups.flatMap((group) => group.initialWarnings ?? [])
      // Hard failures: units that threw and produced no page. Seeded with any
      // parse failures the caller recorded, then extended per import failure.
      const failedFiles: FailedFile[] = initialFailures ? [...initialFailures] : []
      const finalWarnings: string[] = []
      let succeededFiles = 0
      let fileIndex = 0
      let lastTitle = ''
      // #1927 — true once the user hits Cancel mid-loop, or declines the merges.
      let cancelled = false
      try {
        cancelled = !(await confirmAllMerges(groups))
      } catch (err) {
        logger.error(
          'DataSettingsTab',
          'reading the pages the import updates failed',
          undefined,
          err,
        )
        allWarnings.push(t('data.importMergeCheckFailed', { reason: importErrorReason(err) }))
        cancelled = true
      }

      for (const { spaceId, units, finalWarnings: groupFinalWarnings } of groups) {
        const importedPageIds = new Set<string>()
        const attached = new Set<string>()
        // A folder's notes link into one another once all of them are imported.
        const anchors: ImportAnchor[] = []
        const deferred: string[] = []
        for (const unit of units) {
          // #1927 — check the abort flag BETWEEN units. The currently in-flight
          // `importMarkdown` (if any) still completes, but no further units are
          // started; we report how many imported.
          if (cancelled || cancelRef.current) {
            cancelled = true
            break
          }
          fileIndex += 1
          setCurrentFileIndex(fileIndex)
          setCurrentFileName(unit.name)
          // #128 — reset per-block progress for the new file.
          setCurrentFileBlocksDone(0)
          setCurrentFileBlocksTotal(0)
          try {
            const { content, path, dialect, vaultFiles, vaultNotes } = await unit.load()
            const result = await importMarkdown(
              content,
              path,
              spaceId,
              dialect,
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
              vaultNotes,
              // Only a file that can merge needs the run's pages; the rest import as new pages anyway.
              unit.merges === undefined ? [] : [...importedPageIds],
            )
            // A merge is the page's undo step, as an Edit as Markdown save is; one
            // that appended nothing left its page as it was.
            if (result.merged?.length === 0) pagesUnchanged += 1
            else if (result.merged) {
              pagesUpdated += 1
              notifyUndoNewAction(result.page_id, result.merged)
            }
            // Collapse is this device's layout, so the blocks a Logseq page
            // folded are folded here (#5160 D14).
            if (result.collapsed.length > 0) {
              writePreference(PREFERENCES.blockCollapse, result.collapsed, result.page_id)
            }
            totalBlocks += result.blocks_created
            totalProps += result.properties_set
            allWarnings.push(...result.warnings)
            anchors.push(...result.anchors)
            deferred.push(...result.deferred)
            succeededFiles += 1
            importedPageIds.add(result.page_id)
            for (const file of vaultFiles ?? []) attached.add(file.path)
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

        // A cancelled run links what it imported too: each note's blocks exist.
        allWarnings.push(...(await linkImported(spaceId, anchors, deferred)))

        finalWarnings.push(...(groupFinalWarnings?.(attached) ?? []))

        // #5258, #6049 — an imported page, journal day, link or property must not
        // hide behind a cache filled before the import.
        if (importedPageIds.size > 0) {
          invalidateDerivedCaches()
          // #5740 — and an imported `#tag` chip reads its name only from the
          // resolve store, which a sync refills the same way.
          void useResolveStore.getState().preload(spaceId, true, importedPageIds)
        }
      }

      allWarnings.unshift(...finalWarnings)

      // #1927 — the title to navigate to after a successful import. We resolve
      // it to a page id lazily in the View action, so the toast/panel only need
      // the title.
      const navTitle =
        !('groups' in opts) && (totalBlocks > 0 || pagesUpdated > 0 || pagesUnchanged > 0)
          ? lastTitle
          : null
      const upToDate = totalBlocks === 0 && pagesUpdated === 0 && pagesUnchanged > 0

      setImportResult({
        pageTitle: unitCount === 1 ? lastTitle : null,
        notes,
        importedCount: succeededFiles,
        cancelled,
        blocksCreated: totalBlocks,
        propertiesSet: totalProps,
        pagesUpdated,
        pagesUnchanged,
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

      return {
        totalBlocks,
        pagesUpdated,
        upToDate,
        succeededFiles,
        failedFiles,
        cancelled,
        navTitle,
      }
    },
    [confirmAllMerges],
  )

  return {
    importing,
    mergeQuestion,
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
