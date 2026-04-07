/**
 * Tests for PageTreeItem component.
 *
 * Validates:
 *  - Renders leaf page with name and file icon
 *  - Click on leaf triggers onNavigate
 *  - Renders namespace folder with chevron and children
 *  - Expand/collapse toggles children visibility
 *  - forceExpand overrides collapse state
 *  - Renders hybrid node (page + namespace)
 *  - Delete button calls onDelete
 *  - Create-under button calls onCreateUnder
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PageTreeNode } from '../../lib/page-tree'
import { PageTreeItem } from '../PageTreeItem'

beforeEach(() => {
  vi.clearAllMocks()
})

/** Helper: create a leaf node (page with no children). */
function makeLeaf(name: string, fullPath: string, pageId: string): PageTreeNode {
  return { name, fullPath, pageId, children: [] }
}

/** Helper: create a namespace node (no pageId, with children). */
function makeNamespace(name: string, fullPath: string, children: PageTreeNode[]): PageTreeNode {
  return { name, fullPath, children }
}

/** Helper: create a hybrid node (has pageId and children). */
function makeHybrid(
  name: string,
  fullPath: string,
  pageId: string,
  children: PageTreeNode[],
): PageTreeNode {
  return { name, fullPath, pageId, children }
}

const defaultProps = {
  depth: 0,
  onNavigate: vi.fn(),
  onCreateUnder: vi.fn(),
  filterText: '',
  forceExpand: false,
}

describe('PageTreeItem', () => {
  describe('leaf node', () => {
    it('renders the page name', () => {
      const node = makeLeaf('My Page', 'My Page', 'P1')
      render(<PageTreeItem node={node} {...defaultProps} />)

      expect(screen.getByText('My Page')).toBeInTheDocument()
    })

    it('calls onNavigate with pageId and fullPath on click', async () => {
      const user = userEvent.setup()
      const onNavigate = vi.fn()
      const node = makeLeaf('My Page', 'work/My Page', 'P1')
      render(<PageTreeItem node={node} {...defaultProps} onNavigate={onNavigate} />)

      await user.click(screen.getByText('My Page'))
      expect(onNavigate).toHaveBeenCalledWith('P1', 'work/My Page')
    })

    it('shows delete button when onDelete is provided', () => {
      const onDelete = vi.fn()
      const node = makeLeaf('Deletable', 'Deletable', 'P1')
      render(<PageTreeItem node={node} {...defaultProps} onDelete={onDelete} />)

      expect(screen.getByRole('button', { name: /Delete Deletable/ })).toBeInTheDocument()
    })

    it('calls onDelete when delete button is clicked', async () => {
      const user = userEvent.setup()
      const onDelete = vi.fn()
      const node = makeLeaf('Deletable', 'ns/Deletable', 'P1')
      render(<PageTreeItem node={node} {...defaultProps} onDelete={onDelete} />)

      await user.click(screen.getByRole('button', { name: /Delete ns\/Deletable/ }))
      expect(onDelete).toHaveBeenCalledWith('P1', 'ns/Deletable')
    })

    it('does not show delete button when onDelete is not provided', () => {
      const node = makeLeaf('My Page', 'My Page', 'P1')
      render(<PageTreeItem node={node} {...defaultProps} />)

      expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
    })
  })

  describe('namespace folder', () => {
    it('renders namespace name and children', () => {
      const child = makeLeaf('child-page', 'ns/child-page', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      expect(screen.getByText('ns')).toBeInTheDocument()
      // Children are visible by default (expanded = true)
      expect(screen.getByText('child-page')).toBeInTheDocument()
    })

    it('collapses children when namespace button is clicked', async () => {
      const user = userEvent.setup()
      const child = makeLeaf('child-page', 'ns/child-page', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      // Initially expanded
      expect(screen.getByText('child-page')).toBeInTheDocument()

      // Click to collapse
      await user.click(screen.getByText('ns'))
      expect(screen.queryByText('child-page')).not.toBeInTheDocument()

      // Click again to expand
      await user.click(screen.getByText('ns'))
      expect(screen.getByText('child-page')).toBeInTheDocument()
    })

    it('does not collapse when forceExpand is true', async () => {
      const user = userEvent.setup()
      const child = makeLeaf('child-page', 'ns/child-page', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} forceExpand={true} />)

      // Click namespace button — should not collapse
      await user.click(screen.getByText('ns'))
      expect(screen.getByText('child-page')).toBeInTheDocument()
    })

    it('shows create-under button', () => {
      const child = makeLeaf('child', 'ns/child', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      expect(screen.getByRole('button', { name: /Create page under ns/ })).toBeInTheDocument()
    })

    it('calls onCreateUnder when create button is clicked', async () => {
      const user = userEvent.setup()
      const onCreateUnder = vi.fn()
      const child = makeLeaf('child', 'ns/child', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} onCreateUnder={onCreateUnder} />)

      await user.click(screen.getByRole('button', { name: /Create page under ns/ }))
      expect(onCreateUnder).toHaveBeenCalledWith('ns')
    })
  })

  describe('hybrid node (page + namespace)', () => {
    it('renders name and children', () => {
      const child = makeLeaf('sub-page', 'work/sub-page', 'P2')
      const node = makeHybrid('work', 'work', 'P1', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      expect(screen.getByText('work')).toBeInTheDocument()
      expect(screen.getByText('sub-page')).toBeInTheDocument()
    })

    it('navigates to page when name is clicked', async () => {
      const user = userEvent.setup()
      const onNavigate = vi.fn()
      const child = makeLeaf('sub-page', 'work/sub-page', 'P2')
      const node = makeHybrid('work', 'work', 'P1', [child])
      render(<PageTreeItem node={node} {...defaultProps} onNavigate={onNavigate} />)

      await user.click(screen.getByText('work'))
      expect(onNavigate).toHaveBeenCalledWith('P1', 'work')
    })

    it('toggles children via chevron button', async () => {
      const user = userEvent.setup()
      const child = makeLeaf('sub-page', 'work/sub-page', 'P2')
      const node = makeHybrid('work', 'work', 'P1', [child])
      const { container } = render(<PageTreeItem node={node} {...defaultProps} />)

      // Initially expanded
      expect(screen.getByText('sub-page')).toBeInTheDocument()

      // Click the chevron (first button in the row)
      // biome-ignore lint/style/noNonNullAssertion: button known to exist after render
      const chevronBtn = container.querySelector('button')!
      await user.click(chevronBtn)
      expect(screen.queryByText('sub-page')).not.toBeInTheDocument()
    })
  })

  it('has no a11y violations for leaf node', async () => {
    const node = makeLeaf('Accessible Page', 'Accessible Page', 'P1')
    const { container } = render(<PageTreeItem node={node} {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations for namespace node', async () => {
    const child = makeLeaf('child', 'ns/child', 'P1')
    const node = makeNamespace('ns', 'ns', [child])
    const { container } = render(<PageTreeItem node={node} {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  describe('touch-target classes on Plus buttons', () => {
    const touchClasses = [
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-1',
      '[@media(pointer:coarse)]:opacity-100',
      '[@media(pointer:coarse)]:h-[44px]',
      '[@media(pointer:coarse)]:w-[44px]',
      'active:bg-accent',
      'active:scale-95',
    ]

    it('namespace Plus button has touch-target classes', () => {
      const child = makeLeaf('child', 'ns/child', 'P1')
      const node = makeNamespace('ns', 'ns', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      const btn = screen.getByRole('button', { name: /Create page under ns/ })
      for (const cls of touchClasses) {
        expect(btn.className).toContain(cls)
      }
    })

    it('hybrid Plus button has touch-target classes', () => {
      const child = makeLeaf('sub', 'work/sub', 'P2')
      const node = makeHybrid('work', 'work', 'P1', [child])
      render(<PageTreeItem node={node} {...defaultProps} />)

      const btn = screen.getByRole('button', { name: /Create page under work/ })
      for (const cls of touchClasses) {
        expect(btn.className).toContain(cls)
      }
    })
  })
})
