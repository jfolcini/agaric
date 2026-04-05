/**
 * Tests for ConflictListItem component.
 *
 * Validates:
 *  - Renders different conflict types (Text, Property, Move)
 *  - Keep/Discard action button callbacks
 *  - Checkbox selection toggle
 *  - Expand/collapse toggle
 *  - View original button visibility and callback
 *  - Conflict metadata display (ID, timestamp, device)
 *  - Conflict type badge styling
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeConflict } from '../../__tests__/fixtures'
import { ConflictListItem } from '../ConflictListItem'

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

const originalBlock = {
  id: 'ORIG001',
  block_type: 'content',
  content: 'original content',
  parent_id: null,
  position: null,
  deleted_at: null,
  is_conflict: false,
  conflict_type: null,
  todo_state: null,
  priority: null,
  due_date: null,
  scheduled_date: null,
}

describe('ConflictListItem', () => {
  const defaultProps = {
    isExpanded: false,
    isSelected: false,
    deviceName: undefined as string | undefined,
    onToggleExpanded: vi.fn(),
    onToggleSelected: vi.fn(),
    onKeep: vi.fn(),
    onDiscard: vi.fn(),
    onViewOriginal: vi.fn(),
  }

  it('renders a text conflict with Current/Incoming labels', () => {
    const block = makeConflict({ id: 'C1', content: 'incoming text' })

    render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    expect(screen.getByText('Current:')).toBeInTheDocument()
    expect(screen.getByText('Incoming:')).toBeInTheDocument()
    expect(screen.getByText('incoming text')).toBeInTheDocument()
    expect(screen.getByText('original content')).toBeInTheDocument()
  })

  it('renders a property conflict with property diff', () => {
    const block = makeConflict({
      id: 'C1',
      content: 'same',
      conflict_type: 'Property',
      todo_state: 'DONE',
    })
    const original = {
      ...originalBlock,
      content: 'same',
      todo_state: 'TODO',
    }

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={original} />
      </ul>,
    )

    expect(container.querySelector('.conflict-property-diff')).toBeTruthy()
    expect(screen.getByText('Property changes')).toBeInTheDocument()
    expect(screen.getByText('Property')).toBeInTheDocument()
  })

  it('renders a move conflict with move diff', () => {
    const block = makeConflict({
      id: 'C1',
      content: 'moved',
      parent_id: 'NEW_PARENT',
      position: 3,
      conflict_type: 'Move',
    })
    const original = {
      ...originalBlock,
      parent_id: 'OLD_PARENT',
      position: 1,
    }

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={original} />
      </ul>,
    )

    expect(container.querySelector('.conflict-move-diff')).toBeTruthy()
    expect(screen.getByText('Move conflict')).toBeInTheDocument()
    expect(screen.getByText('Move')).toBeInTheDocument()
  })

  it('renders conflict type badge with correct text', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge?.textContent).toBe('Text')
    expect(typeBadge?.className).toContain('bg-conflict-text')
  })

  it('renders block type badge', () => {
    const block = makeConflict({ id: 'C1', content: 'text', block_type: 'content' })

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    const itemTypeBadge = container.querySelector('.conflict-item-type')
    expect(itemTypeBadge?.textContent).toBe('content')
  })

  it('renders truncated source ID in metadata', () => {
    const block = makeConflict({ id: 'CONFLICT-ID-VERY-LONG-1234', content: 'text' })

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    const sourceId = container.querySelector('.conflict-source-id')
    expect(sourceId).toBeTruthy()
    expect(sourceId?.textContent).toContain('ID:')
  })

  it('displays device name when provided', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          deviceName="Phone"
        />
      </ul>,
    )

    expect(screen.getByText('From: Phone')).toBeInTheDocument()
  })

  it('does not display device name when undefined', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          deviceName={undefined}
        />
      </ul>,
    )

    expect(screen.queryByText(/From:/)).not.toBeInTheDocument()
  })

  it('calls onKeep when Keep button is clicked', async () => {
    const user = userEvent.setup()
    const onKeep = vi.fn()
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          onKeep={onKeep}
        />
      </ul>,
    )

    const keepBtn = screen.getByTestId('conflict-keep-btn')
    await user.click(keepBtn)

    expect(onKeep).toHaveBeenCalledWith(block)
  })

  it('calls onDiscard when Discard button is clicked', async () => {
    const user = userEvent.setup()
    const onDiscard = vi.fn()
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          onDiscard={onDiscard}
        />
      </ul>,
    )

    const discardBtn = screen.getByTestId('conflict-discard-btn')
    await user.click(discardBtn)

    expect(onDiscard).toHaveBeenCalledWith('C1')
  })

  it('calls onToggleSelected when checkbox is clicked', async () => {
    const user = userEvent.setup()
    const onToggleSelected = vi.fn()
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          onToggleSelected={onToggleSelected}
        />
      </ul>,
    )

    const checkbox = screen.getByRole('checkbox')
    await user.click(checkbox)

    expect(onToggleSelected).toHaveBeenCalledWith('C1')
  })

  it('renders checkbox as checked when isSelected is true', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          isSelected={true}
        />
      </ul>,
    )

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('calls onToggleExpanded when content area is clicked', async () => {
    const user = userEvent.setup()
    const onToggleExpanded = vi.fn()
    const block = makeConflict({ id: 'C1', content: 'text' })

    const { container } = render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          onToggleExpanded={onToggleExpanded}
        />
      </ul>,
    )

    const expandBtn = container.querySelector('.conflict-item-content') as HTMLElement
    await user.click(expandBtn)

    expect(onToggleExpanded).toHaveBeenCalledWith('C1')
  })

  it('shows View original button when parent_id exists', () => {
    const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'ORIG001' })

    render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    expect(screen.getByText('View original')).toBeInTheDocument()
  })

  it('does not show View original button when parent_id is null', () => {
    const block = makeConflict({ id: 'C1', content: 'text', parent_id: null })

    render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={undefined} />
      </ul>,
    )

    expect(screen.queryByText('View original')).not.toBeInTheDocument()
  })

  it('calls onViewOriginal when View original is clicked', async () => {
    const user = userEvent.setup()
    const onViewOriginal = vi.fn()
    const block = makeConflict({ id: 'C1', content: 'my content', parent_id: 'ORIG001' })

    render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          onViewOriginal={onViewOriginal}
        />
      </ul>,
    )

    const viewBtn = screen.getByText('View original')
    await user.click(viewBtn)

    expect(onViewOriginal).toHaveBeenCalledWith('ORIG001', 'my content')
  })

  it('has aria-expanded attribute on content button', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    const { container, rerender } = render(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          isExpanded={false}
        />
      </ul>,
    )

    const btn = container.querySelector('.conflict-item-content')
    expect(btn?.getAttribute('aria-expanded')).toBe('false')

    rerender(
      <ul>
        <ConflictListItem
          {...defaultProps}
          block={block}
          original={originalBlock}
          isExpanded={true}
        />
      </ul>,
    )

    expect(btn?.getAttribute('aria-expanded')).toBe('true')
  })

  it('action buttons container has flex-wrap class', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    const actionsContainer = document.querySelector('.conflict-item-actions')
    expect(actionsContainer?.className).toContain('flex-wrap')
  })

  describe('a11y', () => {
    it('has no a11y violations', async () => {
      const block = makeConflict({ id: 'C1', content: 'accessible conflict' })

      const { container } = render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      await waitFor(async () => {
        const results = await axe(container, {
          rules: { 'color-contrast': { enabled: false } },
        })
        expect(results).toHaveNoViolations()
      })
    })

    it('has no a11y violations when selected', async () => {
      const block = makeConflict({ id: 'C1', content: 'selected conflict' })

      const { container } = render(
        <ul>
          <ConflictListItem
            {...defaultProps}
            block={block}
            original={originalBlock}
            isSelected={true}
          />
        </ul>,
      )

      await waitFor(async () => {
        const results = await axe(container, {
          rules: { 'color-contrast': { enabled: false } },
        })
        expect(results).toHaveNoViolations()
      })
    })

    it('has no a11y violations when expanded', async () => {
      const block = makeConflict({ id: 'C1', content: 'expanded conflict' })

      const { container } = render(
        <ul>
          <ConflictListItem
            {...defaultProps}
            block={block}
            original={originalBlock}
            isExpanded={true}
          />
        </ul>,
      )

      await waitFor(async () => {
        const results = await axe(container, {
          rules: { 'color-contrast': { enabled: false } },
        })
        expect(results).toHaveNoViolations()
      })
    })
  })
})
