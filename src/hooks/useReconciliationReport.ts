/**
 * useReconciliationReport — runs the reconciliation oracle on demand and
 * holds its report (#4886).
 *
 * `compute_reconciliation_report` rebuilds every derived artefact
 * (`pages_cache`, the link caches, `agenda_cache`, …) from the base tables
 * and diffs the result against the maintained state. It writes nothing and
 * takes the reader pool, but it is O(pages × blocks): it runs when a caller
 * asks and at no other time. Nothing here fires on mount.
 *
 * Two callers, one trigger each: the Data settings section runs it on a
 * button click, and the bug-report dialog runs it on open for a user who
 * turned the setting on. Both surface the failure the same way — the IPC
 * error is logged by `useIpcCommand` and toasted here — so neither has to
 * spell out the rejection path.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useIpcCommand } from '@/hooks/useIpcCommand'
import { unwrap } from '@/lib/app-error'
import type { ReconciliationReport } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { notify } from '@/lib/notify'

export interface UseReconciliationReportResult {
  /** The most recent report, or `null` before the first successful run. */
  report: ReconciliationReport | null
  /** True while a run is in flight. */
  running: boolean
  /** Start a run. Never rejects — a failure is logged, toasted, and consumed. */
  run: () => Promise<void>
  /** Drop the held report (e.g. the caller was switched off). */
  clear: () => void
}

export function useReconciliationReport(module: string): UseReconciliationReportResult {
  const { t } = useTranslation()
  const [report, setReport] = useState<ReconciliationReport | null>(null)

  const { execute, loading } = useIpcCommand<void, ReconciliationReport>({
    call: () => commands.computeReconciliationReport().then(unwrap),
    module,
    errorLogMessage: 'integrity check failed',
    onSuccess: (next) => {
      setReport(next)
    },
    onError: () => {
      notify.error(t('integrity.runFailed'))
    },
  })

  const run = useCallback(async (): Promise<void> => {
    await execute()
  }, [execute])

  const clear = useCallback((): void => {
    setReport(null)
  }, [])

  return { report, running: loading, run, clear }
}
