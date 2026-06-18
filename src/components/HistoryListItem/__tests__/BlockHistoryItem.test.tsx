/**
 * Tests for BlockHistoryItem — per-block history row with restore-with-preview
 * panel. The parent test file (`src/components/__tests__/HistoryListItem.test.tsx`)
 * already covers the major behaviour matrix; this file adds the
 * Phase-3b extraction's render + axe smoke coverage so the sibling
 * file is independently audited.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { computeBlockVsCurrentDiff } from '../../../lib/tauri'
import type { BlockHistoryItemProps } from '../BlockHistoryItem'
import { BlockHistoryItem } from '../BlockHistoryItem'

vi.mock('../../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

// The compared-to-current diff fetch is invoked lazily on expand; stub
// the IPC so the effect doesn't fire a real Tauri call during the axe
// audit. The render-only tests don't expand, so this is defensive.
vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri')
  return {
    ...actual,
    computeBlockVsCurrentDiff: vi.fn(async () => []),
  }
})

function makeEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = 1736942400000,
  deviceId = 'DEVICE01XXXXXXXX',
) {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
  }
}

function defaultProps(overrides: Partial<BlockHistoryItemProps> = {}): BlockHistoryItemProps {
  return {
    blockId: 'BLOCK01',
    entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }),
    index: 0,
    isExpanded: false,
    isLoadingDiff: false,
    diffSpans: undefined,
    onExpandToggle: vi.fn(),
    onRestore: vi.fn(),
    ...overrides,
  }
}

function renderInList(props: BlockHistoryItemProps) {
  return render(
    <ul aria-label="Block history">
      <BlockHistoryItem {...props} />
    </ul>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // `mock*ValueOnce` queues persist across tests (clearAllMocks only resets
  // call history), so reset the diff mock to its default resolving impl to
  // keep the failure-path tests isolated.
  vi.mocked(computeBlockVsCurrentDiff).mockReset().mockResolvedValue([])
})

describe('BlockHistoryItem (extracted sibling)', () => {
  it('renders as an <li> with the test id derived from index', () => {
    renderInList(defaultProps({ index: 7 }))
    const li = screen.getByTestId('block-history-item-7')
    expect(li.tagName).toBe('LI')
  })

  it('renders the op-type badge for the entry', () => {
    renderInList(defaultProps())
    expect(screen.getByTestId('history-type-badge')).toHaveTextContent('edit_block')
  })

  it('exposes the restorable row as a button (collapsed)', () => {
    renderInList(defaultProps())
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('renders a non-restorable row (create_block) without a button affordance', () => {
    renderInList(defaultProps({ entry: makeEntry(1, 'create_block', { content: 'x' }) }))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  // #1092: the restorable row uses the canonical focus-ring-visible utility,
  // not the legacy 2px ring.
  it('#1092: restorable row uses focus-ring-visible (no legacy 2px ring)', () => {
    renderInList(defaultProps())
    const row = screen.getByRole('button', { expanded: false })
    expect(row.className).toContain('focus-ring-visible')
    expect(row.className).not.toContain('focus-visible:ring-2')
    expect(row.className).not.toContain('focus-visible:ring-ring')
  })

  it('has no a11y violations when collapsed (restorable)', async () => {
    const { container } = renderInList(defaultProps())
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when collapsed (non-restorable)', async () => {
    const { container } = renderInList(
      defaultProps({ entry: makeEntry(1, 'create_block', { content: 'x' }) }),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #1736: when the compared-to-current diff fetch rejects, the row must
  // surface an inline error + retry instead of an empty diff container.
  describe('compared-to-current diff fetch failure (#1736)', () => {
    const mockedDiff = vi.mocked(computeBlockVsCurrentDiff)

    it('renders an inline error + retry affordance when the fetch rejects', async () => {
      mockedDiff.mockRejectedValueOnce(new Error('ipc boom'))
      renderInList(defaultProps({ isExpanded: true }))

      await waitFor(() => {
        expect(screen.getByTestId('block-history-diff-error-0')).toBeInTheDocument()
      })
      expect(screen.getByText('Failed to load diff')).toBeInTheDocument()
      expect(screen.getByTestId('block-history-diff-retry-0')).toHaveTextContent('Retry')
    })

    it('re-fetches the diff when Retry is clicked, replacing the error with the diff', async () => {
      const user = userEvent.setup()
      // First call (initial expand) rejects → error state; every subsequent
      // call resolves with the recovered diff so the retry succeeds
      // regardless of how many times the effect fires.
      mockedDiff
        .mockReset()
        .mockResolvedValue([{ tag: 'Insert', value: 'recovered' }])
        .mockRejectedValueOnce(new Error('ipc boom'))

      renderInList(defaultProps({ isExpanded: true }))

      const retry = await screen.findByTestId('block-history-diff-retry-0')
      const callsBeforeRetry = mockedDiff.mock.calls.length
      await user.click(retry)

      await waitFor(() => {
        expect(screen.queryByTestId('block-history-diff-error-0')).not.toBeInTheDocument()
      })
      // Insert is flipped to Delete in comparedToCurrent mode (MAINT-217),
      // so the recovered span renders inside a <del>.
      await waitFor(() => {
        expect(document.querySelector('del')?.textContent).toBe('recovered')
      })
      // Retry must trigger at least one additional fetch.
      expect(mockedDiff.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
    })

    it('has no a11y violations in the error state', async () => {
      mockedDiff.mockRejectedValueOnce(new Error('ipc boom'))
      const { container } = renderInList(defaultProps({ isExpanded: true }))
      await waitFor(() => {
        expect(screen.getByTestId('block-history-diff-error-0')).toBeInTheDocument()
      })
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
