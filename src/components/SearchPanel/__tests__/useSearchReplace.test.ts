/** The pure halves of replace across pages (#6608): the text to find and its candidate search. */
import { describe, expect, it } from 'vitest'

import { candidateQuery, findTextOf } from '@/components/SearchPanel/useSearchReplace'

describe('findTextOf', () => {
  it('is the free text as typed', () => {
    expect(findTextOf('sprint plan')).toBe('sprint plan')
  })

  it('is the inside of one quoted phrase', () => {
    expect(findTextOf('"sprint plan "')).toBe('sprint plan ')
  })

  it('keeps quotes that are not one pair around the whole text', () => {
    expect(findTextOf('say "hi" twice')).toBe('say "hi" twice')
    expect(findTextOf('"a" or "b"')).toBe('"a" or "b"')
  })
})

describe('candidateQuery', () => {
  it('sends the text as one phrase', () => {
    expect(candidateQuery('sprint plan')).toBe('"sprint plan"')
  })

  it('sends the stretches around a quote, dropping one with only spaces', () => {
    expect(candidateQuery('say "hi" twice')).toBe('"say " "hi" " twice"')
    expect(candidateQuery('a" "b')).toBe('"a" "b"')
  })

  it('sends a term under three characters, which search matches by substring (#6752)', () => {
    expect(candidateQuery('ab')).toBe('"ab"')
    expect(candidateQuery('a"b"c')).toBe('"a" "b" "c"')
  })

  it('is null when there is nothing to find', () => {
    expect(candidateQuery('')).toBeNull()
    expect(candidateQuery('   ')).toBeNull()
    expect(candidateQuery('""')).toBeNull()
  })
})
