/**
 * PEND-17 Part B regression guard: the `comparedToCurrent` diff fetch
 * must NOT be self-cancelled by its own `setComparedLoading(true)`
 * triggering a re-run of the effect that owns the in-flight promise.
 *
 * Pre-fix: with `comparedLoading` in the dep array, calling
 * `setComparedLoading(true)` inside the effect re-runs the effect,
 * fires the cleanup (`cancelled = true`), and the resolving fetch's
 * `.finally` skips `setComparedLoading(false)`. The UI is stuck on
 * the spinner forever in production (synchronous test mocks happened
 * to resolve before the cleanup, masking the bug).
 *
 * This test uses an asynchronous mock (resolves via `setTimeout`) so
 * the cleanup-vs-fetch race is exercised the way real Tauri IPC does
 * it.
 */
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeHistoryEntry } from '@/__tests__/fixtures'
import { HistoryPanel } from '@/components/history/HistoryPanel'

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({})),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PEND-17 Part B compareDiff regression', () => {
  it('renders comparedToCurrent diff after async fetch resolves (no stuck spinner)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === 'get_block_history') return Promise.resolve(page)
      if (cmd === 'compute_block_vs_current_diff') {
        // Async — mimic real IPC, not the synchronous in-mocked-router
        // pattern used by the rest of the suite.
        return new Promise((resolve) => {
          setTimeout(() => resolve([{ tag: 'Insert', value: 'extra text' }]), 10)
        })
      }
      if (cmd === 'compute_edit_diff') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const row = await screen.findByTestId('block-history-row-0')
    await user.click(row)

    // The expanded panel must eventually render the diff text — if the
    // self-cancellation bug returns this hangs on the spinner forever.
    await screen.findByText(/extra text/, undefined, { timeout: 1000 })
  })

  // Required by `src/__tests__/AGENTS.md`'s `axe-presence` hook: every
  // component test file under `src/components/__tests__/` ships at
  // least one axe audit.
  it('has no a11y violations after the comparedToCurrent diff renders', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === 'get_block_history') return Promise.resolve(page)
      if (cmd === 'compute_block_vs_current_diff')
        return Promise.resolve([{ tag: 'Insert', value: 'extra text' }])
      if (cmd === 'compute_edit_diff') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const { container } = render(<HistoryPanel blockId="BLOCK001" />)
    const row = await screen.findByTestId('block-history-row-0')
    await user.click(row)
    await screen.findByText(/extra text/)

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
