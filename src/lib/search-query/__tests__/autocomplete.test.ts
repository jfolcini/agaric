import { describe, expect, it } from 'vitest'
import { applyAutocompleteReplacement, detectAutocompleteAnchor } from '../autocomplete'

describe('detectAutocompleteAnchor', () => {
  it('opens on tag:# with empty query', () => {
    const a = detectAutocompleteAnchor('tag:#', 5)
    expect(a).toEqual({ active: 'tag', query: '', anchor: 5 })
  })

  it('captures partial tag query', () => {
    const a = detectAutocompleteAnchor('tag:#urg', 8)
    expect(a).toEqual({ active: 'tag', query: 'urg', anchor: 5 })
  })

  it('closes after space following tag', () => {
    expect(detectAutocompleteAnchor('tag:#urgent ', 12)).toBeNull()
  })

  it('returns null in pure free text', () => {
    expect(detectAutocompleteAnchor('hello world', 5)).toBeNull()
  })

  it('opens on path:', () => {
    const a = detectAutocompleteAnchor('path:Journal/', 13)
    expect(a).toMatchObject({ active: 'pathInclude', query: 'Journal/' })
  })

  it('opens on not-path: (prefix-match priority over path:)', () => {
    const a = detectAutocompleteAnchor('not-path:Archive/', 17)
    expect(a).toMatchObject({ active: 'pathExclude', query: 'Archive/' })
  })

  it('closes when caret is inside an open quoted phrase', () => {
    // The unmatched quote at column 0 opens a phrase that surrounds
    // the entire rest of the input — caret column 5 is inside.
    expect(detectAutocompleteAnchor('"tag:#urgent', 5)).toBeNull()
  })

  it('handles multi-token inputs (only the active token autocompletes)', () => {
    const input = 'hello tag:#urg'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'tag', query: 'urg' })
  })

  it('clamps out-of-range caret positions', () => {
    expect(detectAutocompleteAnchor('tag:#x', 999)).toMatchObject({ active: 'tag', query: 'x' })
    expect(detectAutocompleteAnchor('tag:#x', -10)).toBeNull()
  })
})

describe('applyAutocompleteReplacement', () => {
  it('inserts the chosen value and trailing space', () => {
    const input = 'tag:#urg'
    const anchor = detectAutocompleteAnchor(input, input.length)
    const { nextValue, nextCaret } = applyAutocompleteReplacement(
      input,
      input.length,
      anchor,
      'urgent',
    )
    expect(nextValue).toBe('tag:#urgent ')
    expect(nextCaret).toBe(nextValue.length)
  })

  it('preserves text after the caret', () => {
    const input = 'tag:#u  trailing'
    const anchor = detectAutocompleteAnchor(input, 6)
    const { nextValue } = applyAutocompleteReplacement(input, 6, anchor, 'urgent')
    expect(nextValue).toContain('tag:#urgent')
    expect(nextValue).toContain('trailing')
  })

  it('returns the input unchanged when there is no anchor', () => {
    const { nextValue, nextCaret } = applyAutocompleteReplacement('hello', 5, null, 'world')
    expect(nextValue).toBe('hello')
    expect(nextCaret).toBe(5)
  })
})
