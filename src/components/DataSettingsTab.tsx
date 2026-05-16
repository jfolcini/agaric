/**
 * DataSettingsTab — Import/Export data management (UX-144).
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
import type { ImportResult } from '../lib/tauri'
import { importMarkdown } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

/**
 * UX-385 — sanitize a space's display name for use inside an export
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
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  // UX-283: per-file progress for multi-file imports — shows
  // `t('data.importingProgress', { index, total, name })` while the loop runs.
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null)
  const [currentFileName, setCurrentFileName] = useState('')
  const [totalFiles, setTotalFiles] = useState(0)
  // UX-384: cumulative blocks created and bytes processed across files
  // already imported in the current run. Surfaced as a secondary line so
  // a multi-file run with one large file still shows forward motion
  // between file-index ticks.
  const [blocksProcessed, setBlocksProcessed] = useState(0)
  const [bytesProcessed, setBytesProcessed] = useState(0)
  const [exporting, setExporting] = useState(false)
  // PEND-35 Tier 1.1 — stable id wires the disabled-button's
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

      // PEND-35 Tier 1.1 — `import_markdown` now requires a space_id;
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
      const allWarnings: string[] = []
      let lastTitle = ''

      for (const [i, file] of fileArray.entries()) {
        setCurrentFileIndex(i + 1)
        setCurrentFileName(file.name)
        try {
          const content = await file.text()
          const result = await importMarkdown(content, file.name, activeSpaceId)
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          lastTitle = result.page_title
        } catch (err) {
          logger.warn('DataSettingsTab', 'file import failed', { fileName: file.name }, err)
          allWarnings.push(`Failed to import ${file.name}`)
        }
        // Count bytes regardless of success — the user has waited on
        // this file either way, so the secondary line should reflect
        // forward progress through the selection.
        totalBytes += file.size
        setBlocksProcessed(totalBlocks)
        setBytesProcessed(totalBytes)
      }

      setImportResult({
        page_title: fileArray.length === 1 ? lastTitle : `${fileArray.length} files`,
        blocks_created: totalBlocks,
        properties_set: totalProps,
        warnings: allWarnings,
      })
      setCurrentFileIndex(null)
      setCurrentFileName('')
      setTotalFiles(0)
      setImporting(false)

      if (totalBlocks > 0) {
        notify.success(t('data.importedMessage', { totalBlocks, fileCount: files.length }))
      }

      // Reset file input
      e.target.value = ''
    },
    [t],
  )

  const handleExportAll = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportGraphAsZip(currentSpaceId)
      const date = new Date().toISOString().slice(0, 10)
      // UX-385: include the active space name so a ZIP downloaded weeks
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
    <div className="data-settings-tab space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle
            className="import-panel-title flex items-center gap-2 text-base"
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
              // PEND-35 Tier 1.1 — `import_markdown` now requires a
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
            // PEND-35 Tier 1.1 — visible inline hint on the
            // pre-bootstrap disabled state. `role="status"` +
            // `aria-live="polite"` so screen readers announce the
            // reason once the SpaceStore hydration kicks the user
            // into this branch; `aria-describedby` on the disabled
            // Button above also points here.
            <p
              id={importHintId}
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
              {/* UX-384: secondary line showing cumulative blocks and
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
              {/* UX-12: paired progress bar so users get a visual signal
                  alongside the textual "Importing N of M" message. No
                  design-system Progress primitive yet — use the native
                  <progress> element. */}
              <progress
                className="w-full h-1 mt-2"
                data-testid="import-progress-bar"
                value={currentFileIndex}
                max={totalFiles}
              />
            </>
          )}
          {importResult && (
            <div className="import-result mt-3 text-xs space-y-1" data-testid="import-result">
              <p className="text-status-done-foreground">
                Imported &ldquo;{importResult.page_title}&rdquo;: {importResult.blocks_created}{' '}
                blocks
                {importResult.properties_set > 0 && `, ${importResult.properties_set} properties`}
              </p>
              {importResult.warnings.length > 0 && (
                <p className="text-status-pending-foreground">
                  {importResult.warnings.length} warning(s)
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle
            className="export-panel-title flex items-center gap-2 text-base"
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
