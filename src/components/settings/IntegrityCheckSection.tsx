/**
 * IntegrityCheckSection — the Data tab's opt-in reconciliation-oracle surface
 * (#4886).
 *
 * The oracle rebuilds every derived table from the base tables and diffs the
 * result against the maintained state. It had only ever diffed synthetic
 * fixtures; this is the surface that points it at a real vault.
 *
 * Off by default, and nothing runs until the Run button is pressed — not on
 * mount, not when the tab renders, not when the switch is flipped. The sweep
 * is O(pages × blocks) and the whole point of the preference is that the user
 * chose to pay for it.
 *
 * The result is written for someone who is not us: a count and a table name
 * per artefact ("17 rows diverged in `pages_cache.child_block_count`"), with
 * the backend's sample keys underneath and a Copy button that produces the
 * Markdown section a GitHub issue wants. Turning the preference on also makes
 * {@link BugReportDialog} carry that section, so a reporter who was asked to
 * enable it does not have to paste anything by hand.
 */

import { Copy, ShieldCheck } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { ToggleRow } from '@/components/ui/toggle-row'
import { useReconciliationReport } from '@/hooks/useReconciliationReport'
import { formatIntegrityReport } from '@/lib/bug-report'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, usePreference } from '@/lib/preferences'

const MODULE = 'IntegrityCheckSection'

export function IntegrityCheckSection(): React.ReactElement {
  const { t } = useTranslation()
  const [enabled, setEnabled] = usePreference(PREFERENCES.integrityCheck)
  const { report, running, run, clear } = useReconciliationReport(MODULE)

  // Turning the check off drops the result with it: a stale report from an
  // earlier run would keep claiming a state of the vault nobody asked about.
  const handleToggle = useCallback(
    (next: boolean) => {
      setEnabled(next)
      if (!next) clear()
    },
    [setEnabled, clear],
  )

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
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2" data-testid="integrity-panel-title">
          <ShieldCheck className="h-4 w-4" />
          {t('integrity.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('integrity.description')}</p>

        <ToggleRow
          id="integrity-check-toggle"
          label={t('integrity.toggleLabel')}
          description={t('integrity.toggleHelp')}
          checked={enabled}
          onCheckedChange={handleToggle}
          data-testid="integrity-check-toggle"
        />

        {enabled && (
          <div className="space-y-3">
            <Button
              variant="outline"
              size="sm"
              disabled={running}
              onClick={() => {
                void run()
              }}
              data-testid="integrity-run-button"
            >
              {running ? <Spinner /> : <ShieldCheck className="h-3.5 w-3.5" />}
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
                  <p
                    className="text-sm font-medium text-destructive"
                    data-testid="integrity-summary"
                  >
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
                  <Copy className="h-3.5 w-3.5" />
                  {t('integrity.copyButton')}
                </Button>
              )}
            </output>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
