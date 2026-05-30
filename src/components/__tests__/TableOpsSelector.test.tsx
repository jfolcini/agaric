/**
 * Tests for TableOpsSelector (#215) — verifies each menu item runs the
 * matching TipTap table command on the editor and then closes the popover.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TableOpsSelector } from '../TableOpsSelector'

// Each command returns the chain so calls can be fluent; `.run()` is the
// terminal. We assert the specific command spy fired.
const run = vi.fn()
const addRowBefore = vi.fn(() => ({ run }))
const addRowAfter = vi.fn(() => ({ run }))
const addColumnBefore = vi.fn(() => ({ run }))
const addColumnAfter = vi.fn(() => ({ run }))
const deleteRow = vi.fn(() => ({ run }))
const deleteColumn = vi.fn(() => ({ run }))
const deleteTable = vi.fn(() => ({ run }))

const chainObj = {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
}
const focus = vi.fn(() => chainObj)
const chain = vi.fn(() => ({ focus }))

const editor = { chain } as never

describe('TableOpsSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const cases: Array<[string, () => unknown]> = [
    ['table-op-insert-row-above', () => addRowBefore],
    ['table-op-insert-row-below', () => addRowAfter],
    ['table-op-insert-column-left', () => addColumnBefore],
    ['table-op-insert-column-right', () => addColumnAfter],
    ['table-op-delete-row', () => deleteRow],
    ['table-op-delete-column', () => deleteColumn],
    ['table-op-delete-table', () => deleteTable],
  ]

  for (const [testid, getSpy] of cases) {
    it(`runs the command for ${testid} and closes`, async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(<TableOpsSelector editor={editor} onClose={onClose} />)

      await user.click(screen.getByTestId(testid))

      expect(focus).toHaveBeenCalledTimes(1)
      expect(getSpy() as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  }

  it('renders all seven operations with a menu role', () => {
    render(<TableOpsSelector editor={editor} onClose={vi.fn()} />)
    expect(screen.getByRole('menu', { name: 'Table' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TableOpsSelector editor={editor} onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
