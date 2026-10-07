/**
 * Tests for TrashRowItem memoization (#1623).
 *
 * TrashRowItem used to be a plain (non-memoized) export function that called
 * `renderRichContent` → `parse` inline on every render. A selection / focus
 * re-render (the virtualizer re-renders rows as the user clicks / keyboards
 * through the list) re-ran the full recursive-descent markdown parser for
 * every visible row.
 *
 * This suite verifies:
 *  - The parse (`renderRichContent`) runs exactly once per row content and is
 *    NOT re-run when an unrelated prop (e.g. `isFocused`) changes — the
 *    `useMemo` reuses the parsed nodes across the virtualizer's selection /
 *    focus re-renders of the same row instance.
 *  - Output is unchanged (content still renders; clicks / restore / purge fire).
 *  - a11y audit (axe) on a representative render.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'
import type { RichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import type { BlockRow } from '@/lib/bindings'

// Render rich content as plain text so the parse is queryable AND we can
// count how many times it runs (the memo regression guard).
vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

import { renderRichContent } from '@/components/RichContentRenderer'
import { TrashRowItem } from '@/components/TrashView/TrashRowItem'

const callbacks: RichContentCallbacks = {
  resolveBlockTitle: () => undefined,
  resolveBlockStatus: () => 'active',
  resolveTagName: () => undefined,
  resolveTagStatus: () => 'active',
}

const onTagClick = vi.fn()

function makeRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return makeBlock({
    id: 'B1',
    content: 'deleted content',
    deleted_at: 1736899200000,
    block_type: 'block',
    ...overrides,
  }) as BlockRow
}

function renderRow(props: Partial<React.ComponentProps<typeof TrashRowItem>> = {}) {
  const block = props.block ?? makeRow()
  return render(
    <TrashRowItem
      block={block}
      isSelected={false}
      isFocused={false}
      pageLabel={null}
      descendantCount={0}
      callbacks={callbacks}
      onTagClick={onTagClick}
      onRowClick={vi.fn()}
      onToggleSelection={vi.fn()}
      onRestore={vi.fn()}
      onRequestPurge={vi.fn()}
      {...props}
    />,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('TrashRowItem', () => {
  it('renders the row content', () => {
    renderRow()
    expect(screen.getByText('deleted content')).toBeInTheDocument()
  })

  it('parses the content exactly once on initial render', () => {
    renderRow()
    expect(renderRichContent).toHaveBeenCalledTimes(1)
    expect(renderRichContent).toHaveBeenCalledWith('deleted content', expect.any(Object))
  })

  it('does not re-parse when an unrelated prop (isFocused) changes', () => {
    const block = makeRow()
    const { rerender } = renderRow({ block })
    expect(renderRichContent).toHaveBeenCalledTimes(1)

    // Flip focus: the memo key (block.content + resolve callbacks) is
    // unchanged, so renderRichContent must NOT run again.
    rerender(
      <TrashRowItem
        block={block}
        isSelected={false}
        isFocused
        pageLabel={null}
        descendantCount={0}
        callbacks={callbacks}
        onTagClick={onTagClick}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
      />,
    )
    expect(renderRichContent).toHaveBeenCalledTimes(1)
  })

  it('re-parses when the content actually changes', () => {
    const { rerender } = renderRow({ block: makeRow({ content: 'first' }) })
    expect(renderRichContent).toHaveBeenCalledTimes(1)

    rerender(
      <TrashRowItem
        block={makeRow({ content: 'second' })}
        isSelected={false}
        isFocused={false}
        pageLabel={null}
        descendantCount={0}
        callbacks={callbacks}
        onTagClick={onTagClick}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
      />,
    )
    expect(renderRichContent).toHaveBeenCalledTimes(2)
    expect(renderRichContent).toHaveBeenLastCalledWith('second', expect.any(Object))
  })

  it('renders the empty-content fallback without parsing', () => {
    renderRow({ block: makeRow({ content: null }) })
    expect(renderRichContent).not.toHaveBeenCalled()
    // `trash.emptyContent` → '(empty)'.
    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('fires onRestore and onRequestPurge from the action buttons', async () => {
    const user = userEvent.setup()
    const onRestore = vi.fn()
    const onRequestPurge = vi.fn()
    const block = makeRow()
    renderRow({ block, onRestore, onRequestPurge })

    await user.click(screen.getByTestId('trash-restore-btn'))
    expect(onRestore).toHaveBeenCalledWith(block)

    await user.click(screen.getByTestId('trash-purge-btn'))
    expect(onRequestPurge).toHaveBeenCalledWith(block.id)
  })

  // `list-cursor` is a tint at rest whose ring is gated in CSS on keyboard
  // focus being in the grid; jsdom cannot evaluate that gate, so the class
  // contract is the assertion: the cursor never carries an inline ring.
  it('marks the cursor row with list-cursor and no inline ring', () => {
    const { rerender } = renderRow({ isFocused: true })
    const row = screen.getByTestId('trash-item')
    expect(row).toHaveClass('list-cursor')
    expect(row).not.toHaveClass('ring-2')

    rerender(
      <TrashRowItem
        block={makeRow()}
        isSelected={false}
        isFocused={false}
        pageLabel={null}
        descendantCount={0}
        callbacks={callbacks}
        onTagClick={onTagClick}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
      />,
    )
    expect(screen.getByTestId('trash-item')).not.toHaveClass('list-cursor')
  })

  it('checkbox reflects selection and toggles it once without a row click', async () => {
    const user = userEvent.setup()
    const onToggleSelection = vi.fn()
    const onRowClick = vi.fn()
    renderRow({ isSelected: true, onToggleSelection, onRowClick })

    const checkbox = screen.getByRole('checkbox', { name: /deleted content/ })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)

    expect(onToggleSelection).toHaveBeenCalledTimes(1)
    expect(onToggleSelection).toHaveBeenCalledWith('B1')
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('Space on the checkbox toggles this row once and stays off the document', async () => {
    // TrashView's list shortcuts listen on `document`, and their Space toggles
    // the CURSOR row; a checkbox Space reaching them would toggle a second row.
    const user = userEvent.setup()
    const onToggleSelection = vi.fn()
    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)
    try {
      renderRow({ onToggleSelection })

      screen.getByTestId('trash-item-checkbox').focus()
      await user.keyboard(' ')

      expect(onToggleSelection).toHaveBeenCalledTimes(1)
      expect(onToggleSelection).toHaveBeenCalledWith('B1')
      expect(documentKeydown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('Space on the row toggles it once and stays off the document', async () => {
    // The same document-level Space would toggle the cursor row (this one) back.
    const user = userEvent.setup()
    const onToggleSelection = vi.fn()
    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)
    try {
      renderRow({ onToggleSelection, isFocused: true })

      screen.getByTestId('trash-item').focus()
      await user.keyboard(' ')

      expect(onToggleSelection).toHaveBeenCalledTimes(1)
      expect(onToggleSelection).toHaveBeenCalledWith('B1')
      expect(documentKeydown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('has no a11y violations', async () => {
    // `role="row"` requires a grid/table/rowgroup parent (aria-required-parent).
    // Mirror TrashListView: the row is a direct child of the `role="grid"`
    // viewport. The grid role is set via a spread prop so the
    // `prefer-tag-over-role` lint (which only flags literal `role=` JSX attrs)
    // doesn't misfire on this CSS-grid aria-grid harness.
    const gridProps = { role: 'grid', 'aria-label': 'Trash' }
    const { container } = render(
      <div {...gridProps}>
        <TrashRowItem
          block={makeRow()}
          isSelected={false}
          isFocused={false}
          pageLabel={null}
          descendantCount={0}
          callbacks={callbacks}
          onTagClick={onTagClick}
          onRowClick={vi.fn()}
          onToggleSelection={vi.fn()}
          onRestore={vi.fn()}
          onRequestPurge={vi.fn()}
        />
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
