/**
 * ExportSection — the Export card of the Data settings tab, extracted from
 * `DataTab.tsx`. Two independent actions: the single active-space "Export All"
 * (`exportGraphAsZip`) and the whole-vault "Export All Spaces"
 * (`exportAllSpacesAsZip`, #2964), each with its own loading flag so they
 * run/report independently.
 */

import { Download } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { downloadBlob, exportAllSpacesAsZip, exportGraphAsZip } from '@/lib/export-graph'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { sanitizeSpaceNameForFilename } from '@/lib/vault-import'
import { useSpaceStore } from '@/stores/space'

export function ExportSection(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const [exporting, setExporting] = useState(false)
  // #2964 — separate loading flag for the whole-vault "Export all spaces"
  // action so it can run/report independently of the single active-space
  // "Export All" button above (each disables only itself, mirroring how
  // the two actions are otherwise fully independent).
  const [exportingAllSpaces, setExportingAllSpaces] = useState(false)

  const handleExportAll = useCallback(async () => {
    setExporting(true)
    try {
      const { blob, skippedPages, skippedAttachments } = await exportGraphAsZip(currentSpaceId)
      const date = new Date().toISOString().slice(0, 10)
      // Include the active space name so a ZIP downloaded weeks
      // ago can still be matched to the space it came from. Skip the
      // `<spaceName>-` segment when no space is active or the sanitized
      // name is empty (e.g. an all-emoji name) to avoid double-dashes.
      const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId)
      const sanitizedSpaceName = sanitizeSpaceNameForFilename(activeSpace?.name ?? '')
      const spacePart = sanitizedSpaceName.length > 0 ? `${sanitizedSpaceName}-` : ''
      downloadBlob(blob, `agaric-export-${spacePart}${date}.zip`)
      // #2965 — `exportGraphAsZip` no longer silently swallows per-page /
      // per-attachment failures behind an unconditional success: surface a
      // warning (with a details ledger already written into the ZIP as
      // `export-report.txt`) whenever anything was dropped, and keep the
      // plain success toast for the happy (0-skipped) path unchanged.
      if (skippedPages > 0 || skippedAttachments > 0) {
        const details = [
          skippedPages > 0 ? t('data.exportSkippedPages', { count: skippedPages }) : null,
          skippedAttachments > 0
            ? t('data.exportSkippedAttachments', { count: skippedAttachments })
            : null,
        ]
          .filter((d): d is string => d !== null)
          .join('; ')
        notify.warning(t('data.exportPartial', { detail: details }))
      } else {
        notify.success(t('data.exportSuccess'))
      }
    } catch (err) {
      logger.error('DataSettingsTab', 'export failed', undefined, err)
      notify.error(t('data.exportFailed'))
    }
    setExporting(false)
  }, [t, currentSpaceId, availableSpaces])

  // #2964 — whole-vault export: every space's pages, one top-level ZIP
  // folder per space (`exportAllSpacesAsZip` handles the folder-naming +
  // collision disambiguation). Mirrors `handleExportAll`'s loading/toast
  // shape so the two actions read as siblings, not divergent patterns.
  const handleExportAllSpaces = useCallback(async () => {
    setExportingAllSpaces(true)
    try {
      const { blob, spaceCount, skippedPages, skippedAttachments } = await exportAllSpacesAsZip()
      // A vault with zero spaces has nothing to export — surface that
      // explicitly rather than silently downloading an empty ZIP with no
      // signal (#2964). NOTE: this must NOT `return` early — an early
      // return here would skip the `setExportingAllSpaces(false)` below
      // (it's not in a `finally`), permanently stranding the button
      // disabled/showing its loading label after every zero-space export.
      if (spaceCount === 0) {
        notify.warning(t('data.exportAllSpacesNoSpaces'))
      } else {
        const date = new Date().toISOString().slice(0, 10)
        downloadBlob(blob, `agaric-export-all-spaces-${date}.zip`)
        if (skippedPages > 0 || skippedAttachments > 0) {
          const details = [
            skippedPages > 0 ? t('data.exportSkippedPages', { count: skippedPages }) : null,
            skippedAttachments > 0
              ? t('data.exportSkippedAttachments', { count: skippedAttachments })
              : null,
          ]
            .filter((d): d is string => d !== null)
            .join('; ')
          notify.warning(t('data.exportPartial', { detail: details }))
        } else {
          notify.success(t('data.exportAllSpacesSuccess', { count: spaceCount }))
        }
      }
    } catch (err) {
      logger.error('DataSettingsTab', 'export all spaces failed', undefined, err)
      notify.error(t('data.exportAllSpacesFailed'))
    }
    setExportingAllSpaces(false)
  }, [t])

  return (
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
        {/* #2964 — whole-vault export: every space, one top-level ZIP
            folder per space. A separate action from "Export All" above,
            which only ever sees the currently-active space. */}
        <p className="text-xs text-muted-foreground mt-3 mb-3">{t('data.exportAllSpacesDesc')}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={exportingAllSpaces}
          onClick={handleExportAllSpaces}
          data-testid="export-all-spaces-button"
        >
          <Download className="h-3.5 w-3.5" />{' '}
          {exportingAllSpaces ? t('data.exportingAllSpaces') : t('data.exportAllSpacesButton')}
        </Button>
      </CardContent>
    </Card>
  )
}
