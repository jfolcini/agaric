/**
 * PageRow tests.
 *
 * Verifies the row primitive renders, fires its primitive callbacks on
 * user interaction, and suppresses `↗ 0` / `⊟ 0` zeros per the design.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { collectFlagTokens, formatRelativeShort, PageRow } from '@/components/PageBrowser/PageRow'
import type { ViewportObserver } from '@/hooks/useViewportObserver'

type RequiredProps = React.ComponentProps<typeof PageRow>

/**
 * #2850 — no-op `ViewportObserver` stub. `PageRow` reads it only to
 * drive the mobile/no-hover prefetch fallback (per-id `subscribe` +
 * `isOffscreen` via `useSyncExternalStore`, and `createObserveRef` merged
 * into the row's ref); none of that is under test here, so every member
 * is a inert no-op that satisfies the shape.
 */
function makeMockViewport(): ViewportObserver {
  return {
    createObserveRef: () => () => {},
    isOffscreen: () => false,
    getHeight: () => undefined,
    subscribe: () => () => {},
    subscribeWindow: () => () => {},
    getWindowVersion: () => 0,
  }
}

function baseProps(overrides: Partial<RequiredProps> = {}): RequiredProps {
  return {
    pageId: 'page-1',
    title: 'Project Alpha',
    filterText: '',
    virtualRowIndex: 0,
    virtualRowStart: 0,
    measureElement: undefined,
    pageIndex: 0,
    focusedIndex: -1,
    starred: false,
    showAliasBadge: false,
    deleting: false,
    duplicateTitle: false,
    lastModifiedAt: Date.now() - 3 * 24 * 60 * 60 * 1000, // 3 days ago (epoch-ms)
    inboundLinkCount: 5,
    childBlockCount: 12,
    hasTags: false,
    hasTodo: false,
    hasScheduled: false,
    hasDue: false,
    multiSelected: false,
    onToggleMultiSelect: vi.fn(),
    onSelect: vi.fn(),
    onToggleStar: vi.fn(),
    onDeleteRequest: vi.fn(),
    viewport: makeMockViewport(),
    ...overrides,
  }
}

// React import needed for the `React.ComponentProps` type usage below.
import type * as React from 'react'

describe('PageRow', () => {
  it('renders the title', () => {
    render(<PageRow {...baseProps()} />)
    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
  })

  it('falls back to the localised "Untitled" when title is null', () => {
    render(<PageRow {...baseProps({ title: null })} />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('renders id="page-row-…" with the page id', () => {
    const { container } = render(<PageRow {...baseProps({ pageId: 'abc' })} />)
    expect(container.querySelector('#page-row-abc')).not.toBeNull()
  })

  it('shows ↗ and ⊟ badges when counts > 0', () => {
    render(<PageRow {...baseProps({ inboundLinkCount: 5, childBlockCount: 12 })} />)
    expect(screen.getByText(/5 ↗/u)).toBeInTheDocument()
    expect(screen.getByText(/12 ⊟/u)).toBeInTheDocument()
  })

  it('suppresses ↗ 0 and ⊟ 0', () => {
    render(<PageRow {...baseProps({ inboundLinkCount: 0, childBlockCount: 0 })} />)
    expect(screen.queryByText(/↗/u)).not.toBeInTheDocument()
    expect(screen.queryByText(/⊟/u)).not.toBeInTheDocument()
  })

  it('renders only the first property flag', () => {
    const { container } = render(
      <PageRow
        {...baseProps({
          hasTags: false,
          hasTodo: true,
          hasScheduled: true,
          hasDue: true,
        })}
      />,
    )
    const flags = container.querySelectorAll('[data-page-flag]')
    expect(flags).toHaveLength(1)
    expect(flags[0]?.getAttribute('data-page-flag')).toBe('todos')
  })

  it('renders no flag badges when no flags are set', () => {
    const { container } = render(<PageRow {...baseProps()} />)
    expect(container.querySelector('[data-page-flag]')).toBeNull()
  })

  it('star toggle fires onToggleStar with the page id', async () => {
    const onToggleStar = vi.fn()
    const user = userEvent.setup()
    render(<PageRow {...baseProps({ pageId: 'page-7', onToggleStar })} />)
    await user.click(screen.getByRole('button', { name: /bookmark page/i }))
    expect(onToggleStar).toHaveBeenCalledWith('page-7')
  })

  // Item #2281 — the star toggle must carry the 44px `touch-target` hit-area on
  // coarse pointers (matching its sibling delete button) and no longer be
  // hard-sized to h-6 w-6 (24px), which was sub-WCAG on touch.
  it('star toggle has the 44px touch-target hit-area (matches delete button)', () => {
    render(<PageRow {...baseProps()} />)
    const star = screen.getByRole('button', { name: /bookmark page/i })
    expect(star.className).toContain('touch-target')
    expect(star.className).not.toContain('h-6 w-6')
  })

  it('starred=true reflects via the data-starred attribute', () => {
    const { container } = render(<PageRow {...baseProps({ starred: true })} />)
    expect(container.querySelector('[data-page-item][data-starred="true"]')).not.toBeNull()
  })

  it('delete button fires onDeleteRequest with id + title', async () => {
    const onDeleteRequest = vi.fn()
    const user = userEvent.setup()
    render(<PageRow {...baseProps({ pageId: 'page-9', title: 'Roadmap', onDeleteRequest })} />)
    await user.click(screen.getByRole('button', { name: /delete page/i }))
    expect(onDeleteRequest).toHaveBeenCalledWith({ id: 'page-9', name: 'Roadmap' })
  })

  it('delete button is disabled while deleting=true', () => {
    render(<PageRow {...baseProps({ deleting: true })} />)
    expect(screen.getByRole('button', { name: /delete page/i })).toBeDisabled()
  })

  it('click on the title fires onSelect with id + resolved title', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<PageRow {...baseProps({ pageId: 'p', title: 'Hi', onSelect })} />)
    // The title is wrapped in a <button> that toggles selection.
    const titleButton = screen.getByText('Hi').closest('button[type="button"]') as HTMLButtonElement
    await user.click(titleButton)
    expect(onSelect).toHaveBeenCalledWith('p', 'Hi')
  })

  it('alias badge renders only when showAliasBadge=true', () => {
    const { rerender } = render(<PageRow {...baseProps({ showAliasBadge: false })} />)
    expect(document.querySelector('.alias-badge')).toBeNull()
    rerender(<PageRow {...baseProps({ showAliasBadge: true })} />)
    expect(document.querySelector('.alias-badge')).not.toBeNull()
  })

  it('focused row is marked via aria-selected', () => {
    const { container } = render(<PageRow {...baseProps({ pageIndex: 3, focusedIndex: 3 })} />)
    expect(container.querySelector('[aria-selected="true"]')).not.toBeNull()
  })

  it('has no a11y violations', async () => {
    // Wrap in `role="grid"` so the row's `role="row"` satisfies axe's
    // `aria-required-parent` rule (the real PageBrowser viewport
    // applies this role; the row is never rendered standalone).
    const { container } = render(
      <div role="grid" aria-label="pages">
        <PageRow
          {...baseProps({
            inboundLinkCount: 3,
            childBlockCount: 7,
            hasTags: true,
            hasDue: true,
          })}
        />
      </div>,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  }, 20_000)
})

describe('formatRelativeShort', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z')

  it('returns empty string for null input', () => {
    expect(formatRelativeShort(null, NOW)).toBe('')
  })

  it('returns empty string for invalid date', () => {
    expect(formatRelativeShort('not-a-date', NOW)).toBe('')
  })

  it('returns "now" for sub-minute deltas', () => {
    expect(formatRelativeShort('2026-05-21T11:59:30Z', NOW)).toBe('now')
  })

  it('returns minutes, hours, days correctly', () => {
    expect(formatRelativeShort('2026-05-21T11:58:00Z', NOW)).toBe('2m')
    expect(formatRelativeShort('2026-05-21T09:00:00Z', NOW)).toBe('3h')
    expect(formatRelativeShort('2026-05-18T12:00:00Z', NOW)).toBe('3d')
  })

  it('returns weeks/months/years for larger deltas', () => {
    expect(formatRelativeShort('2026-05-07T12:00:00Z', NOW)).toBe('2w')
    expect(formatRelativeShort('2026-01-01T00:00:00Z', NOW)).toBe('4mo')
    expect(formatRelativeShort('2023-01-01T00:00:00Z', NOW)).toBe('3y')
  })
})

describe('collectFlagTokens', () => {
  it('returns an empty array when no flags are set', () => {
    expect(
      collectFlagTokens({ hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false }),
    ).toEqual([])
  })

  it('preserves a stable order (tags, todos, scheduled, due)', () => {
    expect(
      collectFlagTokens({ hasTags: true, hasTodo: true, hasScheduled: true, hasDue: true }),
    ).toEqual(['tags', 'todos', 'scheduled', 'due'])
  })
})
