/**
 * A delimiter that never closes is literal text, and only that (CommonMark):
 * the links, refs, code and math after it keep their nodes, as does every
 * mark that did close. A one-line paste (#5160 N11) reads a line this way, and
 * so does content stored before #5160 N9 whose mark ends on a space.
 */

import { describe, expect, it } from 'vitest'

import { bold, code, italic, mathInline, tagRef, text } from '@/editor/__tests__/builders'
import { parse } from '@/editor/markdown-serializer'
import type { InlineNode } from '@/editor/types'

const U = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function inline(md: string): readonly InlineNode[] | undefined {
  const block = parse(md).content?.[0]
  return block?.type === 'paragraph' ? block.content : undefined
}

describe('an unclosed delimiter keeps the nodes after it', () => {
  it.each([
    [
      '*Note: see [docs](https://x.com/docs)',
      [
        text('*Note: see '),
        text('docs', [{ type: 'link', attrs: { href: 'https://x.com/docs' } }]),
      ],
    ],
    [`**see #[${U}]`, [text('**see '), tagRef(U)]],
    ['_see `code` and $x$', [text('_see '), code('code'), text(' and '), mathInline('x')]],
    ['**a *b*', [text('**a '), italic('b')]],
    ['<u>**a** b', [text('<u>'), bold('a'), text(' b')]],
    // Each delimiter goes back where it opened.
    ['~~**a', [text('~~**a')]],
    ['**~~a', [text('**~~a')]],
    ['**==a', [text('**==a')]],
    ['**<u>a', [text('**<u>a')]],
    // Stored before #5160 N9, when a mark could end on a space.
    [`see **the **#[${U}] next`, [text('see **the **'), tagRef(U), text(' next')]],
  ])('%j', (md, expected) => {
    expect(inline(md)).toEqual(expected)
  })
})
