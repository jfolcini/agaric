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

  it('keeps autocomplete open for an interior # in a tag value', () => {
    // The classifier strips only a *single leading* `#`, so `foo#bar`
    // is a legal tag name. The anchor detector must agree and not bail
    // out the moment it sees an interior `#`.
    const input = 'tag:foo#bar'
    expect(detectAutocompleteAnchor(input, input.length)).toMatchObject({
      active: 'tag',
      query: 'foo#bar',
    })
  })

  // State / priority / due / scheduled / prop autocomplete.

  it('opens on state:', () => {
    const a = detectAutocompleteAnchor('state:TO', 8)
    expect(a).toMatchObject({ active: 'state', query: 'TO' })
  })

  // #1682 — negated state:/priority: must carry a distinct anchor kind
  // (`notState`/`notPriority`) so the negation signal is preserved, rather
  // than collapsing into the positive 'state'/'priority' kinds.
  it('opens on not-state: with notState kind (longer prefix wins)', () => {
    const a = detectAutocompleteAnchor('not-state:DO', 12)
    expect(a).toMatchObject({ active: 'notState', query: 'DO' })
  })

  it('anchors not-state: value portion just after the prefix', () => {
    const a = detectAutocompleteAnchor('not-state:DO', 12)
    expect(a).toEqual({ active: 'notState', query: 'DO', anchor: 'not-state:'.length })
  })

  it('opens on not-state: with empty query', () => {
    const a = detectAutocompleteAnchor('not-state:', 10)
    expect(a).toEqual({ active: 'notState', query: '', anchor: 10 })
  })

  it('opens on priority:', () => {
    const a = detectAutocompleteAnchor('priority:1', 10)
    expect(a).toMatchObject({ active: 'priority', query: '1' })
  })

  // #1682 — not-priority: parallels not-state:.
  it('opens on not-priority: with notPriority kind (longer prefix wins)', () => {
    const a = detectAutocompleteAnchor('not-priority:1', 14)
    expect(a).toMatchObject({ active: 'notPriority', query: '1' })
  })

  it('anchors not-priority: value portion just after the prefix', () => {
    const a = detectAutocompleteAnchor('not-priority:1', 14)
    expect(a).toEqual({ active: 'notPriority', query: '1', anchor: 'not-priority:'.length })
  })

  // #1682 — positive cases must still report the un-negated kind (regression).
  it('keeps state: on the positive state kind', () => {
    const a = detectAutocompleteAnchor('state:TO', 8)
    expect(a).toMatchObject({ active: 'state', query: 'TO' })
  })

  it('keeps priority: on the positive priority kind', () => {
    const a = detectAutocompleteAnchor('priority:2', 10)
    expect(a).toMatchObject({ active: 'priority', query: '2' })
  })

  it('opens on due:', () => {
    const a = detectAutocompleteAnchor('due:tod', 7)
    expect(a).toMatchObject({ active: 'due', query: 'tod' })
  })

  it('opens on scheduled:', () => {
    const a = detectAutocompleteAnchor('scheduled:>=', 12)
    expect(a).toMatchObject({ active: 'scheduled', query: '>=' })
  })

  it('opens on prop: key portion', () => {
    const a = detectAutocompleteAnchor('prop:sta', 8)
    expect(a).toMatchObject({ active: 'propKey', query: 'sta' })
  })

  it('opens on prop:key= value portion', () => {
    const input = 'prop:status=don'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'propValue', key: 'status', query: 'don' })
  })

  it('opens on not-prop: (longer prefix wins)', () => {
    const a = detectAutocompleteAnchor('not-prop:archive', 16)
    expect(a).toMatchObject({ active: 'propKey', query: 'archive' })
  })
})

// `isInsideQuote` (the caret-inside-a-phrase guard) must agree
// with the tokenizer's quote segmentation. These pin the cases where the
// old odd/even `"`-counting model diverged.
describe('detectAutocompleteAnchor — quote handling', () => {
  it('suppresses autocomplete inside a boundary-closed phrase', () => {
    // `"hello world" tag:#x` — caret at column 5 is inside the phrase
    // `"hello world"` (span [0,13]); no autocomplete there.
    const input = '"hello world" tag:#x'
    expect(detectAutocompleteAnchor(input, 5)).toBeNull()
  })

  it('autocompletes a prefix immediately after a closed phrase', () => {
    // Caret right after the closing `"` opens a fresh token; `tag:#`
    // should autocomplete. Old model: 2 quotes → even → ok (agreed).
    const input = '"hello world" tag:#u'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'tag', query: 'u' })
  })

  it('autocompletes after an odd run of glued quotes (old model said inside)', () => {
    // `"a"b" tag:#u` — the tokenizer closes the phrase at the boundary
    // `"` (span `"a"b"` = [0,5]), so ` tag:#u` is its own token. The old
    // odd-count model saw 3 leading `"` → odd → wrongly suppressed.
    const input = '"a"b" tag:#u'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'tag', query: 'u' })
  })

  it('autocompletes when a stray quote is not at a token start', () => {
    // `foo" tag:#u` — the `"` is glued inside the word `foo"`, never
    // opening a phrase. Old odd-count saw 1 `"` → odd → wrongly
    // suppressed; the tokenizer treats it as a literal char.
    const input = 'foo" tag:#u'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'tag', query: 'u' })
  })

  it('autocompletes a real filter after an unterminated quote with spaces', () => {
    // `"hello world tag:#u` — an unterminated quote degrades to a word;
    // the tokenizer emits `"hello`, `world`, `tag:#u` as separate
    // tokens, so `tag:#u` is a genuine filter token. Old odd-count saw
    // 1 leading `"` → odd → wrongly suppressed.
    const input = '"hello world tag:#u'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'tag', query: 'u' })
  })

  it('still suppresses while typing inside a single-token open quote', () => {
    // `"tag:#urgent` (no whitespace) is one degraded word that does not
    // start a recognised prefix, so no autocomplete fires regardless.
    expect(detectAutocompleteAnchor('"tag:#urgent', 5)).toBeNull()
  })

  it('autocompletes a filter token that follows a closed phrase', () => {
    // `"a b" path:Foo` — the phrase `"a b"` (span [0,5]) is closed; the
    // following `path:Foo` token autocompletes normally.
    const input = '"a b" path:Foo'
    const a = detectAutocompleteAnchor(input, input.length)
    expect(a).toMatchObject({ active: 'pathInclude', query: 'Foo' })
  })

  it('caret exactly after the closing quote is outside the phrase', () => {
    // `"a b"` span is [0,5]; caret at 5 is just past the closing `"`, so
    // it is NOT inside — the guard returns false there.
    const input = '"a b"'
    // No prefix follows, so the result is null either way, but the point
    // is the guard does not treat caret==5 as inside (which would also
    // give null). Use a trailing prefix to make the distinction visible.
    const withPrefix = '"a b"tag:#u'
    // Glued: `"a b"tag:#u` — tokenizer scans for a boundary closer; the
    // `"` at index 4 is followed by `t` (not a boundary), so it keeps
    // scanning, finds none, and degrades the whole thing to one word.
    // That word does not start with a recognised prefix → null.
    expect(detectAutocompleteAnchor(withPrefix, withPrefix.length)).toBeNull()
    expect(detectAutocompleteAnchor(input, input.length)).toBeNull()
  })
})

// The dead `slice === 'tag:#'` arm was removed; the `tag:#name`
// and `tag:name` autocomplete paths must still behave identically.
describe('detectAutocompleteAnchor — tag:# / tag: parity', () => {
  it('treats tag:#name and tag:name with the same query', () => {
    const withHash = detectAutocompleteAnchor('tag:#urgent', 'tag:#urgent'.length)
    const withoutHash = detectAutocompleteAnchor('tag:urgent', 'tag:urgent'.length)
    expect(withHash).toMatchObject({ active: 'tag', query: 'urgent' })
    expect(withoutHash).toMatchObject({ active: 'tag', query: 'urgent' })
  })

  it('treats bare tag:# and tag: with an empty query', () => {
    const hashOnly = detectAutocompleteAnchor('tag:#', 'tag:#'.length)
    const colonOnly = detectAutocompleteAnchor('tag:', 'tag:'.length)
    expect(hashOnly).toMatchObject({ active: 'tag', query: '' })
    expect(colonOnly).toMatchObject({ active: 'tag', query: '' })
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

  it('#718 — quotes a path-history glob containing spaces on insert', () => {
    const input = 'path:Mee'
    const anchor = detectAutocompleteAnchor(input, input.length)
    const { nextValue, nextCaret } = applyAutocompleteReplacement(
      input,
      input.length,
      anchor,
      'Meeting Notes/*',
    )
    expect(nextValue).toBe('path:"Meeting Notes/*" ')
    expect(nextCaret).toBe(nextValue.length)
  })

  it('#718 — quotes a not-path glob with spaces, leaves space-free globs bare', () => {
    const ex = detectAutocompleteAnchor('not-path:Old', 12)
    expect(applyAutocompleteReplacement('not-path:Old', 12, ex, 'Old Archive/**').nextValue).toBe(
      'not-path:"Old Archive/**" ',
    )
    const inc = detectAutocompleteAnchor('path:J', 6)
    expect(applyAutocompleteReplacement('path:J', 6, inc, 'Journal/*').nextValue).toBe(
      'path:Journal/* ',
    )
  })

  it('#718 review — re-quotes a `"`-wrapped history glob (shared serialiser predicate)', () => {
    // A history value like `"ab"` (recorded from `path:""ab""`) must be
    // inserted as `path:""ab""`; bare insertion would strip the literal
    // quotes on the next parse, yielding chip `ab` ≠ history entry.
    const anchor = detectAutocompleteAnchor('path:', 5)
    expect(applyAutocompleteReplacement('path:', 5, anchor, '"ab"').nextValue).toBe('path:""ab"" ')
  })
})
