/**
 * Tests for SourcePageFilter component.
 *
 * Validates:
 *  - Renders filter button
 *  - Button color indicates filter state (default, includes, excludes, mixed)
 *  - Search filters the page list
 *  - Clicking a page includes it
 *  - Shift+clicking a page excludes it
 *  - Clicking an included page removes it
 *  - "Clear all" button clears filters
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { SourcePageFilter } from '../SourcePageFilter'

// Mock Popover components to avoid Radix rendering issues in jsdom
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-root">{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    // When asChild, just render the child directly
    if (asChild) return <>{children}</>
    return <button {...props}>{children}</button>
  },
  PopoverContent: ({ children, ...props }: { children: React.ReactNode }) => (
    <div data-testid="popover-content" {...props}>
      {children}
    </div>
  ),
}))

const samplePages = [
  { pageId: 'P1', pageTitle: 'Alpha Page', blockCount: 5 },
  { pageId: 'P2', pageTitle: 'Beta Page', blockCount: 3 },
  { pageId: 'P3', pageTitle: null, blockCount: 1 },
]

describe('SourcePageFilter', () => {
  let onChange: ReturnType<typeof vi.fn<(included: string[], excluded: string[]) => void>>

  beforeEach(() => {
    onChange = vi.fn<(included: string[], excluded: string[]) => void>()
  })

  // 1. renders filter button
  it('renders filter button', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    expect(screen.getByLabelText('Filter by source page')).toBeInTheDocument()
  })

  // 2. filter button is default color with no filters
  it('filter button is default color with no filters', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const button = screen.getByLabelText('Filter by source page')
    expect(button.className).toContain('text-muted-foreground')
    expect(button.className).not.toContain('text-green-600')
    expect(button.className).not.toContain('text-red-600')
    expect(button.className).not.toContain('text-yellow-600')
  })

  // 3. filter button is green with includes only
  it('filter button is green with includes only', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={['P1']}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const button = screen.getByLabelText('Filter by source page')
    expect(button.className).toContain('text-primary')
  })

  // 4. filter button is red with excludes only
  it('filter button is red with excludes only', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={['P2']}
        onChange={onChange}
      />,
    )

    const button = screen.getByLabelText('Filter by source page')
    expect(button.className).toContain('text-destructive')
  })

  // 5. filter button is yellow with mixed
  it('filter button is yellow with mixed includes and excludes', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={['P1']}
        excluded={['P2']}
        onChange={onChange}
      />,
    )

    const button = screen.getByLabelText('Filter by source page')
    expect(button.className).toContain('text-status-pending-foreground')
  })

  // 6. search filters the page list
  it('search filters the page list', async () => {
    const user = userEvent.setup()
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    // All pages visible initially
    expect(screen.getByText('Alpha Page')).toBeInTheDocument()
    expect(screen.getByText('Beta Page')).toBeInTheDocument()
    expect(screen.getByText('Untitled')).toBeInTheDocument()

    // Type in search
    const searchInput = screen.getByLabelText('Search source pages')
    await user.type(searchInput, 'Alpha')

    // Only Alpha Page should be visible
    expect(screen.getByText('Alpha Page')).toBeInTheDocument()
    expect(screen.queryByText('Beta Page')).not.toBeInTheDocument()
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
  })

  // UX-248 — Unicode-aware fold: Turkish / German / accented titles
  // match their ASCII-typed queries via `matchesSearchFolded`.
  it('search matches Turkish İstanbul when query is lowercase istanbul', async () => {
    const user = userEvent.setup()
    const unicodePages = [
      { pageId: 'P1', pageTitle: 'İstanbul trip', blockCount: 5 },
      { pageId: 'P2', pageTitle: 'Ankara', blockCount: 3 },
    ]
    render(
      <SourcePageFilter
        sourcePages={unicodePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const searchInput = screen.getByLabelText('Search source pages')
    await user.type(searchInput, 'istanbul')

    expect(screen.getByText('İstanbul trip')).toBeInTheDocument()
    expect(screen.queryByText('Ankara')).not.toBeInTheDocument()
  })

  // 7. clicking a page includes it (calls onChange)
  it('clicking a page includes it', async () => {
    const user = userEvent.setup()
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const alphaItem = screen
      .getByText('Alpha Page')
      .closest('.source-page-filter-item') as HTMLElement
    await user.click(alphaItem)

    expect(onChange).toHaveBeenCalledWith(['P1'], [])
  })

  // 8. shift-clicking a page excludes it
  it('shift-clicking a page excludes it', async () => {
    const user = userEvent.setup()
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const betaItem = screen
      .getByText('Beta Page')
      .closest('.source-page-filter-item') as HTMLElement
    await user.keyboard('{Shift>}')
    await user.click(betaItem)
    await user.keyboard('{/Shift}')

    expect(onChange).toHaveBeenCalledWith([], ['P2'])
  })

  // 9. clicking included page removes it
  it('clicking included page removes it', async () => {
    const user = userEvent.setup()
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={['P1']}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const alphaItem = screen
      .getByText('Alpha Page')
      .closest('.source-page-filter-item') as HTMLElement
    await user.click(alphaItem)

    expect(onChange).toHaveBeenCalledWith([], [])
  })

  // 10. "Clear all" button clears filters
  it('"Clear all" button clears filters', async () => {
    const user = userEvent.setup()
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={['P1']}
        excluded={['P2']}
        onChange={onChange}
      />,
    )

    const clearBtn = screen.getByText('Clear all')
    await user.click(clearBtn)

    expect(onChange).toHaveBeenCalledWith([], [])
  })

  // 11. "Clear all" is hidden when no filters active
  it('"Clear all" is hidden when no filters active', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
  })

  // 12. pages are sorted by blockCount descending
  it('pages are sorted by blockCount descending', () => {
    render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const items = screen
      .getAllByRole('button')
      .filter((el) => el.classList.contains('source-page-filter-item'))
    expect(items[0]).toHaveTextContent('Alpha Page')
    expect(items[0]).toHaveTextContent('(5)')
    expect(items[1]).toHaveTextContent('Beta Page')
    expect(items[1]).toHaveTextContent('(3)')
    expect(items[2]).toHaveTextContent('Untitled')
    expect(items[2]).toHaveTextContent('(1)')
  })

  // 13. a11y audit
  it('a11y: no violations', async () => {
    const { container } = render(
      <SourcePageFilter
        sourcePages={samplePages}
        included={[]}
        excluded={[]}
        onChange={onChange}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
