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

import { invoke } from '@tauri-apps/api/core'
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
    <div role="grid" aria-label="History entries">
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

    // UX-351: the visible text label is the accessible name; the Lock svg
    // is decorative (aria-hidden) but still present alongside the text.
    expect(screen.getByText(/Non-reversible/)).toBeInTheDocument()
  })

  it('does not show lock icon for reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
        isNonReversible: false,
      }),
    )

    expect(screen.queryByText(/Non-reversible/)).not.toBeInTheDocument()
  })

  // -- UX-351: visible "Non-reversible" text label + opacity-50 multi-cue ----
  // Pins the WCAG-compliant multi-cue contract: visible text label is the
  // primary accessible signal and opacity-50 is retained as a secondary
  // visual cue. Both must coexist for non-reversible rows.
  describe('UX-351 non-reversible visible label', () => {
    it('renders the visible "Non-reversible" text label when isNonReversible=true', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
          isNonReversible: true,
        }),
      )

      // Visible text — not just an aria-label — so sighted users get the
      // textual cue alongside the (decorative) Lock icon.
      expect(screen.getByText('Non-reversible action')).toBeInTheDocument()
    })

    it('does not render the "Non-reversible" text label when isNonReversible=false', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'edit_block', { to_text: 'content' }),
          isNonReversible: false,
        }),
      )

      expect(screen.queryByText('Non-reversible action')).not.toBeInTheDocument()
    })

    it('retains opacity-50 on non-reversible rows alongside the visible label (multi-cue)', () => {
      renderInListbox(
        defaultProps({
          entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
          isNonReversible: true,
        }),
      )

      // Regression guard: the visible text label is additive, not a
      // replacement for the opacity cue. Both signals must coexist.
      const item = screen.getByTestId('history-item-0')
      expect(item).toHaveClass('opacity-50')
      expect(screen.getByText('Non-reversible action')).toBeInTheDocument()
    })
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

  it('has role=row and aria-selected', () => {
    renderInListbox(defaultProps({ isSelected: true }))

    const item = screen.getByRole('row')
    expect(item).toHaveAttribute('aria-selected', 'true')
  })

  it('has aria-disabled for non-reversible ops', () => {
    renderInListbox(
      defaultProps({
        entry: makeEntry(1, 'purge_block', { block_id: 'B1' }),
        isNonReversible: true,
      }),
    )

    const item = screen.getByRole('row')
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

  // role="row" inside role="grid" permits nested interactive widgets
  // (checkbox + buttons) per the WAI-ARIA APG Grid pattern, so axe runs
  // with no rule overrides.

  it('has no a11y violations for a selected edit_block item', async () => {
    const { container } = renderInListbox(
      defaultProps({
        isSelected: true,
        isFocused: true,
      }),
    )

    await waitFor(async () => {
      const results = await axe(container)
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
      const results = await axe(container)
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
      const results = await axe(container)
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
      expect(screen.getByRole('button', { name: /reset to this point/i })).toBeInTheDocument()
    })

    it('does not render restore button for non-reversible ops', () => {
      renderInListbox(defaultProps({ isNonReversible: true }))
      expect(screen.queryByRole('button', { name: /reset to this point/i })).not.toBeInTheDocument()
    })

    it('calls onRestoreToHere when clicked', async () => {
      const user = userEvent.setup()
      const onRestoreToHere = vi.fn()
      renderInListbox(defaultProps({ onRestoreToHere }))
      await user.click(screen.getByRole('button', { name: /reset to this point/i }))
      expect(onRestoreToHere).toHaveBeenCalledWith(defaultProps().entry)
    })

    it('stops event propagation on click', async () => {
      const user = userEvent.setup()
      const onRowClick = vi.fn()
      renderInListbox(defaultProps({ onRowClick }))
      await user.click(screen.getByRole('button', { name: /reset to this point/i }))
      expect(onRowClick).not.toHaveBeenCalled()
    })

    // -- UX-275 sub-fix 6: visible label on touch ----------------------------
    it('renders a touch-only label next to the restore icon', () => {
      renderInListbox(defaultProps())
      const label = screen.getByTestId('restore-to-here-touch-label')
      // Label is in the DOM but visually hidden on pointer:fine devices.
      expect(label).toBeInTheDocument()
      expect(label.className).toContain('hidden')
      expect(label.className).toContain('[@media(pointer:coarse)]:inline')
      // aria-hidden so SRs read aria-label, not the visible+aria-label duplicate.
      expect(label).toHaveAttribute('aria-hidden', 'true')
    })

    it('does not render the touch label for non-reversible ops', () => {
      renderInListbox(defaultProps({ isNonReversible: true }))
      expect(screen.queryByTestId('restore-to-here-touch-label')).not.toBeInTheDocument()
    })

    // -- UX-345: disambiguate point-in-time reset from per-entry revert ------
    // Pins the new copy so the label/touch-label/tooltip stay distinct from
    // the per-entry "Revert" action and don't drift back to "Restore". The
    // tooltip body lives inside Radix's portal and only mounts on
    // hover/focus, so trigger pointer hover before asserting the tooltip text.
    it('uses the disambiguated "Reset" copy for label, touch label, and tooltip', async () => {
      const user = userEvent.setup()
      renderInListbox(defaultProps())
      const button = screen.getByRole('button', { name: 'Reset to this point' })
      // aria-label distinguishes this point-in-time action from per-entry Revert.
      expect(button).toBeInTheDocument()
      // Touch-only visible label is the short "Reset" form.
      expect(screen.getByTestId('restore-to-here-touch-label')).toHaveTextContent('Reset')
      // Tooltip text disambiguates from the per-entry Revert action. Radix
      // mirrors the body into a sr-only `role="tooltip"` node, so multiple
      // matches are expected — assert at least one carries the new copy.
      await user.hover(button)
      const tooltipMatches = await screen.findAllByText(
        /Undoes every operation after this point — use the per-entry Revert action for individual entries\./,
      )
      expect(tooltipMatches.length).toBeGreaterThan(0)
    })
  })

  // -- UX-275 sub-fix 5: visible focus-ring on the checkbox ------------------
  describe('UX-275 checkbox focus styling', () => {
    it('checkbox carries visible focus-ring utilities', () => {
      renderInListbox(defaultProps())
      const checkbox = screen.getByRole('checkbox')
      // focus-ring-visible utility is present so keyboard focus is surfaced.
      expect(checkbox.className).toContain('focus-ring-visible')
    })

    it('checkbox click still toggles selection without triggering row click', async () => {
      // Regression guard: visible focus-ring must not break the existing
      // dual interaction contract (checkbox onChange + row onClick coexist
      // because checkbox onClick stopPropagation is intact).
      const user = userEvent.setup()
      const onRowClick = vi.fn()
      const onToggleSelection = vi.fn()
      renderInListbox(defaultProps({ onRowClick, onToggleSelection }))

      await user.click(screen.getByRole('checkbox'))

      expect(onToggleSelection).toHaveBeenCalledWith(0)
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

// ===========================================================================
// BlockHistoryItem (PEND-17 Part B redesign)
// ===========================================================================
//
// The component changed shape:
//   - Whole row is the click target (no per-row Diff / Reset buttons).
//   - Expanded panel has: primary "Restore this version" button, a
//     read-only RichContentRenderer preview, and a ToggleGroup
//     switching between "Just this change" / "Compared to current"
//     (default: comparedToCurrent).
//   - In-panel Restore is dialog-free; the parent's toast-with-Undo
//     is the safety net.
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

  it('does not render the legacy Reset / Diff per-row buttons', () => {
    // PEND-17 Part B: those affordances were folded into the expanded
    // panel (Restore button) and the row click (expansion). Their
    // presence would mean the redesign regressed to the dual-button
    // layout.
    renderInList(blockDefaultProps())
    expect(screen.queryByRole('button', { name: /reset to this point/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff$/ })).not.toBeInTheDocument()
  })

  it('exposes the row as an expandable button when restorable', () => {
    renderInList(blockDefaultProps())
    const trigger = screen.getByRole('button', { expanded: false })
    expect(trigger).toBeInTheDocument()
  })

  it('does not expose the row as a button for non-edit_block entries', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'create_block', { content: 'new' }) }))
    // No `aria-expanded` button means the row is non-restorable; only
    // the parent <ul> remains in the a11y tree.
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument()
  })

  it('shows lock affordance + non-reversible label on non-restorable rows (MAINT-220)', () => {
    // Non-edit_block ops are non-restorable. Without a visible cue, the
    // user has no explanation for why the row doesn't respond to clicks.
    // The lock affordance + visible label mirrors the legacy
    // `HistoryListItem` rendering at lines ~330-344.
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'create_block', { content: 'new' }) }))
    expect(screen.getByText('Non-reversible action')).toBeInTheDocument()
  })

  // block-history-sheet-fix-2026-05-14: the non-restorable branch wraps
  // the metadata core + the lock chip in a `flex flex-col` container so
  // the chip drops onto its own line below the timestamp/device-id strip
  // instead of competing for horizontal width. Every `create_block` row
  // is non-restorable, so this was the single largest contributor to
  // "crowded row" in the narrow Sheet.
  it('non-restorable rows render the lock chip in a `flex-col` wrapper, not inline with the metadata', () => {
    renderInList(blockDefaultProps({ entry: makeEntry(1, 'create_block', { content: 'new' }) }))
    const lockLabel = screen.getByText('Non-reversible action')
    const wrapper = lockLabel.closest('[data-testid="block-history-row-0"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('flex', 'flex-col', 'items-start')
    expect(wrapper).not.toHaveClass('items-center')
  })

  it('does not show the lock affordance on restorable rows', () => {
    // Restorable rows shouldn't carry the "non-reversible" label —
    // that would be visually misleading (these rows DO respond to
    // clicks).
    renderInList(blockDefaultProps())
    expect(screen.queryByText('Non-reversible action')).not.toBeInTheDocument()
  })

  it('row click calls onExpandToggle(entry, true) when collapsed', async () => {
    const user = userEvent.setup()
    const onExpandToggle = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInList(blockDefaultProps({ entry, onExpandToggle }))
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(onExpandToggle).toHaveBeenCalledWith(entry, true)
  })

  it('row click calls onExpandToggle(entry, false) when already expanded', async () => {
    const user = userEvent.setup()
    const onExpandToggle = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'content' })
    renderInList(blockDefaultProps({ entry, isExpanded: true, onExpandToggle }))
    // Click on the row header (the aria-expanded button) — clicks
    // inside the panel itself shouldn't double-toggle (regression
    // guard for the closest('[data-history-panel-content]') check).
    await user.click(screen.getByRole('button', { expanded: true }))
    expect(onExpandToggle).toHaveBeenCalledWith(entry, false)
  })

  it('renders the expanded panel only when isExpanded=true', () => {
    const { rerender } = renderInList(blockDefaultProps({ isExpanded: false }))
    expect(screen.queryByTestId('block-history-panel-0')).not.toBeInTheDocument()
    rerender(
      <ul aria-label="Block history">
        <BlockHistoryItem {...blockDefaultProps({ isExpanded: true })} />
      </ul>,
    )
    expect(screen.getByTestId('block-history-panel-0')).toBeInTheDocument()
  })

  it('expanded panel shows the primary "Restore this version" button at the top', () => {
    renderInList(blockDefaultProps({ isExpanded: true }))
    const btn = screen.getByTestId('block-history-restore-0')
    expect(btn).toHaveTextContent(/Restore this version/i)
  })

  it('clicking "Restore this version" triggers onRestore directly (no ConfirmDialog)', async () => {
    const user = userEvent.setup()
    const onRestore = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'historical' })
    renderInList(blockDefaultProps({ entry, isExpanded: true, onRestore }))
    await user.click(screen.getByTestId('block-history-restore-0'))
    expect(onRestore).toHaveBeenCalledWith(entry)
    // Hard regression guard: the restore must NOT open a confirmation
    // dialog from this component (the parent's toast-with-Undo is the
    // safety net).
    expect(screen.queryByText(/Restore to this version\?/i)).not.toBeInTheDocument()
  })

  it('expanded panel renders the historical content preview', () => {
    renderInList(
      blockDefaultProps({
        entry: makeEntry(1, 'edit_block', { to_text: 'historical content' }),
        isExpanded: true,
      }),
    )
    const preview = screen.getByTestId('block-history-preview-0')
    expect(preview).toHaveTextContent('historical content')
  })

  it('default diff mode in the panel is "Compared to current"', () => {
    renderInList(blockDefaultProps({ isExpanded: true }))
    // Radix ToggleGroup type="single" exposes the active item via
    // `data-state="on"`. Asserting on this is more stable than role
    // probing because Radix maps single-mode items to role="radio"
    // (not aria-pressed) — see @radix-ui/react-toggle-group.
    const currentBtn = screen.getByTestId('block-history-diff-mode-current-0')
    const justBtn = screen.getByTestId('block-history-diff-mode-just-0')
    expect(currentBtn).toHaveAttribute('data-state', 'on')
    expect(justBtn).toHaveAttribute('data-state', 'off')
  })

  it('clicking "Just this change" switches to the single-step diff', async () => {
    const user = userEvent.setup()
    const diffSpans = [
      { tag: 'Equal' as const, value: 'Hello' },
      { tag: 'Insert' as const, value: ' world' },
    ]
    renderInList(blockDefaultProps({ isExpanded: true, diffSpans }))
    await user.click(screen.getByTestId('block-history-diff-mode-just-0'))
    expect(screen.getByTestId('block-history-diff-mode-just-0')).toHaveAttribute('data-state', 'on')
    // The single-step diff data is now what's rendered.
    expect(document.querySelector('.diff-container')).toBeInTheDocument()
  })

  it('flips Insert/Delete spans in comparedToCurrent mode so colours match restore intent (MAINT-217)', async () => {
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === 'compute_block_vs_current_diff') {
        return Promise.resolve([
          { tag: 'Insert', value: 'added since historical' },
          { tag: 'Delete', value: 'removed since historical' },
        ])
      }
      return Promise.resolve(null)
    })

    renderInList(blockDefaultProps({ isExpanded: true }))
    await waitFor(() => {
      const del = document.querySelector('del')
      const ins = document.querySelector('ins')
      // Backend Insert (added since historical) → rendered as Delete (red, would be removed on restore)
      expect(del).not.toBeNull()
      expect(del?.textContent).toBe('added since historical')
      // Backend Delete (removed since historical) → rendered as Insert (green, would be restored)
      expect(ins).not.toBeNull()
      expect(ins?.textContent).toBe('removed since historical')
    })
  })

  it('shows device_id with full opacity (not /60)', () => {
    renderInList(blockDefaultProps())
    const deviceEl = screen.getByText('dev:DEVICE01')
    expect(deviceEl).toHaveClass('text-muted-foreground')
    expect(deviceEl.className).not.toContain('/60')
  })

  it('renders relative timestamp', () => {
    renderInList(blockDefaultProps())
    const timeEl = document.querySelector('.history-item-time')
    expect(timeEl).toBeInTheDocument()
  })

  it('renders content preview with line-clamp-2 in collapsed state', () => {
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

  it('has no a11y violations collapsed', async () => {
    const { container } = renderInList(blockDefaultProps())
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations expanded', async () => {
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
