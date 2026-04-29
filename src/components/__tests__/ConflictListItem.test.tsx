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
import { t } from '@/lib/i18n'
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
  page_id: null,
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

  // UX-12 — the conflict-type badge has a tooltip but previously had no
  // visual affordance. It should now render `cursor-help` and a dashed
  // border so users can tell it is interactive.
  it('conflict type badge has cursor-help affordance for the tooltip', () => {
    const block = makeConflict({ id: 'C1', content: 'text' })

    const { container } = render(
      <ul>
        <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
      </ul>,
    )

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge?.className).toContain('cursor-help')
    expect(typeBadge?.className).toContain('border-dashed')
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

  // -- UX-265 sub-fix 1: Keep/Discard tooltip + aria-description ----------
  describe('UX-265 Keep/Discard tooltip + aria-description', () => {
    it('Keep button exposes the tooltip text via aria-description', () => {
      const block = makeConflict({ id: 'C1', content: 'text' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      const keepBtn = screen.getByTestId('conflict-keep-btn')
      expect(keepBtn.getAttribute('aria-description')).toBe(t('conflict.keepTooltip'))
    })

    it('Discard button exposes the tooltip text via aria-description', () => {
      const block = makeConflict({ id: 'C1', content: 'text' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      const discardBtn = screen.getByTestId('conflict-discard-btn')
      expect(discardBtn.getAttribute('aria-description')).toBe(t('conflict.discardTooltip'))
    })

    it('Keep tooltip becomes visible on hover', async () => {
      const user = userEvent.setup()
      const block = makeConflict({ id: 'C1', content: 'text' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      // Tooltip is portaled into document.body — query there once shown.
      await user.hover(screen.getByTestId('conflict-keep-btn'))
      const tooltip = await waitFor(() => {
        const matches = screen.getAllByText(t('conflict.keepTooltip'))
        // First match is the aria-description value attached to the button.
        // The tooltip-content render is a second match once it opens.
        expect(matches.length).toBeGreaterThanOrEqual(1)
        return matches
      })
      // The tooltip content lives under [data-slot="tooltip-content"]; ensure
      // at least one such element renders the keepTooltip text.
      const contents = document.querySelectorAll('[data-slot="tooltip-content"]')
      const visible = Array.from(contents).find((c) =>
        c.textContent?.includes(t('conflict.keepTooltip')),
      )
      expect(visible).toBeTruthy()
      // Sanity: the matches array variable above is non-empty.
      expect(tooltip.length).toBeGreaterThan(0)
    })
  })

  // -- UX-265 sub-fix 3: Conflict-type badge tooltip ----------------------
  describe('UX-265 Conflict-type badge tooltip', () => {
    it('renders the type-description tooltip content for Text conflicts', async () => {
      const user = userEvent.setup()
      const block = makeConflict({ id: 'C1', content: 'text', conflict_type: null })

      const { container } = render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      const badge = container.querySelector('.conflict-type-badge') as HTMLElement
      await user.hover(badge)
      await waitFor(() => {
        const contents = document.querySelectorAll('[data-slot="tooltip-content"]')
        const visible = Array.from(contents).find((c) =>
          c.textContent?.includes(t('conflict.typeTextDescription')),
        )
        expect(visible).toBeTruthy()
      })
    })

    it('renders the type-description tooltip content for Property conflicts', async () => {
      const user = userEvent.setup()
      const block = makeConflict({ id: 'C1', content: 'p', conflict_type: 'Property' })

      const { container } = render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      const badge = container.querySelector('.conflict-type-badge') as HTMLElement
      await user.hover(badge)
      await waitFor(() => {
        const contents = document.querySelectorAll('[data-slot="tooltip-content"]')
        const visible = Array.from(contents).find((c) =>
          c.textContent?.includes(t('conflict.typePropertyDescription')),
        )
        expect(visible).toBeTruthy()
      })
    })
  })

  // -- UX-265 sub-fix 4: original-block-missing fallback -------------------
  describe('UX-265 original-block-missing fallback', () => {
    it('shows the warning banner when parent_id is set but original is undefined', () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} />
        </ul>,
      )

      const banner = screen.getByTestId('conflict-original-missing')
      expect(banner).toBeInTheDocument()
      expect(banner.getAttribute('role')).toBe('alert')
      expect(banner.textContent).toContain(t('conflict.originalNotFound'))
    })

    it('disables the Keep button when the original block is missing', () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} />
        </ul>,
      )

      const keepBtn = screen.getByTestId('conflict-keep-btn') as HTMLButtonElement
      expect(keepBtn.disabled).toBe(true)
      expect(keepBtn.getAttribute('aria-description')).toBe(t('conflict.keepDisabledNoOriginal'))
    })

    it('does not call onKeep when Keep is disabled (missing original)', async () => {
      const user = userEvent.setup()
      const onKeep = vi.fn()
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} onKeep={onKeep} />
        </ul>,
      )

      await user.click(screen.getByTestId('conflict-keep-btn'))
      expect(onKeep).not.toHaveBeenCalled()
    })

    it('does not show the banner when parent_id is null', () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: null })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} />
        </ul>,
      )

      expect(screen.queryByTestId('conflict-original-missing')).not.toBeInTheDocument()
      const keepBtn = screen.getByTestId('conflict-keep-btn') as HTMLButtonElement
      expect(keepBtn.disabled).toBe(false)
    })

    it('does not show the banner when original is loaded', () => {
      const block = makeConflict({ id: 'C1', content: 'text' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={originalBlock} />
        </ul>,
      )

      expect(screen.queryByTestId('conflict-original-missing')).not.toBeInTheDocument()
    })
  })

  // -- UX-5: Ambiguous/hidden state on Keep button + missing-original banner --
  describe('UX-5 — Keep button visible label & collapsed-row banner', () => {
    it('renders "Keep incoming" as the visible Keep button label', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      render(
        <ul>
          <ConflictListItem
            {...defaultProps}
            block={block}
            original={originalBlock}
            isExpanded={false}
          />
        </ul>,
      )

      const keepBtn = screen.getByTestId('conflict-keep-btn')
      expect(keepBtn.textContent).toContain(t('conflict.keepIncoming'))
      expect(keepBtn.textContent).toContain('Keep incoming')
    })

    it('shows the originalMissing banner on the collapsed row (not gated by isExpanded)', () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      render(
        <ul>
          <ConflictListItem
            {...defaultProps}
            block={block}
            original={undefined}
            isExpanded={false}
          />
        </ul>,
      )

      // Banner is present even though the item is collapsed.
      const banner = screen.getByTestId('conflict-original-missing')
      expect(banner).toBeInTheDocument()
      expect(banner.getAttribute('role')).toBe('alert')
    })

    it('exposes the disabled-reason via aria-description when Keep is disabled', () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} />
        </ul>,
      )

      const keepBtn = screen.getByTestId('conflict-keep-btn') as HTMLButtonElement
      expect(keepBtn.disabled).toBe(true)
      expect(keepBtn.getAttribute('aria-description')).toBe(t('conflict.keepDisabledNoOriginal'))
    })

    it('has no a11y violations when the originalMissing banner is shown', async () => {
      const block = makeConflict({ id: 'C1', content: 'text', parent_id: 'GONE' })

      const { container } = render(
        <ul>
          <ConflictListItem {...defaultProps} block={block} original={undefined} />
        </ul>,
      )

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
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
        const results = await axe(container)
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
        const results = await axe(container)
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
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
