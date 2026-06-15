/**
 * Tests for TablePicker (#215b) — the toolbar N×M table grid picker.
 *
 * Verifies the grid renders, that selecting a cell inserts an N×M table via
 * the SAME `insertTable` path as the `/table` slash command (header-row
 * default), that keyboard navigation works, and that there are no a11y
 * violations (per the component-test convention).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TablePicker } from '../TablePicker'

// Mirror the slash command's chain: insertTable returns a chainable that
// terminates in run(). We capture the dimensions it was called with.
const run = vi.fn()
const insertTable = vi.fn(() => ({ run }))
const focus = vi.fn(() => ({ insertTable }))
const chain = vi.fn(() => ({ focus }))
const editor = { chain } as never

describe('TablePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders an 8×8 grid of cells', () => {
    render(<TablePicker editor={editor} onClose={vi.fn()} />)
    expect(screen.getByTestId('table-picker')).toBeInTheDocument()
    expect(screen.getByTestId('table-cell-1-1')).toBeInTheDocument()
    expect(screen.getByTestId('table-cell-8-8')).toBeInTheDocument()
    // 64 cells total.
    expect(screen.getAllByRole('gridcell')).toHaveLength(64)
  })

  it('clicking a cell inserts that N×M table with a header row and closes', () => {
    const onClose = vi.fn()
    render(<TablePicker editor={editor} onClose={onClose} />)

    fireEvent.pointerDown(screen.getByTestId('table-cell-3-4'))

    expect(focus).toHaveBeenCalledTimes(1)
    // SAME path + header-row default as the `/table` slash command.
    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 4, withHeaderRow: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Per-cell coverage (#1170): every grid cell, when clicked, must insert a
  // table whose dimensions match that cell's row/col — across the corners and
  // interior of the 8×8 grid — through the same header-row insert path.
  it.each([
    [1, 1],
    [1, 8],
    [8, 1],
    [8, 8],
    [4, 6],
    [6, 2],
    [5, 5],
  ])('clicking cell %i×%i inserts that exact N×M table', (r, c) => {
    const onClose = vi.fn()
    render(<TablePicker editor={editor} onClose={onClose} />)

    fireEvent.pointerDown(screen.getByTestId(`table-cell-${r}-${c}`))

    expect(insertTable).toHaveBeenCalledTimes(1)
    expect(insertTable).toHaveBeenCalledWith({ rows: r, cols: c, withHeaderRow: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Per-cell coverage (#1170): a click is preceded by a hover (pointerEnter)
  // that sets the highlighted dimensions; the inserted table must match the
  // HOVERED/clicked cell, not any earlier highlight.
  it('inserts the hovered/clicked cell dimensions even after hovering a different cell', () => {
    const onClose = vi.fn()
    render(<TablePicker editor={editor} onClose={onClose} />)

    // Hover one cell, then move to and click another.
    fireEvent.pointerEnter(screen.getByTestId('table-cell-2-2'))
    fireEvent.pointerEnter(screen.getByTestId('table-cell-5-3'))
    fireEvent.pointerDown(screen.getByTestId('table-cell-5-3'))

    expect(insertTable).toHaveBeenCalledTimes(1)
    expect(insertTable).toHaveBeenCalledWith({ rows: 5, cols: 3, withHeaderRow: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hovering highlights the R×C rectangle and updates the dimension label', () => {
    render(<TablePicker editor={editor} onClose={vi.fn()} />)

    fireEvent.pointerEnter(screen.getByTestId('table-cell-2-3'))

    // The label reflects the hovered dimensions.
    expect(screen.getByTestId('table-picker-label')).toHaveTextContent('2 × 3')
    // Cells within the rectangle are selected; cells outside are not.
    expect(screen.getByTestId('table-cell-1-1')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('table-cell-2-3')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('table-cell-3-3')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('table-cell-2-4')).toHaveAttribute('aria-selected', 'false')
  })

  it('supports keyboard selection: arrows size the grid, Enter inserts', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TablePicker editor={editor} onClose={onClose} />)

    const grid = screen.getByRole('grid', { name: 'Insert table' })
    grid.focus()
    // From 0,0: Down → 2 rows (origin 1 + 1), Right → 2 cols.
    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}')

    expect(insertTable).toHaveBeenCalledWith({ rows: 2, cols: 2, withHeaderRow: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TablePicker editor={editor} onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
