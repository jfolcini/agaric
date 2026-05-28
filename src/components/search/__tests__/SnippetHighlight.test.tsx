/**
 * Tests for the `SnippetHighlight` renderer + `parseSnippet` parser.
 *
 * Covers the PEND-50 Phase 1 "Testing surface — frontend / Unit" cases
 * for `SearchResultBlockRow.tsx`'s snippet path:
 *
 *  - Plain text (no `<mark>` boundaries) → single text span.
 *  - One `<mark>` pair → text + mark + text.
 *  - Multiple `<mark>` pairs → alternating text/mark sequence.
 *  - Literal `<` and `&` in source → rendered as text content (React
 *    escapes), zero XSS surface.
 *  - Hypothetical `<script>` payload → rendered as text, no script
 *    executes (this defends against a future regression where a
 *    `dangerouslySetInnerHTML` slip-up would otherwise execute the
 *    payload).
 *  - Defensive: unpaired `<mark>` open or close → no exception thrown.
 *  - `null` / empty / undefined snippet → empty fragment list.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseSnippet, SnippetHighlight } from '../SnippetHighlight'

describe('parseSnippet', () => {
  it('returns [] for null / undefined / empty', () => {
    expect(parseSnippet(null)).toEqual([])
    expect(parseSnippet(undefined)).toEqual([])
    expect(parseSnippet('')).toEqual([])
  })

  it('parses plain text without `<mark>` as a single fragment', () => {
    const out = parseSnippet('plain content')
    expect(out).toEqual([{ text: 'plain content', marked: false }])
  })

  it('parses a single `<mark>` pair into text / mark / text', () => {
    const out = parseSnippet('hello <mark>world</mark> bye')
    expect(out).toEqual([
      { text: 'hello ', marked: false },
      { text: 'world', marked: true },
      { text: ' bye', marked: false },
    ])
  })

  it('parses multiple `<mark>` pairs in order', () => {
    const out = parseSnippet('<mark>a</mark>-<mark>b</mark>-<mark>c</mark>')
    expect(out).toEqual([
      { text: 'a', marked: true },
      { text: '-', marked: false },
      { text: 'b', marked: true },
      { text: '-', marked: false },
      { text: 'c', marked: true },
    ])
  })

  it('preserves literal `<` and `&` characters as text', () => {
    const out = parseSnippet('a < b && c <mark>x</mark>')
    expect(out).toEqual([
      { text: 'a < b && c ', marked: false },
      { text: 'x', marked: true },
    ])
  })

  it('renders a `<script>` payload defensively as literal text', () => {
    const out = parseSnippet('<script>alert(1)</script>')
    // No `<mark>` markers — the whole thing is one plain-text fragment.
    expect(out).toEqual([{ text: '<script>alert(1)</script>', marked: false }])
  })

  it('handles an unpaired `<mark>` open by emitting the rest as text', () => {
    // The dangling open tag itself is rendered as literal text — the
    // parser never throws.
    const out = parseSnippet('before <mark>unterminated end')
    expect(out).toEqual([
      { text: 'before ', marked: false },
      { text: '<mark>unterminated end', marked: false },
    ])
  })

  it('treats an unpaired `</mark>` close as plain text', () => {
    const out = parseSnippet('orphan </mark> close')
    expect(out).toEqual([{ text: 'orphan </mark> close', marked: false }])
  })
})

describe('SnippetHighlight', () => {
  it('renders plain text as a single span (no <mark>)', () => {
    const { container } = render(<SnippetHighlight snippet="plain text" />)
    expect(container.textContent).toBe('plain text')
    expect(container.querySelector('mark')).toBeNull()
  })

  it('renders a `<mark>` highlight with the `.search-result-mark` class', () => {
    render(<SnippetHighlight snippet="hello <mark>world</mark> bye" />)
    const marks = document.querySelectorAll('mark.search-result-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('world')
  })

  it('renders multiple marks for multiple `<mark>` pairs', () => {
    const { container } = render(
      <SnippetHighlight snippet="<mark>a</mark>-<mark>b</mark>-<mark>c</mark>" />,
    )
    const marks = container.querySelectorAll('mark.search-result-mark')
    expect(marks).toHaveLength(3)
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['a', 'b', 'c'])
  })

  it('escapes literal `<` and `&` via React (text content, not parsed HTML)', () => {
    const { container } = render(<SnippetHighlight snippet="a < b && c <mark>x</mark>" />)
    expect(container.textContent).toBe('a < b && c x')
    // Verify the `<` did NOT spawn a stray element.
    expect(container.querySelectorAll('mark').length).toBe(1)
  })

  it('renders `<script>` payloads inert (no script execution, no <script> element)', () => {
    const { container } = render(<SnippetHighlight snippet="<script>alert(1)</script>" />)
    // React renders the entire string as text; no script element is created.
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toBe('<script>alert(1)</script>')
  })

  it('renders nothing for null snippet (empty wrapper span only)', () => {
    const { container } = render(<SnippetHighlight snippet={null} />)
    expect(container.textContent).toBe('')
    expect(container.querySelector('mark')).toBeNull()
  })

  it('does not throw on an unpaired `<mark>`', () => {
    expect(() => render(<SnippetHighlight snippet="before <mark>unterminated end" />)).not.toThrow()
    // The literal dangling tag appears as text — verifies no mark element
    // was emitted.
    expect(screen.queryByText(/<mark>unterminated end/)).toBeTruthy()
  })
})
