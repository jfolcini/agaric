import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { parse } from '@/lib/search-query/classify'
import { tokenSource } from '@/lib/search-query/serialize'
import type { FilterNode, SearchQueryAST } from '@/lib/search-query/types'

/** The tree with each leaf as its filter's source, invalid ones as `!source`. */
function shape(ast: SearchQueryAST, node: FilterNode | undefined = ast.expr): unknown {
  if (node === undefined) return undefined
  if (node.kind === 'token') {
    const f = ast.filters[node.index]
    if (f === undefined) throw new Error(`no filter at ${node.index}`)
    return f.kind === 'invalid' ? `!${f.source}` : tokenSource(f)
  }
  return { [node.kind]: node.children.map((c) => shape(ast, c)) }
}

const errorOf = (ast: SearchQueryAST, source: string): string | undefined => {
  const f = ast.filters.find((x) => x.kind === 'invalid' && x.source === source)
  return f?.kind === 'invalid' ? f.error : undefined
}

describe('the OR grammar (#6742)', () => {
  it('leaves a query without OR as it was, parentheses included', () => {
    const ast = parse('(draft) tag:#a notes')
    expect(ast.expr).toBeUndefined()
    expect(ast.freeText).toBe('(draft) notes')
    expect(ast.filters.map(tokenSource)).toEqual(['tag:#a'])
  })

  it('binds the implicit AND tighter than OR', () => {
    expect(shape(parse('state:TODO tag:#a OR tag:#b'))).toEqual({
      or: [{ and: ['state:TODO', 'tag:#a'] }, 'tag:#b'],
    })
  })

  it('groups with parentheses, glued or apart, and reads `or` in any case', () => {
    const expected = { and: ['state:TODO', { or: ['tag:#a', 'tag:#b'] }] }
    expect(shape(parse('state:TODO (tag:#a OR tag:#b)'))).toEqual(expected)
    expect(shape(parse('state:TODO ( tag:#a or tag:#b )'))).toEqual(expected)
    expect(shape(parse('state:TODO ((tag:#a) OR (tag:#b))'))).toEqual(expected)
  })

  it('closes a quoted value right before a parenthesis', () => {
    const ast = parse('(tag:#x OR tag:#"my tag")')
    expect(shape(ast)).toEqual({ or: ['tag:#x', 'tag:#"my tag"'] })
    expect(ast.filters[1]).toMatchObject({ kind: 'tag', value: 'my tag' })
  })

  it('keeps OR between words FTS5’s, as free text', () => {
    const ast = parse('cats OR dogs')
    expect(ast.expr).toBeUndefined()
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('cats OR dogs')
  })

  it('keeps free text beside a group of filters', () => {
    const ast = parse('meeting ab (tag:#a OR tag:#b)')
    expect(ast.freeText).toBe('meeting ab')
    expect(shape(ast)).toEqual({ or: ['tag:#a', 'tag:#b'] })
  })

  it('reads words in parentheses as the full-text expression when they are every word', () => {
    const ast = parse('(cats OR dogs) tag:#a')
    expect(ast.freeText).toBe('cats OR dogs')
    expect(ast.expr).toBeUndefined()
    expect(ast.filters.map(tokenSource)).toEqual(['tag:#a'])

    const notAlone = parse('meeting (cats OR dogs) tag:#a')
    expect(notAlone.freeText).toBe('meeting')
    expect(errorOf(notAlone, '(cats OR dogs)')).toBe(i18n.t('searchQuery.wordGroupNotAlone'))
  })

  it('flags a word that would be an operand of an OR of filters', () => {
    const message = i18n.t('searchQuery.textBesideFilterOr')
    const mixed = parse('cats OR dogs tag:#a')
    expect(shape(mixed)).toEqual({ or: ['!cats', { and: ['!dogs', 'tag:#a'] }] })
    expect(errorOf(mixed, 'cats')).toBe(message)
    expect(mixed.freeText).toBe('')
    // Inside a group of filters the whole group is the one invalid token.
    const grouped = parse('(meeting tag:#a OR tag:#b) state:TODO')
    expect(errorOf(grouped, '(meeting tag:#a OR tag:#b)')).toBe(message)
  })

  it('flags NOT before a filter or group, keeping NOT between words', () => {
    const ast = parse('NOT (tag:#a OR tag:#b)')
    expect(errorOf(ast, 'NOT')).toBe(i18n.t('searchQuery.notBeforeFilter'))
    expect(parse('(cats NOT dogs) (tag:#a OR tag:#b)').freeText).toBe('cats NOT dogs')
  })

  it('flags an unbalanced parenthesis, a one-sided OR and empty parentheses', () => {
    const unbalanced = i18n.t('searchQuery.unbalancedParen')
    expect(errorOf(parse('(tag:#a OR tag:#b'), '(')).toBe(unbalanced)
    expect(errorOf(parse('tag:#a OR tag:#b)'), ')')).toBe(unbalanced)
    const oneSided = parse('tag:#a OR')
    expect(errorOf(oneSided, 'OR')).toBe(i18n.t('searchQuery.orMissingSide'))
    expect(oneSided.expr).toBeUndefined()
    expect(errorOf(parse('() tag:#a OR tag:#b'), '()')).toBe(i18n.t('searchQuery.emptyGroup'))
  })

  it('applies one due: per AND run', () => {
    const branches = parse('due:today OR due:overdue')
    expect(branches.filters.map((f) => f.kind)).toEqual(['due', 'due'])
    const shadowed = parse('due:today due:overdue OR tag:#a')
    expect(shadowed.filters.map((f) => f.kind)).toEqual(['invalid', 'due', 'tag'])
  })

  it('flags tag: beside under: only when the filters AND', () => {
    expect(parse('under:#a OR tag:#b').filters.map((f) => f.kind)).toEqual(['under', 'tag'])
    const flat = parse('under:#a tag:#b (cats OR dogs)')
    expect(flat.filters.map((f) => f.kind)).toEqual(['under', 'invalid'])
  })
})
