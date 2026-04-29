/**
 * DataSettingsTab — Import/Export data management (UX-144).
 *
 * Provides:
 *  - Import: select .md files to create pages from Logseq/Markdown content
 *  - Export: download all pages as a ZIP of Markdown files
 */

import { Download, Upload } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { downloadBlob, exportGraphAsZip } from '../lib/export-graph'
import { logger } from '../lib/logger'
import type { ImportResult } from '../lib/tauri'
import { importMarkdown } from '../lib/tauri'

export function DataSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  // UX-283: per-file progress for multi-file imports — shows
  // "Importing file 2 of 5: document.md" while the loop runs.
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null)
  const [currentFileName, setCurrentFileName] = useState('')
  const [totalFiles, setTotalFiles] = useState(0)
  const [exporting, setExporting] = useState(false)

  const handleFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      setImporting(true)
      setImportResult(null)
      const fileArray = Array.from(files)
      setTotalFiles(fileArray.length)

      let totalBlocks = 0
      let totalProps = 0
      const allWarnings: string[] = []
      let lastTitle = ''

      for (const [i, file] of fileArray.entries()) {
        setCurrentFileIndex(i + 1)
        setCurrentFileName(file.name)
        try {
          const content = await file.text()
          const result = await importMarkdown(content, file.name)
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          lastTitle = result.page_title
        } catch (err) {
          logger.warn('DataSettingsTab', 'file import failed', { fileName: file.name }, err)
          allWarnings.push(`Failed to import ${file.name}`)
        }
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
        toast.success(t('data.importedMessage', { totalBlocks, fileCount: files.length }))
      }

      // Reset file input
      e.target.value = ''
    },
    [t],
  )

  const handleExportAll = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportGraphAsZip()
      const date = new Date().toISOString().slice(0, 10)
      downloadBlob(blob, `agaric-export-${date}.zip`)
      toast.success(t('data.exportSuccess'))
    } catch (err) {
      logger.error('DataSettingsTab', 'export failed', undefined, err)
      toast.error(t('data.exportFailed'))
    }
    setExporting(false)
  }, [t])

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
              disabled={importing}
            >
              <Upload className="h-3.5 w-3.5" />{' '}
              {importing ? t('data.importingMessage') : t('data.importButton')}
            </Button>
          </div>
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
