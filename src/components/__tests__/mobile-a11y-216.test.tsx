/**
 * Issue #216 — mobile & accessibility regression tests (items A, B, C4).
 *
 *   A: the inline due-date editor (BlockListItem → DueDateChip) and the
 *      add-property picker (AddPropertyPopover) render as a bottom Sheet on
 *      coarse pointers and as an anchored Popover on fine pointers.
 *   B (drag handle): BlockGutterControls' drag handle exposes aria-keyshortcuts
 *      + an accessible name. (The swipe-row aria-description is covered in
 *      SortableBlock.test.tsx where the full mock surface already exists.)
 *   C4: the collapsed chevron (BlockInlineControls) carries a non-rotation
 *       (colour-blind-safe) cue.
 *
 * C1–C3 shipped in #279; C5/C6 skipped per the maintainer decision.
 *
 * Coarse-pointer detection (useIsTouch → matchMedia '(pointer: coarse)') is
 * driven by overriding `window.matchMedia` per the established pattern used in
 * BlockGutterControls.test.tsx / SortableBlock.test.tsx.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Side-effect import: src/test-setup.ts already initialises i18next, but make
// the dependency explicit so `useTranslation()` resolves real English strings
// (aria-labels / aria-keyshortcuts) rather than dropping the attributes.
import '../../lib/i18n'
import { TooltipProvider } from '../ui/tooltip'

// lib/tauri is imported transitively (BlockListItem → useBlockReschedule);
// stub the IPC surface so the module loads under happy-dom.
vi.mock('../../lib/tauri', () => ({
  getBlock: vi.fn(),
  setDueDate: vi.fn(),
  setScheduledDate: vi.fn(),
  reschedule: vi.fn(),
}))

// DateChipEditor pulls in tauri-backed reschedule hooks; stub it to a sentinel
// so the date-chip surface tests focus on the Sheet-vs-Popover wrapper.
vi.mock('@/components/properties/DateChipEditor', () => ({
  DateChipEditor: () => <div data-testid="date-chip-editor-stub" />,
}))

import { BlockGutterControls } from '@/components/editor/BlockGutterControls'
import { BlockInlineControls } from '@/components/editor/BlockInlineControls'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { AddPropertyPopover } from '@/components/properties/AddPropertyPopover'

/** Override window.matchMedia so `(pointer: coarse)` reports the given value. */
function setCoarse(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: coarse && query.includes('coarse'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  // #1236: useIsTouch() now requires real touch hardware
  // (navigator.maxTouchPoints > 0) alongside a coarse pointer. The afterEach
  // calls setCoarse(false), which resets this back to the desktop default (0).
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: coarse ? 5 : 0,
    writable: true,
    configurable: true,
  })
}

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

afterEach(() => {
  // Restore the shared fine-pointer default from src/test-setup.ts.
  setCoarse(false)
})

// Radix Popover/Sheet triggers toggle on pointerdown; userEvent's synthetic
// pointer events don't open them reliably under happy-dom, so use fireEvent.

describe('#216 A — keyboard-aware due-date chip (BlockListItem)', () => {
  function renderChip() {
    return render(
      <ul>
        <BlockListItem content="Task" blockId="b1" dueDate="2026-01-15" testId="row" />
      </ul>,
    )
  }

  it('renders the editor in a Popover on fine pointers', () => {
    setCoarse(false)
    renderChip()
    fireEvent.click(screen.getByLabelText('Edit date'))
    expect(screen.getByTestId('due-date-popover')).toBeInTheDocument()
    expect(screen.queryByTestId('due-date-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('date-chip-editor-stub')).toBeInTheDocument()
  })

  it('renders the editor in a bottom Sheet on coarse pointers', () => {
    setCoarse(true)
    renderChip()
    fireEvent.click(screen.getByLabelText('Edit date'))
    expect(screen.getByTestId('due-date-sheet')).toBeInTheDocument()
    expect(screen.queryByTestId('due-date-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('date-chip-editor-stub')).toBeInTheDocument()
  })
})

describe('#216 A — keyboard-aware add-property picker', () => {
  const defs = [{ key: 'status', value_type: 'text' }] as never

  // Drive the surface via the controlled `open` prop: Radix Dialog/Popover
  // triggers don't toggle on a synthetic `fireEvent.click` under happy-dom
  // (they listen on pointerdown), so opening through the controlled API is the
  // reliable way to assert which branch (Sheet vs Popover) renders.
  it('renders the picker in a Popover on fine pointers', () => {
    setCoarse(false)
    renderWithTooltip(
      <AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />,
    )
    expect(screen.queryByTestId('add-property-sheet')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
  })

  it('renders the picker in a bottom Sheet on coarse pointers', () => {
    setCoarse(true)
    renderWithTooltip(
      <AddPropertyPopover definitions={defs} onAdd={vi.fn()} open onOpenChange={vi.fn()} />,
    )
    expect(screen.getByTestId('add-property-sheet')).toBeInTheDocument()
    expect(screen.getByLabelText('Search definitions')).toBeInTheDocument()
  })
})

describe('#216 B — drag handle a11y (BlockGutterControls)', () => {
  it('exposes aria-keyshortcuts and an accessible name', () => {
    setCoarse(false)
    renderWithTooltip(<BlockGutterControls blockId="b1" />)
    const handle = screen.getByTestId('drag-handle')
    expect(handle).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Shift+ArrowUp Control+Shift+ArrowDown',
    )
    expect(handle.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0)
  })

  it('exposes aria-keyshortcuts on the touch drag handle too', () => {
    setCoarse(true)
    renderWithTooltip(<BlockGutterControls blockId="b1" />)
    expect(screen.getByTestId('drag-handle')).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Shift+ArrowUp Control+Shift+ArrowDown',
    )
  })
})

describe('#216 C4 — colour-blind collapse cue (BlockInlineControls)', () => {
  const baseProps = {
    blockId: 'b1',
    hasChildren: true,
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
    todoState: null,
    onToggleTodo: vi.fn(),
  }

  it('adds a non-rotation cue when collapsed', () => {
    renderWithTooltip(<BlockInlineControls {...baseProps} isCollapsed onToggleCollapse={vi.fn()} />)
    const toggle = screen.getByTestId('collapse-toggle')
    expect(toggle).toHaveAttribute('data-collapsed', 'true')
    expect(toggle.className).toMatch(/bg-muted/)
    expect(toggle.className).toMatch(/ring-1/)
  })

  it('does not show the cue when expanded', () => {
    renderWithTooltip(
      <BlockInlineControls {...baseProps} isCollapsed={false} onToggleCollapse={vi.fn()} />,
    )
    const toggle = screen.getByTestId('collapse-toggle')
    expect(toggle).toHaveAttribute('data-collapsed', 'false')
    expect(toggle.className).not.toMatch(/ring-1/)
  })
})

describe('#216 — axe accessibility checks', () => {
  it('gutter controls have no axe violations', async () => {
    setCoarse(false)
    const { container } = renderWithTooltip(<BlockGutterControls blockId="b1" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
