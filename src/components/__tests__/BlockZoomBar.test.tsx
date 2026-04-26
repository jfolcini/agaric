/**
 * Tests for BlockZoomBar component (UX-257 — consumes the Breadcrumb primitive).
 *
 * Validates:
 * - Returns null when breadcrumbs are empty
 * - Renders Home button + breadcrumb items via the primitive
 * - Home button calls onZoomToRoot
 * - Clicking a non-last breadcrumb calls onNavigate
 * - Last breadcrumb does not navigate (rendered as a span, not a button)
 * - Untitled blocks show fallback text
 * - `[[ULID]]` content is rendered as plain stripped text — never as a chip
 *   inside `button[data-zoom-crumb]`
 * - Chevron separators (not slashes / commas) between crumbs
 * - UX-215 keyboard navigation moved into the primitive — still works here
 * - a11y compliance (axe)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BreadcrumbItem } from '../../hooks/useBlockZoom'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'block.breadcrumb': 'Breadcrumb',
        'block.untitled': 'Untitled',
        'block.zoomToRoot': 'Go to root',
        'blockZoom.breadcrumbs': 'Zoom breadcrumbs',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) => (id === 'PAGE1' ? 'My Page' : undefined)),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn((id: string) => (id === 'TAG1' ? 'project' : undefined)),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

import { BlockZoomBar } from '../BlockZoomBar'

describe('BlockZoomBar', () => {
  const breadcrumbs: BreadcrumbItem[] = [
    { id: 'A', content: 'Page' },
    { id: 'B', content: 'Section' },
    { id: 'C', content: 'Detail' },
  ]

  it('returns null when breadcrumbs are empty', () => {
    const { container } = render(
      <BlockZoomBar breadcrumbs={[]} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders the breadcrumb toolbar with aria-label', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    const toolbar = screen.getByRole('toolbar', { name: 'Zoom breadcrumbs' })
    expect(toolbar).toBeInTheDocument()
    expect(toolbar).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('wraps the toolbar in a navigation landmark with aria-label', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    expect(screen.getByRole('navigation', { name: 'Zoom breadcrumbs' })).toBeInTheDocument()
  })

  it('renders all breadcrumb items', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    expect(screen.getByText('Page')).toBeInTheDocument()
    expect(screen.getByText('Section')).toBeInTheDocument()
    expect(screen.getByText('Detail')).toBeInTheDocument()
  })

  it('calls onZoomToRoot when Home button is clicked', async () => {
    const user = userEvent.setup()
    const onZoomToRoot = vi.fn()
    render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={onZoomToRoot} />,
    )
    const buttons = screen.getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    expect(onZoomToRoot).toHaveBeenCalledTimes(1)
  })

  it('calls onNavigate when a non-last breadcrumb is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={onNavigate} onZoomToRoot={vi.fn()} />,
    )
    await user.click(screen.getByText('Page'))
    expect(onNavigate).toHaveBeenCalledWith('A')
  })

  it('does not call onNavigate when the last breadcrumb is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={onNavigate} onZoomToRoot={vi.fn()} />,
    )
    // Last crumb is now a non-clickable span — clicking it must not navigate.
    await user.click(screen.getByText('Detail'))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows "Untitled" for breadcrumbs with empty content', () => {
    const items: BreadcrumbItem[] = [{ id: 'X', content: '' }]
    render(<BlockZoomBar breadcrumbs={items} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('applies font-medium class to the last breadcrumb (the active span)', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    const last = screen.getByText('Detail')
    expect(last.className).toContain('font-medium')
  })

  it('does not apply font-medium to non-last breadcrumbs', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    const firstButton = screen.getByText('Page').closest('button') as HTMLButtonElement
    expect(firstButton.className).not.toContain('font-medium')
  })

  // UX-257 — the headline visual win: no inline chips inside crumbs. Block-link
  // tokens are stripped to plain text so the bar reads as nav chrome.
  it('renders [[ULID]] content as stripped plain text — no chip elements', () => {
    const items: BreadcrumbItem[] = [{ id: 'Z', content: 'See [[01JFAKE00000000000000ULID]]' }]
    const { container } = render(
      <BlockZoomBar breadcrumbs={items} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )

    // No nested chip elements should exist inside any crumb element.
    const crumbNodes = container.querySelectorAll('[data-zoom-crumb]')
    expect(crumbNodes.length).toBeGreaterThan(0)
    for (const node of crumbNodes) {
      expect(node.querySelector('.block-link-chip')).toBeNull()
      expect(node.querySelector('[data-testid="block-link-chip"]')).toBeNull()
      expect(node.querySelector('[data-tag-chip]')).toBeNull()
    }

    // The raw `[[…]]` markers must not be in the rendered text.
    expect(container.textContent ?? '').not.toContain('[[')
    expect(container.textContent ?? '').not.toContain(']]')
  })

  it('uses chevron separators between crumbs (not slashes or commas)', () => {
    const { container } = render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )
    const seps = container.querySelectorAll('[data-slot="breadcrumb-separator"]')
    // Home + 3 crumbs → 3 separators
    expect(seps.length).toBe(3)
    // Defensive — make sure the old slash-divider design is gone.
    const visibleText = container.textContent ?? ''
    expect(visibleText).not.toContain('/')
    expect(visibleText).not.toContain(',')
    // Each separator should be the chevron svg.
    for (const sep of seps) {
      expect(sep.tagName.toLowerCase()).toBe('svg')
    }
  })

  it('preserves the data-zoom-crumb attribute on each crumb button', () => {
    const { container } = render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )
    // Home + 2 intermediate buttons + 1 active span = 4 nodes carry the attr.
    const all = container.querySelectorAll('[data-zoom-crumb]')
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(container.querySelector('[data-zoom-crumb="home"]')).not.toBeNull()
    expect(container.querySelector('[data-zoom-crumb="A"]')).not.toBeNull()
    expect(container.querySelector('[data-zoom-crumb="B"]')).not.toBeNull()
  })

  it('passes axe a11y audit', async () => {
    const { container } = render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  describe('UX-215 arrow-key navigation', () => {
    it('marks the last breadcrumb with aria-current="page"', () => {
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      // The active crumb is now a span (non-clickable). Look up by text.
      const last = screen.getByText('Detail')
      expect(last).toHaveAttribute('aria-current', 'page')
    })

    it('does not mark non-last breadcrumbs with aria-current', () => {
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const first = screen.getByText('Page').closest('button') as HTMLButtonElement
      const middle = screen.getByText('Section').closest('button') as HTMLButtonElement
      expect(first).not.toHaveAttribute('aria-current')
      expect(middle).not.toHaveAttribute('aria-current')
    })

    it('ArrowRight moves focus to the next breadcrumb', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      // Buttons are: [Home, Page, Section] — Detail is the active span.
      ;(buttons[0] as HTMLButtonElement).focus()
      expect(document.activeElement).toBe(buttons[0])

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[1])

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[2])
    })

    it('ArrowLeft moves focus to the previous breadcrumb', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      ;(buttons[2] as HTMLButtonElement).focus()
      expect(document.activeElement).toBe(buttons[2])

      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[1])

      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('ArrowLeft clamps at the first breadcrumb', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      ;(buttons[0] as HTMLButtonElement).focus()

      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('ArrowRight clamps at the last button', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      const lastIdx = buttons.length - 1
      ;(buttons[lastIdx] as HTMLButtonElement).focus()

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[lastIdx])
    })

    it('Home jumps focus to the Home button', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      ;(buttons[2] as HTMLButtonElement).focus()

      await user.keyboard('{Home}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('End jumps focus to the last button', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      const lastIdx = buttons.length - 1
      ;(buttons[0] as HTMLButtonElement).focus()

      await user.keyboard('{End}')
      expect(document.activeElement).toBe(buttons[lastIdx])
    })

    it('does not capture unrelated keys (e.g., Tab, Enter)', async () => {
      const onNavigate = vi.fn()
      const user = userEvent.setup()
      render(
        <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={onNavigate} onZoomToRoot={vi.fn()} />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[0] as HTMLButtonElement).focus()

      await user.keyboard('{ArrowRight}')
      const afterArrow = document.activeElement
      await user.keyboard('x')
      expect(document.activeElement).toBe(afterArrow)
    })
  })
})
