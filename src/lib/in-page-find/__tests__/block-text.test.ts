/**
 * In-page find over block text (#6557): the text a block renders, matches
 * over it, and the DOM ranges of a hydrated row's matches.
 */

import { describe, expect, it } from 'vitest'

import { blockFindText, domMatchesIn, findInBlocks } from '@/lib/in-page-find/block-text'
import { type CompiledQuery, compileQuery } from '@/lib/in-page-find/matcher'

type ScanQuery = Extract<CompiledQuery, { kind: 'literal' | 'regex' }>

const options = { caseSensitive: false, wholeWord: false, isRegex: false }

function compile(query: string, opts = options): ScanQuery {
  const compiled = compileQuery(query, opts)
  if (compiled.kind !== 'literal' && compiled.kind !== 'regex') throw new Error(compiled.kind)
  return compiled
}

const PAGE_ID = '01HZZZZZZZZZZZZZZZZZZZPAGE'
const titles: Record<string, string> = { [PAGE_ID]: 'Projects/Garden' }
const resolveTitle = (id: string) => titles[id] ?? `[[${id.slice(0, 8)}...]]`

describe('blockFindText', () => {
  it('drops the markdown marks and shows a page link as its title leaf', () => {
    expect(blockFindText(`**bold**tail and [[${PAGE_ID}]]`, resolveTitle)).toBe(
      'boldtail and Garden',
    )
  })

  it('has no text for a query or an embed block', () => {
    expect(blockFindText('{{query tag:work}}', resolveTitle)).toBe('')
    expect(blockFindText(`{{embed ((${PAGE_ID}))}}`, resolveTitle)).toBe('')
  })
})

describe('findInBlocks', () => {
  const blocks = [
    { id: 'A', text: 'Needle in the first' },
    { id: 'B', text: 'nothing here' },
    { id: 'C', text: 'needle, NEEDLE' },
  ]

  it('finds every match in block order, folding case as the DOM matcher does', () => {
    expect(findInBlocks(blocks, compile('needle')).matches).toEqual([
      { blockId: 'A', start: 0, end: 6 },
      { blockId: 'C', start: 0, end: 6 },
      { blockId: 'C', start: 8, end: 14 },
    ])
  })

  it('honours case sensitivity', () => {
    const sensitive = compile('NEEDLE', { ...options, caseSensitive: true })
    expect(findInBlocks(blocks, sensitive).matches).toEqual([{ blockId: 'C', start: 8, end: 14 }])
  })

  it('returns nothing for a query no block holds', () => {
    expect(findInBlocks(blocks, compile('zebra'))).toEqual({
      matches: [],
      skippedLongNodes: 0,
      timedOut: false,
    })
  })
})

describe('domMatchesIn', () => {
  it('matches across a mark boundary and skips text that is not content', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<span aria-hidden="true">boldtail</span><strong>bo</strong>ld<em>tail</em><span class="sr-only">boldtail</span>'
    const [match, ...rest] = domMatchesIn(root, compile('boldtail'))
    expect(rest).toHaveLength(0)
    expect(match?.node.nodeValue).toBe('bo')
    expect(match?.start).toBe(0)
    expect(match?.endNode?.nodeValue).toBe('tail')
    expect(match?.end).toBe(4)
  })
})
