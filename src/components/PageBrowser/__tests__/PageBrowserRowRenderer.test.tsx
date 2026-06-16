/**
 * PEND-58d T-F4 — PageBrowserRowRenderer tests.
 *
 * `PageBrowserRowRenderer` is the per-row dispatcher inside the
 * `PageBrowser` virtualizer. It branches on `row.kind`:
 *
 *   - `header`    → `HeaderRow`     (section header: Starred / Pages)
 *   - `tree-page` → `TreePageRow`   (recursive `PageTreeItem` wrapper)
 *   - `page`      → `DensityPageRow` (metadata-aware, density-aware leaf)
 *
 * These tests drive each branch.
 *
 * Rows are never rendered standalone in the app — the real viewport is a
 * `role="grid"`. We wrap every render in a `role="grid"` scaffold so the
 * row's `role="row"` satisfies axe's `aria-required-parent` rule.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { PageBrowserRow } from '@/hooks/usePageBrowserGrouping'
import type { PageTreeNode } from '@/lib/page-tree'
import type { BlockRow } from '@/lib/tauri'

import { PageBrowserRowRenderer, type PageBrowserRowRendererProps } from '../PageBrowserRowRenderer'

/** Minimal `VirtualItem` — only `key`/`index`/`start` are read by the renderer. */
function virtualRow(index = 0): PageBrowserRowRendererProps['virtualRow'] {
  return { key: `row-${index}`, index, start: index * 44, end: index * 44 + 44, size: 44, lane: 0 }
}

/** Minimal `BlockRow` page payload. */
function blockRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'page-1',
    block_type: 'page',
    content: 'Project Alpha',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    ...overrides,
  }
}

/** A leaf tree node (single segment, no children). */
function treeNode(overrides: Partial<PageTreeNode> = {}): PageTreeNode {
  return {
    name: 'work',
    fullPath: 'work',
    pageId: 'tree-page-1',
    children: [],
    ...overrides,
  }
}

/**
 * Build the full prop bag. `row` is required (it drives the branch); the
 * rest default to inert values and can be overridden per-test.
 */
function baseProps(
  row: PageBrowserRow,
  overrides: Partial<PageBrowserRowRendererProps> = {},
): PageBrowserRowRendererProps {
  return {
    virtualRow: virtualRow(0),
    row,
    measureElement: vi.fn(),
    focusedIndex: -1,
    hasStarred: false,
    sectionLabelId: 'section-label',
    filterText: '',
    isFiltering: false,
    aliasMatchId: null,
    deletingId: null,
    isStarred: () => false,
    toggleStar: vi.fn(),
    onPageSelect: vi.fn(),
    onCreateUnder: vi.fn(),
    onDeleteRequest: vi.fn(),
    density: 'regular',
    selectedIds: new Set<string>(),
    onToggleMultiSelect: vi.fn(),
    ...overrides,
  }
}

/** Render a single row inside a `role="grid"` scaffold (mirrors the viewport). */
function renderRow(props: PageBrowserRowRendererProps) {
  return render(
    <div role="grid" aria-label="pages">
      <PageBrowserRowRenderer {...props} />
    </div>,
  )
}

describe('PageBrowserRowRenderer — page leaf (DensityRow)', () => {
  const pageRow: Extract<PageBrowserRow, { kind: 'page' }> = {
    kind: 'page',
    page: blockRow({ id: 'leaf-1', content: 'Project Alpha' }),
    pageIndex: 0,
  }

  it('renders the DensityRow leaf variant (data-density present)', () => {
    const { container } = renderRow(baseProps(pageRow, { density: 'regular' }))
    const densityLeaf = container.querySelector('[data-page-item][data-density="regular"]')
    expect(densityLeaf).not.toBeNull()
    // The DensityRow uses a stable id derived from the page id.
    expect(container.querySelector('#page-row-leaf-1')).not.toBeNull()
    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
  })

  it('threads the active density through to the DensityRow body', () => {
    const { container } = renderRow(baseProps(pageRow, { density: 'compact' }))
    expect(container.querySelector('[data-page-item][data-density="compact"]')).not.toBeNull()
    expect(container.querySelector('[data-page-item][data-density="regular"]')).toBeNull()
  })
})

describe('PageBrowserRowRenderer — header rows', () => {
  it('renders the Starred section header (not a page leaf)', () => {
    const headerRow: PageBrowserRow = { kind: 'header', section: 'starred', count: 3 }
    const { container } = renderRow(baseProps(headerRow, { hasStarred: true }))
    const section = container.querySelector('[data-page-section="starred"]')
    expect(section).not.toBeNull()
    // Visible label + count.
    expect(screen.getByText('Starred')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    // Accessible label carries the count via the labelledby span.
    expect(screen.getByText('Starred, 3 pages')).toBeInTheDocument()
    // Not a page leaf, not a tree row.
    expect(container.querySelector('[data-page-item]')).toBeNull()
    expect(container.querySelector('[data-page-tree-row]')).toBeNull()
  })

  it('renders the Pages section header with a divider when starred precedes it', () => {
    const headerRow: PageBrowserRow = { kind: 'header', section: 'pages', count: 7 }
    const { container } = renderRow(baseProps(headerRow, { hasStarred: true }))
    const section = container.querySelector('[data-page-section="pages"]')
    expect(section).not.toBeNull()
    expect(screen.getByText('Pages')).toBeInTheDocument()
    // `hasStarred` adds a top border to separate the two groups.
    expect(section?.className).toContain('border-t')
  })

  it('omits the divider on the Pages header when there is no Starred section', () => {
    const headerRow: PageBrowserRow = { kind: 'header', section: 'pages', count: 2 }
    const { container } = renderRow(baseProps(headerRow, { hasStarred: false }))
    const section = container.querySelector('[data-page-section="pages"]')
    expect(section?.className).not.toContain('border-t')
  })
})

describe('PageBrowserRowRenderer — tree-page rows', () => {
  it('renders the tree-page wrapper hosting a PageTreeItem leaf', () => {
    const treeRow: PageBrowserRow = {
      kind: 'tree-page',
      node: treeNode({ name: 'work', fullPath: 'work', pageId: 'tp-1', children: [] }),
      pageIndex: 0,
      depth: 0,
    }
    const { container } = renderRow(baseProps(treeRow))
    const wrapper = container.querySelector('[data-page-tree-row]')
    expect(wrapper).not.toBeNull()
    // Stable activedescendant id keyed off the node fullPath.
    expect(container.querySelector('#page-row-work')).not.toBeNull()
    // The inner PageTreeItem renders the segment name.
    expect(screen.getByText('work')).toBeInTheDocument()
    // Not a flat page leaf.
    expect(container.querySelector('[data-page-item]')).toBeNull()
  })

  it('renders a namespace tree-page with indentation/affordances for children', () => {
    // Pure namespace node (no pageId, has children) — PageTreeItem renders
    // the collapsible folder with a nested leaf at depth+1. `pageId` is
    // omitted entirely (not set to `undefined`) for exactOptionalPropertyTypes.
    const namespaceNode: PageTreeNode = {
      name: 'projects',
      fullPath: 'projects',
      children: [
        treeNode({ name: 'alpha', fullPath: 'projects/alpha', pageId: 'child-1', children: [] }),
      ],
    }
    const treeRow: PageBrowserRow = {
      kind: 'tree-page',
      node: namespaceNode,
      pageIndex: 0,
      depth: 0,
    }
    const { container } = renderRow(baseProps(treeRow, { isFiltering: true }))
    expect(container.querySelector('[data-page-tree-row]')).not.toBeNull()
    expect(screen.getByText('projects')).toBeInTheDocument()
    // The nested child renders below the namespace folder (forceExpand via
    // isFiltering keeps it visible).
    expect(screen.getByText('alpha')).toBeInTheDocument()
    // The "create under" affordance for the namespace is present.
    expect(screen.getByRole('button', { name: /create.*projects/i })).toBeInTheDocument()
  })

  it('marks the focused tree-page row via a focus ring on the wrapper', () => {
    const treeRow: PageBrowserRow = {
      kind: 'tree-page',
      node: treeNode({ name: 'work', fullPath: 'work', pageId: 'tp-1', children: [] }),
      pageIndex: 2,
      depth: 0,
    }
    const { container } = renderRow(baseProps(treeRow, { focusedIndex: 2 }))
    const wrapper = container.querySelector('[data-page-tree-row]')
    expect(wrapper?.className).toContain('ring-2')
  })
})

describe('PageBrowserRowRenderer — a11y', () => {
  it('has no a11y violations for a density leaf row', async () => {
    const pageRow: PageBrowserRow = {
      kind: 'page',
      page: blockRow({ id: 'leaf-axe', content: 'Roadmap' }),
      pageIndex: 0,
    }
    const { container } = renderRow(baseProps(pageRow, { density: 'regular' }))
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  }, 20_000)
})
