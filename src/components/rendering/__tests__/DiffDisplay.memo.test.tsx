/**
 * Tests for DiffDisplay span-parse memoization (#1623).
 *
 * Each visible diff span used to call `renderRichContent` → `parse`
 * (recursive-descent markdown parser) inline inside the render's `.map()`.
 * A hunk-nav click only flips the active-hunk ring, yet it re-ran the full
 * parse for every visible span (up to COLLAPSED_SPAN_COUNT = 100, or the
 * whole span set when expanded).
 *
 * This suite verifies:
 *  - Each span is parsed exactly once on initial render.
 *  - A prev/next hunk-nav click does NOT re-parse any span (the `useMemo`
 *    reuses the parsed nodes; only the ring data-attributes update).
 *  - Expanding a large diff parses the newly-revealed spans once.
 *  - Output (active-hunk ring wiring) is unchanged.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DiffSpan } from '@/lib/tauri'

// Return STABLE callback identities across renders (the real hooks use
// `useCallback` with empty deps), so the component's span memo only recomputes
// on real visible-span / resolve-version changes — NOT on every render.
vi.mock('@/hooks/useRichContentCallbacks', () => {
  const stableCallbacks = {
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  }
  const stableTagClick = vi.fn()
  return {
    useRichContentCallbacks: vi.fn(() => stableCallbacks),
    useTagClickHandler: vi.fn(() => stableTagClick),
  }
})

// Render rich content as plain text so the parse is queryable AND countable.
vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

import { DiffDisplay } from '@/components/rendering/DiffDisplay'
import { renderRichContent } from '@/components/RichContentRenderer'

function makeSpan(tag: DiffSpan['tag'], value: string): DiffSpan {
  return { tag, value }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('DiffDisplay span memoization (#1623)', () => {
  it('parses each visible span exactly once on initial render', () => {
    const spans: DiffSpan[] = [
      makeSpan('Equal', 'a '),
      makeSpan('Insert', 'one'),
      makeSpan('Equal', ' b '),
      makeSpan('Delete', 'two'),
      makeSpan('Equal', ' c'),
    ]
    render(<DiffDisplay spans={spans} />)
    expect(renderRichContent).toHaveBeenCalledTimes(spans.length)
  })

  it('does not re-parse any span on a hunk-nav click', async () => {
    const user = userEvent.setup()
    // Avoid scrollIntoView noise (jsdom doesn't implement it).
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})

    const spans: DiffSpan[] = [
      makeSpan('Equal', 'a '),
      makeSpan('Insert', 'one'), // hunk 0
      makeSpan('Equal', ' b '),
      makeSpan('Delete', 'two'), // hunk 1
      makeSpan('Equal', ' c'),
    ]
    const { container } = render(<DiffDisplay spans={spans} />)
    expect(renderRichContent).toHaveBeenCalledTimes(spans.length)

    const ins = container.querySelector('ins') as HTMLElement
    const del = container.querySelector('del') as HTMLElement
    // Initially hunk 0 (<ins>) is active.
    expect(ins.getAttribute('data-hunk-active')).toBe('true')
    expect(del.getAttribute('data-hunk-active')).toBeNull()

    await user.click(screen.getByTestId('diff-next-hunk-btn'))

    // Ring moved to hunk 1 (<del>) — output updated.
    expect(ins.getAttribute('data-hunk-active')).toBeNull()
    expect(del.getAttribute('data-hunk-active')).toBe('true')

    // …but the parse must NOT have re-run for any span: the memo key
    // (visibleSpans + resolve callbacks + resolveVersion) is unchanged.
    expect(renderRichContent).toHaveBeenCalledTimes(spans.length)

    await user.click(screen.getByTestId('diff-prev-hunk-btn'))
    expect(renderRichContent).toHaveBeenCalledTimes(spans.length)
  })

  it('parses only the newly-revealed spans once when expanding a large diff', async () => {
    const user = userEvent.setup()
    // 750 spans → collapsed to first 100 by default.
    const spans: DiffSpan[] = Array.from({ length: 750 }, (_, i) =>
      makeSpan(i % 3 === 0 ? 'Insert' : i % 3 === 1 ? 'Delete' : 'Equal', `tok${i}`),
    )

    render(<DiffDisplay spans={spans} />)
    // Collapsed: only the first 100 spans are parsed.
    expect(renderRichContent).toHaveBeenCalledTimes(100)

    await user.click(screen.getByTestId('diff-toggle-btn'))
    // Expanded: the memo recomputes for the new (full) visible set — all 750
    // spans parsed (the visible span set changed, a legitimate recompute).
    expect(renderRichContent).toHaveBeenCalledTimes(100 + 750)
  })
})
