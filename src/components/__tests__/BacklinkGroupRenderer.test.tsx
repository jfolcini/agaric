/**
 * Tests for BacklinkGroupRenderer component.
 *
 * Validates:
 *  - Renders group header with title and block count
 *  - Expand/collapse toggling hides/shows blocks
 *  - Renders child block items with badge, content, truncated ID
 *  - Handles multiple groups
 *  - Handles null page_title (shows "Untitled")
 *  - Clicking block item invokes handleBlockClick
 *  - Keyboard navigation invokes handleBlockKeyDown
 *  - a11y compliance with axe
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Component, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BacklinkGroup, BlockRow } from '../../lib/tauri'
import { BacklinkGroupRenderer } from '../BacklinkGroupRenderer'
import { renderRichContent } from '../StaticBlock'

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
      onClick={(e) => e.stopPropagation()}
    >
      {title}
    </button>
  ),
}))

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((content: string, _options?: unknown) => content),
}))

function makeBlock(id: string, content: string | null): BlockRow {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: 'P1',
    position: 1,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  }
}

function makeGroup(pageId: string, pageTitle: string | null, blocks: BlockRow[]): BacklinkGroup {
  return { page_id: pageId, page_title: pageTitle, blocks }
}

const defaultResolvers = {
  resolveBlockTitle: (id: string) => `Title:${id}`,
  resolveBlockStatus: () => 'active' as const,
  resolveTagName: (id: string) => `Tag:${id}`,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BacklinkGroupRenderer', () => {
  it('renders group header with title and block count', () => {
    const groups = [makeGroup('P1', 'My Page', [makeBlock('B1', 'block content')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('My Page (1)')).toBeInTheDocument()
  })

  it('renders collapsed group without showing blocks', () => {
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'hidden block')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: false }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('Page One (1)')).toBeInTheDocument()
    expect(screen.queryByText('hidden block')).not.toBeInTheDocument()
  })

  it('renders expanded group with blocks visible', () => {
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'visible block')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('visible block')).toBeInTheDocument()
  })

  it('calls onToggleGroup when header is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'block')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={onToggle}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    await user.click(screen.getByText('Page One (1)'))
    expect(onToggle).toHaveBeenCalledWith('P1')
  })

  it('renders child blocks with badge, content, and truncated ID', () => {
    const groups = [makeGroup('P1', 'Page', [makeBlock('01HAAAAA00000000000001', 'My block text')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    // Badge
    expect(screen.getByText('content')).toBeInTheDocument()
    // Content
    expect(screen.getByText('My block text')).toBeInTheDocument()
    // Truncated ID
    expect(screen.getByText('01HAAAAA...')).toBeInTheDocument()
  })

  it('handles null page_title with "Untitled"', () => {
    const groups = [makeGroup('P1', null, [makeBlock('B1', 'block')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('Untitled (1)')).toBeInTheDocument()
  })

  it('renders multiple groups', () => {
    const groups = [
      makeGroup('P1', 'Page One', [makeBlock('B1', 'block 1')]),
      makeGroup('P2', 'Page Two', [makeBlock('B2', 'block 2'), makeBlock('B3', 'block 3')]),
    ]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true, P2: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('Page One (1)')).toBeInTheDocument()
    expect(screen.getByText('Page Two (2)')).toBeInTheDocument()
    expect(screen.getByText('block 1')).toBeInTheDocument()
    expect(screen.getByText('block 2')).toBeInTheDocument()
    expect(screen.getByText('block 3')).toBeInTheDocument()
  })

  it('calls handleBlockClick when a block item is clicked', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const block = makeBlock('B1', 'clickable block')
    const groups = [makeGroup('P1', 'Page', [block])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={onClick}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    await user.click(screen.getByText('clickable block'))
    expect(onClick).toHaveBeenCalledWith(block)
  })

  it('calls handleBlockKeyDown on keyboard events', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    const block = makeBlock('B1', 'keyboard block')
    const groups = [makeGroup('P1', 'Page', [block])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={onKeyDown}
        {...defaultResolvers}
      />,
    )

    const blockEl = screen.getByText('keyboard block')
    const li = blockEl.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onKeyDown).toHaveBeenCalled()
    expect(onKeyDown.mock.calls[0]?.[1]).toEqual(block)
  })

  it('shows "Empty" for blocks with null content', () => {
    const groups = [makeGroup('P1', 'Page', [makeBlock('B1', null)])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('has accessible aria-label on block lists', () => {
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'block')])]

    render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    expect(screen.getByLabelText('Backlinks from Page One')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'accessible block')])]

    const { container } = render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: true }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with collapsed group', async () => {
    const groups = [makeGroup('P1', 'Page One', [makeBlock('B1', 'hidden block')])]

    const { container } = render(
      <BacklinkGroupRenderer
        groups={groups}
        expandedGroups={{ P1: false }}
        onToggleGroup={vi.fn()}
        handleBlockClick={vi.fn()}
        handleBlockKeyDown={vi.fn()}
        {...defaultResolvers}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  /*
   * BacklinkGroupRenderer is purely presentational — it contains no invoke
   * calls and no async work. Error-path tests below cover synchronous render
   * failures (renderRichContent throwing) and data edge cases that upstream
   * invoke failures would produce (empty groups, zero blocks, all-null content).
   */

  describe('error paths', () => {
    it('renders nothing when groups array is empty', () => {
      const { container } = render(
        <BacklinkGroupRenderer
          groups={[]}
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          handleBlockClick={vi.fn()}
          handleBlockKeyDown={vi.fn()}
          {...defaultResolvers}
        />,
      )

      expect(container.querySelector('.linked-references-group')).toBeNull()
    })

    it('renders group header but no block items when group has zero blocks', () => {
      const groups = [makeGroup('P1', 'Empty Page', [])]

      render(
        <BacklinkGroupRenderer
          groups={groups}
          expandedGroups={{ P1: true }}
          onToggleGroup={vi.fn()}
          handleBlockClick={vi.fn()}
          handleBlockKeyDown={vi.fn()}
          {...defaultResolvers}
        />,
      )

      expect(screen.getByText('Empty Page (0)')).toBeInTheDocument()
      expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    })

    it('propagates render error when renderRichContent throws', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const caughtError = { current: null as Error | null }
      const mockFn = vi.mocked(renderRichContent)

      class TestErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
        state = { hasError: false }
        static getDerivedStateFromError() {
          return { hasError: true }
        }
        componentDidCatch(error: Error) {
          caughtError.current = error
        }
        render() {
          return this.state.hasError ? (
            <div data-testid="error-fallback">error</div>
          ) : (
            this.props.children
          )
        }
      }

      // Persistent mock — React 18 retries render after errors, so
      // mockImplementationOnce is consumed on the first attempt and the
      // retry succeeds with the default. Use mockImplementation instead.
      mockFn.mockImplementation(() => {
        throw new Error('parse failure')
      })

      const groups = [makeGroup('P1', 'Page', [makeBlock('B1', 'bad content')])]

      render(
        <TestErrorBoundary>
          <BacklinkGroupRenderer
            groups={groups}
            expandedGroups={{ P1: true }}
            onToggleGroup={vi.fn()}
            handleBlockClick={vi.fn()}
            handleBlockKeyDown={vi.fn()}
            {...defaultResolvers}
          />
        </TestErrorBoundary>,
      )

      expect(screen.getByTestId('error-fallback')).toBeInTheDocument()
      expect(caughtError.current).toBeInstanceOf(Error)
      expect(caughtError.current?.message).toBe('parse failure')

      // Restore default mock for subsequent tests
      mockFn.mockImplementation((content: string) => content)
      consoleSpy.mockRestore()
    })

    it('renders "(empty)" for every null-content block in a group', () => {
      const groups = [
        makeGroup('P1', 'Page', [
          makeBlock('B1', null),
          makeBlock('B2', null),
          makeBlock('B3', 'valid'),
        ]),
      ]

      render(
        <BacklinkGroupRenderer
          groups={groups}
          expandedGroups={{ P1: true }}
          onToggleGroup={vi.fn()}
          handleBlockClick={vi.fn()}
          handleBlockKeyDown={vi.fn()}
          {...defaultResolvers}
        />,
      )

      const empties = screen.getAllByText('(empty)')
      expect(empties).toHaveLength(2)
      expect(screen.getByText('valid')).toBeInTheDocument()
    })
  })
})
