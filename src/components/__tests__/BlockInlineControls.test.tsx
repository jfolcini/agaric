import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'

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
  X: (props: { size: number; className?: string }) => (
    <svg data-testid="x-icon" width={props.size} height={props.size} className={props.className} />
  ),
}))

vi.mock('@/components/ui/chevron-toggle', () => ({
  ChevronToggle: ({
    isExpanded,
    className,
    ...rest
  }: { isExpanded: boolean; className?: string } & Record<string, unknown>) => (
    <svg data-testid="chevron-toggle" data-expanded={isExpanded} className={className} {...rest} />
  ),
}))

// PropertyChip mock — mirrors the TEST-4b shape: a non-button wrapper with
// two sibling buttons. We attach onClick to the wrapper (not a hidden third
// button) so `user.click(getByTestId('property-chip-${key}'))` still
// exercises the value-edit path without reintroducing nested buttons.
vi.mock('../PropertyChip', () => ({
  PropertyChip: (props: {
    propKey: string
    value: string
    onClick?: () => void
    onKeyClick?: () => void
  }) => (
    // biome-ignore lint/a11y/useSemanticElements: mirrors PropertyChip's production role="group" — see TEST-4b.
    <div
      data-testid={`property-chip-${props.propKey}`}
      className="property-chip"
      role="group"
      onClick={props.onClick}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') props.onClick?.()
      }}
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
    </div>
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
    anyBlockHasChildren: true,
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
    expect(dueDateColor('2000-01-01')).toContain('text-destructive')
  })

  it('returns amber classes for today', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(dueDateColor(today)).toContain('text-status-pending-foreground')
  })

  it('returns muted classes for future dates', () => {
    expect(dueDateColor('2099-12-31')).toContain('bg-muted')
  })
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

  it('renders CANCELLED style with X icon (UX-202)', () => {
    const { container } = render(<TaskCheckbox state="CANCELLED" />)
    const checkbox = container.querySelector('.task-checkbox-cancelled')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox?.getAttribute('class')).toContain('border-task-cancelled')
    expect(checkbox?.getAttribute('data-testid')).toBe('task-checkbox-cancelled')
    // X icon glyph should be present
    expect(screen.getByTestId('x-icon')).toBeInTheDocument()
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

  it('does not render collapse toggle when hasChildren is false', () => {
    renderControls(makeProps())
    expect(screen.queryByTestId('chevron-toggle')).not.toBeInTheDocument()
  })

  it('renders collapse toggle when hasChildren is true', () => {
    renderControls(makeProps({ hasChildren: true }))
    expect(screen.getByTestId('chevron-toggle')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: t('block.expandChildren') })).toBeInTheDocument()
  })

  it('shows collapse label when expanded', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: false }))
    expect(screen.getByRole('button', { name: t('block.collapseChildren') })).toBeInTheDocument()
  })

  it('passes isExpanded=true when expanded', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: false }))
    const chevron = screen.getByTestId('chevron-toggle')
    expect(chevron.getAttribute('data-expanded')).toBe('true')
  })

  it('passes isExpanded=false when collapsed', () => {
    renderControls(makeProps({ hasChildren: true, isCollapsed: true }))
    const chevron = screen.getByTestId('chevron-toggle')
    expect(chevron.getAttribute('data-expanded')).toBe('false')
  })

  it('renders placeholder span when anyBlockHasChildren is true but block has no children', () => {
    const { container } = renderControls(
      makeProps({ hasChildren: false, anyBlockHasChildren: true }),
    )
    const placeholder = container.querySelector('span.flex-shrink-0.w-5.h-5')
    expect(placeholder).toBeInTheDocument()
  })

  it('omits placeholder span when anyBlockHasChildren is false and block has no children', () => {
    const { container } = renderControls(
      makeProps({ hasChildren: false, anyBlockHasChildren: false }),
    )
    const placeholder = container.querySelector('span.flex-shrink-0.w-5.h-5')
    expect(placeholder).not.toBeInTheDocument()
  })

  it('renders collapse toggle when hasChildren is true regardless of anyBlockHasChildren', () => {
    renderControls(makeProps({ hasChildren: true, anyBlockHasChildren: false }))
    expect(screen.getByTestId('collapse-toggle')).toBeInTheDocument()
  })

  it('spacer and collapse toggle have matching width', () => {
    // Render with hasChildren=false, anyBlockHasChildren=true to get spacer
    const { container: spacerContainer } = renderControls(
      makeProps({ hasChildren: false, anyBlockHasChildren: true }),
    )
    const spacer = spacerContainer.querySelector('span[aria-hidden]')
    expect(spacer?.className).toContain('w-5')

    // Render with hasChildren=true to get button
    const { container: buttonContainer } = renderControls(
      makeProps({ hasChildren: true, anyBlockHasChildren: true }),
    )
    const button = buttonContainer.querySelector('.collapse-toggle')
    expect(button?.className).toContain('w-5')
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

  it('renders the repeat indicator as a non-interactive status span (UX-5)', () => {
    const { container } = renderControls(
      makeProps({
        properties: [{ key: 'repeat', value: 'weekly' }],
      }),
    )

    // It must NOT be a <button> (no click target, screen readers should not
    // announce "button"). It is rendered as a <span role="status">.
    const indicator = container.querySelector('.repeat-indicator') as HTMLElement
    expect(indicator).toBeInTheDocument()
    expect(indicator.tagName).toBe('SPAN')
    expect(indicator.getAttribute('role')).toBe('status')
    expect(indicator.getAttribute('aria-label')).toContain('weekly')
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

  describe('property overflow button (UX-229)', () => {
    const fourProps = [
      { key: 'a', value: 'v1' },
      { key: 'b', value: 'v2' },
      { key: 'c', value: 'v3' },
      { key: 'd', value: 'v4' },
    ]

    it('renders as a button when filteredProperties.length > 3', () => {
      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      expect(overflow).toBeInTheDocument()
      expect(overflow.tagName).toBe('BUTTON')
      expect(overflow).toHaveTextContent('+1')
    })

    it('does not render when filteredProperties.length is exactly 3', () => {
      renderControls(
        makeProps({
          filteredProperties: [
            { key: 'a', value: 'v1' },
            { key: 'b', value: 'v2' },
            { key: 'c', value: 'v3' },
          ],
        }),
      )
      expect(screen.queryByTestId('property-overflow')).not.toBeInTheDocument()
    })

    it('does not render when filteredProperties is empty', () => {
      renderControls(makeProps({ filteredProperties: [] }))
      expect(screen.queryByTestId('property-overflow')).not.toBeInTheDocument()
    })

    it('has an accessible name via aria-label with total count', () => {
      renderControls(makeProps({ filteredProperties: fourProps }))
      const label = t('block.showAllProperties', { count: fourProps.length })
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    })

    it('dispatches OPEN_BLOCK_PROPERTIES event on click', async () => {
      const user = userEvent.setup()
      const handler = vi.fn()
      document.addEventListener('open-block-properties', handler)

      renderControls(makeProps({ filteredProperties: fourProps }))
      await user.click(screen.getByTestId('property-overflow'))

      expect(handler).toHaveBeenCalledOnce()
      document.removeEventListener('open-block-properties', handler)
    })

    it('dispatches OPEN_BLOCK_PROPERTIES when activated with Enter', async () => {
      const user = userEvent.setup()
      const handler = vi.fn()
      document.addEventListener('open-block-properties', handler)

      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      overflow.focus()
      await user.keyboard('{Enter}')

      expect(handler).toHaveBeenCalledOnce()
      document.removeEventListener('open-block-properties', handler)
    })

    it('dispatches OPEN_BLOCK_PROPERTIES when activated with Space', async () => {
      const user = userEvent.setup()
      const handler = vi.fn()
      document.addEventListener('open-block-properties', handler)

      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      overflow.focus()
      await user.keyboard(' ')

      expect(handler).toHaveBeenCalledOnce()
      document.removeEventListener('open-block-properties', handler)
    })

    it('wraps the button in a Tooltip trigger', () => {
      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      expect(overflow.getAttribute('data-slot')).toBe('tooltip-trigger')
    })

    it('applies the shared focus-visible ring classes', () => {
      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      expect(overflow.className).toContain('focus-visible:ring-[3px]')
      expect(overflow.className).toContain('focus-visible:ring-ring/50')
    })

    it('applies max-sm: touch target padding', () => {
      renderControls(makeProps({ filteredProperties: fourProps }))
      const overflow = screen.getByTestId('property-overflow')
      expect(overflow.className).toContain('max-sm:px-2.5')
      expect(overflow.className).toContain('max-sm:py-1')
    })

    it('has no a11y violations when overflow button is rendered', async () => {
      const { container } = renderControls(makeProps({ filteredProperties: fourProps }))
      await waitFor(
        async () => {
          expect(await axe(container)).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
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

  it('main container has narrow-viewport wrapping layout classes', () => {
    const { container } = renderControls(makeProps())
    const inlineControls = container.querySelector('.inline-controls') as HTMLElement
    expect(inlineControls.className).toContain('max-sm:flex-wrap')
    expect(inlineControls.className).toContain('max-sm:w-auto')
    expect(inlineControls.className).toContain('max-sm:flex-shrink')
  })

  it('indicator buttons use max-sm: classes instead of [@media(pointer:coarse)]', () => {
    renderControls(makeProps({ hasChildren: true, priority: '1' }))
    const collapseToggle = screen.getByTestId('collapse-toggle')
    const taskMarker = screen.getByTestId('task-marker')
    const priorityBadge = screen.getByTestId('priority-badge')
    expect(collapseToggle.className).not.toContain('[@media(pointer:coarse)]')
    expect(taskMarker.className).not.toContain('[@media(pointer:coarse)]')
    expect(priorityBadge.className).not.toContain('[@media(pointer:coarse)]')
    expect(collapseToggle.className).toContain('max-sm:')
    expect(taskMarker.className).toContain('max-sm:')
    expect(priorityBadge.className).toContain('max-sm:')
  })
})
