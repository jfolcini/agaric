/**
 * Tests for the `SnippetHighlight` renderer + `parseSnippet` parser.
 *
 * Covers the PEND-50 Phase 1 "Testing surface — frontend / Unit" cases
 * for `SearchResultBlockRow.tsx`'s snippet path:
 *
 *  - Plain text (no sentinel boundaries) → single text span.
 *  - One sentinel pair (U+E000 / U+E001) → text + mark + text.
 *  - Multiple sentinel pairs → alternating text/mark sequence.
 *  - Literal `<` and `&` in source → rendered as text content (React
 *    escapes), zero XSS surface.
 *  - #828: a literal `<mark>` substring in content → rendered verbatim as
 *    text, NEVER treated as a highlight boundary.
 *  - Hypothetical `<script>` payload → rendered as text, no script
 *    executes (this defends against a future regression where a
 *    `dangerouslySetInnerHTML` slip-up would otherwise execute the
 *    payload).
 *  - Defensive: unpaired OPEN or CLOSE sentinel → no exception thrown.
 *  - `null` / empty / undefined snippet → empty fragment list.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseSnippet, SnippetHighlight } from '../SnippetHighlight'

// #828 — the backend snippet sentinels the parser recognises.
const OPEN = '\u{E000}'
const CLOSE = '\u{E001}'

describe('parseSnippet', () => {
  it('returns [] for null / undefined / empty', () => {
    expect(parseSnippet(null)).toEqual([])
    expect(parseSnippet(undefined)).toEqual([])
    expect(parseSnippet('')).toEqual([])
  })

  it('parses plain text without sentinels as a single fragment', () => {
    const out = parseSnippet('plain content')
    expect(out).toEqual([{ text: 'plain content', marked: false }])
  })

  it('parses a single sentinel pair into text / mark / text', () => {
    const out = parseSnippet(`hello ${OPEN}world${CLOSE} bye`)
    expect(out).toEqual([
      { text: 'hello ', marked: false },
      { text: 'world', marked: true },
      { text: ' bye', marked: false },
    ])
  })

  it('parses multiple sentinel pairs in order', () => {
    const out = parseSnippet(`${OPEN}a${CLOSE}-${OPEN}b${CLOSE}-${OPEN}c${CLOSE}`)
    expect(out).toEqual([
      { text: 'a', marked: true },
      { text: '-', marked: false },
      { text: 'b', marked: true },
      { text: '-', marked: false },
      { text: 'c', marked: true },
    ])
  })

  it('preserves literal `<` and `&` characters as text', () => {
    const out = parseSnippet(`a < b && c ${OPEN}x${CLOSE}`)
    expect(out).toEqual([
      { text: 'a < b && c ', marked: false },
      { text: 'x', marked: true },
    ])
  })

  it('#828: a literal `<mark>` substring in content is plain text, never a boundary', () => {
    // Only the real sentinel pair around `foo` is a highlight; the typed
    // `<mark>` is rendered verbatim.
    const out = parseSnippet(`use ${OPEN}foo${CLOSE} with <mark> literal`)
    expect(out).toEqual([
      { text: 'use ', marked: false },
      { text: 'foo', marked: true },
      { text: ' with <mark> literal', marked: false },
    ])
  })

  it('renders a `<script>` payload defensively as literal text', () => {
    const out = parseSnippet('<script>alert(1)</script>')
    // No sentinel markers — the whole thing is one plain-text fragment.
    expect(out).toEqual([{ text: '<script>alert(1)</script>', marked: false }])
  })

  it('handles an unpaired OPEN sentinel by emitting the rest as text', () => {
    // The dangling open sentinel itself is rendered as literal text — the
    // parser never throws.
    const out = parseSnippet(`before ${OPEN}unterminated end`)
    expect(out).toEqual([
      { text: 'before ', marked: false },
      { text: `${OPEN}unterminated end`, marked: false },
    ])
  })

  it('treats an unpaired CLOSE sentinel as plain text', () => {
    const out = parseSnippet(`orphan ${CLOSE} close`)
    expect(out).toEqual([{ text: `orphan ${CLOSE} close`, marked: false }])
  })
})

describe('SnippetHighlight', () => {
  it('renders plain text as a single span (no <mark>)', () => {
    const { container } = render(<SnippetHighlight snippet="plain text" />)
    expect(container.textContent).toBe('plain text')
    expect(container.querySelector('mark')).toBeNull()
  })

  it('renders a sentinel highlight with the `.search-result-mark` class', () => {
    render(<SnippetHighlight snippet={`hello ${OPEN}world${CLOSE} bye`} />)
    const marks = document.querySelectorAll('mark.search-result-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('world')
  })

  it('renders multiple marks for multiple sentinel pairs', () => {
    const { container } = render(
      <SnippetHighlight snippet={`${OPEN}a${CLOSE}-${OPEN}b${CLOSE}-${OPEN}c${CLOSE}`} />,
    )
    const marks = container.querySelectorAll('mark.search-result-mark')
    expect(marks).toHaveLength(3)
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['a', 'b', 'c'])
  })

  it('escapes literal `<` and `&` via React (text content, not parsed HTML)', () => {
    const { container } = render(<SnippetHighlight snippet={`a < b && c ${OPEN}x${CLOSE}`} />)
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

  it('does not throw on an unpaired OPEN sentinel', () => {
    expect(() =>
      render(<SnippetHighlight snippet={`before ${OPEN}unterminated end`} />),
    ).not.toThrow()
    // The literal dangling sentinel appears as text — verifies no mark
    // element was emitted.
    expect(screen.queryByText(/unterminated end/)).toBeTruthy()
  })
})
