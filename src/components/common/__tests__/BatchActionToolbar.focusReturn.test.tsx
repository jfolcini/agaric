/**
 * The batch toolbar is rendered only while something is selected, so a button
 * of its own that empties the selection unmounts it with focus on that button.
 * Focus then moves to the list's Tab stop instead of falling to <body>; a
 * selection emptied from elsewhere leaves focus where it is.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BatchActionToolbar } from '@/components/common/BatchActionToolbar'

/** `listIsTabStop`: Pages and Trash tab to the list itself, History to its cursor row. */
function Harness({ listIsTabStop }: { listIsTabStop: boolean }) {
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedCount, setSelectedCount] = useState(1)
  return (
    <>
      <button type="button" onClick={() => setSelectedCount(0)}>
        Change filter
      </button>
      {selectedCount > 0 && (
        <BatchActionToolbar selectedCount={selectedCount} listRef={listRef}>
          <button type="button" onClick={() => setSelectedCount(0)}>
            Clear selection
          </button>
        </BatchActionToolbar>
      )}
      <div ref={listRef} role="grid" aria-label="Items" tabIndex={listIsTabStop ? 0 : -1}>
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors the CSS-grid rows of the list views */}
        <div role="row" aria-label="Cursor row" tabIndex={listIsTabStop ? -1 : 0}>
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors the CSS-grid cells of the list views */}
          <div role="gridcell">First</div>
        </div>
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors the CSS-grid rows of the list views */}
        <div role="row" aria-label="Other row" tabIndex={-1}>
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors the CSS-grid cells of the list views */}
          <div role="gridcell">Second</div>
        </div>
      </div>
    </>
  )
}

async function pressClearSelection() {
  const user = userEvent.setup()
  screen.getByRole('button', { name: 'Clear selection' }).focus()
  await user.keyboard('{Enter}')
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
}

describe('BatchActionToolbar focus return', () => {
  it('moves focus to the list when its own button empties the selection', async () => {
    render(<Harness listIsTabStop />)
    await pressClearSelection()
    expect(screen.getByRole('grid', { name: 'Items' })).toHaveFocus()
  })

  it('moves focus to the cursor row when the row, not the list, is the Tab stop', async () => {
    render(<Harness listIsTabStop={false} />)
    await pressClearSelection()
    expect(screen.getByRole('row', { name: 'Cursor row' })).toHaveFocus()
  })

  it('leaves focus where it is when the selection empties from outside the toolbar', async () => {
    const user = userEvent.setup()
    render(<Harness listIsTabStop />)
    const filter = screen.getByRole('button', { name: 'Change filter' })
    filter.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(filter).toHaveFocus()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Harness listIsTabStop />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
