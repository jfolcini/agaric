import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  Calendar: (props: { size: number; className?: string }) => (
    <svg
      data-testid="calendar-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  CalendarDays: (props: { size: number; className?: string }) => (
    <svg
      data-testid="calendar-days-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  Check: (props: { size: number; className?: string }) => (
    <svg
      data-testid="check-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  ChevronRight: (props: { size: number; className?: string }) => (
    <svg
      data-testid="chevron-right-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  Paperclip: (props: { size: number; className?: string }) => (
    <svg
      data-testid="paperclip-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  Repeat: (props: { size: number; className?: string }) => (
    <svg
      data-testid="repeat-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
}))

vi.mock('../PropertyChip', () => ({
  PropertyChip: (props: {
    propKey: string
    value: string
    onClick?: () => void
    onKeyClick?: () => void
  }) => (
    <button
      type="button"
      data-testid={`property-chip-${props.propKey}`}
      className="property-chip"
      onClick={props.onClick}
    >
      <button
        data-testid={`property-key-${props.propKey}`}
        type="button"
        onClick={(e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          props.onKeyClick?.()
        }}
      >
        {props.propKey}:
      </button>
      <span>{props.value}</span>
    </button>
  ),
}))

import type { LucideIcon } from 'lucide-react'
import {
  BlockInlineControls,
  type BlockInlineControlsProps,
  DateChip,
  dueDateColor,
  formatCompactDate,
  MONTH_SHORT,
  PRIORITY_DISPLAY,
  TaskCheckbox,
} from '../BlockInlineControls'
import { TooltipProvider } from '../ui/tooltip'

function renderControls(props: BlockInlineControlsProps) {
  return render(
    <TooltipProvider>
      <BlockInlineControls {...props} />
    </TooltipProvider>,
  )
}

function makeProps(overrides: Partial<BlockInlineControlsProps> = {}): BlockInlineControlsProps {
  return {
    blockId: 'BLOCK_1',
    hasChildren: false,
    isCollapsed: false,
    filteredProperties: [],
    attachmentCount: 0,
    showAttachments: false,
    onToggleAttachments: vi.fn(),
    onEditProp: vi.fn(),
    onEditKey: vi.fn(),
    ...overrides,
  }
}

describe('formatCompactDate', () => {
  it('formats same-year date without year', () => {
    const year = new Date().getFullYear()
    expect(formatCompactDate(`${year}-04-15`)).toBe('Apr 15')
  })

  it('formats different-year date with year', () => {
    expect(formatCompactDate('2019-12-25')).toBe('Dec 25, 2019')
  })

  it('returns original string for invalid format', () => {
    expect(formatCompactDate('not-a-date')).toBe('not-a-date')
  })

  it('returns original string for non-numeric parts', () => {
    expect(formatCompactDate('abc-de-fg')).toBe('abc-de-fg')
  })
})

describe('dueDateColor', () => {
  it('returns red classes for overdue dates', () => {
    expect(dueDateColor('2000-01-01')).toContain('bg-red-100')
  })

  it('returns amber classes for today', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(dueDateColor(today)).toContain('bg-amber-100')
  })

  it('returns muted classes for future dates', () => {
    expect(dueDateColor('2099-12-31')).toContain('bg-muted')
  })
})

describe('PRIORITY_DISPLAY', () => {
  it('maps 1 to P1', () => expect(PRIORITY_DISPLAY['1']).toBe('P1'))
  it('maps 2 to P2', () => expect(PRIORITY_DISPLAY['2']).toBe('P2'))
  it('maps 3 to P3', () => expect(PRIORITY_DISPLAY['3']).toBe('P3'))
})

describe('MONTH_SHORT', () => {
  it('has 12 entries', () => expect(MONTH_SHORT).toHaveLength(12))
  it('starts with Jan', () => expect(MONTH_SHORT[0]).toBe('Jan'))
  it('ends with Dec', () => expect(MONTH_SHORT[11]).toBe('Dec'))
})

describe('TaskCheckbox', () => {
  it('renders empty style for null state', () => {
    const { container } = render(<TaskCheckbox state={null} />)
    expect(container.querySelector('.task-checkbox-empty')).toBeInTheDocument()
  })

  it('renders empty style for undefined state', () => {
    const { container } = render(<TaskCheckbox state={undefined} />)
    expect(container.querySelector('.task-checkbox-empty')).toBeInTheDocument()
  })

  it('renders TODO style', () => {
    const { container } = render(<TaskCheckbox state="TODO" />)
    expect(container.querySelector('.task-checkbox-todo')).toBeInTheDocument()
  })

  it('renders DOING style', () => {
    const { container } = render(<TaskCheckbox state="DOING" />)
    expect(container.querySelector('.task-checkbox-doing')).toBeInTheDocument()
  })

  it('renders DONE style with check icon', () => {
    const { container } = render(<TaskCheckbox state="DONE" />)
    expect(container.querySelector('.task-checkbox-done')).toBeInTheDocument()
    expect(screen.getByTestId('check-icon')).toBeInTheDocument()
  })

  it('renders custom style for unknown state', () => {
    const { container } = render(<TaskCheckbox state="WAITING" />)
    expect(container.querySelector('.task-checkbox-custom')).toBeInTheDocument()
  })
})

describe('DateChip', () => {
  it('renders date text and icon', () => {
    render(
      <DateChip
        date="2099-06-15"
        icon={
          (({ size, className }: { size: number; className?: string }) => (
            <svg data-testid="test-icon" width={size} className={className} />
          )) as unknown as LucideIcon
        }
        colorClass="bg-muted"
        eventName="test-event"
        i18nKey="block.dueDate"
        chipClass="test-chip"
      />,
    )
    expect(screen.getByText('Jun 15, 2099')).toBeInTheDocument()
    expect(screen.getByTestId('test-icon')).toBeInTheDocument()
  })

  it('dispatches custom event on click', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    document.addEventListener('test-event', handler)

    render(
      <DateChip
        date="2099-01-01"
        icon={(() => <svg />) as unknown as LucideIcon}
        colorClass=""
        eventName="test-event"
        i18nKey="block.dueDate"
        chipClass=""
      />,
    )

    await user.click(screen.getByRole('button'))
    expect(handler).toHaveBeenCalledOnce()

    document.removeEventListener('test-event', handler)
  })
})

describe('BlockInlineControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders spacer when hasChildren is false', () => {
    const { container } = renderControls(makeProps())
    const spacer = container.querySelector('.w-5')
    expect(spacer).toBeInTheDocument()
    expect(screen.queryByTestId('chevron-right-icon')).not.toBeInTheDocument()
  })

  it('renders collapse toggle when hasChildren is true', () => {
    renderControls(makeProps({ hasChildren: true }))
    expect(screen.getByTestId('chevron-right-icon')).toBeInTheDocument()
    expect(screen.getByTestId('collapse-toggle')).toBeInTheDocument()
  })

  it('calls onToggleCollapse with blockId on chevron click', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderControls(makeProps({ hasChildren: true, onToggleCollapse: onToggle }))
    await user.click(screen.getByTestId('collapse-toggle'))
    expect(onToggle).toHaveBeenCalledWith('BLOCK_1')
  })

  it('shows expand label when collapsed', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: true }))
    expect(screen.getByRole('button', { name: 'Expand children' })).toBeInTheDocument()
  })

  it('shows collapse label when expanded', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: false }))
    expect(screen.getByRole('button', { name: 'Collapse children' })).toBeInTheDocument()
  })

  it('applies rotate-90 when expanded', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: false }))
    const chevron = screen.getByTestId('chevron-right-icon')
    expect(chevron.getAttribute('class')).toContain('rotate-90')
  })

  it('does not apply rotate-90 when collapsed', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: true }))
    const chevron = screen.getByTestId('chevron-right-icon')
    expect(chevron.getAttribute('class')).not.toContain('rotate-90')
  })

  it('renders task marker button', () => {
    renderControls(makeProps())
    expect(screen.getByTestId('task-marker')).toBeInTheDocument()
  })

  it('calls onToggleTodo on task marker click', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderControls(makeProps({ onToggleTodo: onToggle, todoState: 'TODO' }))
    await user.click(screen.getByTestId('task-marker'))
    expect(onToggle).toHaveBeenCalledWith('BLOCK_1')
  })

  it('renders priority badge when priority is set', () => {
    renderControls(makeProps({ priority: '1' }))
    expect(screen.getByTestId('priority-badge')).toBeInTheDocument()
    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('does not render priority badge when priority is null', () => {
    renderControls(makeProps({ priority: null }))
    expect(screen.queryByTestId('priority-badge')).not.toBeInTheDocument()
  })

  it('calls onTogglePriority on priority badge click', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderControls(makeProps({ priority: '2', onTogglePriority: onToggle }))
    await user.click(screen.getByTestId('priority-badge'))
    expect(onToggle).toHaveBeenCalledWith('BLOCK_1')
  })

  it('renders due date chip when dueDate is set', () => {
    renderControls(makeProps({ dueDate: '2099-03-15' }))
    expect(screen.getByText('Mar 15, 2099')).toBeInTheDocument()
  })

  it('renders scheduled date chip when scheduledDate is set', () => {
    renderControls(makeProps({ scheduledDate: '2099-07-01' }))
    expect(screen.getByText('Jul 1, 2099')).toBeInTheDocument()
  })

  it('renders repeat indicator when repeat property exists', () => {
    renderControls(
      makeProps({
        properties: [{ key: 'repeat', value: 'weekly' }],
      }),
    )
    expect(screen.getByText('weekly')).toBeInTheDocument()
    expect(screen.getByTestId('repeat-icon')).toBeInTheDocument()
  })

  it('renders property chips up to 3', () => {
    const filtered = [
      { key: 'a', value: 'v1' },
      { key: 'b', value: 'v2' },
      { key: 'c', value: 'v3' },
      { key: 'd', value: 'v4' },
    ]
    renderControls(makeProps({ filteredProperties: filtered }))
    expect(screen.getByTestId('property-chip-a')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-b')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-c')).toBeInTheDocument()
    expect(screen.queryByTestId('property-chip-d')).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('calls onEditProp when property chip is clicked', async () => {
    const user = userEvent.setup()
    const onEditProp = vi.fn()
    renderControls(
      makeProps({
        filteredProperties: [{ key: 'effort', value: '2h' }],
        onEditProp,
      }),
    )
    await user.click(screen.getByTestId('property-chip-effort'))
    expect(onEditProp).toHaveBeenCalledWith({ key: 'effort', value: '2h' })
  })

  it('calls onEditKey when property key label is clicked', async () => {
    const user = userEvent.setup()
    const onEditKey = vi.fn()
    renderControls(
      makeProps({
        filteredProperties: [{ key: 'effort', value: '2h' }],
        onEditKey,
      }),
    )
    await user.click(screen.getByTestId('property-key-effort'))
    expect(onEditKey).toHaveBeenCalledWith({ oldKey: 'effort', value: '2h' })
  })

  it('renders attachment badge when attachmentCount > 0', () => {
    renderControls(makeProps({ attachmentCount: 3 }))
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByTestId('paperclip-icon')).toBeInTheDocument()
  })

  it('does not render attachment badge when attachmentCount is 0', () => {
    renderControls(makeProps({ attachmentCount: 0 }))
    expect(screen.queryByTestId('paperclip-icon')).not.toBeInTheDocument()
  })

  it('calls onToggleAttachments when attachment badge is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderControls(makeProps({ attachmentCount: 2, onToggleAttachments: onToggle }))
    await user.click(screen.getByRole('button', { name: /attachment/i }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('has no a11y violations (default state)', async () => {
    const { container } = renderControls(makeProps())
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (with children and priority)', async () => {
    const { container } = renderControls(
      makeProps({
        hasChildren: true,
        priority: '1',
        todoState: 'TODO',
        dueDate: '2099-01-01',
        attachmentCount: 1,
      }),
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
