/**
 * PEND-56 — DensityRow tests.
 *
 * Verifies the row primitive renders correctly across the three
 * densities, fires its primitive callbacks on user interaction, and
 * suppresses `↗ 0` / `⊟ 0` zeros per the design.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { DensityMode } from '@/hooks/usePageBrowserDensity'

import { collectFlagTokens, DensityRow, formatRelativeShort } from '../DensityRow'

type RequiredProps = React.ComponentProps<typeof DensityRow>

function baseProps(overrides: Partial<RequiredProps> = {}): RequiredProps {
  return {
    pageId: 'page-1',
    title: 'Project Alpha',
    filterText: '',
    density: 'regular',
    virtualRowIndex: 0,
    virtualRowStart: 0,
    measureElement: undefined,
    pageIndex: 0,
    focusedIndex: -1,
    starred: false,
    showAliasBadge: false,
    deleting: false,
    lastModifiedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
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
    ...overrides,
  }
}

// React import needed for the `React.ComponentProps` type usage below.
import type * as React from 'react'

describe('DensityRow', () => {
  it('renders the title at every density', () => {
    const densities: DensityMode[] = ['compact', 'regular', 'expanded']
    for (const density of densities) {
      const { unmount } = render(<DensityRow {...baseProps({ density })} />)
      expect(screen.getByText('Project Alpha')).toBeInTheDocument()
      unmount()
    }
  })

  it('falls back to the localised "Untitled" when title is null', () => {
    render(<DensityRow {...baseProps({ title: null })} />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('exposes the active density via data-density', () => {
    const densities: DensityMode[] = ['compact', 'regular', 'expanded']
    for (const density of densities) {
      const { container, unmount } = render(<DensityRow {...baseProps({ density })} />)
      const row = container.querySelector(`[data-page-item][data-density="${density}"]`)
      expect(row).not.toBeNull()
      unmount()
    }
  })

  it('renders id="page-row-…" with the page id', () => {
    const { container } = render(<DensityRow {...baseProps({ pageId: 'abc' })} />)
    expect(container.querySelector('#page-row-abc')).not.toBeNull()
  })

  it('regular density shows ↗ and ⊟ badges when counts > 0', () => {
    render(
      <DensityRow
        {...baseProps({ density: 'regular', inboundLinkCount: 5, childBlockCount: 12 })}
      />,
    )
    expect(screen.getByText(/5 ↗/u)).toBeInTheDocument()
    expect(screen.getByText(/12 ⊟/u)).toBeInTheDocument()
  })

  it('suppresses ↗ 0 and ⊟ 0 in regular density', () => {
    render(
      <DensityRow
        {...baseProps({ density: 'regular', inboundLinkCount: 0, childBlockCount: 0 })}
      />,
    )
    expect(screen.queryByText(/↗/u)).not.toBeInTheDocument()
    expect(screen.queryByText(/⊟/u)).not.toBeInTheDocument()
  })

  it('compact density hides metadata badges (tooltip carries them instead)', () => {
    const { container } = render(
      <DensityRow
        {...baseProps({
          density: 'compact',
          inboundLinkCount: 5,
          childBlockCount: 12,
          hasTags: true,
        })}
      />,
    )
    expect(container.querySelector('[data-metadata-inbound]')).toBeNull()
    expect(container.querySelector('[data-metadata-children]')).toBeNull()
    expect(container.querySelector('[data-page-flag]')).toBeNull()
    // Title still renders.
    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
  })

  it('regular density caps property flags at one badge', () => {
    const { container } = render(
      <DensityRow
        {...baseProps({
          density: 'regular',
          hasTags: true,
          hasTodo: true,
          hasScheduled: true,
          hasDue: true,
        })}
      />,
    )
    const flags = container.querySelectorAll('[data-page-flag]')
    expect(flags).toHaveLength(1)
  })

  it('expanded density renders all matched property flags', () => {
    const { container } = render(
      <DensityRow
        {...baseProps({
          density: 'expanded',
          hasTags: true,
          hasTodo: true,
          hasScheduled: false,
          hasDue: true,
        })}
      />,
    )
    const flags = container.querySelectorAll('[data-page-flag]')
    expect(flags).toHaveLength(3)
  })

  it('renders no flag badges when no flags are set', () => {
    const { container } = render(<DensityRow {...baseProps({ density: 'expanded' })} />)
    expect(container.querySelector('[data-page-flag]')).toBeNull()
  })

  it('star toggle fires onToggleStar with the page id', async () => {
    const onToggleStar = vi.fn()
    const user = userEvent.setup()
    render(<DensityRow {...baseProps({ pageId: 'page-7', onToggleStar })} />)
    await user.click(screen.getByRole('button', { name: /star page/i }))
    expect(onToggleStar).toHaveBeenCalledWith('page-7')
  })

  it('starred=true reflects via the data-starred attribute', () => {
    const { container } = render(<DensityRow {...baseProps({ starred: true })} />)
    expect(container.querySelector('[data-page-item][data-starred="true"]')).not.toBeNull()
  })

  it('delete button fires onDeleteRequest with id + title', async () => {
    const onDeleteRequest = vi.fn()
    const user = userEvent.setup()
    render(<DensityRow {...baseProps({ pageId: 'page-9', title: 'Roadmap', onDeleteRequest })} />)
    await user.click(screen.getByRole('button', { name: /delete page/i }))
    expect(onDeleteRequest).toHaveBeenCalledWith({ id: 'page-9', name: 'Roadmap' })
  })

  it('delete button is disabled while deleting=true', () => {
    render(<DensityRow {...baseProps({ deleting: true })} />)
    expect(screen.getByRole('button', { name: /delete page/i })).toBeDisabled()
  })

  it('click on the title fires onSelect with id + resolved title', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<DensityRow {...baseProps({ pageId: 'p', title: 'Hi', onSelect })} />)
    // The title is wrapped in a <button> that toggles selection.
    const titleButton = screen.getByText('Hi').closest('button[type="button"]') as HTMLButtonElement
    await user.click(titleButton)
    expect(onSelect).toHaveBeenCalledWith('p', 'Hi')
  })

  it('alias badge renders only when showAliasBadge=true', () => {
    const { rerender } = render(<DensityRow {...baseProps({ showAliasBadge: false })} />)
    expect(document.querySelector('.alias-badge')).toBeNull()
    rerender(<DensityRow {...baseProps({ showAliasBadge: true })} />)
    expect(document.querySelector('.alias-badge')).not.toBeNull()
  })

  it('focused row is marked via aria-selected', () => {
    const { container } = render(<DensityRow {...baseProps({ pageIndex: 3, focusedIndex: 3 })} />)
    expect(container.querySelector('[aria-selected="true"]')).not.toBeNull()
  })

  it('compact tooltip text includes inbound + children + relative metadata', () => {
    render(
      <DensityRow
        {...baseProps({
          density: 'compact',
          title: 'Roadmap',
          inboundLinkCount: 9,
          childBlockCount: 41,
        })}
      />,
    )
    const titled = document.querySelector('[title]')
    // The element with the tooltip is the title span, not the row wrapper.
    expect(titled).not.toBeNull()
    const tooltip = titled?.getAttribute('title') ?? ''
    expect(tooltip).toContain('Roadmap')
    expect(tooltip).toContain('9')
    expect(tooltip).toContain('41')
  })

  it.each<DensityMode>(['compact', 'regular', 'expanded'])(
    'has no a11y violations at density=%s',
    async (density) => {
      // Wrap in `role="grid"` so the row's `role="row"` satisfies axe's
      // `aria-required-parent` rule (the real PageBrowser viewport
      // applies this role; the row is never rendered standalone).
      const { container } = render(
        <div role="grid" aria-label="pages">
          <DensityRow
            {...baseProps({
              density,
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
    },
    20_000,
  )
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
