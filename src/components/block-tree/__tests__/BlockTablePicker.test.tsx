/**
 * BlockTablePicker — the `/table` size grid. The focus path that keeps the
 * roving editor mounted runs only in a browser: `e2e/slash-table-grid.spec.ts`.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BlockTablePicker } from '@/components/block-tree/BlockTablePicker'
import { EDITOR_PORTAL_SELECTOR } from '@/editor/editor-portal'

const run = vi.fn()
const insertTable = vi.fn(() => ({ run }))
const chain = vi.fn(() => ({ focus: () => ({ insertTable }) }))
const editor = {
  chain,
  isDestroyed: false,
  state: { selection: { from: 1 } },
  view: { coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 16 }) },
  commands: { focus: vi.fn() },
} as never

describe('BlockTablePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens with focus in the 3×3 grid, inside an editor portal', async () => {
    render(<BlockTablePicker editor={editor} onClose={vi.fn()} />)

    const grid = await screen.findByRole('grid', { name: 'Insert table' })
    expect(grid).toHaveFocus()
    expect(grid.closest(EDITOR_PORTAL_SELECTOR)).not.toBeNull()
    expect(screen.getByTestId('table-picker-label')).toHaveTextContent('3 × 3')
  })

  it('Enter inserts the 3×3 table and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BlockTablePicker editor={editor} onClose={onClose} />)
    expect(await screen.findByRole('grid', { name: 'Insert table' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes without inserting', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BlockTablePicker editor={editor} onClose={onClose} />)
    expect(await screen.findByRole('grid', { name: 'Insert table' })).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(chain).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    render(<BlockTablePicker editor={editor} onClose={vi.fn()} />)
    await screen.findByRole('grid', { name: 'Insert table' })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
