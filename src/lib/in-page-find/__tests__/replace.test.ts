/**
 * In-page replace (#6608): the rewrite of a block's stored Markdown for
 * matches counted over its rendered text.
 */

import { describe, expect, it } from 'vitest'

import { blockFindText } from '@/lib/in-page-find/block-text'
import { type CompiledQuery, compileQuery, type FindOptions } from '@/lib/in-page-find/matcher'
import {
  indexAfter,
  replaceAllInContent,
  replaceInContent,
  replacementFor,
  type ReplaceSpec,
} from '@/lib/in-page-find/replace'

const PAGE_ID = '01HZZZZZZZZZZZZZZZZZZZPAGE'
const TAG_ID = '01HZZZZZZZZZZZZZZZZZZZZTAG'
const titles: Record<string, string> = { [PAGE_ID]: 'Garden', [TAG_ID]: 'garden' }
const resolveTitle = (id: string) => titles[id] ?? id

const plain: FindOptions = { caseSensitive: false, wholeWord: false, isRegex: false }

function spec(query: string, replacement: string, toggles: Partial<FindOptions> = {}): ReplaceSpec {
  return { query, replacement, toggles: { ...plain, ...toggles } }
}

/** Replace every match of `s.query` in `content`. */
function replaceAll(content: string, s: ReplaceSpec) {
  const compiled = compileQuery(s.query, s.toggles) as Extract<
    CompiledQuery,
    { kind: 'literal' | 'regex' }
  >
  return replaceAllInContent(
    content,
    compiled,
    s,
    (c) => blockFindText(c, resolveTitle),
    resolveTitle,
  )
}

describe('replaceAllInContent', () => {
  it('replaces a plain match in the stored text, case folded as find folds it', () => {
    expect(replaceAll('Foo and foo', spec('foo', 'bar'))).toEqual({
      content: 'bar and bar',
      replaced: 2,
      skipped: 0,
    })
  })

  it('keeps the marks around a match and the Markdown escapes of the rest', () => {
    expect(replaceAll('**foo** and 2\\*3', spec('foo', 'bar')).content).toBe('**bar** and 2\\*3')
  })

  it('replaces a match across a mark boundary with the marks of its first character', () => {
    expect(replaceAll('**ne**edle tail', spec('needle', 'pin')).content).toBe('**pin** tail')
    expect(replaceAll('ne**edle** tail', spec('needle', 'pin')).content).toBe('pin tail')
  })

  it('leaves a match in a chip title alone and counts it as skipped', () => {
    const content = `garden [[${PAGE_ID}]] and #[${TAG_ID}]`
    expect(replaceAll(content, spec('garden', 'yard'))).toEqual({
      content: `yard [[${PAGE_ID}]] and #[${TAG_ID}]`,
      replaced: 1,
      skipped: 2,
    })
  })

  it('replaces a match that only touches a chip', () => {
    expect(replaceAll(`foo#[${TAG_ID}]foo`, spec('foo', 'bar'))).toEqual({
      content: `bar#[${TAG_ID}]bar`,
      replaced: 2,
      skipped: 0,
    })
  })

  it('skips a match that runs into a chip or across a line break', () => {
    expect(replaceAll(`see [[${PAGE_ID}]]`, spec('see Gar', 'x'))).toEqual({
      content: `see [[${PAGE_ID}]]`,
      replaced: 0,
      skipped: 1,
    })
    expect(replaceAll('one\ntwo', spec('e\nt', 'x', { isRegex: true })).skipped).toBe(1)
    // Inline math shows no find text, so `needle` runs across it.
    expect(replaceAll('ne$x$edle', spec('needle', 'pin'))).toEqual({
      content: 'ne$x$edle',
      replaced: 0,
      skipped: 1,
    })
  })

  it('replaces only the first of overlapping matches', () => {
    expect(replaceAll('aaa', spec('aa', 'b'))).toEqual({ content: 'ba', replaced: 1, skipped: 0 })
  })

  it('takes an empty replacement as a delete', () => {
    expect(replaceAll('keep drop keep', spec(' drop', '')).content).toBe('keep keep')
    expect(replaceAll('**drop**tail', spec('drop', '')).content).toBe('tail')
  })

  it('does not run again over a replacement that itself matches', () => {
    expect(replaceAll('foo foo', spec('foo', 'foofoo'))).toEqual({
      content: 'foofoo foofoo',
      replaced: 2,
      skipped: 0,
    })
  })

  it('expands capture groups in regex mode', () => {
    expect(
      replaceAll('2026-11-12', spec('(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1', { isRegex: true })),
    ).toEqual({ content: '12/11/2026', replaced: 1, skipped: 0 })
    expect(replaceAll('a-b', spec('(?<x>a)-b', '$<x>$$', { isRegex: true })).content).toBe('a$')
  })

  it('takes a dollar sign literally in plain mode', () => {
    const { content } = replaceAll('cost', spec('cost', '$1 $&'))
    expect(blockFindText(content, resolveTitle)).toBe('$1 $&')
  })

  it('writes Markdown in the replacement as text, not as a mark or a link', () => {
    const { content } = replaceAll('x', spec('x', '**y** [[z]]'))
    expect(blockFindText(content, resolveTitle)).toBe('**y** [[z]]')
  })

  it('honours whole word', () => {
    expect(replaceAll('cat category', spec('cat', 'dog', { wholeWord: true })).content).toBe(
      'dog category',
    )
  })

  it('changes nothing in a query block', () => {
    expect(replaceAll('{{query tag:x}}', spec('query', 'q'))).toEqual({
      content: '{{query tag:x}}',
      replaced: 0,
      skipped: 0,
    })
  })
})

describe('replaceInContent', () => {
  it('replaces only the ranges it is given', () => {
    expect(
      replaceInContent('foo foo foo', [{ start: 4, end: 7, text: 'X' }], resolveTitle),
    ).toEqual({ content: 'foo X foo', replaced: 1, skipped: 0 })
  })
})

describe('replacementFor', () => {
  it('expands the groups of the match at the given offset, with its context', () => {
    const s = spec('(?<=-)(\\w)', '[$1]', { isRegex: true })
    expect(replacementFor('a-b-c', { start: 4, end: 5 }, s)).toBe('[c]')
  })
})

describe('indexAfter', () => {
  const order = new Map([
    ['A', 0],
    ['B', 1],
    ['C', 2],
  ])
  const matches = [
    { blockId: 'A', start: 0 },
    { blockId: 'A', start: 10 },
    { blockId: 'C', start: 3 },
  ]

  it('moves to the next match in the block, past the replaced text', () => {
    expect(indexAfter(matches, order, 'A', 5)).toBe(1)
  })

  it('moves to a later block when the replaced one has no match left after it', () => {
    expect(indexAfter(matches, order, 'A', 11)).toBe(2)
    expect(indexAfter(matches, order, 'B', 0)).toBe(2)
  })

  it('wraps to the first match, and is -1 with none', () => {
    expect(indexAfter(matches, order, 'C', 4)).toBe(0)
    expect(indexAfter([], order, 'A', 0)).toBe(-1)
  })
})
