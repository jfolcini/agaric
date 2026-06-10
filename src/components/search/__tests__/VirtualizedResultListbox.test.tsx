/**
 * VirtualizedResultListbox — direct component tests.
 *
 * #756 item 7: the listbox cap was `max-h-[calc(100dvh-320px)]`, which
 * collapses to a sliver when the Android soft keyboard shrinks `100dvh`.
 * The cap is now floored via CSS `max(…, 12rem)`; these tests pin the
 * class so a refactor can't silently drop the floor, and cover the
 * basic listbox contract (roles, active descendant, keyboard, axe).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { SearchBlockRow } from '@/lib/bindings'

import { VirtualizedResultListbox } from '../VirtualizedResultListbox'

// Deterministic virtualizer: yields every row (jsdom has no layout, so the
// real windowing math would mount nothing). Mirrors the configurable mock
// in SearchResultGroups.test.tsx, fixed to the "yield all" mode.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    let start = 0
    const items = Array.from({ length: opts.count }, (_, index) => {
      const size = opts.estimateSize(index)
      const item = { index, key: index, start, size, end: start + size }
      start += size
      return item
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * 36,
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
      measureElement: vi.fn(),
    }
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

function makeRow(id: string): SearchBlockRow {
  return {
    id,
    block_type: 'content',
    content: `content ${id}`,
    parent_id: null,
    page_id: 'p1',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: null,
    match_offsets: [],
  } as SearchBlockRow
}

function renderRow(
  block: SearchBlockRow,
  style: React.CSSProperties,
  measureRef: (el: HTMLElement | null) => void,
  index: number,
): React.ReactNode {
  return (
    <li
      key={block.id}
      id={`result-row-${block.id}`}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role -- mirrors the production row shape (SearchResultBlockRow): `<li role="option">` is the canonical WAI-ARIA pattern inside a `<ul role="listbox">`.
      role="option"
      aria-selected={false}
      style={style}
      ref={measureRef}
      data-index={index}
      data-testid={`row-${block.id}`}
    >
      {block.content}
    </li>
  )
}

function setup(overrides?: Partial<React.ComponentProps<typeof VirtualizedResultListbox>>) {
  const blocks = [makeRow('b1'), makeRow('b2'), makeRow('b3')]
  const onKeyDown = vi.fn()
  const utils = render(
    <VirtualizedResultListbox
      blocks={blocks}
      activeRowId={undefined}
      activeRowIndex={-1}
      ariaLabel="Results in Page 1"
      tabIndex={0}
      dataTestId="group-listbox"
      onKeyDown={onKeyDown}
      renderRow={renderRow}
      {...overrides}
    />,
  )
  return { ...utils, onKeyDown, blocks }
}

describe('VirtualizedResultListbox', () => {
  it('renders one option per block inside a labelled listbox', () => {
    setup()
    const listbox = screen.getByRole('listbox', { name: 'Results in Page 1' })
    expect(listbox).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('caps its height with a 12rem floor so the soft keyboard cannot collapse it (#756)', () => {
    setup()
    const listbox = screen.getByTestId('group-listbox')
    // `max(calc(100dvh-320px), 12rem)`: with the Android soft keyboard up,
    // 100dvh shrinks until `100dvh - 320px` is a sliver (or negative);
    // the floor keeps ~5 rows visible.
    expect(listbox.className).toContain('max-h-[max(calc(100dvh-320px),12rem)]')
    expect(listbox.className).toContain('overflow-y-auto')
  })

  it('carries aria-activedescendant only when given an active row', () => {
    const { rerender } = setup()
    expect(screen.getByTestId('group-listbox')).not.toHaveAttribute('aria-activedescendant')
    rerender(
      <VirtualizedResultListbox
        blocks={[makeRow('b1'), makeRow('b2'), makeRow('b3')]}
        activeRowId="result-row-b2"
        activeRowIndex={1}
        ariaLabel="Results in Page 1"
        tabIndex={0}
        dataTestId="group-listbox"
        onKeyDown={vi.fn()}
        renderRow={renderRow}
      />,
    )
    expect(screen.getByTestId('group-listbox')).toHaveAttribute(
      'aria-activedescendant',
      'result-row-b2',
    )
  })

  it('forwards keydown events to the supplied handler', () => {
    const { onKeyDown } = setup()
    fireEvent.keyDown(screen.getByTestId('group-listbox'), { key: 'ArrowDown' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = setup()
    // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })
})
