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

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const mockNavigateToPage = vi.fn()

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

import { BlockListItem, type BlockListItemProps } from '../BlockListItem'

function defaultProps(overrides: Partial<BlockListItemProps> = {}): BlockListItemProps {
  return {
    content: 'Test block content',
    ...overrides,
  }
}

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
    // Base classes still present
    expect(contentSpan.className).toContain('truncate')

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

  // 11. Uses custom contentMaxLength and emptyContentFallback
  it('truncates content at custom maxLength', () => {
    const longContent = 'A'.repeat(50)

    render(
      <ul>
        <BlockListItem {...defaultProps({ content: longContent, contentMaxLength: 10 })} />
      </ul>,
    )

    expect(screen.getByText('AAAAAAAAAA...')).toBeInTheDocument()
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

  // 19. Strips markdown from content via truncateContent
  it('strips markdown formatting from content', () => {
    render(
      <ul>
        <BlockListItem {...defaultProps({ content: '**bold** and [[link]]' })} />
      </ul>,
    )

    expect(screen.getByText('bold and link')).toBeInTheDocument()
  })
})
