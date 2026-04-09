/**
 * Tests for PageOutline component.
 *
 * Validates:
 *  - Renders heading list from blocks with `# `, `## ` prefixes
 *  - Indents headings by level
 *  - Shows empty state when no headings found
 *  - Click heading calls scrollIntoView
 *  - extractHeadings utility correctness
 *  - Axe a11y audit passes
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'
import { createStore } from 'zustand'
import type { FlatBlock } from '../../stores/page-blocks'
import { PageBlockContext, type PageBlockState } from '../../stores/page-blocks'
import { extractHeadings, PageOutline } from '../PageOutline'

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock('lucide-react', () => ({
  List: (props: Record<string, unknown>) => <svg data-testid="list-icon" {...props} />,
  X: () => <svg data-testid="x-icon" />,
  XIcon: (props: Record<string, unknown>) => <svg data-testid="x-icon" {...props} />,
}))

// ── Helpers ──────────────────────────────────────────────────────────────

function makeBlock(id: string, content: string | null): FlatBlock {
  return {
    id,
    block_type: 'block',
    content,
    parent_id: 'PAGE_1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth: 0,
  }
}

function createTestStore(blocks: FlatBlock[]): StoreApi<PageBlockState> {
  return createStore<PageBlockState>()(() => ({
    blocks,
    rootParentId: 'PAGE_1',
    loading: false,
    load: vi.fn(),
    createBelow: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
    splitBlock: vi.fn(),
    reorder: vi.fn(),
    moveToParent: vi.fn(),
    indent: vi.fn(),
    dedent: vi.fn(),
    moveUp: vi.fn(),
    moveDown: vi.fn(),
    merge: vi.fn(),
    toggleCollapse: vi.fn(),
    setCollapse: vi.fn(),
  })) as StoreApi<PageBlockState>
}

function renderOutline(blocks: FlatBlock[]) {
  const store = createTestStore(blocks)
  return render(
    createElement(PageBlockContext.Provider, { value: store }, createElement(PageOutline)),
  )
}

// ── extractHeadings unit tests ───────────────────────────────────────────

describe('extractHeadings', () => {
  it('extracts headings from blocks with heading prefixes', () => {
    const blocks: FlatBlock[] = [
      makeBlock('b1', '# Introduction'),
      makeBlock('b2', 'Some paragraph text'),
      makeBlock('b3', '## Section A'),
      makeBlock('b4', '### Sub-section'),
    ]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([
      { blockId: 'b1', level: 1, text: 'Introduction' },
      { blockId: 'b3', level: 2, text: 'Section A' },
      { blockId: 'b4', level: 3, text: 'Sub-section' },
    ])
  })

  it('skips blocks with null content', () => {
    const blocks: FlatBlock[] = [makeBlock('b1', null), makeBlock('b2', '# Title')]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([{ blockId: 'b2', level: 1, text: 'Title' }])
  })

  it('skips blocks without heading prefix', () => {
    const blocks: FlatBlock[] = [
      makeBlock('b1', 'no heading here'),
      makeBlock('b2', '#no space after hash'),
    ]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([])
  })

  it('handles up to h6 headings', () => {
    const blocks: FlatBlock[] = [makeBlock('b1', '###### Deep heading')]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([{ blockId: 'b1', level: 6, text: 'Deep heading' }])
  })

  it('returns empty array when no blocks', () => {
    expect(extractHeadings([])).toEqual([])
  })
})

// ── PageOutline component tests ──────────────────────────────────────────

describe('PageOutline', () => {
  it('shows empty state when no headings found', async () => {
    const user = userEvent.setup()
    renderOutline([makeBlock('b1', 'just text')])

    // Open the sheet
    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    expect(screen.getByText('No headings found')).toBeInTheDocument()
  })

  it('renders heading list from blocks with heading prefixes', async () => {
    const user = userEvent.setup()
    renderOutline([
      makeBlock('b1', '# Title'),
      makeBlock('b2', '## Subtitle'),
      makeBlock('b3', 'plain text'),
      makeBlock('b4', '### Deep'),
    ])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Subtitle')).toBeInTheDocument()
    expect(screen.getByText('Deep')).toBeInTheDocument()
    expect(screen.queryByText('plain text')).not.toBeInTheDocument()
  })

  it('indents headings by level via paddingLeft', async () => {
    const user = userEvent.setup()
    renderOutline([makeBlock('b1', '# H1'), makeBlock('b2', '## H2'), makeBlock('b3', '### H3')])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const nav = screen.getByRole('navigation', { name: 'Page outline' })
    const items = within(nav).getAllByRole('listitem')

    // level 1 → (1-1)*12 = 0px
    expect(items[0]).toHaveStyle({ paddingLeft: '0px' })
    // level 2 → (2-1)*12 = 12px
    expect(items[1]).toHaveStyle({ paddingLeft: '12px' })
    // level 3 → (3-1)*12 = 24px
    expect(items[2]).toHaveStyle({ paddingLeft: '24px' })
  })

  it('clicking a heading calls scrollIntoView', async () => {
    const user = userEvent.setup()
    const mockScrollIntoView = vi.fn()

    // Create a fake DOM element with the block ID
    const fakeEl = document.createElement('div')
    fakeEl.id = 'b1'
    fakeEl.scrollIntoView = mockScrollIntoView
    document.body.appendChild(fakeEl)

    renderOutline([makeBlock('b1', '# Click me')])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))
    await user.click(screen.getByText('Click me'))

    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })

    document.body.removeChild(fakeEl)
  })

  it('passes axe a11y audit', async () => {
    const user = userEvent.setup()
    const { container } = renderOutline([
      makeBlock('b1', '# Accessible heading'),
      makeBlock('b2', '## Another heading'),
    ])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('passes axe a11y audit with empty state', async () => {
    const user = userEvent.setup()
    const { container } = renderOutline([makeBlock('b1', 'no headings')])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
