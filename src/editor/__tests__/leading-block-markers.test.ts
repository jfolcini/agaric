import { describe, expect, it } from 'vitest'

import { parse, serialize } from '../markdown-serializer'
import { doc, paragraph, tagRef, text } from './builders'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

// A paragraph whose visible text begins with a character sequence that the
// block parser treats as a block marker must survive serialize -> parse
// unchanged: it has to reparse to a paragraph (not get promoted to a heading /
// list / blockquote / horizontal rule / table) and be value-preserving and
// idempotent. Regression: blockquote (`> `, bare `>`) and the all-dashes
// horizontal rule (`---`) previously drifted to other block types on save.
const LEADERS = [
  '# heading-ish',
  '## heading-ish',
  '###### heading-ish',
  '1. ordered-ish',
  '- bullet-ish',
  '* star-bullet-ish',
  '- [ ] task-ish',
  '* [x] task-ish',
  '> quote-ish',
  '>quote-no-space',
  '>',
  '> ',
  '---',
  '----',
  '--------',
  '***',
  '___',
  '```fence',
  '$$mathblock',
  '| table | ish |',
  '[!note] callout-ish',
  '+ plus-bullet',
  '-- two dashes',
  '--- trailing text',
]

describe('leading block markers round-trip as paragraph text', () => {
  for (const lead of LEADERS) {
    it(`paragraph starting with ${JSON.stringify(lead)}`, () => {
      const d = doc(paragraph(text(lead)))
      const md = serialize(d)
      const back = parse(md)
      // reparses to a single paragraph, not promoted to another block type
      expect(back.content?.map((b) => b.type)).toEqual(['paragraph'])
      // value-preserving and idempotent
      expect(back).toEqual(d)
      expect(parse(serialize(back))).toEqual(d)
    })
  }
})

describe('block starting with a tag round-trips', () => {
  it('tag followed by text', () => {
    const d = doc(paragraph(tagRef(ULID), text(' hello')))
    expect(parse(serialize(d))).toEqual(d)
  })
  it('tag only', () => {
    const d = doc(paragraph(tagRef(ULID)))
    expect(parse(serialize(d))).toEqual(d)
  })
})
