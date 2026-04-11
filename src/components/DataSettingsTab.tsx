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
import type { ImportResult } from '../lib/tauri'
import { importMarkdown } from '../lib/tauri'

export function DataSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [exporting, setExporting] = useState(false)

  const handleFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      setImporting(true)
      setImportResult(null)

      let totalBlocks = 0
      let totalProps = 0
      const allWarnings: string[] = []
      let lastTitle = ''

      for (const file of Array.from(files)) {
        try {
          const content = await file.text()
          const result = await importMarkdown(content, file.name)
          totalBlocks += result.blocks_created
          totalProps += result.properties_set
          allWarnings.push(...result.warnings)
          lastTitle = result.page_title
        } catch {
          allWarnings.push(`Failed to import ${file.name}`)
        }
      }

      setImportResult({
        page_title: files.length === 1 ? lastTitle : `${files.length} files`,
        blocks_created: totalBlocks,
        properties_set: totalProps,
        warnings: allWarnings,
      })
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
    } catch {
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
              {importing ? t('data.importingMessage') : t('data.importButton')}
            </Button>
          </div>
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
            {exporting ? t('data.exporting') : t('data.exportButton')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
