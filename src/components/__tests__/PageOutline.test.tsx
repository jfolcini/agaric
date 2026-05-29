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
import type { StoreApi } from 'zustand'
import { createStore } from 'zustand'

import { axe } from '@/__tests__/helpers/axe'

import { makeBlock } from '../../__tests__/fixtures'
import type { FlatBlock } from '../../stores/page-blocks'
import { PageBlockContext, type PageBlockState } from '../../stores/page-blocks'
import { extractHeadings, PageOutline } from '../PageOutline'
import { TooltipProvider } from '../ui/tooltip'

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock('lucide-react', () => ({
  List: (props: Record<string, unknown>) => <svg data-testid="list-icon" {...props} />,
  X: () => <svg data-testid="x-icon" />,
  XIcon: (props: Record<string, unknown>) => <svg data-testid="x-icon" {...props} />,
}))

// ── Helpers ──────────────────────────────────────────────────────────────

function createTestStore(blocks: FlatBlock[]): StoreApi<PageBlockState> {
  // PEND-20 G — `blocksById` mirrors `blocks` for O(1) lookups.
  const blocksById = new Map(blocks.map((b) => [b.id, b]))
  return createStore<PageBlockState>()(() => ({
    blocks,
    blocksById,
    rootParentId: 'PAGE_1',
    loading: false,
    getBlockById: (id: string) => blocksById.get(id),
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
    appendBlock: vi.fn(),
    merge: vi.fn(),
    toggleCollapse: vi.fn(),
    setCollapse: vi.fn(),
  })) as StoreApi<PageBlockState>
}

function renderOutline(blocks: FlatBlock[]) {
  const store = createTestStore(blocks)
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(PageBlockContext.Provider, { value: store }, createElement(PageOutline)),
    ),
  )
}

// ── extractHeadings unit tests ───────────────────────────────────────────

describe('extractHeadings', () => {
  it('extracts headings from blocks with heading prefixes', () => {
    const blocks: FlatBlock[] = [
      makeBlock({ id: 'b1', content: '# Introduction' }),
      makeBlock({ id: 'b2', content: 'Some paragraph text' }),
      makeBlock({ id: 'b3', content: '## Section A' }),
      makeBlock({ id: 'b4', content: '### Sub-section' }),
    ]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([
      { blockId: 'b1', level: 1, text: 'Introduction' },
      { blockId: 'b3', level: 2, text: 'Section A' },
      { blockId: 'b4', level: 3, text: 'Sub-section' },
    ])
  })

  it('skips blocks with null content', () => {
    const blocks: FlatBlock[] = [
      makeBlock({ id: 'b1', content: null }),
      makeBlock({ id: 'b2', content: '# Title' }),
    ]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([{ blockId: 'b2', level: 1, text: 'Title' }])
  })

  it('skips blocks without heading prefix', () => {
    const blocks: FlatBlock[] = [
      makeBlock({ id: 'b1', content: 'no heading here' }),
      makeBlock({ id: 'b2', content: '#no space after hash' }),
    ]
    const headings = extractHeadings(blocks)
    expect(headings).toEqual([])
  })

  it('handles up to h6 headings', () => {
    const blocks: FlatBlock[] = [makeBlock({ id: 'b1', content: '###### Deep heading' })]
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
    renderOutline([makeBlock({ id: 'b1', content: 'just text' })])

    // Open the sheet
    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    expect(screen.getByText('No headings found')).toBeInTheDocument()
  })

  it('renders heading list from blocks with heading prefixes', async () => {
    const user = userEvent.setup()
    renderOutline([
      makeBlock({ id: 'b1', content: '# Title' }),
      makeBlock({ id: 'b2', content: '## Subtitle' }),
      makeBlock({ id: 'b3', content: 'plain text' }),
      makeBlock({ id: 'b4', content: '### Deep' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Subtitle')).toBeInTheDocument()
    expect(screen.getByText('Deep')).toBeInTheDocument()
    expect(screen.queryByText('plain text')).not.toBeInTheDocument()
  })

  it('indents headings by level via paddingLeft', async () => {
    const user = userEvent.setup()
    renderOutline([
      makeBlock({ id: 'b1', content: '# H1' }),
      makeBlock({ id: 'b2', content: '## H2' }),
      makeBlock({ id: 'b3', content: '### H3' }),
    ])

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

    renderOutline([makeBlock({ id: 'b1', content: '# Click me' })])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))
    await user.click(screen.getByText('Click me'))

    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })

    document.body.removeChild(fakeEl)
  })

  it('UX-237: heading buttons have ring-inset focus rings so they are not clipped by the inner ScrollArea', async () => {
    const user = userEvent.setup()
    renderOutline([makeBlock({ id: 'b1', content: '# Heading 1' })])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const headingBtn = screen.getByRole('button', { name: 'Heading 1' })
    expect(headingBtn).toHaveClass('focus-ring-visible')
    expect(headingBtn).toHaveClass('focus-visible:ring-inset')
  })

  it('passes axe a11y audit', async () => {
    const user = userEvent.setup()
    const { container } = renderOutline([
      makeBlock({ id: 'b1', content: '# Accessible heading' }),
      makeBlock({ id: 'b2', content: '## Another heading' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('passes axe a11y audit with empty state', async () => {
    const user = userEvent.setup()
    const { container } = renderOutline([makeBlock({ id: 'b1', content: 'no headings' })])

    await user.click(screen.getByRole('button', { name: 'Open outline' }))

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── UX-361: trigger tooltip ────────────────────────────────────────────

  describe('UX-361: trigger tooltip', () => {
    it('shows a tooltip with the localised label when hovering the trigger', async () => {
      const user = userEvent.setup()
      renderOutline([makeBlock({ id: 'b1', content: 'just text' })])

      const trigger = screen.getByRole('button', { name: 'Open outline' })
      await user.hover(trigger)

      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Open outline')
    })

    it('does not show the tooltip until the user hovers, and wires Tooltip primitives onto the trigger', () => {
      // No hover yet → no tooltip role in the document. The trigger Button
      // itself is composed via Radix `Slot` with the design-system Tooltip
      // primitive (data-slot="tooltip-trigger"), so we don't reinvent
      // hover/un-hover behaviour — that's covered by the Tooltip's own tests.
      renderOutline([makeBlock({ id: 'b1', content: 'just text' })])

      const trigger = screen.getByRole('button', { name: 'Open outline' })
      expect(trigger).toHaveAttribute('data-slot', 'tooltip-trigger')
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })
})
