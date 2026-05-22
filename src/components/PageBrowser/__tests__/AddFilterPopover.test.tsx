/**
 * PEND-58 Phase 4 — AddFilterPopover tests.
 *
 * The Radix Popover is mocked to render its content inline (matching the
 * `GraphFilterBar` test pattern) so jsdom doesn't have to deal with the
 * portal / positioning machinery.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { FilterPrimitive } from '@/lib/tauri'
import { AddFilterPopover } from '../AddFilterPopover'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-root">{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    [key: string]: unknown
  }) => (asChild ? <>{children}</> : <button {...props}>{children}</button>),
  PopoverContent: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <div data-testid="popover-content" {...props}>
      {children}
    </div>
  ),
}))

describe('AddFilterPopover', () => {
  it('renders both filter category groups', () => {
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(screen.getByText('Pages')).toBeInTheDocument()
  })

  it('adds a boolean Pages primitive immediately on click', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Orphan'))
    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Orphan' })
  })

  it('maps the "Edited this week" bucket to Rolling { days: 7 }', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Edited this week'))
    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'LastEdited',
      spec: { type: 'Rolling', days: 7 },
    })
  })

  it('maps "Edited long ago" to OlderThan { days: 30 }', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Edited long ago'))
    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'LastEdited',
      spec: { type: 'OlderThan', days: 30 },
    })
  })

  it('emits a Priority primitive from the priority buttons', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Priority', priority: 'A' })
  })

  it('emits a Tag primitive through the inline editor', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Tag'))
    const input = screen.getByLabelText('Tag name or id')
    await userEvent.type(input, 'urgent')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Tag', tag: 'urgent' })
  })

  it('emits a PathGlob primitive (exclude=false) from the path editor', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Page path'))
    await userEvent.type(screen.getByLabelText('e.g. Projects/*'), 'Projects/*')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'PathGlob',
      pattern: 'Projects/*',
      exclude: false,
    })
  })

  it('emits HasProperty with op=exists when no value is given', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)

    await userEvent.click(screen.getByText('Has property'))
    await userEvent.type(screen.getByLabelText('Property key'), 'status')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      op: 'exists',
      value: null,
    })
  })

  it('does not offer Search-only primitives', () => {
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    expect(screen.queryByText(/regex/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/whole word/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/snippet/i)).not.toBeInTheDocument()
  })

  it('shows the many-filters warning when warnManyFilters is set', () => {
    render(<AddFilterPopover onAddFilter={vi.fn()} warnManyFilters />)
    expect(screen.getByText('Many filters can slow the view.')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<AddFilterPopover onAddFilter={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
