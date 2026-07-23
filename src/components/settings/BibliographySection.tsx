/**
 * BibliographySection — bibliography import concerns extracted from
 * `DataTab.tsx` (#1454).
 *
 * A bibliography import is a single-IPC run (`import_bibliography`, one page
 * per entry), NOT the markdown importer's per-file loop, so it does not use
 * `useImportRunner`'s progress machinery. It does, however, share the same
 * `importing` gate as the other import affordances (all import buttons disable
 * during any import), so the owning `ImportSection` passes the runner's
 * `setImporting` into {@link useBibliographyImport}.
 *
 * The bib button lives inline in `ImportSection`'s shared button row and the
 * result panel renders lower in the same card, so this module ships a hook
 * (state + handler + input ref) plus the presentational {@link
 * BibliographyResultPanel} rather than a single spanning component.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { importBibliography } from '@/lib/tauri'
import { importErrorReason, inferBibliographyFormat } from '@/lib/vault-import'
import { useSpaceStore } from '@/stores/space'

/**
 * #1454 — outcome of a bibliography import, rendered by its own result
 * panel. camelCase mirror of the backend `ImportBibliographyResult` wire
 * shape (see `importBibliography` in `src/lib/tauri.ts`); a bibliography
 * import is a single-IPC run with page/entry counts, not the markdown
 * importer's per-file block loop.
 */
export interface BibliographyImportOutcome {
  pagesCreated: number
  entriesSkipped: number
  warnings: string[]
}

export interface UseBibliographyImport {
  bibInputRef: React.RefObject<HTMLInputElement | null>
  bibResult: BibliographyImportOutcome | null
  handleBibliographyImport: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
}

/**
 * Bibliography import handler + state. Shares the `importing` gate with the
 * markdown importers via the passed `setImporting` so every import button
 * disables during a bib import (and the bib button disables during any other
 * import). Space gating, toasts, and error extraction (#1935) mirror the
 * markdown importer.
 */
export function useBibliographyImport(
  setImporting: (value: boolean) => void,
): UseBibliographyImport {
  const { t } = useTranslation()
  const bibInputRef = useRef<HTMLInputElement>(null)
  // #1454 — bibliography import outcome, rendered by its own summary +
  // warnings panel below the markdown importer's result region.
  const [bibResult, setBibResult] = useState<BibliographyImportOutcome | null>(null)

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
    [t, setImporting],
  )

  return { bibInputRef, bibResult, handleBibliographyImport }
}

/**
 * #1454 — presentational result region for a bibliography import. Mirrors
 * the markdown import-result region's live-region + warnings-panel pattern
 * (#1928 / #1929) but with page/entry counts instead of a per-file block
 * summary.
 */
export function BibliographyResultPanel({
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
