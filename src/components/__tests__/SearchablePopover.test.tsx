/**
 * Tests for SearchablePopover component.
 *
 * Validates:
 *  - Render with trigger button
 *  - Search input inside popover
 *  - Item selection
 *  - Empty state message
 *  - Loading state (spinner)
 *  - Disabled trigger
 *  - Disabled items
 *  - a11y compliance (axe audit)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { SearchablePopover, type SearchablePopoverProps } from '../SearchablePopover'

interface TestItem {
  id: string
  label: string
}

const items: TestItem[] = [
  { id: '1', label: 'Alpha' },
  { id: '2', label: 'Beta' },
  { id: '3', label: 'Gamma' },
]

function renderPopover(overrides: Partial<SearchablePopoverProps<TestItem>> = {}) {
  const defaultProps: SearchablePopoverProps<TestItem> = {
    open: true,
    onOpenChange: vi.fn(),
    items,
    isLoading: false,
    onSelect: vi.fn(),
    renderItem: (item) => item.label,
    keyExtractor: (item) => item.id,
    searchValue: '',
    onSearchChange: vi.fn(),
    searchPlaceholder: 'Search items...',
    emptyMessage: 'No items found',
    triggerLabel: '+ Add',
    ...overrides,
  }
  return { ...render(<SearchablePopover {...defaultProps} />), props: defaultProps }
}

describe('SearchablePopover', () => {
  it('renders the trigger button', () => {
    renderPopover({ open: false })

    expect(screen.getByRole('button', { name: '+ Add' })).toBeInTheDocument()
  })

  it('shows search input when open', () => {
    renderPopover()

    expect(screen.getByPlaceholderText('Search items...')).toBeInTheDocument()
  })

  it('renders items in the list', () => {
    renderPopover()

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('calls onSelect when an item is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()

    renderPopover({ onSelect })

    await user.click(screen.getByText('Beta'))

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(items[1])
  })

  it('calls onSearchChange when typing in the search input', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()

    renderPopover({ onSearchChange })

    const input = screen.getByPlaceholderText('Search items...')
    await user.type(input, 'x')

    expect(onSearchChange).toHaveBeenCalledWith('x')
  })

  it('shows empty message when items is empty and not loading', () => {
    renderPopover({ items: [], isLoading: false })

    expect(screen.getByText('No items found')).toBeInTheDocument()
  })

  it('does not show empty message when loading', () => {
    renderPopover({ items: [], isLoading: true })

    expect(screen.queryByText('No items found')).not.toBeInTheDocument()
  })

  it('shows spinner when loading', () => {
    renderPopover({ isLoading: true })

    // PopoverContent renders via a portal, so query from document
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('does not show spinner when not loading', () => {
    renderPopover({ isLoading: false })

    const spinner = document.querySelector('.animate-spin')
    expect(spinner).not.toBeInTheDocument()
  })

  it('disables the trigger button when triggerDisabled is true', () => {
    renderPopover({ open: false, triggerDisabled: true })

    expect(screen.getByRole('button', { name: '+ Add' })).toBeDisabled()
  })

  it('disables individual items when isItemDisabled returns true', () => {
    renderPopover({
      isItemDisabled: (item) => item.id === '2',
    })

    const betaButton = screen.getByText('Beta')
    expect(betaButton).toBeDisabled()
    expect(screen.getByText('Alpha')).not.toBeDisabled()
    expect(screen.getByText('Gamma')).not.toBeDisabled()
  })

  it('list item buttons have normalized focus-visible ring classes (UX-209)', () => {
    renderPopover()

    const itemButton = screen.getByText('Alpha').closest('button') as HTMLButtonElement
    expect(itemButton).not.toBeNull()
    expect(itemButton.className).toContain('focus-visible:ring-[3px]')
    expect(itemButton.className).toContain('focus-visible:ring-ring/50')
    expect(itemButton.className).toContain('focus-visible:outline-hidden')
  })

  it('calls onOpenChange when trigger is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    renderPopover({ open: false, onOpenChange })

    await user.click(screen.getByRole('button', { name: '+ Add' }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalled()
    })
  })

  it('has no a11y violations when open', async () => {
    const { container } = renderPopover()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when closed', async () => {
    const { container } = renderPopover({ open: false })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── UX-9: keyboard navigation via useListKeyboardNavigation ─────────
  describe('keyboard navigation (UX-9)', () => {
    it('roving tabindex starts on the first item', () => {
      renderPopover()

      const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      const second = screen.getByText('Beta').closest('button') as HTMLButtonElement
      const third = screen.getByText('Gamma').closest('button') as HTMLButtonElement
      expect(first).toHaveAttribute('tabindex', '0')
      expect(second).toHaveAttribute('tabindex', '-1')
      expect(third).toHaveAttribute('tabindex', '-1')
    })

    it('ArrowDown moves the focused index to the next item', async () => {
      const user = userEvent.setup()
      renderPopover()

      // Start with focus on the first item so the hook's effect moves
      // DOM focus (otherwise the focus-management effect bails because
      // no list button is the active element).
      const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      first.focus()

      await user.keyboard('{ArrowDown}')

      await waitFor(() => {
        const second = screen.getByText('Beta').closest('button') as HTMLButtonElement
        expect(second).toHaveAttribute('tabindex', '0')
        expect(second).toHaveFocus()
      })
    })

    it('ArrowUp wraps to the last item from the first', async () => {
      const user = userEvent.setup()
      renderPopover()

      const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      first.focus()

      await user.keyboard('{ArrowUp}')

      await waitFor(() => {
        const last = screen.getByText('Gamma').closest('button') as HTMLButtonElement
        expect(last).toHaveAttribute('tabindex', '0')
        expect(last).toHaveFocus()
      })
    })

    it('Enter triggers onSelect for the focused item', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      renderPopover({ onSelect })

      const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      first.focus()

      // Move down once to focus Beta, then press Enter.
      await user.keyboard('{ArrowDown}')
      await waitFor(() => {
        const second = screen.getByText('Beta').closest('button') as HTMLButtonElement
        expect(second).toHaveFocus()
      })
      await user.keyboard('{Enter}')

      expect(onSelect).toHaveBeenCalledWith(items[1])
    })

    it('has no a11y violations after arrow-key navigation', async () => {
      const user = userEvent.setup()
      const { container } = renderPopover()

      const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      first.focus()
      await user.keyboard('{ArrowDown}')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
