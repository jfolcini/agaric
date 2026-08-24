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
 *       (colour-blind-safe) cue — a SOLID caret glyph in place of the outline
 *       chevron. It used to be a boxed plate (bg + ring) around the caret;
 *       that read as stray chrome on a phone and was replaced by the glyph
 *       swap, which is a shape difference rather than a colour-only one.
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
import '@/lib/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'

// lib/tauri is imported transitively (BlockListItem → useBlockReschedule);
// stub the IPC surface so the module loads under happy-dom.
vi.mock('@/lib/tauri', () => ({
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
import { BlockCollapseControl } from '@/components/editor/BlockInlineControls'
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

  // #1968: on touch the drag activator moved off the gutter onto the leading
  // chevron / leaf bullet (BlockCollapseControl). It still exposes the reorder
  // keyshortcuts so AT users can move blocks without the gesture.
  it('exposes aria-keyshortcuts on the touch drag activator (BlockCollapseControl)', () => {
    setCoarse(true)
    renderWithTooltip(
      <BlockCollapseControl blockId="b1" hasChildren={false} isCollapsed={false} isTouch />,
    )
    expect(screen.getByTestId('drag-handle')).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Shift+ArrowUp Control+Shift+ArrowDown',
    )
  })
})

// #1968: the collapse chevron (and its colour-blind cue) moved out of
// BlockInlineControls into the gutter lane as `BlockCollapseControl`.
describe('#216 C4 — colour-blind collapse cue (BlockCollapseControl)', () => {
  const baseProps = {
    blockId: 'b1',
    hasChildren: true,
    isCollapsed: false,
    isTouch: false,
    onToggleCollapse: vi.fn(),
  }

  /** The rendered glyph inside the toggle button. */
  function glyphOf(toggle: HTMLElement): SVGElement {
    const svg = toggle.querySelector('svg')
    expect(svg).not.toBeNull()
    return svg as SVGElement
  }

  it('carries the collapsed state on a SHAPE cue: the glyph goes solid', () => {
    renderWithTooltip(
      <BlockCollapseControl {...baseProps} isCollapsed onToggleCollapse={vi.fn()} />,
    )
    const toggle = screen.getByTestId('collapse-toggle')
    expect(toggle).toHaveAttribute('data-collapsed', 'true')
    // The cue is the glyph itself — a solid caret, not the outline chevron.
    const glyph = glyphOf(toggle)
    expect(glyph).toHaveAttribute('data-solid', 'true')
    expect(glyph.getAttribute('class') ?? '').toContain('fill-current')
    // …and it is NOT the rotation: the collapsed glyph never rotates.
    expect(glyph.getAttribute('class') ?? '').not.toContain('rotate-90')
    // Colour reinforces the shape (weaker on its own, so it is not the cue).
    expect(toggle.className).toMatch(/text-foreground/)
  })

  it('does not show the cue when expanded (outline chevron, no fill)', () => {
    renderWithTooltip(
      <BlockCollapseControl {...baseProps} isCollapsed={false} onToggleCollapse={vi.fn()} />,
    )
    const toggle = screen.getByTestId('collapse-toggle')
    expect(toggle).toHaveAttribute('data-collapsed', 'false')
    const glyph = glyphOf(toggle)
    expect(glyph).not.toHaveAttribute('data-solid')
    expect(glyph.getAttribute('class') ?? '').not.toContain('fill-current')
  })

  // The reporter's complaint (mobile): the collapsed caret grew a box. The cue
  // must never come back as a plate — no ring, no border, no filled background
  // on the button itself.
  it('draws no box, border or background plate around the collapsed caret', () => {
    renderWithTooltip(
      <BlockCollapseControl {...baseProps} isCollapsed onToggleCollapse={vi.fn()} />,
    )
    const toggle = screen.getByTestId('collapse-toggle')
    // (`focus-ring-visible` is the keyboard focus indicator, not a plate —
    // it only paints while focus-visible, so it is deliberately allowed.)
    expect(toggle.className).not.toMatch(/\bring-\d/)
    expect(toggle.className).not.toMatch(/ring-border/)
    expect(toggle.className).not.toMatch(/\bborder\b/)
    expect(toggle.className).not.toMatch(/\bbg-/)
  })
})

describe('#216 — axe accessibility checks', () => {
  it('gutter controls have no axe violations', async () => {
    setCoarse(false)
    const { container } = renderWithTooltip(<BlockGutterControls blockId="b1" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
