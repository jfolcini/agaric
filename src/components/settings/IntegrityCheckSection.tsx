/**
 * IntegrityCheckSection — the reconciliation oracle's card in Settings › App
 * health, after the sync card (#4886, #5360).
 *
 * The oracle rebuilds every derived table from the base tables and diffs the
 * result against the maintained state. Nothing runs until the Run button is
 * pressed — not on mount, not when the tab renders: the sweep is
 * O(pages × blocks), so the button is the opt-in.
 *
 * The result is written for someone who is not us: a count and a table name
 * per artefact ("17 rows diverged in `pages_cache.child_block_count`"), with
 * the backend's sample keys underneath and a Copy button that produces the
 * Markdown section a GitHub issue wants. `SettingsView` owns the result so
 * Help's Report a bug button can hand the latest one to {@link BugReportDialog}.
 */

import { Copy, ShieldCheck } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import type { UseReconciliationReportResult } from '@/hooks/useReconciliationReport'
import { formatIntegrityReport } from '@/lib/bug-report'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

const MODULE = 'IntegrityCheckSection'

export function IntegrityCheckSection({
  report,
  running,
  run,
}: UseReconciliationReportResult): React.ReactElement {
  const { t } = useTranslation()

  const handleCopy = useCallback(async () => {
    if (report === null) return
    try {
      await writeText(formatIntegrityReport(report))
      notify.success(t('integrity.copied'))
    } catch (err) {
      logger.error(MODULE, 'failed to copy the integrity report', undefined, err)
      notify.error(t('integrity.copyFailed'))
    }
  }, [report, t])

  return (
    <Card>
      <CardHeader>
        <CardTitle data-testid="integrity-panel-title">{t('integrity.title')}</CardTitle>
        <CardDescription>{t('integrity.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          variant="outline"
          size="sm"
          disabled={running}
          onClick={() => {
            void run()
          }}
          data-testid="integrity-run-button"
        >
          {running ? <Spinner /> : <ShieldCheck />}
          {running ? t('integrity.running') : t('integrity.runButton')}
        </Button>

        {/* `output` is an implicit `status` live region, so the result is
            announced when it lands rather than only appearing. */}
        <output aria-label={t('integrity.resultLabel')} className="block space-y-2">
          {report !== null && report.total_divergences === 0 && (
            <EmptyState
              compact
              headingLevel="p"
              icon={ShieldCheck}
              message={t('integrity.cleanTitle')}
              description={t('integrity.cleanDetail', {
                count: report.blocks_scanned,
                date: report.today,
              })}
            />
          )}

          {report !== null && report.total_divergences > 0 && (
            <>
              <p className="text-sm font-medium text-destructive" data-testid="integrity-summary">
                {t('integrity.divergedSummary', {
                  count: report.total_divergences,
                  blocks: report.blocks_scanned,
                  date: report.today,
                })}
              </p>
              <ScrollArea className="max-h-56 rounded-md border" viewportClassName="p-3">
                <ul className="space-y-3" data-testid="integrity-artefact-list">
                  {report.artefacts.map((artefact) => (
                    <li key={artefact.artefact} className="space-y-1">
                      <p className="text-sm">
                        {t('integrity.artefactLine', {
                          count: artefact.count,
                          artefact: artefact.artefact,
                        })}
                      </p>
                      {artefact.sample_keys.length > 0 && (
                        <p className="text-xs font-mono break-all text-muted-foreground">
                          {t('integrity.sampleKeys', { keys: artefact.sample_keys.join(', ') })}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </>
          )}

          {report !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleCopy()
              }}
              data-testid="integrity-copy-button"
            >
              <Copy />
              {t('integrity.copyButton')}
            </Button>
          )}
        </output>
      </CardContent>
    </Card>
  )
}
