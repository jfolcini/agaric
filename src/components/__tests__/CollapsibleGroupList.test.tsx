/**
 * Tests for CollapsibleGroupList component.
 *
 * Validates:
 *  - Renders all group headers with titles and counts
 *  - Shows expanded groups' blocks
 *  - Hides collapsed groups' blocks
 *  - Calls onToggleGroup when header clicked
 *  - Shows chevron down for expanded, right for collapsed
 *  - Uses untitledLabel for null page_title
 *  - Renders blocks via renderBlock prop
 *  - Respects defaultExpanded prop
 *  - Sets aria-expanded correctly
 *  - Applies custom classNames
 *  - axe a11y audit
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { GroupItem } from '../CollapsibleGroupList'
import { CollapsibleGroupList } from '../CollapsibleGroupList'

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
}))

vi.mock('../PageLink', () => ({
  PageLink: ({
    pageId,
    title,
    className,
  }: {
    pageId: string
    title: string
    className?: string
  }) => (
    <button
      type="button"
      data-testid={`page-link-${pageId}`}
      className={className}
      onClick={(e) => {
        e.stopPropagation()
        // The real PageLink calls navigateToPage; in tests we verify via onPageTitleClick
      }}
    >
      {title}
    </button>
  ),
}))

function makeGroup(
  pageId: string,
  pageTitle: string | null,
  blocks: Array<{ id: string; content: string }>,
): GroupItem & { blocks: Array<{ id: string; content: string }> } {
  return {
    page_id: pageId,
    page_title: pageTitle,
    blocks,
  }
}

const defaultRenderBlock = (block: { id: string; content: string }) => (
  <li key={block.id} data-testid={`block-${block.id}`}>
    {block.content}
  </li>
)

describe('CollapsibleGroupList', () => {
  // 1. Renders all group headers with titles and counts
  it('renders all group headers with titles and counts', () => {
    const groups = [
      makeGroup('P1', 'Alpha Page', [
        { id: 'B1', content: 'block 1' },
        { id: 'B2', content: 'block 2' },
      ]),
      makeGroup('P2', 'Beta Page', [{ id: 'B3', content: 'block 3' }]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('Alpha Page (2)')).toBeInTheDocument()
    expect(screen.getByText('Beta Page (1)')).toBeInTheDocument()
  })

  // 2. Shows expanded groups' blocks
  it('shows expanded groups blocks', () => {
    const groups = [
      makeGroup('P1', 'Page One', [
        { id: 'B1', content: 'visible block 1' },
        { id: 'B2', content: 'visible block 2' },
      ]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('visible block 1')).toBeInTheDocument()
    expect(screen.getByText('visible block 2')).toBeInTheDocument()
  })

  // 3. Hides collapsed groups' blocks
  it('hides collapsed groups blocks', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'hidden block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: false }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.queryByText('hidden block')).not.toBeInTheDocument()
  })

  // 4. Calls onToggleGroup when header clicked
  it('calls onToggleGroup when header clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={onToggle}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    await user.click(screen.getByText('Page One (1)'))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('P1')
  })

  // 5. Shows chevron down for expanded, right for collapsed
  it('shows chevron down for expanded, right for collapsed', () => {
    const groups = [
      makeGroup('P1', 'Expanded', [{ id: 'B1', content: 'b1' }]),
      makeGroup('P2', 'Collapsed', [{ id: 'B2', content: 'b2' }]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true, P2: false }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    const expandedHeader = screen.getByText('Expanded (1)').closest('button') as HTMLElement
    const collapsedHeader = screen.getByText('Collapsed (1)').closest('button') as HTMLElement

    expect(within(expandedHeader).getByTestId('chevron-down')).toBeInTheDocument()
    expect(within(collapsedHeader).getByTestId('chevron-right')).toBeInTheDocument()
  })

  // 6. Uses untitledLabel for null page_title
  it('uses untitledLabel for null page_title', () => {
    const groups = [makeGroup('P1', null, [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        untitledLabel="No Title"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('No Title (1)')).toBeInTheDocument()
  })

  // 7. Renders blocks via renderBlock prop
  it('renders blocks via renderBlock prop', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'custom render' }])]

    const customRender = (block: { id: string; content: string }) => (
      <li key={block.id} data-testid="custom-block">
        <strong>{block.content}</strong>
      </li>
    )

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={customRender}
      />,
    )

    expect(screen.getByTestId('custom-block')).toBeInTheDocument()
    expect(screen.getByText('custom render')).toBeInTheDocument()
  })

  // 8. Respects defaultExpanded=true
  it('respects defaultExpanded=true — groups expand when not in expandedGroups', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'default expanded' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        defaultExpanded
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('default expanded')).toBeInTheDocument()
  })

  // 9. Respects defaultExpanded=false (default)
  it('respects defaultExpanded=false — groups collapse when not in expandedGroups', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'default collapsed' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.queryByText('default collapsed')).not.toBeInTheDocument()
  })

  // 10. Sets aria-expanded correctly
  it('sets aria-expanded correctly', () => {
    const groups = [
      makeGroup('P1', 'Expanded', [{ id: 'B1', content: 'b1' }]),
      makeGroup('P2', 'Collapsed', [{ id: 'B2', content: 'b2' }]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true, P2: false }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    const expandedBtn = screen.getByText('Expanded (1)').closest('button') as HTMLElement
    const collapsedBtn = screen.getByText('Collapsed (1)').closest('button') as HTMLElement

    expect(expandedBtn).toHaveAttribute('aria-expanded', 'true')
    expect(collapsedBtn).toHaveAttribute('aria-expanded', 'false')
  })

  // 11. Applies custom classNames
  it('applies custom classNames', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    const { container } = render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        groupClassName="my-group"
        headerClassName="my-header"
        listClassName="my-list"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(container.querySelector('.my-group')).toBeInTheDocument()
    expect(container.querySelector('.my-header')).toBeInTheDocument()
    expect(container.querySelector('.my-list')).toBeInTheDocument()
  })

  // 12. listAriaLabel is applied to <ul>
  it('applies listAriaLabel to the block list', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        listAriaLabel={(title) => `Blocks from ${title}`}
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByLabelText('Blocks from Page One')).toBeInTheDocument()
  })

  // 13. listAriaLabel uses untitledLabel for null titles
  it('listAriaLabel uses untitledLabel for null page_title', () => {
    const groups = [makeGroup('P1', null, [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="No Title"
        listAriaLabel={(title) => `Blocks from ${title}`}
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByLabelText('Blocks from No Title')).toBeInTheDocument()
  })

  // 14. Renders empty when groups is empty
  it('renders nothing when groups is empty', () => {
    const { container } = render(
      <CollapsibleGroupList
        groups={[]}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  // 15. renderBlock receives the group as second argument
  it('renderBlock receives the group as second argument', () => {
    const groups = [makeGroup('P1', 'Source Page', [{ id: 'B1', content: 'block' }])]

    const renderBlock = vi.fn((block: { id: string; content: string }) => (
      <li key={block.id}>{block.content}</li>
    ))

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={renderBlock}
      />,
    )

    expect(renderBlock).toHaveBeenCalledWith({ id: 'B1', content: 'block' }, groups[0])
  })

  // 16. Multiple groups can be independently expanded/collapsed
  it('multiple groups can be independently expanded/collapsed', () => {
    const groups = [
      makeGroup('P1', 'Expanded Page', [{ id: 'B1', content: 'expanded block' }]),
      makeGroup('P2', 'Collapsed Page', [{ id: 'B2', content: 'collapsed block' }]),
      makeGroup('P3', 'Also Expanded', [{ id: 'B3', content: 'also visible' }]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true, P2: false, P3: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('expanded block')).toBeInTheDocument()
    expect(screen.queryByText('collapsed block')).not.toBeInTheDocument()
    expect(screen.getByText('also visible')).toBeInTheDocument()
  })

  // 17. Uses default header/list classes when no custom classes provided
  it('uses default classes when no custom classNames', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    const { container } = render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    const button = container.querySelector('button')
    expect(button?.className).toContain('flex w-full items-center gap-2')

    const ul = container.querySelector('ul')
    expect(ul?.className).toContain('ml-4 mt-1 space-y-1')
  })

  // 18. a11y: no violations
  it('a11y: no violations', async () => {
    const groups = [
      makeGroup('P1', 'Page One', [
        { id: 'B1', content: 'accessible block 1' },
        { id: 'B2', content: 'accessible block 2' },
      ]),
      makeGroup('P2', 'Page Two', [{ id: 'B3', content: 'accessible block 3' }]),
    ]

    const { container } = render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true, P2: false }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        listAriaLabel={(title) => `Blocks from ${title}`}
        renderBlock={defaultRenderBlock}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ---------------------------------------------------------------------------
  // onPageTitleClick tests
  // ---------------------------------------------------------------------------

  // 19. When onPageTitleClick provided, clicking title renders PageLink with correct props
  it('when onPageTitleClick is provided, renders PageLink for the title', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        onPageTitleClick={vi.fn()}
        renderBlock={defaultRenderBlock}
      />,
    )

    // PageLink renders a button with data-testid="page-link-P1"
    const pageLink = screen.getByTestId('page-link-P1')
    expect(pageLink).toBeInTheDocument()
    expect(pageLink).toHaveTextContent('Page One')
  })

  // 20. When onPageTitleClick provided, chevron still toggles group
  it('when onPageTitleClick is provided, chevron still toggles group', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={onToggle}
        untitledLabel="Untitled"
        onPageTitleClick={vi.fn()}
        renderBlock={defaultRenderBlock}
      />,
    )

    // Click the chevron button (the one with aria-expanded)
    const chevronBtn = screen.getByRole('button', { expanded: true })
    await user.click(chevronBtn)

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('P1')
  })

  // 21. When onPageTitleClick is NOT provided, clicking title toggles group (backward compat)
  it('when onPageTitleClick is not provided, clicking title toggles group', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{}}
        onToggleGroup={onToggle}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    await user.click(screen.getByText('Page One (1)'))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('P1')
  })

  // 22. When onPageTitleClick is NOT provided, title is not a PageLink
  it('when onPageTitleClick is not provided, no PageLink is rendered', () => {
    const groups = [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block' }])]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.queryByTestId('page-link-P1')).not.toBeInTheDocument()
  })

  // 23. When onPageTitleClick provided, count is rendered as passive span
  it('when onPageTitleClick is provided, count is rendered as passive span', () => {
    const groups = [
      makeGroup('P1', 'Page One', [
        { id: 'B1', content: 'block 1' },
        { id: 'B2', content: 'block 2' },
      ]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        onPageTitleClick={vi.fn()}
        renderBlock={defaultRenderBlock}
      />,
    )

    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  // 24. When onPageTitleClick provided, aria-expanded stays on the chevron button
  it('when onPageTitleClick is provided, aria-expanded stays on chevron button', () => {
    const groups = [
      makeGroup('P1', 'Expanded', [{ id: 'B1', content: 'b1' }]),
      makeGroup('P2', 'Collapsed', [{ id: 'B2', content: 'b2' }]),
    ]

    render(
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={{ P1: true, P2: false }}
        onToggleGroup={vi.fn()}
        untitledLabel="Untitled"
        onPageTitleClick={vi.fn()}
        renderBlock={defaultRenderBlock}
      />,
    )

    const expandedBtn = screen.getByRole('button', { expanded: true })
    const collapsedBtn = screen.getByRole('button', { expanded: false })

    expect(expandedBtn).toHaveAttribute('aria-expanded', 'true')
    expect(collapsedBtn).toHaveAttribute('aria-expanded', 'false')

    // These should be chevron buttons, not the entire header
    expect(within(expandedBtn).getByTestId('chevron-down')).toBeInTheDocument()
    expect(within(collapsedBtn).getByTestId('chevron-right')).toBeInTheDocument()
  })
})
