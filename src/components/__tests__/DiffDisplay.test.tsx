/**
 * Tests for DiffDisplay component (#471).
 *
 * Validates:
 *  - Empty state rendering for zero spans
 *  - Delete span renders <del> with red styling
 *  - Insert span renders <ins> with green styling
 *  - Equal span renders as plain <span>
 *  - Mixed spans render in correct order
 *  - Edge cases: long text, empty strings, unicode
 *  - Rich content rendering (ULID tokens resolved via renderRichContent)
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { DiffSpan } from '../../lib/tauri'
import { DiffDisplay } from '../DiffDisplay'

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) => (id === 'PAGE1' ? 'My Page' : undefined)),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn((id: string) => (id === 'TAG1' ? 'project' : undefined)),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

function makeSpan(tag: DiffSpan['tag'], value: string): DiffSpan {
  return { tag, value }
}

describe('DiffDisplay', () => {
  it('renders empty state for zero spans', () => {
    render(<DiffDisplay spans={[]} />)

    expect(screen.getByText('No changes')).toBeInTheDocument()
  })

  it('renders Delete span with del element', () => {
    const spans: DiffSpan[] = [makeSpan('Delete', 'removed text')]

    const { container } = render(<DiffDisplay spans={spans} />)

    const del = container.querySelector('del')
    expect(del).not.toBeNull()
    expect(del).toHaveTextContent('removed text')
    expect(del).toHaveClass('bg-destructive/15', 'text-destructive')
  })

  it('renders Insert span with ins element', () => {
    const spans: DiffSpan[] = [makeSpan('Insert', 'added text')]

    const { container } = render(<DiffDisplay spans={spans} />)

    const ins = container.querySelector('ins')
    expect(ins).not.toBeNull()
    expect(ins).toHaveTextContent('added text')
    expect(ins).toHaveClass('bg-status-done', 'text-status-done-foreground')
  })

  it('renders Equal span as plain text', () => {
    const spans: DiffSpan[] = [makeSpan('Equal', 'unchanged')]

    const { container } = render(<DiffDisplay spans={spans} />)

    // Equal spans render as <span> inside the <p>
    const p = container.querySelector('p.diff-display')
    expect(p).not.toBeNull()
    const span = p?.querySelector('span')
    expect(span).not.toBeNull()
    expect(span).toHaveTextContent('unchanged')
  })

  it('renders mixed spans in order', () => {
    const spans: DiffSpan[] = [
      makeSpan('Delete', 'old'),
      makeSpan('Insert', 'new'),
      makeSpan('Equal', 'same'),
    ]

    const { container } = render(<DiffDisplay spans={spans} />)

    const p = container.querySelector('p.diff-display')
    expect(p).not.toBeNull()

    const children = Array.from((p as HTMLElement).children)
    expect(children).toHaveLength(3)

    expect(children[0]?.tagName).toBe('DEL')
    expect(children[0] as HTMLElement).toHaveTextContent('old')

    expect(children[1]?.tagName).toBe('INS')
    expect(children[1] as HTMLElement).toHaveTextContent('new')

    expect(children[2]?.tagName).toBe('SPAN')
    expect(children[2] as HTMLElement).toHaveTextContent('same')
  })

  it('handles very long text', () => {
    const longText = 'a'.repeat(10000)
    const spans: DiffSpan[] = [makeSpan('Equal', longText)]

    const { container } = render(<DiffDisplay spans={spans} />)

    const span = container.querySelector('p.diff-display span')
    expect(span).not.toBeNull()
    expect((span as HTMLElement).textContent).toHaveLength(10000)
  })

  it('handles empty string values', () => {
    const spans: DiffSpan[] = [
      makeSpan('Delete', ''),
      makeSpan('Insert', ''),
      makeSpan('Equal', ''),
    ]

    const { container } = render(<DiffDisplay spans={spans} />)

    const p = container.querySelector('p.diff-display')
    expect(p).not.toBeNull()

    const children = Array.from((p as HTMLElement).children)
    expect(children).toHaveLength(3)
    expect(children[0]?.tagName).toBe('DEL')
    expect(children[1]?.tagName).toBe('INS')
    expect(children[2]?.tagName).toBe('SPAN')
  })

  it('handles unicode characters', () => {
    const spans: DiffSpan[] = [
      makeSpan('Delete', '🔥 fire'),
      makeSpan('Insert', '日本語テスト'),
      makeSpan('Equal', '✅ done — «quoted»'),
    ]

    const { container } = render(<DiffDisplay spans={spans} />)

    // renderRichContent wraps text in elements; check textContent on diff elements
    const del = container.querySelector('del')
    expect(del).not.toBeNull()
    expect((del as Element).textContent).toContain('🔥 fire')

    const ins = container.querySelector('ins')
    expect(ins).not.toBeNull()
    expect((ins as Element).textContent).toContain('日本語テスト')

    // Equal spans are inside <span> within <p>
    const p = container.querySelector('p.diff-display')
    expect(p).not.toBeNull()
    expect((p as Element).textContent).toContain('✅ done — «quoted»')
  })

  it('has no a11y violations', async () => {
    const spans: DiffSpan[] = [
      makeSpan('Delete', 'removed'),
      makeSpan('Insert', 'added'),
      makeSpan('Equal', 'unchanged'),
    ]

    const { container } = render(<DiffDisplay spans={spans} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -- Rich content rendering (B-45) ----------------------------------------

  it('renders diff spans through renderRichContent', () => {
    const spans: DiffSpan[] = [
      makeSpan('Equal', 'Check '),
      makeSpan('Delete', 'old text'),
      makeSpan('Insert', 'new text'),
    ]

    const { container } = render(<DiffDisplay spans={spans} />)

    const p = container.querySelector('p.diff-display')
    expect(p).not.toBeNull()
    // Content is rendered through renderRichContent but plain text still appears
    expect((p as Element).textContent).toContain('Check')
    expect((p as Element).textContent).toContain('old text')
    expect((p as Element).textContent).toContain('new text')
    // Diff semantics preserved
    expect((container.querySelector('del') as Element).textContent).toContain('old text')
    expect((container.querySelector('ins') as Element).textContent).toContain('new text')
  })

  // -- UX-265 sub-fix 5: large-diff toggle --------------------------------
  describe('UX-265 large-diff toggle', () => {
    /** Build a span list that exceeds the LARGE_DIFF_THRESHOLD (500). */
    function makeLargeSpans(count: number): DiffSpan[] {
      return Array.from({ length: count }, (_, i) =>
        makeSpan(i % 3 === 0 ? 'Insert' : i % 3 === 1 ? 'Delete' : 'Equal', `tok${i}`),
      )
    }

    it('does not render the toggle for diffs below the threshold', () => {
      // 500 spans is the threshold; 500 should NOT trigger the toggle.
      const spans = makeLargeSpans(500)

      const { container } = render(<DiffDisplay spans={spans} />)

      expect(container.querySelector('[data-testid="diff-toggle-btn"]')).toBeNull()
      const p = container.querySelector('p.diff-display') as HTMLElement
      expect(p.children.length).toBe(500)
    })

    it('renders the Show full diff toggle when spans exceed the threshold', () => {
      const spans = makeLargeSpans(750)

      const { container } = render(<DiffDisplay spans={spans} />)

      const toggle = container.querySelector('[data-testid="diff-toggle-btn"]') as HTMLElement
      expect(toggle).toBeTruthy()
      expect(toggle.textContent).toMatch(/Show full diff/i)
      // Hidden count is total - visible (100 visible by default) = 650.
      expect(toggle.textContent).toContain('650')
    })

    it('default state shows only the first 100 spans when diff is large', () => {
      const spans = makeLargeSpans(750)

      const { container } = render(<DiffDisplay spans={spans} />)

      const p = container.querySelector('p.diff-display') as HTMLElement
      expect(p.children.length).toBe(100)
    })

    it('expanding the toggle reveals all spans and switches to Collapse label', async () => {
      const user = userEvent.setup()
      const spans = makeLargeSpans(750)

      const { container } = render(<DiffDisplay spans={spans} />)

      const toggle = container.querySelector('[data-testid="diff-toggle-btn"]') as HTMLElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      await user.click(toggle)

      const p = container.querySelector('p.diff-display') as HTMLElement
      expect(p.children.length).toBe(750)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(toggle.textContent).toMatch(/Collapse diff/i)

      // Re-collapse round-trips back to 100 visible.
      await user.click(toggle)
      const p2 = container.querySelector('p.diff-display') as HTMLElement
      expect(p2.children.length).toBe(100)
      expect(toggle.textContent).toMatch(/Show full diff/i)
    })

    it('hidden count in toggle label tracks span total', () => {
      // 501 spans → 100 visible, 401 hidden. Just over the threshold
      // exercises the i18n plural template's count interpolation.
      const spans = makeLargeSpans(501)

      const { container } = render(<DiffDisplay spans={spans} />)

      const toggle = container.querySelector('[data-testid="diff-toggle-btn"]') as HTMLElement
      expect(toggle.textContent).toContain('401')
    })
  })
})
