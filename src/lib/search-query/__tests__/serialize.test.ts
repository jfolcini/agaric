import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parse } from '../classify'
import { addFilter, removeFilterAt, serialize, tokenSource } from '../serialize'

describe('serialize round-trip', () => {
  const canonicalInputs = [
    'tag:#urgent',
    'tag:#urgent tag:#followup',
    'path:Journal/* tag:#urgent',
    'not-path:Archive/** path:Journal/*',
    'tag:#urgent hello world',
    'path:{Journal,Archive}/* tag:#meeting',
    'tag:#日本語',
    // PEND-53 — new token kinds round-trip cleanly.
    'state:TODO',
    'not-state:DONE',
    'priority:1 priority:2',
    'not-priority:none',
    'due:today',
    'due:this-week',
    'due:>=2026-01-01',
    'scheduled:none',
    'scheduled:2026-05-17',
    'prop:status=done',
    'not-prop:archived=true',
    'prop:tag=',
    'state:TODO priority:1 due:today prop:status=blocked hello world',
    // #152 — prop values with whitespace round-trip via "..." quoting.
    'prop:status="in progress"',
    'not-prop:owner="Jane Doe"',
    'tag:#urgent prop:status="in progress" leftover',
  ]

  for (const s of canonicalInputs) {
    it(`canonical: serialize(parse('${s}')) === ('${s}')`, () => {
      const round = serialize(parse(s))
      // Reconstructed AST should be equivalent — chips and freetext
      // are order-preserving by their classification rules.
      expect(parse(round)).toEqual(parse(s))
    })
  }

  it('idempotency: parse(serialize(parse(s))) === parse(s)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('tag:#urgent', 'path:Journal/*', '#followup', 'hello world'),
          fc.string({ minLength: 0, maxLength: 30 }),
        ),
        (s) => {
          const once = parse(s)
          const twice = parse(serialize(once))
          // Filters and freeText must match (key-by-key).
          if (once.freeText !== twice.freeText) return false
          if (once.filters.length !== twice.filters.length) return false
          for (let i = 0; i < once.filters.length; i++) {
            const a = once.filters[i]
            const b = twice.filters[i]
            if (!a || !b) return false
            if (a.kind !== b.kind) return false
            if (tokenSource(a) !== tokenSource(b)) return false
          }
          return true
        },
      ),
      { numRuns: 200 },
    )
  })

  it('removeFilterAt drops the requested token', () => {
    const ast = parse('tag:#a tag:#b tag:#c')
    const next = removeFilterAt(ast, 1)
    expect(next.filters).toHaveLength(2)
    expect(serialize(next)).toBe('tag:#a tag:#c')
  })

  it('addFilter appends to the end', () => {
    const ast = parse('tag:#a hello')
    const next = addFilter(ast, { kind: 'pathInclude', value: 'X/*', span: [0, 0] })
    expect(serialize(next)).toBe('tag:#a path:X/* hello')
  })

  it('#152 — tokenSource quotes a prop value that contains whitespace', () => {
    expect(tokenSource({ kind: 'prop', key: 'status', value: 'in progress', span: [0, 0] })).toBe(
      'prop:status="in progress"',
    )
    expect(tokenSource({ kind: 'notProp', key: 'owner', value: 'Jane Doe', span: [0, 0] })).toBe(
      'not-prop:owner="Jane Doe"',
    )
  })

  it('#152 — tokenSource leaves whitespace-free prop values bare', () => {
    expect(tokenSource({ kind: 'prop', key: 'status', value: 'done', span: [0, 0] })).toBe(
      'prop:status=done',
    )
  })
})
