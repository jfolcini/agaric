/**
 * Tests for HistoryListItem component.
 *
 * Validates:
 *  - Renders op type badge for different operation types
 *  - Renders payload preview text via renderRichContent
 *  - Renders timestamp
 *  - Renders device ID (truncated to 8 chars)
 *  - Checkbox reflects selection state
 *  - Checkbox disabled for non-reversible ops
 *  - Lock icon shown for non-reversible ops
 *  - opacity-50 applied for non-reversible ops
 *  - Diff toggle button shown for edit_block entries
 *  - Diff toggle button not shown for non-edit_block entries
 *  - Diff display shown when expanded with diff data
 *  - Spinner shown when loading diff
 *  - Row click calls onRowClick
 *  - Checkbox click calls onToggleSelection
 *  - Diff button click calls onToggleDiff
 *  - Focus ring shown when isFocused is true
 *  - Selected state adds bg-accent class
 *  - Rich content rendering (ULID tokens resolved)
 *  - Property op display (set_property/delete_property formatted)
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ArrowRight,
  Circle,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BlockHistoryItemProps, HistoryListItemProps } from '../HistoryListItem'
import { BlockHistoryItem, HistoryListItem, opIcon } from '../HistoryListItem'

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) => (id === 'PAGE1' ? 'My Page' : undefined)),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn((id: string) => (id === 'TAG1' ? 'project' : undefined)),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

function makeEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = '2025-01-15T12:00:00Z',
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

function defaultProps(overrides: Partial<HistoryListItemProps> = {}): HistoryListItemProps {
  return {
    entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }),
    index: 0,
    isSelected: false,
    isFocused: false,
    isNonReversible: false,
    isExpanded: false,
    isLoadingDiff: false,
    diffSpans: undefined,
    onRowClick: vi.fn(),
    onToggleSelection: vi.fn(),
    onToggleDiff: vi.fn(),
    onRestoreToHere: vi.fn(),
    ...overrides,
  }
}

function renderInListbox(props: HistoryListItemProps) {
  return render(
    <div role="listbox" aria-label="History entries">
      <HistoryListItem {...props} />
    </div>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryListItem', () => {
  // -- Rendering different op types ------------------------------------------

  it('renders edit_block op type badge', () => {
    renderInListbox(defaultProps())

    expect(screen.getByText('edit_block')).toBeInTheDocument()
    const badge = screen.getByTestId('history-type-badge')
    expect(badge).toHaveTextContent('edit_block')
  })

  it('renders create_block op type badge', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'create_block', { content: 'New block' }),
      }),
    )

    expect(screen.getByText('create_block')).toBeInTheDocument()
  })

  it('renders delete_block op type badge', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'delete_block', { block_id: 'B1' }),
      }),
    )

    expect(screen.getByText('delete_block')).toBeInTheDocument()
  })

  it('renders purge_block op type badge', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    expect(screen.getByText('purge_block')).toBeInTheDocument()
  })

  // -- Payload preview -------------------------------------------------------

  it('renders payload preview for edit_block (to_text)', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'Updated content' }),
      }),
    )

    expect(screen.getByText('Updated content')).toBeInTheDocument()
  })

  it('renders payload preview for create_block (content)', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'create_block', { content: 'New block content' }),
      }),
    )

    expect(screen.getByText('New block content')).toBeInTheDocument()
  })

  it('does not render preview when payload has no preview-able fields', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'move_block', { target_id: 'T1' }),
      }),
    )

    // Should still render op type badge
    expect(screen.getByText('move_block')).toBeInTheDocument()
    // No preview text
    expect(screen.queryByText('T1')).not.toBeInTheDocument()
  })

  // -- Device ID -------------------------------------------------------------

  it('shows device_id truncated to first 8 chars', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(
          1,
          'edit_block',
          { to_text: 'content' },
          '2025-01-15T12:00:00Z',
          'ABCDEF1234567890',
        ),
      }),
    )

    expect(screen.getByText('dev:ABCDEF12')).toBeInTheDocument()
  })

  // -- Selection state -------------------------------------------------------

  it('checkbox is unchecked when not selected', () => {
    renderInListbox(defaultProps({ isSelected: false }))

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
  })

  it('checkbox is checked when selected', () => {
    renderInListbox(defaultProps({ isSelected: true }))

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('selected row has bg-accent class', () => {
    renderInListbox(defaultProps({ isSelected: true }))

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('bg-accent/50')
  })

  it('unselected row has bg-card class', () => {
    renderInListbox(defaultProps({ isSelected: false }))

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('bg-card')
  })

  // -- Non-reversible ops ----------------------------------------------------

  it('checkbox is disabled for non-reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeDisabled()
  })

  it('shows opacity-50 for non-reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('opacity-50')
  })

  it('shows lock icon for non-reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    expect(screen.getByLabelText('Non-reversible')).toBeInTheDocument()
  })

  it('does not show lock icon for reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
        isNonReversible: false,
      }),
    )

    expect(screen.queryByLabelText('Non-reversible')).not.toBeInTheDocument()
  })

  // -- Diff display ----------------------------------------------------------

  it('shows diff toggle button for edit_block entries', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
      }),
    )

    expect(screen.getByRole('button', { name: /Diff/ })).toBeInTheDocument()
  })

  it('does not show diff toggle button for non-edit_block entries', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'create_block', { content: 'new' }),
      }),
    )

    expect(screen.queryByRole('button', { name: /Diff/ })).not.toBeInTheDocument()
  })

  it('renders diff display when expanded with diff data', () => {
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Delete' as const, value: 'old' },
      { tag: 'Insert' as const, value: 'new' },
      { tag: 'Equal' as const, value: 'world' },
    ]

    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
        isExpanded: true,
        diffSpans,
      }),
    )

    // Diff container should be present
    expect(document.querySelector('.diff-container')).toBeInTheDocument()
    // Check diff content is displayed
    expect(screen.getByText('old')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument()
  })

  it('does not render diff display when not expanded', () => {
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Delete' as const, value: 'old' },
    ]

    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
        isExpanded: false,
        diffSpans,
      }),
    )

    // diff-container should not be present
    expect(document.querySelector('.diff-container')).not.toBeInTheDocument()
  })

  // -- Focus state -----------------------------------------------------------

  it('shows focus ring when isFocused is true', () => {
    renderInListbox(defaultProps({ isFocused: true }))

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('ring-2')
  })

  it('does not show focus ring when isFocused is false', () => {
    renderInListbox(defaultProps({ isFocused: false }))

    const item = screen.getByTestId('history-item-0')
    expect(item).not.toHaveClass('ring-2')
  })

  it('has tabIndex=0 when focused', () => {
    renderInListbox(defaultProps({ isFocused: true }))

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveAttribute('tabindex', '0')
  })

  it('has tabIndex=-1 when not focused', () => {
    renderInListbox(defaultProps({ isFocused: false }))

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveAttribute('tabindex', '-1')
  })

  // -- Interactions ----------------------------------------------------------

  it('calls onRowClick when row is clicked', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    renderInListbox(defaultProps({ onRowClick }))

    await user.click(screen.getByTestId('history-item-0'))
    expect(onRowClick).toHaveBeenCalledWith(0, expect.any(Object))
  })

  it('calls onToggleSelection when checkbox is clicked', async () => {
    const user = userEvent.setup()
    const onToggleSelection = vi.fn()
    renderInListbox(defaultProps({ onToggleSelection }))

    const checkbox = screen.getByRole('checkbox')
    await user.click(checkbox)
    expect(onToggleSelection).toHaveBeenCalledWith(0)
  })

  it('calls onToggleDiff when diff button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleDiff = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInListbox(defaultProps({ entry, onToggleDiff }))

    await user.click(screen.getByRole('button', { name: /Diff/ }))
    expect(onToggleDiff).toHaveBeenCalledWith(entry)
  })

  it('checkbox click does not propagate to row click', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onToggleSelection = vi.fn()
    renderInListbox(defaultProps({ onRowClick, onToggleSelection }))

    const checkbox = screen.getByRole('checkbox')
    await user.click(checkbox)

    // onToggleSelection should be called (from checkbox onChange)
    expect(onToggleSelection).toHaveBeenCalledWith(0)
    // onRowClick should NOT be called (stopPropagation)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('diff button click does not propagate to row click', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onToggleDiff = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInListbox(defaultProps({ entry, onRowClick, onToggleDiff }))

    await user.click(screen.getByRole('button', { name: /Diff/ }))

    expect(onToggleDiff).toHaveBeenCalled()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  // -- ARIA ------------------------------------------------------------------

  it('has role=option and aria-selected', () => {
    renderInListbox(defaultProps({ isSelected: true }))

    const item = screen.getByRole('option')
    expect(item).toHaveAttribute('aria-selected', 'true')
  })

  it('has aria-disabled for non-reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    const item = screen.getByRole('option')
    expect(item).toHaveAttribute('aria-disabled', 'true')
  })

  it('checkbox has accessible label with op type and seq', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(42, 'edit_block', { to_text: 'content' }),
      }),
    )

    expect(
      screen.getByRole('checkbox', { name: /Select operation edit_block #42/ }),
    ).toBeInTheDocument()
  })

  // -- a11y ------------------------------------------------------------------

  // Note: axe tests disable nested-interactive rule because the
  // role="option" items intentionally contain checkbox and button controls.
  // This matches the existing HistoryView pattern and is a known trade-off.
  const axeOpts = { rules: { 'nested-interactive': { enabled: false } } }

  it('has no a11y violations for a selected edit_block item', async () => {
    const { container } = renderInListbox(
      defaultProps({
        isSelected: true,
        isFocused: true,
      }),
    )

    await waitFor(async () => {
      const results = await axe(container, axeOpts)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations for a non-reversible item', async () => {
    const { container } = renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    await waitFor(async () => {
      const results = await axe(container, axeOpts)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with diff expanded', async () => {
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Insert' as const, value: 'world' },
    ]

    const { container } = renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
        isExpanded: true,
        diffSpans,
      }),
    )

    await waitFor(async () => {
      const results = await axe(container, axeOpts)
      expect(results).toHaveNoViolations()
    })
  })

  // -- Op type icons ---------------------------------------------------------

  describe('opIcon helper', () => {
    it.each([
      ['create_block', Plus],
      ['create_page', Plus],
      ['restore_block', RotateCcw],
      ['edit_block', Pencil],
      ['edit_heading', Pencil],
      ['delete_block', Trash2],
      ['purge_block', Trash2],
      ['move_block', ArrowRight],
      ['add_tag', Tag],
      ['remove_tag', Tag],
      ['set_property', Settings],
      ['delete_property', Settings],
      ['add_attachment', Paperclip],
      ['delete_attachment', Paperclip],
      ['unknown_op', Circle],
    ])('returns correct icon for %s', (opType, expectedIcon) => {
      expect(opIcon(opType)).toBe(expectedIcon)
    })
  })

  describe('op type badge icons', () => {
    it('renders an icon inside the badge with correct sizing classes', () => {
      renderInListbox(defaultProps())

      const badge = screen.getByTestId('history-type-badge')
      const svg = badge.querySelector('svg')
      expect(svg).toBeInTheDocument()
      expect(svg).toHaveClass('h-3', 'w-3', 'mr-1')
    })

    it.each([
      ['create_block', { content: 'New block' }],
      ['restore_block', { block_id: 'B1' }],
      ['edit_block', { to_text: 'content' }],
      ['delete_block', { block_id: 'B1' }],
      ['purge_block', { block_id: 'B1' }],
      ['move_block', { target_id: 'T1' }],
      ['add_tag', { tag: 'todo' }],
      ['remove_tag', { tag: 'todo' }],
      ['set_property', { key: 'k', value: 'v' }],
      ['delete_property', { key: 'k' }],
      ['add_attachment', { name: 'f.txt' }],
      ['delete_attachment', { name: 'f.txt' }],
      ['unknown_op', {}],
    ] as const)('renders an icon in badge for %s', (opType, payload) => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, opType, payload as Record<string, unknown>),
        }),
      )

      const badge = screen.getByTestId('history-type-badge')
      const svg = badge.querySelector('svg')
      expect(svg).toBeInTheDocument()
      expect(svg).toHaveClass('h-3', 'w-3', 'mr-1')
    })
  })

  describe('restore to here button', () => {
    it('renders restore button for reversible ops', () => {
      renderInListbox(defaultProps())
      expect(screen.getByRole('button', { name: /restore to this point/i })).toBeInTheDocument()
    })

    it('does not render restore button for non-reversible ops', () => {
      renderInListbox(defaultProps({ isNonReversible: true }))
      expect(
        screen.queryByRole('button', { name: /restore to this point/i }),
      ).not.toBeInTheDocument()
    })

    it('calls onRestoreToHere when clicked', async () => {
      const user = userEvent.setup()
      const onRestoreToHere = vi.fn()
      renderInListbox(defaultProps({ onRestoreToHere }))
      await user.click(screen.getByRole('button', { name: /restore to this point/i }))
      expect(onRestoreToHere).toHaveBeenCalledWith(defaultProps().entry)
    })

    it('stops event propagation on click', async () => {
      const user = userEvent.setup()
      const onRowClick = vi.fn()
      renderInListbox(defaultProps({ onRowClick }))
      await user.click(screen.getByRole('button', { name: /restore to this point/i }))
      expect(onRowClick).not.toHaveBeenCalled()
    })
  })

  // -- Rich content rendering (B-45) ----------------------------------------

  describe('rich content rendering', () => {
    it('renders preview with line-clamp-2 instead of truncate', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }),
        }),
      )

      const preview = screen.getByText('Hello world').closest('.history-item-preview')
      expect(preview).toHaveClass('line-clamp-2')
    })

    it('renders long content without string truncation', () => {
      const longText = 'A'.repeat(200)
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'edit_block', { to_text: longText }),
        }),
      )

      // Full text present (CSS handles truncation)
      expect(screen.getByText(longText)).toBeInTheDocument()
    })
  })

  // -- Property op display (UX-134) -----------------------------------------

  describe('property op display', () => {
    it('renders set_property with formatted name and value', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'set_property', { key: 'due_date', value: '2026-04-15' }),
        }),
      )

      expect(screen.getByText(/Due Date/)).toBeInTheDocument()
      expect(screen.getByText(/2026-04-15/)).toBeInTheDocument()
    })

    it('renders delete_property with formatted name only', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'delete_property', { key: 'due_date' }),
        }),
      )

      expect(screen.getByText('Due Date')).toBeInTheDocument()
      // No arrow/value
      expect(screen.queryByText(/→/)).not.toBeInTheDocument()
    })

    it('falls back to raw content when property payload is invalid', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'set_property', { content: 'some text' }),
        }),
      )

      // Should render content through renderRichContent
      expect(screen.getByText('some text')).toBeInTheDocument()
    })
  })
})

describe('BlockHistoryItem', () => {
  function makeEntry(
    seq: number,
    opType: string,
    payload: Record<string, unknown>,
    createdAt = '2025-01-15T12:00:00Z',
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

  function blockDefaultProps(
    overrides: Partial<BlockHistoryItemProps> = {},
  ): BlockHistoryItemProps {
    return {
      entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }),
      index: 0,
      isExpanded: false,
      isLoadingDiff: false,
      diffSpans: undefined,
      onToggleDiff: vi.fn(),
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

  it('renders edit_block entry with semantic badge', () => {
    renderInList(blockDefaultProps())
    const badge = screen.getByTestId('history-type-badge')
    expect(badge).toHaveTextContent('edit_block')
  })

  it('renders as a <li> element', () => {
    renderInList(blockDefaultProps())
    expect(screen.getByTestId('block-history-item-0').tagName).toBe('LI')
  })

  it('uses compact layout without card borders', () => {
    renderInList(blockDefaultProps())
    const li = screen.getByTestId('block-history-item-0')
    expect(li).toHaveClass('border-b')
    expect(li).not.toHaveClass('rounded-lg')
  })

  it('shows restore button only for edit_block with rawContent', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'edit_block', { to_text: 'content' }) }))
    expect(screen.getByRole('button', { name: /restore to this point/i })).toBeInTheDocument()
  })

  it('does not show restore button for edit_block without rawContent', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'edit_block', { some_field: 'val' }) }))
    expect(screen.queryByRole('button', { name: /restore to this point/i })).not.toBeInTheDocument()
  })

  it('does not show restore button for create_block', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'create_block', { content: 'new' }) }))
    expect(screen.queryByRole('button', { name: /restore to this point/i })).not.toBeInTheDocument()
  })

  it('does not show restore button for delete_block', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'delete_block', { block_id: 'B1' }) }))
    expect(screen.queryByRole('button', { name: /restore to this point/i })).not.toBeInTheDocument()
  })

  it('calls onRestore when restore button is clicked', async () => {
    const user = userEvent.setup()
    const onRestore = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInList(blockDefaultProps({ entry, onRestore }))
    await user.click(screen.getByRole('button', { name: /restore to this point/i }))
    expect(onRestore).toHaveBeenCalledWith(entry)
  })

  it('shows diff toggle for edit_block entries', () => {
    renderInList(blockDefaultProps())
    expect(screen.getByRole('button', { name: /Diff/ })).toBeInTheDocument()
  })

  it('does not show diff toggle for non-edit_block', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'create_block', { content: 'new' }) }))
    expect(screen.queryByRole('button', { name: /Diff/ })).not.toBeInTheDocument()
  })

  it('calls onToggleDiff when diff button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleDiff = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInList(blockDefaultProps({ entry, onToggleDiff }))
    await user.click(screen.getByRole('button', { name: /Diff/ }))
    expect(onToggleDiff).toHaveBeenCalledWith(entry)
  })

  it('renders diff display when expanded', () => {
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Delete' as const, value: 'old' },
      { tag: 'Insert' as const, value: 'new' },
    ]
    renderInList(blockDefaultProps({ isExpanded: true, diffSpans }))
    expect(document.querySelector('.diff-container')).toBeInTheDocument()
  })

  it('does not render diff display when not expanded', () => {
    const diffSpans = [{ tag: 'Equal' as const, value: 'Hello' }]
    renderInList(blockDefaultProps({ isExpanded: false, diffSpans }))
    expect(document.querySelector('.diff-container')).not.toBeInTheDocument()
  })

  it('shows device_id with full opacity (not /60)', () => {
    renderInList(blockDefaultProps())
    const deviceEl = screen.getByText('dev:DEVICE01')
    expect(deviceEl).toHaveClass('text-muted-foreground')
    expect(deviceEl.className).not.toContain('/60')
  })

  it('renders relative timestamp', () => {
    renderInList(blockDefaultProps())
    // formatTimestamp with 'relative' is called — check the time element exists
    const timeEl = document.querySelector('.history-item-time')
    expect(timeEl).toBeInTheDocument()
  })

  it('renders content preview with line-clamp-2', () => {
    renderInList(
      blockDefaultProps({ entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }) }),
    )
    const preview = screen.getByText('Hello world').closest('.history-item-preview')
    expect(preview).toHaveClass('line-clamp-2')
  })

  it('renders property payload display', () => {
    renderInList(
      blockDefaultProps({
        entry: makeEntry(1, 'set_property', { key: 'due_date', value: '2026-04-15' }),
      }),
    )
    expect(screen.getByText(/Due Date/)).toBeInTheDocument()
    expect(screen.getByText(/2026-04-15/)).toBeInTheDocument()
  })

  it('does not render checkbox (no selection in block history)', () => {
    renderInList(blockDefaultProps())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = renderInList(blockDefaultProps())
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with diff expanded', async () => {
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Insert' as const, value: 'world' },
    ]
    const { container } = renderInList(blockDefaultProps({ isExpanded: true, diffSpans }))
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
