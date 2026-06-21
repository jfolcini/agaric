/**
 * DataSettingsTab — Import/Export data management.
 *
 * Provides:
 *  - Import: select .md files to create pages from Logseq/Markdown content
 *  - Export: download all pages as a ZIP of Markdown files
 */

import { Download, Upload } from 'lucide-react'
import type React from 'react'
import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { notify } from '@/lib/notify'

import { downloadBlob, exportGraphAsZip } from '../lib/export-graph'
import { formatBytes } from '../lib/format'
import { logger } from '../lib/logger'
import { importMarkdown } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

/**
 * Aggregated outcome of a (possibly multi-file) import run, rendered by the
 * result panel. Unlike the backend `ImportResult` (one page), this carries
 * hard `failures` separately from soft `warnings` (#1928) so the UI can show
 * distinct, actionable messaging for files that did not import at all.
 */
interface ImportRunResult {
  /** Page title (single file) or null for the multi-file placeholder. */
  pageTitle: string | null
  fileCount: number
  blocksCreated: number
  propertiesSet: number
  /** Soft, per-file parse warnings; the file still imported. */
  warnings: string[]
  /** Filenames that threw and produced no page. */
  failures: string[]
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

export function DataSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportRunResult | null>(null)
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
      const fileArray = Array.from(files)
      setTotalFiles(fileArray.length)

      let totalBlocks = 0
      let totalProps = 0
      let totalBytes = 0
      // Soft, per-file parse warnings reported by the backend (malformed
      // YAML, dropped properties, …). The file still imported.
      const allWarnings: string[] = []
      // Hard failures: a file that threw and produced no page. Tracked
      // SEPARATELY from warnings (#1928) so we can show distinct messaging,
      // gate the success toast, and offer a retry of just the failed subset.
      const failedFiles: string[] = []
      let succeededFiles = 0
      let lastTitle = ''

      for (const [i, file] of fileArray.entries()) {
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
          const result = await importMarkdown(content, importPath, activeSpaceId, (update) => {
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
          })
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          succeededFiles += 1
          lastTitle = result.page_title
        } catch (err) {
          logger.warn('DataSettingsTab', 'file import failed', { fileName: file.name }, err)
          // Record the failing filename separately from soft warnings so the
          // result panel can list and retry it, and so the success toast can
          // be suppressed when nothing imported (#1928).
          failedFiles.push(file.name)
        }
        // Count bytes regardless of success — the user has waited on
        // this file either way, so the secondary line should reflect
        // forward progress through the selection.
        totalBytes += file.size
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      setImportResult({
        pageTitle: fileArray.length === 1 ? lastTitle : null,
        fileCount: fileArray.length,
        blocksCreated: totalBlocks,
        propertiesSet: totalProps,
        warnings: allWarnings,
        failures: failedFiles,
      })
      setDetailsExpanded(false)
      setCurrentFileIndex(null)
      setCurrentFileName('')
      setTotalFiles(0)
      setCurrentFileBlocksDone(0)
      setCurrentFileBlocksTotal(0)
      setImporting(false)

      // Reset file input before any async toast handler so a retry can
      // re-open the picker without a stale value.
      e.target.value = ''

      if (totalBlocks === 0) {
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
        notify.success(t('data.importedMessage', { totalBlocks, count: succeededFiles }))
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
          <div className="flex gap-2">
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
              disabled={importing || currentSpaceId == null}
              title={currentSpaceId == null ? t('data.importSpaceNotReady') : undefined}
              aria-describedby={currentSpaceId == null ? importHintId : undefined}
            >
              <Upload className="h-3.5 w-3.5" />{' '}
              {importing ? t('data.importingMessage') : t('data.importButton')}
            </Button>
          </div>
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
              const { failures, warnings, blocksCreated, propertiesSet, fileCount, pageTitle } =
                importResult
              const allFailed = blocksCreated === 0 && failures.length > 0
              const hasDetail = failures.length > 0 || warnings.length > 0
              // Cap the at-rest list; the toggle reveals the rest.
              const PREVIEW = 5
              const shownFailures = detailsExpanded ? failures : failures.slice(0, PREVIEW)
              const shownWarnings = detailsExpanded ? warnings : warnings.slice(0, PREVIEW)
              const truncated = failures.length > PREVIEW || warnings.length > PREVIEW
              const title = pageTitle ?? t('data.importResultFilesTitle', { count: fileCount })
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
                        {shownFailures.map((name) => (
                          <li
                            key={`fail-${name}`}
                            className="text-destructive"
                            data-testid="import-failure-item"
                          >
                            {t('data.importFailedFile', { name })}
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
