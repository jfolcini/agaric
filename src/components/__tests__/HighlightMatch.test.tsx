/**
 * Tests for HighlightMatch component.
 *
 * Validates:
 *  - Renders plain text when filterText is empty
 *  - Highlights matching substring with <mark>
 *  - Case-insensitive matching
 *  - No highlight when no match found
 *  - Handles special regex characters safely
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { HighlightMatch } from '../HighlightMatch'

describe('HighlightMatch', () => {
  it('renders plain text when filterText is empty', () => {
    render(<HighlightMatch text="Hello World" filterText="" />)
    expect(screen.getByText('Hello World')).toBeInTheDocument()
    expect(document.querySelector('mark')).not.toBeInTheDocument()
  })

  it('highlights matching substring', () => {
    const { container } = render(<HighlightMatch text="Hello World" filterText="World" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('World')
  })

  it('renders text before and after the match', () => {
    const { container } = render(<HighlightMatch text="abcXYZdef" filterText="XYZ" />)
    expect(container.textContent).toBe('abcXYZdef')
    const mark = container.querySelector('mark')
    expect(mark?.textContent).toBe('XYZ')
  })

  it('matches case-insensitively', () => {
    const { container } = render(<HighlightMatch text="Hello World" filterText="hello" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('Hello')
  })

  it('renders plain text when there is no match', () => {
    render(<HighlightMatch text="Hello World" filterText="xyz" />)
    expect(screen.getByText('Hello World')).toBeInTheDocument()
    expect(document.querySelector('mark')).not.toBeInTheDocument()
  })

  it('handles special regex characters in filter text', () => {
    const { container } = render(<HighlightMatch text="price: $5.00" filterText="$5.0" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('$5.0')
  })

  it('only highlights the first occurrence', () => {
    const { container } = render(<HighlightMatch text="abcabcabc" filterText="abc" />)
    const marks = container.querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('abc')
    // Rest of text should still be visible
    expect(container.textContent).toBe('abcabcabc')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<HighlightMatch text="Hello World" filterText="World" />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // UX-247 — Unicode-aware folding regression tests.  Plain
  // `.toLowerCase()` fails these cases; `indexOfFolded` handles them.

  it('highlights Turkish İstanbul when filter is istanbul', () => {
    const { container } = render(<HighlightMatch text="İstanbul" filterText="istanbul" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    // The slice starts at 0 and spans the user-entered needle length
    // so the <mark> visually covers the original non-ASCII prefix.
    expect(mark?.textContent).toBe('İstanbul')
  })

  it('highlights German Straße when filter is strasse', () => {
    const { container } = render(<HighlightMatch text="Straße" filterText="strasse" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('Straße')
  })

  // PAGES-FOLD-MARK regression: the <mark> bound must use the original-
  // string span length (not filterText.length) so the highlight stops at
  // the end of "Straße" and does not bleed into the next character.
  it('does not bleed past Straße when surrounding chars exist (ß→ss fold)', () => {
    const { container } = render(<HighlightMatch text="abc Straße." filterText="strasse" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('Straße')
    expect(container.textContent).toBe('abc Straße.')
  })

  // PAGES-FOLD-MARK: ligature ﬁ (U+FB01) folds to "fi" (length 2). The
  // <mark> must cover only the ligature (1 code unit) — not the next
  // character.
  it('highlights only the ﬁ ligature, not the next character', () => {
    const { container } = render(<HighlightMatch text="aﬁx" filterText="fi" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('ﬁ')
    expect(container.textContent).toBe('aﬁx')
  })

  it('highlights accented café when filter is cafe', () => {
    const { container } = render(<HighlightMatch text="café" filterText="cafe" />)
    const mark = container.querySelector('mark')
    expect(mark).toBeInTheDocument()
    expect(mark?.textContent).toBe('café')
  })

  it('renders plain text when Unicode substring does not match', () => {
    render(<HighlightMatch text="İstanbul" filterText="ankara" />)
    expect(screen.getByText('İstanbul')).toBeInTheDocument()
    expect(document.querySelector('mark')).not.toBeInTheDocument()
  })
})
