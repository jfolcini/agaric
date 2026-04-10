/**
 * Tests for HistoryView component.
 *
 * Validates:
 *  - Renders empty state when no history entries
 *  - Renders history entries with correct badges, timestamps, previews
 *  - Checkbox toggles selection on click
 *  - Shift+click selects range
 *  - Arrow key navigation moves focus
 *  - Space toggles checkbox on focused item
 *  - Enter with selection shows confirmation dialog
 *  - Confirmation dialog "Revert" calls revertOps with correct ops in reverse chronological order
 *  - Non-reversible ops (purge_block) have disabled checkbox
 *  - "Load more" button appears when hasMore=true
 *  - Op type filter updates query
 *  - a11y compliance
 *  - Selection toolbar shows correct count
 *  - "Clear selection" button clears all
 *  - Escape key clears selection
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryView } from '../HistoryView'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

// Mock CompactionCard so it doesn't make extra invoke calls in HistoryView tests
vi.mock('../CompactionCard', () => ({
  CompactionCard: () => null,
}))

vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({ value, onValueChange, children }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: any) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: any) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: any) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        id: tp.id,
      },
      children,
    )
  }

  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

const mockedInvoke = vi.mocked(invoke)

function makeHistoryEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = '2025-01-15T12:00:00Z',
  deviceId = 'DEVICE01',
) {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryView', () => {
  it('renders empty state when no history entries', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryView />)

    expect(await screen.findByText('No history entries found')).toBeInTheDocument()
  })

  it('renders history entries with correct badges, timestamps, previews', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'Updated content' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'create_block', { content: 'New block' }, '2025-01-14T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    // Op type badges
    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    expect(screen.getByText('create_block')).toBeInTheDocument()

    // Payload previews
    expect(screen.getByText('Updated content')).toBeInTheDocument()
    expect(screen.getByText('New block')).toBeInTheDocument()
  })

  it('checkbox toggles selection on click', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /Select operation edit_block #1/,
    })
    expect(checkbox).not.toBeChecked()

    await user.click(checkbox)
    expect(checkbox).toBeChecked()

    // Selection toolbar should appear
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it('shift+click selects range', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }, '2025-01-15T11:00:00Z'),
        makeHistoryEntry(3, 'edit_block', { to_text: 'item 3' }, '2025-01-15T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    // Wait for items to render
    await screen.findByText('item 1')

    // Click the first item row
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)

    // Shift+click the third item row
    await user.keyboard('{Shift>}')
    await user.click(items[2] as HTMLElement)
    await user.keyboard('{/Shift}')

    // All three should be selected
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked()
    expect(checkboxes[1]).toBeChecked()
    expect(checkboxes[2]).toBeChecked()

    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  it('arrow key navigation moves focus', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // First item should be auto-focused on load
    const items = screen.getAllByTestId(/^history-item-/)
    expect(items[0]).toHaveClass('ring-2')

    // Press ArrowDown to move to second item
    await user.keyboard('{ArrowDown}')
    expect(items[0]).not.toHaveClass('ring-2')
    expect(items[1]).toHaveClass('ring-2')

    // Press ArrowUp to go back
    await user.keyboard('{ArrowUp}')
    expect(items[0]).toHaveClass('ring-2')
    expect(items[1]).not.toHaveClass('ring-2')
  })

  it('space toggles checkbox on focused item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Navigate to first item
    await user.keyboard('{ArrowDown}')

    // Press space to toggle
    await user.keyboard(' ')

    const checkbox = screen.getByRole('checkbox', { name: /Select operation edit_block #1/ })
    expect(checkbox).toBeChecked()

    // Press space again to untoggle
    await user.keyboard(' ')
    expect(checkbox).not.toBeChecked()
  })

  it('enter with selection shows confirmation dialog', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select via clicking the row
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)

    // Press Enter
    await user.keyboard('{Enter}')

    expect(screen.getByText('Revert 1 operations?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will create 1 new operations that reverse the selected changes. The original operations remain in history.',
      ),
    ).toBeInTheDocument()
  })

  it('confirmation dialog "Revert" calls revertOps with correct ops in reverse chronological order', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'oldest' }, '2025-01-13T10:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'middle' }, '2025-01-14T10:00:00Z'),
        makeHistoryEntry(3, 'edit_block', { to_text: 'newest' }, '2025-01-15T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // initial load
      .mockResolvedValueOnce([]) // revertOps
      .mockResolvedValueOnce(emptyPage) // reload after revert

    render(<HistoryView />)

    await screen.findByText('oldest')

    // Select all via Ctrl+A
    await user.keyboard('{Control>}a{/Control}')

    expect(screen.getByText('3 selected')).toBeInTheDocument()

    // Click "Revert selected" button
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))

    // Confirmation dialog appears
    expect(screen.getByText('Revert 3 operations?')).toBeInTheDocument()

    // Click Revert in dialog
    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('revert_ops', {
        ops: [
          { device_id: 'DEVICE01', seq: 3 }, // newest first
          { device_id: 'DEVICE01', seq: 2 },
          { device_id: 'DEVICE01', seq: 1 }, // oldest last
        ],
      })
    })
  })

  it('non-reversible ops (purge_block) have disabled checkbox', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'purge_block', { block_id: 'B1' }),
        makeHistoryEntry(2, 'delete_attachment', { attachment_id: 'A1' }),
        makeHistoryEntry(3, 'edit_block', { to_text: 'editable' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const checkboxes = screen.getAllByRole('checkbox')
    // purge_block checkbox should be disabled
    expect(checkboxes[0]).toBeDisabled()
    // delete_attachment checkbox should be disabled
    expect(checkboxes[1]).toBeDisabled()
    // edit_block checkbox should be enabled
    expect(checkboxes[2]).not.toBeDisabled()
  })

  it('"Load more" button appears when hasMore=true', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
    // Verify shared LoadMoreButton is used (aria-busy attribute)
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
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<HistoryView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    expect(await screen.findByText('entry 1')).toBeInTheDocument()
    expect(screen.getByText('entry 2')).toBeInTheDocument()
  })

  it('op type filter updates query', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<HistoryView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: null,
        limit: 50,
      })
    })

    // Change filter to 'edit_block'
    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: 'edit_block',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with entries', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'accessible item' }),
        makeHistoryEntry(2, 'purge_block', { block_id: 'B1' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<HistoryView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('selection toolbar shows correct count', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }, '2025-01-15T11:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select first item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Select second item
    await user.click(items[1] as HTMLElement)
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('"Clear selection" button clears all', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)

    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Click Clear selection
    await user.click(screen.getByRole('button', { name: /Clear selection/ }))

    // Toolbar stays visible but shows 0 selected with disabled buttons
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Revert selected/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Clear selection/ })).toBeDisabled()
  })

  it('escape key clears selection', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Press Escape
    await user.keyboard('{Escape}')

    // Selection should be cleared but toolbar stays visible
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    expect(screen.getByText('0 selected')).toBeInTheDocument()
  })

  it('toolbar is visible even when nothing is selected', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Toolbar should be visible with 0 selected
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: /0 selected/ })).toBeInTheDocument()

    // Buttons should be disabled
    expect(screen.getByRole('button', { name: /Revert selected/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Clear selection/ })).toBeDisabled()
  })

  it('calls list_page_history with correct params on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('shows loading skeletons during initial load', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<HistoryView />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('non-reversible ops have opacity-50 class', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'purge_block', { block_id: 'B1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('opacity-50')
  })

  it('handles error from listPageHistory without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<HistoryView />)

    // Should render error banner and empty state, not crash
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load history')
      expect(screen.getByText('No history entries found')).toBeInTheDocument()
    })
  })

  it('Ctrl+A selects all reversible items but not non-reversible', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'purge_block', { block_id: 'B1' }),
        makeHistoryEntry(3, 'create_block', { content: 'item 3' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Ctrl+A to select all
    await user.keyboard('{Control>}a{/Control}')

    expect(screen.getByText('2 selected')).toBeInTheDocument()

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked() // edit_block
    expect(checkboxes[1]).not.toBeChecked() // purge_block (disabled)
    expect(checkboxes[2]).toBeChecked() // create_block
  })

  it('clicking a non-reversible row does not select it', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'purge_block', { block_id: 'B1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const item = screen.getByTestId('history-item-0')
    await user.click(item)

    // Should not show selection toolbar
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('has no a11y violations with empty state', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const { container } = render(<HistoryView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('confirmation dialog Cancel button closes dialog without calling revertOps', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select the entry
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Open confirmation dialog via Enter
    await user.keyboard('{Enter}')
    expect(screen.getByText('Revert 1 operations?')).toBeInTheDocument()

    // Click Cancel
    await user.click(screen.getByRole('button', { name: /Cancel/ }))

    // Dialog should be closed
    await waitFor(() => {
      expect(screen.queryByText('Revert 1 operations?')).not.toBeInTheDocument()
    })

    // revertOps should NOT have been called (only the initial list_page_history invoke)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    // Selection should be preserved
    const checkbox = screen.getByRole('checkbox', { name: /Select operation edit_block #1/ })
    expect(checkbox).toBeChecked()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('handles revert error gracefully', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'create_block', { content: 'item 2' }, '2025-01-14T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // initial load
      .mockRejectedValueOnce(new Error('revert failed')) // revertOps throws

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select an entry
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)

    // Open dialog and confirm revert
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))
    expect(screen.getByText('Revert 1 operations?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    // Dialog should close
    await waitFor(() => {
      expect(screen.queryByText('Revert 1 operations?')).not.toBeInTheDocument()
    })

    // Component should not crash — entries are still visible
    expect(screen.getByText('item 1')).toBeInTheDocument()
    expect(screen.getByText('item 2')).toBeInTheDocument()
  })

  it('reloads history after successful revert', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'original' }, '2025-01-15T12:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    const page2 = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'original' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(
          2,
          'edit_block',
          { to_text: 'reverse op' },
          '2025-01-15T13:00:00Z',
          'DEVICE01',
        ),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page1) // initial load
      .mockResolvedValueOnce([]) // revertOps succeeds
      .mockResolvedValueOnce(page2) // reload after revert

    render(<HistoryView />)

    await screen.findByText('original')

    // Select the entry
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Open dialog and confirm
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))
    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    // listPageHistory should be called again (reload)
    await waitFor(() => {
      const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_page_history')
      expect(listCalls).toHaveLength(2) // initial load + reload after revert
    })

    // Selection should be cleared
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()

    // New data should be visible
    expect(await screen.findByText('reverse op')).toBeInTheDocument()
  })

  it('preserves selection when revert fails', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }, '2025-01-15T11:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // initial load
      .mockRejectedValueOnce(new Error('revert failed')) // revertOps fails

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select both entries
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)
    await user.click(items[1] as HTMLElement)
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    // Open dialog and confirm
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))
    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    // Wait for dialog to close
    await waitFor(() => {
      expect(screen.queryByText('Revert 2 operations?')).not.toBeInTheDocument()
    })

    // Selection should still be preserved
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked()
    expect(checkboxes[1]).toBeChecked()
  })

  // -- Focus management edge cases (#187) -------------------------------------

  it('focus ring resets when op type filter changes', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue({
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Navigate to focus the second item
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    const items = screen.getAllByTestId(/^history-item-/)
    expect(items[1]).toHaveClass('ring-2')

    // Change op type filter — this triggers a reset
    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    // After filter change, entries reload and focus resets to first item (auto-focus)
    await waitFor(() => {
      const newItems = screen.getAllByTestId(/^history-item-/)
      expect(newItems[0]).toHaveClass('ring-2')
      // Second item should no longer have focus ring
      expect(newItems[1]).not.toHaveClass('ring-2')
    })
  })

  it('arrow navigation works from reset position after filter change', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue({
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'filtered item' })],
      next_cursor: null,
      has_more: false,
    })

    render(<HistoryView />)

    await screen.findByText('filtered item')

    // Navigate to focus the item
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('history-item-0')).toHaveClass('ring-2')

    // Change filter — resets focusedIndex to -1
    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    // Wait for reload
    await waitFor(() => {
      expect(screen.getByText('filtered item')).toBeInTheDocument()
    })

    // Move focus away from the <select> — the keyboard handler ignores
    // events when target is INPUT/SELECT/TEXTAREA.
    await user.click(document.body)

    // ArrowDown from -1 should focus first item (index 0)
    await user.keyboard('{ArrowDown}')
    await waitFor(() => {
      expect(screen.getByTestId('history-item-0')).toHaveClass('ring-2')
    })
  })

  it('shows error banner when loadHistory fails and clears on retry', async () => {
    mockedInvoke
      .mockRejectedValueOnce(new Error('network failure')) // initial load fails
      .mockResolvedValueOnce(emptyPage) // retry succeeds

    const user = userEvent.setup()

    render(<HistoryView />)

    // Error banner should appear
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Failed to load history')

    // Retry button should be visible
    const retryBtn = screen.getByRole('button', { name: /Retry/ })
    expect(retryBtn).toBeInTheDocument()

    // Click retry — should clear error and reload
    await user.click(retryBtn)

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('shows toast when revert fails', async () => {
    const user = userEvent.setup()
    const mockedToastError = vi.mocked(toast.error)
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // initial load
      .mockRejectedValueOnce(new Error('revert failed')) // revertOps throws

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select an entry
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0] as HTMLElement)

    // Open dialog and confirm revert
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))
    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to revert operations')
    })
  })

  // -- Device ID display --------------------------------------------------------

  it('shows device_id for each entry', async () => {
    const page = {
      items: [
        makeHistoryEntry(
          1,
          'edit_block',
          { to_text: 'item 1' },
          '2025-01-15T12:00:00Z',
          'ABCDEF1234567890',
        ),
        makeHistoryEntry(
          2,
          'create_block',
          { content: 'item 2' },
          '2025-01-14T10:00:00Z',
          'XY987654AABBCCDD',
        ),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // device_id truncated to first 8 chars
    expect(screen.getByText('dev:ABCDEF12')).toBeInTheDocument()
    expect(screen.getByText('dev:XY987654')).toBeInTheDocument()
  })

  describe('restore to here', () => {
    it('shows confirmation dialog when restore button is clicked', async () => {
      const user = userEvent.setup()
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z')],
        next_cursor: null,
        has_more: false,
      }
      mockedInvoke.mockResolvedValueOnce(page)

      render(<HistoryView />)

      await screen.findByText('item 1')

      // Click restore button
      const restoreBtn = screen.getByRole('button', { name: /Restore to this point/i })
      await user.click(restoreBtn)

      // Confirmation dialog should appear
      expect(screen.getByText(/Restore to/)).toBeInTheDocument()
    })

    it('calls restorePageToOp on confirm', async () => {
      const user = userEvent.setup()
      const page = {
        items: [
          makeHistoryEntry(
            1,
            'edit_block',
            { to_text: 'item 1' },
            '2025-01-15T12:00:00Z',
            'DEVICE01',
          ),
        ],
        next_cursor: null,
        has_more: false,
      }
      mockedInvoke
        .mockResolvedValueOnce(page) // initial load
        .mockResolvedValueOnce({ ops_reverted: 1, non_reversible_skipped: 0, results: [] }) // restorePageToOp
        .mockResolvedValueOnce(emptyPage) // reload

      render(<HistoryView />)

      await screen.findByText('item 1')

      // Click restore button
      await user.click(screen.getByRole('button', { name: /Restore to this point/i }))

      // Click Restore in dialog
      await user.click(screen.getByRole('button', { name: /^Restore$/ }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('restore_page_to_op', {
          pageId: '__all__',
          targetDeviceId: 'DEVICE01',
          targetSeq: 1,
        })
      })
    })

    it('shows success toast after restore', async () => {
      const user = userEvent.setup()
      const mockedToastSuccess = vi.mocked(toast.success)
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z')],
        next_cursor: null,
        has_more: false,
      }
      mockedInvoke
        .mockResolvedValueOnce(page) // initial load
        .mockResolvedValueOnce({ ops_reverted: 3, non_reversible_skipped: 0, results: [] }) // restorePageToOp
        .mockResolvedValueOnce(emptyPage) // reload

      render(<HistoryView />)

      await screen.findByText('item 1')

      await user.click(screen.getByRole('button', { name: /Restore to this point/i }))
      await user.click(screen.getByRole('button', { name: /^Restore$/ }))

      await waitFor(() => {
        expect(mockedToastSuccess).toHaveBeenCalledWith('3 operations reverted successfully')
      })
    })

    it('shows warning toast when non-reversible ops are skipped', async () => {
      const user = userEvent.setup()
      const mockedToastWarning = vi.mocked(toast.warning)
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z')],
        next_cursor: null,
        has_more: false,
      }
      mockedInvoke
        .mockResolvedValueOnce(page) // initial load
        .mockResolvedValueOnce({ ops_reverted: 2, non_reversible_skipped: 1, results: [] }) // restorePageToOp
        .mockResolvedValueOnce(emptyPage) // reload

      render(<HistoryView />)

      await screen.findByText('item 1')

      await user.click(screen.getByRole('button', { name: /Restore to this point/i }))
      await user.click(screen.getByRole('button', { name: /^Restore$/ }))

      await waitFor(() => {
        expect(mockedToastWarning).toHaveBeenCalledWith('1 non-reversible operations were skipped')
      })
    })

    it('shows error toast on failure', async () => {
      const user = userEvent.setup()
      const mockedToastError = vi.mocked(toast.error)
      const page = {
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z')],
        next_cursor: null,
        has_more: false,
      }
      mockedInvoke
        .mockResolvedValueOnce(page) // initial load
        .mockRejectedValueOnce(new Error('restore failed')) // restorePageToOp throws

      render(<HistoryView />)

      await screen.findByText('item 1')

      await user.click(screen.getByRole('button', { name: /Restore to this point/i }))
      await user.click(screen.getByRole('button', { name: /^Restore$/ }))

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('Failed to restore — please try again')
      })
    })
  })
})
