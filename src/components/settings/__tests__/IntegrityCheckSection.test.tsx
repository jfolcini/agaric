/**
 * Tests for IntegrityCheckSection (#4886, #5360) — the reconciliation oracle's
 * card in Settings › App health.
 *
 * The load-bearing property is that the sweep is O(pages × blocks) and must
 * never run on its own: rendering the card has to leave
 * `compute_reconciliation_report` uncalled; the Run button is the opt-in.
 * Everything else — the clean result, the diverged result, the copy and
 * report-a-bug hand-offs, the rejection path — is what the user sees once they
 * press Run.
 *
 * `SettingsView` owns the hook; the harness here does the same so the real
 * hook + IPC path runs. It also mounts the bug-report dialog the way `App`
 * does, so the Report a bug test sees the dialog the user gets.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { BugReportDialog } from '@/components/dialogs/BugReportDialog'
import { IntegrityCheckSection } from '@/components/settings/IntegrityCheckSection'
import { useAppDialogs } from '@/hooks/useAppDialogs'
import { useReconciliationReport } from '@/hooks/useReconciliationReport'
import type { BugReport, ReconciliationReport } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'

vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
const mockedWriteText = vi.mocked(writeText)

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)
const mockedToastSuccess = vi.mocked(toast.success)

// Typed, not inferred: this is an IPC contract, and an untyped literal lets
// the fixture go stale while `tsc` stays green.
const CLEAN: ReconciliationReport = {
  blocks_scanned: 1200,
  today: '2026-09-09',
  total_divergences: 0,
  artefacts: [],
}

const DIVERGED: ReconciliationReport = {
  blocks_scanned: 1200,
  today: '2026-09-09',
  total_divergences: 17,
  artefacts: [
    {
      artefact: 'pages_cache.child_block_count',
      count: 12,
      sample_keys: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01BX5ZZKBKACTAV9WEVGEMMVRZ'],
    },
    { artefact: 'block_tag_inherited', count: 5, sample_keys: [] },
  ],
}

const METADATA: BugReport = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: 'DEV-XYZ',
  recent_errors: [],
  retry_queue: { depth: 0, oldest_age_ms: null, max_attempts: 0, task_kinds: [] },
}

// The App shell's wiring from `BUG_REPORT_EVENT` to the dialog's props.
function AppBugReportDialog() {
  const { bugReportOpen, setBugReportOpen, bugReportPrefill } = useAppDialogs()
  if (!bugReportOpen || bugReportPrefill == null) return null
  return (
    <BugReportDialog
      open
      onOpenChange={setBugReportOpen}
      initialTitle={bugReportPrefill.message}
      initialDescription={bugReportPrefill.stack ?? ''}
      integrityReport={bugReportPrefill.integrityReport}
    />
  )
}

function Harness() {
  const integrity = useReconciliationReport('IntegrityCheckSection.test')
  return (
    <>
      <IntegrityCheckSection {...integrity} />
      <AppBugReportDialog />
    </>
  )
}

function mockReport(report: ReconciliationReport) {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      compute_reconciliation_report: () => report,
      collect_bug_report_metadata: () => METADATA,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriteText.mockResolvedValue(undefined)
  mockReport(CLEAN)
})

describe('IntegrityCheckSection', () => {
  it('shows its description as the card description in the header, like the other tabs', () => {
    render(<Harness />)

    const description = screen.getByText(t('integrity.description'))
    expect(description).toHaveAttribute('data-slot', 'card-description')
    expect(description.closest('[data-slot="card-header"]')).not.toBeNull()
  })

  it('shows Run on mount with no switch, and sweeps nothing until it is pressed', () => {
    render(<Harness />)

    expect(screen.getByTestId('integrity-run-button')).toBeEnabled()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('reports a clean vault with the block count that makes it non-vacuous', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('integrity-run-button'))

    expect(await screen.findByText(t('integrity.cleanTitle'))).toBeInTheDocument()
    expect(
      screen.getByText(t('integrity.cleanDetail', { count: 1200, date: '2026-09-09' })),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('integrity-artefact-list')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('compute_reconciliation_report')
  })

  it('names each diverged artefact, its row count and its sample keys', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ compute_reconciliation_report: () => DIVERGED }),
    )
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('integrity-run-button'))

    expect(await screen.findByTestId('integrity-summary')).toHaveTextContent(
      '17 rows do not match a fresh rebuild (1200 blocks checked, 2026-09-09).',
    )
    expect(
      screen.getByText('12 rows diverged in pages_cache.child_block_count'),
    ).toBeInTheDocument()
    expect(screen.getByText('5 rows diverged in block_tag_inherited')).toBeInTheDocument()
    expect(
      screen.getByText(
        t('integrity.sampleKeys', {
          keys: '01ARZ3NDEKTSV4RRFFQ69G5FAV, 01BX5ZZKBKACTAV9WEVGEMMVRZ',
        }),
      ),
    ).toBeInTheDocument()
    // The artefact with no sample keys renders its line and no empty examples
    // row. The matcher has no trailing space on purpose: testing-library
    // trims, so `/^Examples: /` would never match the empty row this asserts
    // the absence of.
    expect(screen.getAllByText(/^Examples:/)).toHaveLength(1)
  })

  it('copies the Markdown section a bug report wants', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ compute_reconciliation_report: () => DIVERGED }),
    )
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByTestId('integrity-summary')

    await user.click(screen.getByTestId('integrity-copy-button'))

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledTimes(1)
    })
    const copied = mockedWriteText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('## Integrity check')
    expect(copied).toContain('17 divergences over 1200 blocks scanned, 2026-09-09.')
    expect(copied).toContain(
      '`pages_cache.child_block_count` — 12 rows: 01ARZ3NDEKTSV4RRFFQ69G5FAV',
    )
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('integrity.copied'))
  })

  it('opens the bug report with a diverged result as its title and integrity section', async () => {
    mockReport(DIVERGED)
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByTestId('integrity-summary')

    await user.click(screen.getByTestId('integrity-report-bug-button'))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText(t('bugReport.fieldTitleLabel'))).toHaveValue(
      'Integrity check: 17 divergences',
    )
    const preview = screen.getByTestId('bug-report-preview')
    await waitFor(() => {
      expect(preview).toHaveTextContent('## Integrity check')
    })
    expect(preview).toHaveTextContent('17 divergences over 1200 blocks scanned, 2026-09-09.')
    expect(preview).toHaveTextContent(
      '`pages_cache.child_block_count` — 12 rows: 01ARZ3NDEKTSV4RRFFQ69G5FAV',
    )
  })

  it('offers no bug report on a clean result', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)

    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByText(t('integrity.cleanTitle'))

    expect(screen.getByTestId('integrity-copy-button')).toBeInTheDocument()
    expect(screen.queryByTestId('integrity-report-bug-button')).not.toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('surfaces a clipboard failure instead of claiming the copy worked', async () => {
    const user = userEvent.setup()
    mockedWriteText.mockRejectedValue(new Error('clipboard unavailable'))
    render(<Harness />)
    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByText(t('integrity.cleanTitle'))

    await user.click(screen.getByTestId('integrity-copy-button'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('integrity.copyFailed'))
    })
    expect(mockedToastSuccess).not.toHaveBeenCalled()
  })

  it('surfaces an IPC rejection and holds no result', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        // `AppError::Database` reaches the frontend as a plain object, not an
        // `Error` — `typedError` rethrows only real `Error`s.
        compute_reconciliation_report: () =>
          Promise.reject({ kind: 'database', message: 'no such table: agenda_cache' }),
      }),
    )
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('integrity-run-button'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('integrity.runFailed'))
    })
    expect(screen.queryByTestId('integrity-summary')).not.toBeInTheDocument()
    expect(screen.queryByText(t('integrity.cleanTitle'))).not.toBeInTheDocument()
    expect(screen.queryByTestId('integrity-copy-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('integrity-report-bug-button')).not.toBeInTheDocument()
    // The Run button comes back so the user can retry.
    expect(screen.getByTestId('integrity-run-button')).toBeEnabled()
  })

  it('has no a11y violations with a diverged result and its Report a bug button', async () => {
    mockReport(DIVERGED)
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByTestId('integrity-report-bug-button')

    expect(await axe(container)).toHaveNoViolations()
  })
})
