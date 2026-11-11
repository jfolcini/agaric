/**
 * IntegrityCheckSection — the reconciliation oracle's card in Settings › App
 * health, after the sync card (#4886, #5360).
 *
 * The oracle rebuilds every derived table from the base tables and diffs the
 * result against the maintained state. Nothing runs until the Run button is
 * pressed — not on mount, not when the tab renders: the sweep is
 * O(pages × blocks), so the button is the opt-in.
 *
 * The result is written for someone who is not us (#6488). Each divergence
 * falls in one of three groups (`@/lib/integrity-report`): caches the app can
 * rebuild from the notes, rows where the database disagrees with the sync
 * engine, and blocks stored under a non-standard id. Each group says what it is, whether it is harmless, and what to do;
 * each table under it gets its plain name and its problem, then the internal
 * artefact name, its sample keys and one truncated rebuilt-versus-stored
 * pair, for a bug report. Copy produces the Markdown section a GitHub issue
 * wants, without the pairs (they are the user's text and the issue is
 * public). Rebuild rewrites the caches and shows the report they leave; a
 * diverged result also gets a Report a bug button that opens the App-level
 * bug-report dialog with the result in it. `SettingsView` owns the result so
 * Help's Report a bug button can hand the latest one to {@link
 * BugReportDialog} too.
 */

import { cva } from 'class-variance-authority'
import { Bug, Copy, RefreshCw, ShieldCheck } from 'lucide-react'
import type React from 'react'
import { useCallback, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import type { UseReconciliationReportResult } from '@/hooks/useReconciliationReport'
import type { ArtefactDivergences, DivergenceSample, ReconciliationReport } from '@/lib/bindings'
import { formatIntegrityReport } from '@/lib/bug-report'
import { dispatchBugReport } from '@/lib/bug-report-events'
import { writeText } from '@/lib/clipboard'
import type { IntegrityGroup } from '@/lib/integrity-report'
import { divergenceKind, GROUP_KEYS, groupByKind, problemId, tableId } from '@/lib/integrity-report'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

const MODULE = 'IntegrityCheckSection'

/** The tint marks the group; the text inside keeps the normal foreground and
 *  muted tokens, which hold their contrast on the light tints. */
const groupVariants = cva('space-y-2 rounded-lg border p-3 text-sm text-foreground', {
  variants: {
    kind: {
      rebuildable: 'border-alert-warning-border bg-alert-warning',
      engine: 'border-alert-error-border bg-alert-error',
      ids: 'border-alert-note-border bg-alert-note',
    },
  },
})

const groupHeadingVariants = cva('font-semibold', {
  variants: {
    kind: {
      rebuildable: 'text-alert-warning-foreground',
      engine: 'text-alert-error-foreground',
      ids: 'text-alert-note-foreground',
    },
  },
})

/** Sample keys a group shows before "and N more"; Copy keeps all of them. */
const KEYS_SHOWN = 3

/** The summary line: rows per kind, then what the run covered. */
function useSummary(report: ReconciliationReport, groups: IntegrityGroup[]): string {
  const { t } = useTranslation()
  const parts = groups.map((group) => {
    if (group.kind === 'engine') return t('integrity.summaryEngine', { count: group.rows })
    if (group.kind === 'ids') return t('integrity.summaryIds', { count: group.rows })
    const tables = new Set(group.artefacts.map((a) => tableId(a.artefact) ?? a.artefact))
    const first = group.artefacts[0]
    const only = first === undefined ? null : tableId(first.artefact)
    if (tables.size === 1 && only !== null) {
      return t('integrity.summaryRebuildableOneTable', {
        count: group.rows,
        table: t(`integrity.tableInline.${only}`),
      })
    }
    return t('integrity.summaryRebuildable', { count: group.rows, tables: tables.size })
  })
  parts.push(t('integrity.summaryScanned', { count: report.blocks_scanned, date: report.today }))
  return parts.join(' ')
}

function ArtefactItem({
  artefact,
  sample,
}: {
  artefact: ArtefactDivergences
  sample: DivergenceSample | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const id = tableId(artefact.artefact)
  const table = id === null ? artefact.artefact : t(`integrity.table.${id}`)
  return (
    <li className="space-y-1" data-testid="integrity-artefact">
      <p className="font-medium">
        {table}: {t(`integrity.problem.${problemId(artefact.artefact)}`)}
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        {t('integrity.artefactLine', { count: artefact.count, artefact: artefact.artefact })}
      </p>
      {artefact.sample_keys.length > 0 && (
        <p className="font-mono text-xs text-muted-foreground">
          {t(
            artefact.sample_keys.length > KEYS_SHOWN
              ? 'integrity.sampleKeysMore'
              : 'integrity.sampleKeys',
            {
              keys: artefact.sample_keys.slice(0, KEYS_SHOWN).join(', '),
              count: artefact.count - KEYS_SHOWN,
            },
          )}
        </p>
      )}
      {sample !== undefined && (
        <div className="space-y-0.5 font-mono text-xs break-words" data-testid="integrity-sample">
          {divergenceKind(artefact.artefact) === 'ids' ? (
            <p>
              {t('integrity.sampleIdForm', {
                found: sample.key,
                expected: sample.key.toUpperCase(),
              })}
            </p>
          ) : (
            <>
              <p>{t('integrity.sampleExpected', { value: sample.expected })}</p>
              <p>{t('integrity.sampleActual', { value: sample.actual })}</p>
            </>
          )}
        </div>
      )}
    </li>
  )
}

function GroupSection({
  group,
  samples,
}: {
  group: IntegrityGroup
  samples: DivergenceSample[]
}): React.ReactElement {
  const { t } = useTranslation()
  const headingId = useId()
  const keys = GROUP_KEYS[group.kind]
  return (
    <section
      aria-labelledby={headingId}
      className={cn(groupVariants({ kind: group.kind }))}
      data-testid={`integrity-group-${group.kind}`}
    >
      <h3 id={headingId} className={groupHeadingVariants({ kind: group.kind })}>
        {t(keys.title)}
      </h3>
      <p>{t(keys.detail)}</p>
      <p className="font-medium">{t(keys.action)}</p>
      <ul className="space-y-3 pt-1">
        {group.artefacts.map((artefact) => (
          <ArtefactItem
            key={artefact.artefact}
            artefact={artefact}
            sample={samples.find((s) => s.artefact === artefact.artefact)}
          />
        ))}
      </ul>
    </section>
  )
}

function DivergedResult({ report }: { report: ReconciliationReport }): React.ReactElement {
  const groups = groupByKind(report)
  const summary = useSummary(report, groups)
  const samples = report.samples ?? []
  return (
    <>
      <p className="text-sm font-medium" data-testid="integrity-summary">
        {summary}
      </p>
      {/* No inner scroll: Settings already scrolls, and the list is bounded by
          the oracle's artefacts and its ten sample keys each. */}
      <div className="space-y-3" data-testid="integrity-artefact-list">
        {groups.map((group) => (
          <GroupSection key={group.kind} group={group} samples={samples} />
        ))}
      </div>
    </>
  )
}

export function IntegrityCheckSection({
  report,
  running,
  run,
  rebuilding,
  rebuild,
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

  const busy = running || rebuilding
  const rebuildable =
    report !== null && groupByKind(report).some((group) => group.kind === 'rebuildable')

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
          disabled={busy}
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

          {report !== null && report.total_divergences > 0 && <DivergedResult report={report} />}

          {report !== null && (
            <div className="flex flex-wrap gap-2">
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
              {rebuildable && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void rebuild()
                  }}
                  data-testid="integrity-rebuild-button"
                >
                  {rebuilding ? <Spinner /> : <RefreshCw />}
                  {rebuilding ? t('integrity.rebuilding') : t('integrity.rebuildButton')}
                </Button>
              )}
              {report.total_divergences > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    dispatchBugReport({
                      message: t('integrity.reportTitle', { count: report.total_divergences }),
                      integrityReport: report,
                    })
                  }}
                  data-testid="integrity-report-bug-button"
                >
                  <Bug />
                  {t('help.reportBugButton')}
                </Button>
              )}
            </div>
          )}
        </output>
      </CardContent>
    </Card>
  )
}
