import { describe, expect, it } from 'vitest'
import { parse } from '../classify'

describe('classify / parse', () => {
  it('parses an empty string', () => {
    const ast = parse('')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('')
  })

  it('recognises tag: prefix', () => {
    const ast = parse('tag:#urgent')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('')
  })

  it('recognises bare #tag alias', () => {
    const ast = parse('#urgent')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
  })

  it('strips leading # inside tag: value', () => {
    const a = parse('tag:#x')
    const b = parse('tag:x')
    expect(a.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(b.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
  })

  it('recognises path: include and not-path: exclude', () => {
    const ast = parse('path:Journal/* not-path:Archive/**')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathExclude', value: 'Archive/**' })
  })

  it('places free text into freeText, preserving order-agnostically', () => {
    const ast = parse('hello tag:#urgent world')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('hello world')
  })

  it('rejects unknown filter keys as invalid tokens', () => {
    const ast = parse('foo:bar baz')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    expect(tok).toMatchObject({
      kind: 'invalid',
      source: 'foo:bar',
    })
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain("'foo:'")
    }
    expect(ast.freeText).toBe('baz')
  })

  it('keeps a pasted URL as free text rather than an invalid chip (DSL-10)', () => {
    // `http:` matches the unknown-prefix shape, but the `//` right after
    // the colon means it is a URL, not a filter — it must survive in
    // free text instead of being consumed (and dropped) as an invalid
    // chip.
    for (const url of ['http://example.com', 'https://example.com/a?b=c', 'file:///tmp/x']) {
      const ast = parse(url)
      expect(ast.filters).toEqual([])
      expect(ast.freeText).toBe(url)
    }
  })

  it('accepts due:/scheduled: NONE case-insensitively, normalised to "none" (DSL-3)', () => {
    for (const raw of ['due:NONE', 'due:none', 'due:None']) {
      const ast = parse(raw)
      expect(ast.filters[0]).toMatchObject({ kind: 'due', value: { kind: 'named', name: 'none' } })
    }
    expect(parse('scheduled:NONE').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'named', name: 'none' },
    })
  })

  it('collapses internal whitespace in free text (DSL-4 contract)', () => {
    // Documented lossy round-trip: runs of whitespace between free-text
    // words collapse to a single space.
    const ast = parse('foo    bar\t\tbaz')
    expect(ast.freeText).toBe('foo bar baz')
  })

  it('flags an earlier shadowed due: token as invalid (DSL-5)', () => {
    const ast = parse('due:today due:this-week')
    expect(ast.filters).toHaveLength(2)
    // The first (shadowed) token is marked invalid so its chip reflects
    // that it does not apply; the last due: stays valid.
    expect(ast.filters[0]).toMatchObject({ kind: 'invalid', source: 'due:today' })
    if (ast.filters[0]?.kind === 'invalid') {
      expect(ast.filters[0].error).toContain('shadowed')
    }
    expect(ast.filters[1]).toMatchObject({
      kind: 'due',
      value: { kind: 'named', name: 'this-week' },
    })
  })

  it('flags malformed glob as invalid with InvalidGlob: prefix', () => {
    const ast = parse('path:[unclosed')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidGlob:/)
      expect(tok.error).toContain('unbalanced bracket')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags brace nesting as invalid', () => {
    const ast = parse('path:{a,{b,c}}')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('brace nesting')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags empty tag: value as invalid', () => {
    const ast = parse('tag:')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('required')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('preserves Unicode tag names', () => {
    const ast = parse('tag:#日本語')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: '日本語' })
  })

  it('passes quoted phrases through to free text verbatim', () => {
    const ast = parse('"exact phrase" tag:#x')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.freeText).toContain('exact phrase')
  })

  it('preserves multiple internal spaces inside a quoted phrase (DSL-A1)', () => {
    // A quoted phrase is matched exactly, so the free-text collapse must
    // NOT touch whitespace inside the quotes.
    const ast = parse('"two  spaces   here"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"two  spaces   here"')
  })

  it('collapses whitespace outside quotes while preserving it inside (DSL-A1)', () => {
    const ast = parse('alpha    "two  spaces"    beta')
    expect(ast.filters).toEqual([])
    // Outside the quotes: runs collapse to one space. Inside: verbatim.
    expect(ast.freeText).toBe('alpha "two  spaces" beta')
  })

  it('preserves intra-quote whitespace alongside a consumed filter (DSL-A1)', () => {
    const ast = parse('tag:#x   "keep  the   gaps"   word')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.freeText).toBe('"keep  the   gaps" word')
  })

  it('handles two quoted phrases each preserving internal spacing (DSL-A1)', () => {
    const ast = parse('"a  b"   "c   d"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"a  b" "c   d"')
  })

  it('treats an unterminated quote as a word and collapses normally (DSL-A1)', () => {
    // No closing quote at a token boundary → the tokeniser degrades the
    // stray quote to a word, so the run is plain free text and collapses.
    const ast = parse('foo  "bar  baz')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('foo "bar baz')
  })

  it('keeps an empty quoted phrase and collapses around it (DSL-A1)', () => {
    // An empty `""` is a zero-length quoted range; it must survive while
    // the whitespace on either side still collapses.
    const ast = parse('a ""  b')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('a "" b')
  })

  it('shields a colon inside a quoted phrase from filter recognition (DSL-A1)', () => {
    // `due:today` would normally be consumed as a filter, but inside quotes
    // the whole phrase is verbatim free text — the colon must NOT be parsed
    // as a filter key, and the internal spacing is preserved.
    const ast = parse('"due:today  is  fine"')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('"due:today  is  fine"')
  })

  it('does not treat boolean operators as filters', () => {
    const ast = parse('foo AND bar OR baz NOT quux')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('foo AND bar OR baz NOT quux')
  })

  it('falls back to substring-style bare token as freeText, not a filter', () => {
    // PEND-54 decision: bare tokens stay in freeText (FTS5 trigram
    // substring already covers the "match anywhere" use-case).
    const ast = parse('alpha')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('alpha')
  })

  it('supports multiple path: tokens (AND across the IN clause)', () => {
    const ast = parse('path:Journal/* path:Notes/*')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathInclude', value: 'Notes/*' })
  })

  it('accepts brace expansion', () => {
    const ast = parse('path:{Journal,Archive}/*')
    expect(ast.filters[0]).toMatchObject({
      kind: 'pathInclude',
      value: '{Journal,Archive}/*',
    })
  })

  it('records token spans pointing into the original input', () => {
    const input = '  tag:#urgent  '
    const ast = parse(input)
    const tok = ast.filters[0]
    if (!tok) throw new Error('expected a filter token')
    const span = tok.span
    expect(input.slice(span[0], span[1])).toBe('tag:#urgent')
  })

  // -------------------------------------------------------------------
  // PEND-53 — state / priority / due / scheduled / prop tokens
  // -------------------------------------------------------------------

  it('recognises state: tokens', () => {
    const ast = parse('state:TODO state:DOING')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'state', value: 'TODO' })
    expect(ast.filters[1]).toMatchObject({ kind: 'state', value: 'DOING' })
  })

  it('recognises not-state: tokens', () => {
    const ast = parse('not-state:DONE')
    expect(ast.filters[0]).toMatchObject({ kind: 'notState', value: 'DONE' })
  })

  it('recognises priority: tokens with none sentinel', () => {
    const ast = parse('priority:1 priority:none')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'priority', value: '1' })
    expect(ast.filters[1]).toMatchObject({ kind: 'priority', value: 'none' })
  })

  it('recognises due: bucket keywords', () => {
    // Each keyword tested in isolation — multiple due: tokens in one
    // query now shadow all but the last (DSL-5), so recognition is a
    // per-token unit assertion.
    for (const name of ['today', 'this-week', 'overdue', 'none'] as const) {
      const ast = parse(`due:${name}`)
      expect(ast.filters[0]).toMatchObject({ kind: 'due', value: { kind: 'named', name } })
    }
  })

  it('recognises scheduled: comparison form', () => {
    expect(parse('scheduled:>=2026-01-01').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '>=', date: '2026-01-01' },
    })
    expect(parse('scheduled:<2026-06-01').filters[0]).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '<', date: '2026-06-01' },
    })
  })

  it('recognises bare ISO date as = form', () => {
    const ast = parse('due:2026-05-17')
    expect(ast.filters[0]).toMatchObject({
      kind: 'due',
      value: { kind: 'op', op: '=', date: '2026-05-17' },
    })
  })

  it('flags unknown date bucket as invalid', () => {
    const ast = parse('due:tomorrowish')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidDateFilter:/)
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags unparseable date in op form as invalid', () => {
    const ast = parse('due:>=2026-13-99')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidDateFilter:/)
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('recognises prop:key=value tokens', () => {
    const ast = parse('prop:status=done not-prop:archived=true')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'done',
    })
    expect(ast.filters[1]).toMatchObject({
      kind: 'notProp',
      key: 'archived',
      value: 'true',
    })
  })

  it('accepts prop:key= (empty value = key-presence-only)', () => {
    const ast = parse('prop:status=')
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: '',
    })
  })

  it('flags prop without = as invalid', () => {
    const ast = parse('prop:status')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('key=value')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags prop with empty key as invalid', () => {
    const ast = parse('prop:=value')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('key cannot be empty')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('parses prop:key="value with spaces" (#152)', () => {
    const ast = parse('prop:status="in progress"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'in progress',
    })
    expect(ast.freeText).toBe('')
  })

  it('parses not-prop:key="value with spaces" (#152)', () => {
    const ast = parse('not-prop:owner="Jane Doe"')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({
      kind: 'notProp',
      key: 'owner',
      value: 'Jane Doe',
    })
    expect(ast.freeText).toBe('')
  })

  it('quoted prop value coexists with other tokens (#152)', () => {
    const ast = parse('tag:#urgent prop:status="in progress" leftover words')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.filters[1]).toMatchObject({
      kind: 'prop',
      key: 'status',
      value: 'in progress',
    })
    expect(ast.freeText).toBe('leftover words')
  })

  it('serialise round-trip preserves PEND-53 token shapes', () => {
    // Canonical form is reproduced verbatim.
    const inputs = [
      'state:TODO',
      'not-state:DONE',
      'priority:1',
      'not-priority:none',
      'due:today',
      'due:>=2026-01-01',
      'scheduled:none',
      'prop:status=done',
      'not-prop:archived=true',
      'prop:tag=', // key-presence-only
    ]
    for (const input of inputs) {
      const ast = parse(input)
      expect(ast.filters).toHaveLength(1)
      // Round-trip invariant: re-parsing serialise(parse(input)) yields
      // the same filter list — guards the registry-source-string
      // invariant. The actual round-trip is exercised in
      // `serialize.test.ts`; here we just assert each shape is
      // recognised in isolation.
      expect(ast.filters[0]?.kind).not.toBe('invalid')
    }
  })
})
