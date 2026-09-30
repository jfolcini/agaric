/**
 * The report a saved *Edit as Markdown* buffer leaves behind (#5160 X2, X8).
 *
 * A save that deleted blocks, created pages or tags for names it wrote, or
 * kept something other than what was written stays until dismissed: those are
 * the saves worth checking, and a typo in a `[[Name]]` shows up here as a page
 * nobody meant to create. Any other save says so for the usual few seconds.
 * Undo reverts the whole save while it is still the page's latest undo entry;
 * after that it would revert something else, so it does nothing.
 */

import type React from 'react'
import { Fragment } from 'react'

import { PageLink } from '@/components/pages/PageLink'
import { performPageUndo } from '@/hooks/useUndoShortcuts'
import type { PageSourceReport } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { useUndoStore } from '@/stores/undo'

/** The page's latest undo entry, compared by identity. */
export function latestUndoEntry(pageId: string): unknown {
  return useUndoStore.getState().pages.get(pageId)?.undoStack[0]
}

function countsLine(report: PageSourceReport): string {
  const others = [
    report.created > 0 && t('pageSource.countCreated', { count: report.created }),
    report.edited > 0 && t('pageSource.countEdited', { count: report.edited }),
    report.moved > 0 && t('pageSource.countMoved', { count: report.moved }),
  ]
  return [t('pageSource.countDeleted', { count: report.deleted }), ...others]
    .filter((part) => part !== false)
    .join(', ')
}

function SaveReportBody({ report }: { report: PageSourceReport }): React.ReactElement {
  // Two identical warnings say nothing the first did not.
  const warnings = [...new Set(report.warnings)]
  return (
    <div className="flex flex-col gap-1">
      {report.deleted > 0 && <p>{countsLine(report)}</p>}
      {report.names_created.length > 0 && (
        <p>
          <span>{t('pageSource.reportCreated')}</span>{' '}
          {report.names_created.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && ', '}
              <PageLink pageId={row.id} title={row.content ?? ''} className="underline">
                {row.block_type === 'tag' ? `#${row.content ?? ''}` : row.content}
              </PageLink>
            </Fragment>
          ))}
        </p>
      )}
      {warnings.length > 0 && (
        <>
          <p>{t('pageSource.reportWarnings')}</p>
          <ul className="list-disc pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

async function undoSave(pageId: string, entry: unknown): Promise<void> {
  if (latestUndoEntry(pageId) !== entry) {
    notify(t('pageSource.undoStale'))
    return
  }
  await performPageUndo(pageId)
}

/**
 * Report the save of `pageId` that returned `report`. `before` is the page's
 * latest undo entry from before the save: a save that wrote nothing added no
 * entry, and offers no Undo.
 */
export function notifyPageSourceSaved(
  pageId: string,
  report: PageSourceReport,
  before: unknown,
): void {
  const entry = latestUndoEntry(pageId)
  const worthChecking =
    report.deleted > 0 || report.names_created.length > 0 || report.warnings.length > 0
  const show = report.warnings.length > 0 ? notify.warning : notify.success
  show(t('pageSource.saved'), {
    ...(worthChecking && {
      description: <SaveReportBody report={report} />,
      duration: Number.POSITIVE_INFINITY,
    }),
    ...(entry !== undefined &&
      entry !== before && {
        action: { label: t('action.undo'), onClick: () => void undoSave(pageId, entry) },
      }),
  })
}
