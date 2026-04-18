/**
 * Tests for BlockListItem component (UX-9).
 *
 * Validates:
 *  1. Renders truncated content text
 *  2. Renders metadata slot before content
 *  3. Renders breadcrumb with PageLink when breadcrumbAsLink=true (default)
 *  4. Renders breadcrumb as plain text when breadcrumbAsLink=false
 *  5. Hides breadcrumb when pageId is null/undefined
 *  6. Calls onClick handler on click
 *  7. Calls onKeyDown handler on keydown
 *  8. Applies custom className to li
 *  9. Applies contentClassName and breadcrumbClassName
 * 10. Applies data-testid via testId prop
 * 11. Uses custom contentMaxLength and emptyContentFallback
 * 12. Uses custom breadcrumbArrow
 * 13. Shows fallback for null/empty content
 * 14. A11y: li has tabIndex=0 for keyboard navigation
 * 15. A11y audit passes (axe)
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const mockNavigateToPage = vi.fn()

// Mock tauri IPC functions used by handleDateSelect
const mockGetBlock = vi.fn()
const mockSetDueDate = vi.fn()
const mockSetScheduledDate = vi.fn()
vi.mock('../../lib/tauri', () => ({
  getBlock: (...args: unknown[]) => mockGetBlock(...args),
  setDueDate: (...args: unknown[]) => mockSetDueDate(...args),
  setScheduledDate: (...args: unknown[]) => mockSetScheduledDate(...args),
}))

// Mock Calendar to capture onSelect for simulated date selection
let mockCalendarOnSelect: ((day: Date | undefined) => void) | undefined
vi.mock('../ui/calendar', () => ({
  Calendar: (props: { onSelect?: (day: Date | undefined) => void; 'data-testid'?: string }) => {
    mockCalendarOnSelect = props.onSelect
    return <div data-testid="mock-calendar">Calendar</div>
  },
}))

// Mock Popover components — render children inline, controlled by open prop
vi.mock('../ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange: _onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div data-testid="popover" data-open={String(!!open)}>
      {children}
    </div>
  ),
  PopoverTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => <>{children}</>,
  PopoverContent: ({
    children,
  }: {
    children: React.ReactNode
    align?: string
    className?: string
    onClick?: (e: React.MouseEvent) => void
    onKeyDown?: (e: React.KeyboardEvent) => void
  }) => <div data-testid="popover-content">{children}</div>,
}))

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) => (id === 'PAGE1' ? 'My Page' : undefined)),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn((id: string) => (id === 'TAG1' ? 'project' : undefined)),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
}))

vi.mock('../PageLink', () => ({
  PageLink: ({ pageId, title }: { pageId: string; title: string; className?: string }) => (
    // biome-ignore lint/a11y/useSemanticElements: test mock for PageLink
    <span
      role="link"
      tabIndex={0}
      data-testid={`page-link-${pageId}`}
      onClick={(e) => {
        e.stopPropagation()
        mockNavigateToPage(pageId, title)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') mockNavigateToPage(pageId, title)
      }}
    >
      {title}
    </span>
  ),
}))

import { toast } from 'sonner'
import { BlockListItem, type BlockListItemProps } from '../BlockListItem'

function defaultProps(overrides: Partial<BlockListItemProps> = {}): BlockListItemProps {
  return {
    content: 'Test block content',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetBlock.mockReset()
  mockSetDueDate.mockReset()
  mockSetScheduledDate.mockReset()
  mockCalendarOnSelect = undefined
})

describe('BlockListItem', () => {
  // 1. Renders truncated content text
  it('renders truncated content text', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ content: 'Hello world task' })} />
      </ul>,
    )

    expect(screen.getByText('Hello world task')).toBeInTheDocument()
  })

  // 2. Renders metadata slot before content
  it('renders metadata slot before content', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            metadata: <span data-testid="custom-icon">ICON</span>,
          })}
        />
      </ul>,
    )

    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
    expect(screen.getByText('ICON')).toBeInTheDocument()

    // Verify order: metadata appears before content
    const li = screen.getByRole('listitem')
    const icon = screen.getByTestId('custom-icon')
    const contentSpan = screen.getByText('Test block content')
    const allChildren = [...li.childNodes]
    const iconIdx = allChildren.indexOf(icon)
    const contentIdx = allChildren.indexOf(contentSpan)
    expect(iconIdx).toBeLessThan(contentIdx)
  })

  // 3. Renders breadcrumb with PageLink when breadcrumbAsLink=true (default)
  it('renders breadcrumb with PageLink by default', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: 'PAGE1',
            pageTitle: 'My Page',
          })}
        />
      </ul>,
    )

    expect(screen.getByTestId('page-link-PAGE1')).toBeInTheDocument()
    expect(screen.getByText('My Page')).toBeInTheDocument()
  })

  // 4. Renders breadcrumb as plain text when breadcrumbAsLink=false
  it('renders breadcrumb as plain text when breadcrumbAsLink=false', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: 'PAGE1',
            pageTitle: 'Plain Page',
            breadcrumbAsLink: false,
          })}
        />
      </ul>,
    )

    expect(screen.getByText(/Plain Page/)).toBeInTheDocument()
    expect(screen.queryByTestId('page-link-PAGE1')).not.toBeInTheDocument()
  })

  // 5. Hides breadcrumb when pageId is null/undefined
  it('hides breadcrumb when pageId is null', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: null,
            pageTitle: 'Hidden Page',
          })}
        />
      </ul>,
    )

    expect(screen.queryByText(/Hidden Page/)).not.toBeInTheDocument()
  })

  it('hides breadcrumb when pageId is undefined', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    // No breadcrumb span rendered at all
    const li = screen.getByRole('listitem')
    expect(li.querySelectorAll('span').length).toBe(1) // only the content span
  })

  // 6. Calls onClick handler on click
  it('calls onClick handler on click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <ul>
        <BlockListItem {...defaultProps({ onClick })} />
      </ul>,
    )

    await user.click(screen.getByRole('listitem'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  // 7. Calls onKeyDown handler on keydown
  it('calls onKeyDown handler on keydown', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()

    render(
      <ul>
        <BlockListItem {...defaultProps({ onKeyDown })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    li.focus()
    await user.keyboard('{Enter}')

    expect(onKeyDown).toHaveBeenCalled()
    expect(onKeyDown.mock.calls[0]?.[0].key).toBe('Enter')
  })

  // 8. Applies custom className to li
  it('applies custom className to li', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ className: 'custom-item hover:bg-accent/50' })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.className).toContain('custom-item')
    expect(li.className).toContain('hover:bg-accent/50')
    // Base classes still present
    expect(li.className).toContain('flex')
    expect(li.className).toContain('cursor-pointer')
  })

  // 9. Applies contentClassName and breadcrumbClassName
  it('applies contentClassName and breadcrumbClassName', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: 'P1',
            pageTitle: 'Page',
            contentClassName: 'my-content-class',
            breadcrumbClassName: 'my-breadcrumb-class',
          })}
        />
      </ul>,
    )

    const contentSpan = screen.getByText('Test block content')
    expect(contentSpan.className).toContain('my-content-class')
    // Base classes still present (line-clamp-2 is NOT a base class — callers
    // opt in via contentClassName; see UX-197).
    expect(contentSpan.className).toContain('text-sm')
    expect(contentSpan.className).not.toContain('line-clamp-2')

    const breadcrumbSpan = screen.getByText(/Page/).closest('span')
    // Go up to parent span that has the breadcrumb class (not the inner PageLink span)
    const outerBreadcrumb = breadcrumbSpan?.closest('.my-breadcrumb-class') ?? breadcrumbSpan
    expect(outerBreadcrumb?.className).toContain('my-breadcrumb-class')
  })

  // 10. Applies data-testid via testId prop
  it('applies data-testid via testId prop', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ testId: 'my-test-id' })} />
      </ul>,
    )

    expect(screen.getByTestId('my-test-id')).toBeInTheDocument()
  })

  // 11. Full content rendering — NO built-in line-clamp (UX-197)
  it('renders full content without line-clamp by default', () => {
    const longContent = 'A'.repeat(50)

    render(
      <ul>
        <BlockListItem {...defaultProps({ content: longContent, contentMaxLength: 10 })} />
      </ul>,
    )

    const contentSpan = screen.getByText(longContent)
    expect(contentSpan).toBeInTheDocument()
    // UX-197: line-clamp is opt-in via contentClassName, not a base class.
    expect(contentSpan.className).not.toContain('line-clamp-2')
  })

  // UX-197 follow-up: line-clamp is still available when callers opt in
  it('applies line-clamp when caller passes contentClassName="line-clamp-2"', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({ content: 'pill content', contentClassName: 'line-clamp-2' })}
        />
      </ul>,
    )

    const contentSpan = screen.getByText('pill content')
    expect(contentSpan.className).toContain('line-clamp-2')
  })

  // UX-195: touch min-height on the list-item container
  it('applies touch min-height utility on the li for 44px tap targets', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    // The touch-only minimum-height utility ensures embedded pills don't get clipped.
    expect(li.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('shows custom emptyContentFallback for null content', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            content: null,
            emptyContentFallback: '(no content)',
          })}
        />
      </ul>,
    )

    expect(screen.getByText('(no content)')).toBeInTheDocument()
  })

  // 12. Uses custom breadcrumbArrow
  it('uses custom breadcrumbArrow', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: 'P1',
            pageTitle: 'Arrow Page',
            breadcrumbArrow: '>>',
            breadcrumbAsLink: false,
          })}
        />
      </ul>,
    )

    expect(screen.getByText(/>> Arrow Page/)).toBeInTheDocument()
  })

  // 13. Shows fallback for null/empty content
  it('shows default "(empty)" for null content', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ content: null })} />
      </ul>,
    )

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('shows default "(empty)" for empty string content', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ content: '' })} />
      </ul>,
    )

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  // 14. A11y: li has tabIndex=0 for keyboard navigation
  it('li has tabIndex=0 for keyboard focus', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li).toHaveAttribute('tabindex', '0')
  })

  // 15. A11y audit passes (axe)
  it('a11y: no violations', async () => {
    const { container } = render(
      <ul>
        <BlockListItem
          {...defaultProps({
            metadata: <span>ICON</span>,
            pageId: 'P1',
            pageTitle: 'Test Page',
          })}
        />
      </ul>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // 16. Multiple metadata nodes render in order
  it('renders multiple metadata nodes', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            metadata: (
              <>
                <span data-testid="icon-1">A</span>
                <span data-testid="icon-2">B</span>
              </>
            ),
          })}
        />
      </ul>,
    )

    expect(screen.getByTestId('icon-1')).toBeInTheDocument()
    expect(screen.getByTestId('icon-2')).toBeInTheDocument()
  })

  // 17. Default breadcrumb arrow is "→"
  it('uses default breadcrumb arrow "→"', () => {
    render(
      <ul>
        <BlockListItem
          {...defaultProps({
            pageId: 'P1',
            pageTitle: 'Default Arrow',
            breadcrumbAsLink: false,
          })}
        />
      </ul>,
    )

    expect(screen.getByText(/\u2192 Default Arrow/)).toBeInTheDocument()
  })

  // 18. No data-testid rendered when testId is not provided
  it('does not render data-testid when testId is omitted', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.getAttribute('data-testid')).toBeNull()
  })

  // 19. Delegates content rendering to renderRichContent
  it('renders content via renderRichContent (mock returns raw markdown)', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ content: '**bold** and [[link]]' })} />
      </ul>,
    )

    expect(screen.getByText('**bold** and [[link]]')).toBeInTheDocument()
  })

  // 20. Draggable: li is not draggable when blockId is not provided
  it('is not draggable when blockId is omitted', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li).not.toHaveAttribute('draggable', 'true')
  })

  // 21. Draggable: li is draggable when blockId is provided
  it('is draggable when blockId is provided', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-123' })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li).toHaveAttribute('draggable', 'true')
  })

  // 22. Draggable: has cursor-grab class when blockId is provided
  it('has cursor-grab class when blockId is provided', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-123' })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.className).toContain('cursor-grab')
  })

  // 23. Draggable: onDragStart sets correct MIME type and blockId
  it('sets reschedule MIME type and blockId on dragStart', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-xyz' })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    const setData = vi.fn()
    const dataTransfer = {
      setData,
      effectAllowed: 'uninitialized',
    }

    fireEvent.dragStart(li, { dataTransfer })

    expect(setData).toHaveBeenCalledWith('application/x-block-reschedule', 'block-xyz')
    expect(dataTransfer.effectAllowed).toBe('move')
  })
})

// ─── isFocused prop ────────────────────────────────────────────────────────
describe('BlockListItem — isFocused prop', () => {
  it('applies ring styling when isFocused is true', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ isFocused: true })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.className).toContain('ring-2')
    expect(li.className).toContain('bg-accent/30')
  })

  it('does not apply ring styling when isFocused is false', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ isFocused: false })} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.className).not.toContain('ring-2')
    expect(li.className).not.toContain('bg-accent/30')
  })

  it('does not apply ring styling by default (prop omitted)', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    const li = screen.getByRole('listitem')
    expect(li.className).not.toContain('ring-2')
    expect(li.className).not.toContain('bg-accent/30')
  })
})

// ─── reschedule button ─────────────────────────────────────────────────────
describe('BlockListItem — reschedule button', () => {
  it('renders reschedule button when blockId is provided', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    expect(screen.getByTestId('reschedule-btn')).toBeInTheDocument()
  })

  it('does not render reschedule button when blockId is absent', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps()} />
      </ul>,
    )

    expect(screen.queryByTestId('reschedule-btn')).not.toBeInTheDocument()
  })

  it('renders calendar popover content when blockId is provided', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    // The mocked Popover always renders children inline
    expect(screen.getByTestId('mock-calendar')).toBeInTheDocument()
  })
})

// ─── handleDateSelect ──────────────────────────────────────────────────────
describe('BlockListItem — handleDateSelect', () => {
  it('calls getBlock then setDueDate on date selection (block has due_date)', async () => {
    mockGetBlock.mockResolvedValue({
      id: 'block-1',
      due_date: '2025-01-01',
      scheduled_date: null,
    })
    mockSetDueDate.mockResolvedValue({})

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    // Simulate date selection via the captured Calendar onSelect
    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 5, 15))
    })

    await waitFor(() => {
      expect(mockGetBlock).toHaveBeenCalledWith('block-1')
      expect(mockSetDueDate).toHaveBeenCalledWith('block-1', '2025-06-15')
      expect(mockSetScheduledDate).not.toHaveBeenCalled()
    })
  })

  it('calls setScheduledDate when block has scheduled_date and no due_date', async () => {
    mockGetBlock.mockResolvedValue({
      id: 'block-1',
      due_date: null,
      scheduled_date: '2025-01-01',
    })
    mockSetScheduledDate.mockResolvedValue({})

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 2, 10))
    })

    await waitFor(() => {
      expect(mockGetBlock).toHaveBeenCalledWith('block-1')
      expect(mockSetScheduledDate).toHaveBeenCalledWith('block-1', '2025-03-10')
      expect(mockSetDueDate).not.toHaveBeenCalled()
    })
  })

  it('shows success toast on successful reschedule', async () => {
    mockGetBlock.mockResolvedValue({
      id: 'block-1',
      due_date: '2025-01-01',
      scheduled_date: null,
    })
    mockSetDueDate.mockResolvedValue({})

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 0, 20))
    })

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('2025-01-20'))
    })
  })

  it('shows error toast when getBlock fails and setDueDate also fails', async () => {
    mockGetBlock.mockRejectedValue(new Error('network error'))
    // After getBlock fails, useScheduledDate stays false so setDueDate is called.
    // Make setDueDate also fail to trigger the catch block.
    mockSetDueDate.mockRejectedValue(new Error('set failed'))

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 0, 1))
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })
  })

  it('shows error toast when setDueDate fails', async () => {
    mockGetBlock.mockResolvedValue({
      id: 'block-1',
      due_date: '2025-01-01',
      scheduled_date: null,
    })
    mockSetDueDate.mockRejectedValue(new Error('set due failed'))

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1' })} />
      </ul>,
    )

    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 0, 5))
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to reschedule task')
    })
  })

  it('calls onReschedule callback and skips IPC when provided', async () => {
    const onReschedule = vi.fn()

    render(
      <ul>
        <BlockListItem {...defaultProps({ blockId: 'block-1', onReschedule })} />
      </ul>,
    )

    expect(mockCalendarOnSelect).toBeDefined()
    await waitFor(async () => {
      ;(mockCalendarOnSelect as (d: Date) => void)(new Date(2025, 7, 25))
    })

    await waitFor(() => {
      expect(onReschedule).toHaveBeenCalledWith('block-1', '2025-08-25')
    })

    // IPC should NOT be called when onReschedule is provided
    expect(mockGetBlock).not.toHaveBeenCalled()
    expect(mockSetDueDate).not.toHaveBeenCalled()
    expect(mockSetScheduledDate).not.toHaveBeenCalled()
  })
})

// ─── a11y — reschedule ─────────────────────────────────────────────────────
describe('BlockListItem — a11y reschedule', () => {
  it('passes axe audit with reschedule button visible', async () => {
    const { container } = render(
      <ul>
        <BlockListItem
          {...defaultProps({
            blockId: 'block-1',
            metadata: <span>ICON</span>,
            pageId: 'P1',
            pageTitle: 'Test Page',
          })}
        />
      </ul>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
