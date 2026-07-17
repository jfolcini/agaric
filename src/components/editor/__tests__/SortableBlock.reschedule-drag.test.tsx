// @vitest-environment jsdom
// The dragStart assertion relies on `fireEvent.dragStart(el, { dataTransfer })`
// passing the test's dataTransfer reference through to the component. jsdom
// honours this; happy-dom's DragEvent constructor reconstructs a fresh
// DataTransfer and discards the test's object, so component mutations never
// surface back (see BlockListItem.test.tsx, which forces jsdom for the same
// reason). The rest of this repo's SortableBlock tests run under the
// project-default happy-dom environment, so this drag-specific coverage
// lives in its own file rather than flipping the environment for the whole
// (5000+ line) SortableBlock.test.tsx.

/**
 * Tests for SortableBlock's reschedule-by-drag row (#2770, F-32).
 *
 * `RescheduleDropZone` (#2708) has accepted a native HTML5
 * `application/x-block-reschedule` drag payload since it shipped, but
 * nothing in the app ever SET that payload from a reachable row — agenda's
 * `BlockListItem` sets it, but agenda panels never co-render with the drop
 * zone (daily/agenda-mode only vs. weekly-mode only). WeeklyView renders its
 * per-day blocks through this SAME `SortableBlock` row (shared with
 * DailyView / the page editor), so this row must become the drag source —
 * but ONLY inside `WeeklyView`'s `RescheduleDragSourceProvider`, and it must
 * not interfere with dnd-kit's own pointer-based reorder drag on the grip
 * handle.
 *
 * Validates:
 *  1. Outside any provider (DailyView / page-editor context): the row is not
 *     a native drag source at all.
 *  2. Inside `RescheduleDragSourceProvider`: the row is draggable and
 *     `dragstart` sets the reschedule MIME type + blockId, `effectAllowed
 *     = 'move'`.
 *  3. The grip (dnd-kit reorder) handle is explicitly `draggable={false}`
 *     regardless of context, so native drag can never hijack a press that
 *     starts on it.
 *  4. Touch devices never become a native drag source, even inside the
 *     provider (native HTML5 DnD is desktop-only; touch already owns a
 *     separate gesture vocabulary on this row).
 *  5. A11y: no new violations when the row is a drag source.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock @dnd-kit/sortable to control sortable state (mirrors SortableBlock.test.tsx)
const mockUseSortable = vi.fn()
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: (...args: unknown[]) => mockUseSortable(...args),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}))

// Mock EditableBlock — keep the test focused on the row/handle, not TipTap.
vi.mock('@/components/editor/EditableBlock', () => ({
  EditableBlock: (props: { blockId: string }) => (
    <div data-testid={`editable-block-${props.blockId}`}>EditableBlock</div>
  ),
}))

// Mock tauri IPC surface SortableBlock's descendants touch on mount/interact.
vi.mock('@/lib/tauri', () => ({
  setProperty: vi.fn().mockResolvedValue({}),
  getPropertyDef: vi.fn().mockResolvedValue(null),
  listBlocks: vi
    .fn()
    .mockResolvedValue({ items: [], next_cursor: null, has_more: false, total_count: null }),
  listPageHistory: vi
    .fn()
    .mockResolvedValue({ items: [], next_cursor: null, has_more: false, total_count: null }),
  undoPageOp: vi.fn(),
  redoPageOp: vi.fn(),
  loadPageSubtree: vi.fn().mockResolvedValue({ blocks: [] }),
}))

import { SortableBlock } from '@/components/editor/SortableBlock'
import { RESCHEDULE_DRAG_TYPE } from '@/components/journal/RescheduleDropZone'
import { RescheduleDragSourceProvider } from '@/hooks/useRescheduleDragSource'

function makeSortable() {
  return {
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }
}

function makeRovingEditor() {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnMarkdownChange: vi.fn(),
    markCommitted: vi.fn(),
  }
}

describe('SortableBlock reschedule-drag source (#2770)', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
    window.matchMedia = originalMatchMedia
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 0,
      writable: true,
      configurable: true,
    })
  })

  it('is NOT a native drag source outside RescheduleDragSourceProvider (DailyView / page editor)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_NO_PROVIDER"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const row = screen.getByTestId('sortable-block')
    expect(row).not.toHaveAttribute('draggable', 'true')

    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'uninitialized' }
    fireEvent.dragStart(row, { dataTransfer })

    // No onDragStart wired — the payload is never set.
    expect(setData).not.toHaveBeenCalled()
  })

  it('becomes a native drag source inside RescheduleDragSourceProvider and sets the reschedule payload on dragstart', () => {
    render(
      <RescheduleDragSourceProvider>
        <SortableBlock
          blockId="BLOCK_WEEKLY_ROW"
          content="Buy groceries"
          isFocused={false}
          rovingEditor={makeRovingEditor()}
        />
      </RescheduleDragSourceProvider>,
    )

    const row = screen.getByTestId('sortable-block')
    expect(row).toHaveAttribute('draggable', 'true')

    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'uninitialized' }
    fireEvent.dragStart(row, { dataTransfer })

    expect(setData).toHaveBeenCalledWith(RESCHEDULE_DRAG_TYPE, 'BLOCK_WEEKLY_ROW')
    expect(dataTransfer.effectAllowed).toBe('move')
  })

  it('never marks the grip (dnd-kit reorder) handle as a native drag source, in or out of the provider', () => {
    const { rerender } = render(
      <SortableBlock
        blockId="BLOCK_GRIP"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(screen.getByTestId('drag-handle')).toHaveAttribute('draggable', 'false')

    rerender(
      <RescheduleDragSourceProvider>
        <SortableBlock
          blockId="BLOCK_GRIP"
          content="hello"
          isFocused={false}
          rovingEditor={makeRovingEditor()}
        />
      </RescheduleDragSourceProvider>,
    )

    // Even with the row itself now draggable, the grip handle stays opted
    // out — dnd-kit's own pointer-based reorder drag must never race a
    // native dragstart on the same element.
    expect(screen.getByTestId('sortable-block')).toHaveAttribute('draggable', 'true')
    expect(screen.getByTestId('drag-handle')).toHaveAttribute('draggable', 'false')
  })

  it('does NOT become a native drag source on touch devices, even inside the provider', () => {
    // Force coarse-pointer + real touch hardware so `useIsTouch()` → true,
    // mirroring SortableBlock.test.tsx's existing touch-forcing pattern.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 5,
      writable: true,
      configurable: true,
    })

    render(
      <RescheduleDragSourceProvider>
        <SortableBlock
          blockId="BLOCK_TOUCH"
          content="hello"
          isFocused={false}
          rovingEditor={makeRovingEditor()}
        />
      </RescheduleDragSourceProvider>,
    )

    expect(screen.getByTestId('sortable-block')).not.toHaveAttribute('draggable', 'true')
  })

  it('has no a11y violations when the row is a reschedule drag source', async () => {
    const { container } = render(
      <RescheduleDragSourceProvider>
        <SortableBlock
          blockId="BLOCK_A11Y"
          content="hello"
          isFocused={false}
          rovingEditor={makeRovingEditor()}
        />
      </RescheduleDragSourceProvider>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
