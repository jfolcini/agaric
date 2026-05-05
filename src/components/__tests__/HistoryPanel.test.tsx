/**
 * Tests for HistoryPanel component.
 *
 * PEND-17 Part B redesign — the in-panel restore is dialog-free
 * (toast-with-Undo is the safety net). Restore now goes through the
 * expanded panel's primary "Restore this version" button, reached by
 * clicking the row to expand.
 *
 * Validates:
 *  - Renders "Select a block" when blockId is null
 *  - Renders empty state when no history entries
 *  - Renders history entries with op_type badge, timestamp, payload preview
 *  - Restore action calls editBlock with to_text from payload (new flow)
 *  - Cursor-based pagination (Load more)
 *  - Rich content rendering (ULID tokens resolved via renderRichContent)
 *  - Property op display (set_property/delete_property formatted)
 *  - Keyboard navigation (↓/↑/Enter/Escape)
 *  - Confirmation dialog is NOT shown for in-panel restore
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeHistoryEntry } from '../../__tests__/fixtures'
import { HistoryPanel } from '../HistoryPanel'

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) => (id === 'PAGE1' ? 'My Page' : undefined)),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn((id: string) => (id === 'TAG1' ? 'project' : undefined)),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

/**
 * Route IPC calls by command name. Test files used to chain
 * `mockResolvedValueOnce` calls, but the PEND-17 Part B expanded panel
 * eagerly fires `compute_block_vs_current_diff` (and `compute_edit_diff`
 * via `useHistoryDiffToggle`) on row expansion — call ordering is no
 * longer 1:1 with user actions. Routing by command name keeps tests
 * deterministic regardless of how many auxiliary IPCs the panel adds.
 */
function setupInvokeRouter(handlers: Record<string, (args: unknown) => unknown>) {
  mockedInvoke.mockImplementation((cmd: unknown, args?: unknown) => {
    const handler = handlers[cmd as string]
    if (!handler) {
      // Default: return an empty value so unrelated UI doesn't crash.
      return Promise.resolve(null)
    }
    try {
      const result = handler(args)
      return Promise.resolve(result)
    } catch (err) {
      return Promise.reject(err)
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryPanel', () => {
  it('renders null blockId state', () => {
    render(<HistoryPanel blockId={null} />)

    expect(screen.getByText('Select a block to see history')).toBeInTheDocument()
  })

  it('renders empty state when no history entries', async () => {
    setupInvokeRouter({ get_block_history: () => emptyPage })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No history for this block')).toBeInTheDocument()
  })

  it('shows loading skeleton while fetching history', async () => {
    // Never-resolving promise to keep loading state
    mockedInvoke.mockImplementation(() => new Promise(() => {}))

    const { container } = render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(container.querySelector('.history-panel-loading')).toBeInTheDocument()
    })
  })

  it('calls get_block_history with correct params on mount', async () => {
    setupInvokeRouter({ get_block_history: () => emptyPage })

    render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK001',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders history entries with op_type badge and timestamp', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'Updated content' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'create_block', { block_type: 'content' }, '2025-01-14T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    expect(screen.getByText('create_block')).toBeInTheDocument()
    expect(screen.getByText('Updated content')).toBeInTheDocument()
  })

  it('renders long payload previews with line-clamp instead of truncation', async () => {
    const longText = 'A'.repeat(150)
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: longText })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    const previewEl = await screen.findByText(longText)
    expect(previewEl).toBeInTheDocument()
    expect(previewEl.closest('.history-item-preview')).toHaveClass('line-clamp-2')
  })

  // -- New restore flow (no dialog) ----------------------------------------

  it('restores via expanded panel: row click → "Restore this version" → editBlock', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({
      get_block_history: () => page,
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Current text' }),
      edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }),
      compute_block_vs_current_diff: () => [],
      compute_edit_diff: () => [],
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    // Expand the row.
    const row = await screen.findByTestId('block-history-row-0')
    await user.click(row)

    // The in-panel primary button is the only restore affordance.
    const restoreBtn = await screen.findByTestId('block-history-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'BLOCK001',
        toText: 'Old content',
      })
    })

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Reverted successfully',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      )
    })
  })

  it('does NOT open a ConfirmDialog when "Restore this version" is clicked (in-panel flow)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({
      get_block_history: () => page,
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Current text' }),
      edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }),
      compute_block_vs_current_diff: () => [],
      compute_edit_diff: () => [],
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const row = await screen.findByTestId('block-history-row-0')
    await user.click(row)
    const restoreBtn = await screen.findByTestId('block-history-restore-0')
    await user.click(restoreBtn)

    // The legacy ConfirmDialog title is gone for the panel flow. This
    // is the regression guard for the user-approved decision to drop
    // the dialog from in-panel restore (per PEND-17 Part B Q2).
    expect(screen.queryByText('Restore to this version?')).not.toBeInTheDocument()
  })

  it('does not show restore button for create_block entries in block history', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'create_block', { block_type: 'content' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    await screen.findByText('create_block')
    expect(screen.queryByTestId('block-history-restore-0')).not.toBeInTheDocument()
    // Non-restorable rows render but are not interactive (no aria-expanded).
    expect(screen.getByTestId('block-history-row-0')).not.toHaveAttribute('aria-expanded')
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    setupInvokeRouter({ get_block_history: () => page1 })

    render(<HistoryPanel blockId="BLOCK001" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
    expect(loadMoreBtn).toHaveAttribute('aria-busy', 'false')
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'entry 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeHistoryEntry(2, 'edit_block', { to_text: 'entry 2' })],
      next_cursor: null,
      has_more: false,
    }
    let callCount = 0
    setupInvokeRouter({
      get_block_history: (args) => {
        callCount++
        const a = args as Record<string, unknown>
        return a['cursor'] === 'cursor_page2' ? page2 : page1
      },
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK001',
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    expect(callCount).toBe(2)
    expect(await screen.findByText('entry 1')).toBeInTheDocument()
    expect(screen.getByText('entry 2')).toBeInTheDocument()
  })

  it('reloads when blockId changes', async () => {
    setupInvokeRouter({ get_block_history: () => emptyPage })

    const { rerender } = render(<HistoryPanel blockId="BLOCK_A" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK_A',
        cursor: null,
        limit: 50,
      })
    })

    rerender(<HistoryPanel blockId="BLOCK_B" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK_B',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with entries', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'accessible' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    const { container } = render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with null blockId', async () => {
    const { container } = render(<HistoryPanel blockId={null} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('handles error from getBlockHistory without crashing', async () => {
    setupInvokeRouter({
      get_block_history: () => {
        throw new Error('network failure')
      },
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(screen.getByText('No history for this block')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load history')
    })
  })

  it('handles malformed JSON payload gracefully', async () => {
    const page = {
      items: [
        {
          device_id: 'DEVICE01',
          seq: 1,
          op_type: 'edit_block',
          payload: '{invalid json!!!',
          created_at: '2025-01-15T12:00:00Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    // Malformed payload ⇒ rawContent === null ⇒ row not expandable.
    // Non-restorable rows render but are not interactive (no aria-expanded).
    expect(screen.getByTestId('block-history-row-0')).not.toHaveAttribute('aria-expanded')
  })

  it('handles payload without to_text field', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { some_other_field: 'value' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    // Non-restorable rows render but are not interactive (no aria-expanded).
    expect(screen.getByTestId('block-history-row-0')).not.toHaveAttribute('aria-expanded')
  })

  it('shows error toast when restore fails', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'some content' })],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({
      get_block_history: () => page,
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'snapshot' }),
      edit_block: () => {
        throw new Error('edit failed')
      },
      compute_block_vs_current_diff: () => [],
      compute_edit_diff: () => [],
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const row = await screen.findByTestId('block-history-row-0')
    await user.click(row)
    const restoreBtn = await screen.findByTestId('block-history-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to revert')
    })
  })

  it('shows device_id for each entry', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'content' }, '2025-01-15T12:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    await screen.findByText('edit_block')
    expect(screen.getByText('dev:DEVICE01')).toBeInTheDocument()
  })

  // -- Op-type filter bar (UX-139) -------------------------------------------

  it('renders the op-type filter bar', async () => {
    setupInvokeRouter({ get_block_history: () => emptyPage })

    render(<HistoryPanel blockId="BLOCK001" />)

    const select = await screen.findByRole('combobox', { name: /Filter by operation type/ })
    expect(select).toBeInTheDocument()
  })

  it('filters entries by op type when filter is changed', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'edited' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'create_block', { block_type: 'content' }, '2025-01-14T10:00:00Z'),
        makeHistoryEntry(3, 'edit_block', { to_text: 'another edit' }, '2025-01-13T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('edited')).toBeInTheDocument()
    expect(screen.getByText('create_block')).toBeInTheDocument()
    expect(screen.getByText('another edit')).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    expect(screen.getByText('edited')).toBeInTheDocument()
    expect(screen.getByText('another edit')).toBeInTheDocument()
    expect(screen.queryByText('create_block')).not.toBeInTheDocument()
  })

  it('shows empty state when filter produces zero results', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'edited' }, '2025-01-15T12:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    await screen.findByText('edited')

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'create_block')

    expect(screen.getByText('No history for this block')).toBeInTheDocument()
    expect(screen.queryByText('edited')).not.toBeInTheDocument()
  })

  // -- Rich content rendering (B-45) ----------------------------------------

  it('renders content through renderRichContent for rich preview', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'Updated content' }, '2025-01-15T12:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('Updated content')).toBeInTheDocument()
    const preview = screen.getByText('Updated content').closest('.history-item-preview')
    expect(preview).toHaveClass('line-clamp-2')
  })

  // -- Property op display (UX-134) -----------------------------------------

  it('renders set_property with formatted property name and value', async () => {
    const page = {
      items: [
        makeHistoryEntry(
          1,
          'set_property',
          { key: 'due_date', value: '2026-04-15' },
          '2025-01-15T12:00:00Z',
        ),
      ],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('set_property')).toBeInTheDocument()
    expect(screen.getByText(/Due Date/)).toBeInTheDocument()
    expect(screen.getByText(/2026-04-15/)).toBeInTheDocument()
  })

  it('renders delete_property with formatted property name without value', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'delete_property', { key: 'due_date' }, '2025-01-15T12:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    setupInvokeRouter({ get_block_history: () => page })

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('delete_property')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
  })

  // ===========================================================================
  // UX-275 sub-fix 4: restore success toast carries an Undo action that
  // round-trips the block back to its pre-restore content. PEND-17 Part B
  // preserves this contract — the in-panel flow is the new primary path.
  // ===========================================================================
  describe('UX-275 restore Undo round-trip (in-panel flow)', () => {
    it('attaches an Undo action to the success toast that re-applies the snapshot', async () => {
      const user = userEvent.setup()
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
        next_cursor: null,
        has_more: false,
      }
      let editBlockCallCount = 0
      setupInvokeRouter({
        get_block_history: () => page,
        get_block: () => ({
          id: 'BLOCK001',
          block_type: 'content',
          content: 'CURRENT TEXT',
        }),
        edit_block: () => {
          editBlockCallCount++
          return { id: 'BLOCK001', block_type: 'content', content: 'whatever' }
        },
        compute_block_vs_current_diff: () => [],
        compute_edit_diff: () => [],
      })

      render(<HistoryPanel blockId="BLOCK001" />)

      const row = await screen.findByTestId('block-history-row-0')
      await user.click(row)
      const restoreBtn = await screen.findByTestId('block-history-restore-0')
      await user.click(restoreBtn)

      let undoOnClick: (() => void) | undefined
      await waitFor(() => {
        const calls = vi.mocked(toast.success).mock.calls
        const lastCall = calls.find((c) => c[0] === 'Reverted successfully')
        expect(lastCall).toBeDefined()
        const opts = lastCall?.[1] as { action?: { label: string; onClick: () => void } }
        expect(opts?.action?.label).toBe('Undo')
        undoOnClick = opts?.action?.onClick
      })

      // Fire the Undo action — the previously-captured snapshot is re-applied.
      undoOnClick?.()

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
          blockId: 'BLOCK001',
          toText: 'CURRENT TEXT',
        })
      })

      // Expect at least 2 edit_block calls — original restore + undo.
      expect(editBlockCallCount).toBeGreaterThanOrEqual(2)

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Restore undone')
      })
    })

    it('omits the Undo action when the pre-restore snapshot fails to load', async () => {
      const user = userEvent.setup()
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
        next_cursor: null,
        has_more: false,
      }
      setupInvokeRouter({
        get_block_history: () => page,
        get_block: () => {
          throw new Error('block not found')
        },
        edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }),
        compute_block_vs_current_diff: () => [],
        compute_edit_diff: () => [],
      })

      render(<HistoryPanel blockId="BLOCK001" />)

      const row = await screen.findByTestId('block-history-row-0')
      await user.click(row)
      const restoreBtn = await screen.findByTestId('block-history-restore-0')
      await user.click(restoreBtn)

      // Toast still fires, but with no action option (single arg call form).
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Reverted successfully')
      })
    })
  })

  // ===========================================================================
  // PEND-17 Part B keyboard browse — ↓/↑/Enter/Escape on the list.
  // ===========================================================================
  describe('keyboard browse', () => {
    function setupKeyboardFixture() {
      const page = {
        items: [
          makeHistoryEntry(3, 'edit_block', { to_text: 'newest' }, '2025-01-17T12:00:00Z'),
          makeHistoryEntry(2, 'edit_block', { to_text: 'middle' }, '2025-01-16T12:00:00Z'),
          makeHistoryEntry(1, 'edit_block', { to_text: 'oldest' }, '2025-01-15T12:00:00Z'),
        ],
        next_cursor: null,
        has_more: false,
      }
      setupInvokeRouter({
        get_block_history: () => page,
        get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'live' }),
        edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'newest' }),
        compute_block_vs_current_diff: () => [],
        compute_edit_diff: () => [],
      })
    }

    it('ArrowDown auto-expands the next row and collapses the previous one', async () => {
      const user = userEvent.setup()
      setupKeyboardFixture()

      render(<HistoryPanel blockId="BLOCK001" />)

      const list = await screen.findByTestId('history-panel-list')
      // Focus the list so the keydown handler fires.
      list.focus()

      await user.keyboard('{ArrowDown}')
      // First press from a "no expansion" state expands index 0 (newest).
      await waitFor(() => {
        expect(screen.getByTestId('block-history-panel-0')).toBeInTheDocument()
      })

      await user.keyboard('{ArrowDown}')
      await waitFor(() => {
        // Previously-expanded panel must collapse.
        expect(screen.queryByTestId('block-history-panel-0')).not.toBeInTheDocument()
        expect(screen.getByTestId('block-history-panel-1')).toBeInTheDocument()
      })
    })

    it('ArrowUp moves focus / expansion to the previous row', async () => {
      const user = userEvent.setup()
      setupKeyboardFixture()

      render(<HistoryPanel blockId="BLOCK001" />)

      const list = await screen.findByTestId('history-panel-list')
      list.focus()

      await user.keyboard('{ArrowDown}')
      await user.keyboard('{ArrowDown}')
      await waitFor(() => {
        expect(screen.getByTestId('block-history-panel-1')).toBeInTheDocument()
      })

      await user.keyboard('{ArrowUp}')
      await waitFor(() => {
        expect(screen.queryByTestId('block-history-panel-1')).not.toBeInTheDocument()
        expect(screen.getByTestId('block-history-panel-0')).toBeInTheDocument()
      })
    })

    it('Enter on the focused row triggers restore (no dialog)', async () => {
      const user = userEvent.setup()
      setupKeyboardFixture()

      render(<HistoryPanel blockId="BLOCK001" />)

      const list = await screen.findByTestId('history-panel-list')
      list.focus()

      await user.keyboard('{ArrowDown}')
      await waitFor(() => {
        expect(screen.getByTestId('block-history-panel-0')).toBeInTheDocument()
      })

      await user.keyboard('{Enter}')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
          blockId: 'BLOCK001',
          toText: 'newest',
        })
      })
      // No dialog gets in the way of the keyboard flow.
      expect(screen.queryByText('Restore to this version?')).not.toBeInTheDocument()
    })

    it('Escape collapses the focused row', async () => {
      const user = userEvent.setup()
      setupKeyboardFixture()

      render(<HistoryPanel blockId="BLOCK001" />)

      const list = await screen.findByTestId('history-panel-list')
      list.focus()

      await user.keyboard('{ArrowDown}')
      await waitFor(() => {
        expect(screen.getByTestId('block-history-panel-0')).toBeInTheDocument()
      })

      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(screen.queryByTestId('block-history-panel-0')).not.toBeInTheDocument()
      })
    })
  })
})
