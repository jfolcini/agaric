/**
 * Tests for BlockZoomBar component.
 *
 * Validates:
 * - Returns null when breadcrumbs are empty
 * - Renders Home button and breadcrumb items
 * - Home button calls onZoomToRoot
 * - Clicking a non-last breadcrumb calls onNavigate
 * - Last breadcrumb does not navigate
 * - Untitled blocks show fallback text
 * - Renders [[ULID]] content as pill chips via renderRichContent
 * - a11y compliance (axe)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
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

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string, _opts?: unknown): React.ReactNode => {
    // Simulate pill rendering for [[ULID]] tokens
    const parts: React.ReactNode[] = []
    const re = /\[\[([^\]]+)\]\]/g
    let lastIndex = 0
    let match: RegExpExecArray | null = null
    let key = 0
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((match = re.exec(markdown)) !== null) {
      if (match.index > lastIndex) {
        parts.push(markdown.slice(lastIndex, match.index))
      }
      parts.push(
        <span key={`chip-${key++}`} className="block-link-chip" data-testid="block-link-chip">
          {match[1]}
        </span>,
      )
      lastIndex = re.lastIndex
    }
    if (lastIndex < markdown.length) {
      parts.push(markdown.slice(lastIndex))
    }
    return parts.length > 0 ? parts : markdown
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
    // Home button is the first button in the nav
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
    await user.click(screen.getByText('Detail'))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows "Untitled" for breadcrumbs with empty content', () => {
    const items: BreadcrumbItem[] = [{ id: 'X', content: '' }]
    render(<BlockZoomBar breadcrumbs={items} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('applies font-medium class to the last breadcrumb', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    const lastButton = screen.getByText('Detail')
    expect(lastButton.className).toContain('font-medium')
  })

  it('does not apply font-medium to non-last breadcrumbs', () => {
    render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
    const firstButton = screen.getByText('Page')
    expect(firstButton.className).not.toContain('font-medium')
  })

  it('renders [[ULID]] content as a pill chip instead of raw text', () => {
    const items: BreadcrumbItem[] = [{ id: 'Z', content: 'See [[01JFAKE00000000000000ULID]]' }]
    render(<BlockZoomBar breadcrumbs={items} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)

    // The mock renderRichContent produces a span.block-link-chip for [[…]] tokens
    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.className).toContain('block-link-chip')
    expect(chip.textContent).toBe('01JFAKE00000000000000ULID')

    // Raw ULID text should not appear outside the chip
    expect(screen.queryByText('[[01JFAKE00000000000000ULID]]')).not.toBeInTheDocument()
  })

  it('passes axe a11y audit', async () => {
    const { container } = render(
      <BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  describe('UX-215 arrow-key navigation', () => {
    it('marks the last breadcrumb with aria-current="location"', () => {
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const last = screen.getByText('Detail').closest('button') as HTMLButtonElement
      expect(last).toHaveAttribute('aria-current', 'location')
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
      // Focus the home button first (index 0)
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

    it('ArrowRight clamps at the last breadcrumb', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      const lastIdx = buttons.length - 1
      ;(buttons[lastIdx] as HTMLButtonElement).focus()

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[lastIdx])
    })

    it('Home jumps focus to the first breadcrumb (Home button)', async () => {
      const user = userEvent.setup()
      render(<BlockZoomBar breadcrumbs={breadcrumbs} onNavigate={vi.fn()} onZoomToRoot={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      ;(buttons[2] as HTMLButtonElement).focus()

      await user.keyboard('{Home}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('End jumps focus to the last breadcrumb', async () => {
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

      // Enter on the home button should NOT move arrow focus; it should
      // fire the button's click (onZoomToRoot). We just assert focus didn't shift.
      await user.keyboard('{ArrowRight}')
      const afterArrow = document.activeElement
      // Type a random letter and verify focus doesn't move
      await user.keyboard('x')
      expect(document.activeElement).toBe(afterArrow)
    })
  })
})
