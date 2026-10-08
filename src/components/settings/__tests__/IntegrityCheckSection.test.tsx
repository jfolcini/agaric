/**
 * Tests for IntegrityCheckSection (#4886, #5360) — the reconciliation oracle's
 * card in Settings › App health.
 *
 * The load-bearing property is that the sweep is O(pages × blocks) and must
 * never run on its own: rendering the card has to leave
 * `compute_reconciliation_report` uncalled; the Run button is the opt-in.
 * Everything else — the clean result, the diverged result, the copy hand-off,
 * the rejection path — is what the user sees once they press Run.
 *
 * `SettingsView` owns the hook; the harness here does the same so the real
 * hook + IPC path runs.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { IntegrityCheckSection } from '@/components/settings/IntegrityCheckSection'
import { useReconciliationReport } from '@/hooks/useReconciliationReport'
import type { ReconciliationReport } from '@/lib/bindings'
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

function Harness() {
  const integrity = useReconciliationReport('IntegrityCheckSection.test')
  return <IntegrityCheckSection {...integrity} />
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriteText.mockResolvedValue(undefined)
  mockedInvoke.mockImplementation(
    mockInvokeCommands({ compute_reconciliation_report: () => CLEAN }),
  )
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
    // The Run button comes back so the user can retry.
    expect(screen.getByTestId('integrity-run-button')).toBeEnabled()
  })

  it('has no a11y violations with a result on screen', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ compute_reconciliation_report: () => DIVERGED }),
    )
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    await user.click(screen.getByTestId('integrity-run-button'))
    await screen.findByTestId('integrity-summary')

    expect(await axe(container)).toHaveNoViolations()
  })
})
