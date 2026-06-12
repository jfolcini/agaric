import { describe, expect, it } from 'vitest'

import {
  QUERY_KEYS,
  QUERY_OPERATORS,
  QUERY_PROPERTY_KEYS,
  QUERY_TYPE_VALUES,
} from '../../lib/query-utils'
import { computeQueryHint, queryExprAtCaret } from '../query-hint'

/**
 * Convenience: place the caret at the literal `|` marker in `s`, strip it, and
 * compute the hint. Keeps the cases readable.
 */
function hintAt(s: string) {
  const caret = s.indexOf('|')
  if (caret < 0) throw new Error('test string must contain a | caret marker')
  // Remove exactly the marker char at `caret` (not a global/first-occurrence replace —
  // the body may contain real `|` table-pipes; js/incomplete-sanitization guard).
  return computeQueryHint({ text: s.slice(0, caret) + s.slice(caret + 1), caret })
}

describe('queryExprAtCaret', () => {
  it('recognises the caret inside the expression body', () => {
    const got = queryExprAtCaret({ text: '{{query tag:work}}', caret: 11 })
    expect(got).not.toBeNull()
    expect(got?.expr).toBe('tag:work')
  })

  it('returns null when the caret is before the query opener', () => {
    expect(queryExprAtCaret({ text: 'hello {{query tag:x}}', caret: 3 })).toBeNull()
  })

  it('returns null when the caret is past the closing }}', () => {
    expect(queryExprAtCaret({ text: '{{query tag:x}} more', caret: 18 })).toBeNull()
  })

  it('returns null for {{query with no following space', () => {
    expect(queryExprAtCaret({ text: '{{query}}', caret: 7 })).toBeNull()
  })
})

describe('computeQueryHint — key completions', () => {
  it('completes a partial key and appends the colon separator', () => {
    expect(hintAt('{{query ta|')).toEqual({ completion: 'g:', display: 'tag:' })
  })

  it('completes property', () => {
    expect(hintAt('{{query prop|')).toEqual({ completion: 'erty:', display: 'property:' })
  })

  it('only offers keys the parser accepts (vocabulary from query-utils)', () => {
    // Every single-letter prefix hint must resolve to a real QUERY_KEY.
    for (const key of QUERY_KEYS) {
      const partial = key.slice(0, 1)
      const hint = computeQueryHint({ text: `{{query ${partial}`, caret: 8 + partial.length })
      if (hint) {
        expect(QUERY_KEYS).toContain(hint.display.replace(':', ''))
      }
    }
  })

  it('offers nothing for an unknown key prefix', () => {
    expect(hintAt('{{query zz|')).toBeNull()
  })

  it('offers nothing immediately after a space (does NOT fire on every space)', () => {
    expect(hintAt('{{query tag:work |')).toBeNull()
  })

  it('offers nothing at the very start of an empty expression', () => {
    expect(hintAt('{{query |')).toBeNull()
  })
})

describe('computeQueryHint — property key + operator', () => {
  it('completes a well-known property key', () => {
    expect(hintAt('{{query property:todo|')).toEqual({
      completion: '_state',
      display: 'todo_state',
    })
    expect(QUERY_PROPERTY_KEYS).toContain('todo_state')
  })

  it('offers the default = operator once a key is typed', () => {
    expect(hintAt('{{query property:context|')).toEqual({
      completion: '=',
      display: 'context=',
    })
    expect(QUERY_OPERATORS).toContain('=')
  })

  it('stops hinting once an operator is present (now typing a value)', () => {
    expect(hintAt('{{query property:context=|')).toBeNull()
    expect(hintAt('{{query property:priority>=|')).toBeNull()
  })
})

describe('computeQueryHint — type values', () => {
  it('completes a legacy type: value', () => {
    expect(hintAt('{{query type:ta|')).toEqual({ completion: 'g', display: 'tag' })
    expect(hintAt('{{query type:back|')).toEqual({ completion: 'links', display: 'backlinks' })
    for (const v of QUERY_TYPE_VALUES) {
      const partial = v.slice(0, 2)
      const hint = computeQueryHint({
        text: `{{query type:${partial}`,
        caret: 13 + partial.length,
      })
      if (hint) expect(QUERY_TYPE_VALUES).toContain(hint.display)
    }
  })
})

describe('computeQueryHint — free-form values never hint', () => {
  it('does not hint inside a tag: value', () => {
    expect(hintAt('{{query tag:wor|')).toBeNull()
  })

  it('does not hint inside an expr: value', () => {
    expect(hintAt('{{query expr:proj|')).toBeNull()
  })
})
