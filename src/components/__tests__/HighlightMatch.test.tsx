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
})
