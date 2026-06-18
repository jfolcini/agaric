/**
 * Tests for markdown image support (#1434).
 *
 * Covers `![alt](url)` parsing (incl. empty alt), serialization, round-trip
 * stability both ways, the `!` discriminator that keeps a `[text](url)` link
 * from being an image, and the `\!` escape that keeps a literal `!` from opening
 * an image. SCOPE: `![alt](url)` parse/serialize + render only — binary
 * paste/drag-drop → attachment is a deferred FOLLOW-UP.
 */
import { describe, expect, it } from 'vitest'

import { parse } from '../markdown-parse'
import { serialize } from '../markdown-serialize'
import type { DocNode, ImageNode, ParagraphNode } from '../types'

/** Inline content nodes of the first paragraph of a parsed doc. */
function firstParaContent(md: string) {
  const block = (parse(md) as DocNode).content?.[0] as ParagraphNode
  return block.content ?? []
}

function imageDoc(alt: string, src: string): DocNode {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'image', attrs: { alt, src } } as ImageNode] },
    ],
  }
}

describe('image `![alt](url)` — parse (#1434)', () => {
  it('parses `![cat](https://x.com/c.png)` as an image node (alt + src)', () => {
    const content = firstParaContent('![cat](https://x.com/c.png)')
    expect(content).toEqual([{ type: 'image', attrs: { alt: 'cat', src: 'https://x.com/c.png' } }])
  })

  it('parses an empty-alt `![](url)`', () => {
    const content = firstParaContent('![](https://x.com/c.png)')
    expect(content).toEqual([{ type: 'image', attrs: { alt: '', src: 'https://x.com/c.png' } }])
  })

  it('parses an image surrounded by text', () => {
    const content = firstParaContent('see ![cat](c.png) here')
    expect(content).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'image', attrs: { alt: 'cat', src: 'c.png' } },
      { type: 'text', text: ' here' },
    ])
  })

  it('a `[text](url)` link is NOT an image (no leading `!`)', () => {
    const content = firstParaContent('[cat](https://x.com/c.png)')
    expect(content).toEqual([
      {
        type: 'text',
        text: 'cat',
        marks: [{ type: 'link', attrs: { href: 'https://x.com/c.png' } }],
      },
    ])
  })

  it('`\\![x](y)` stays literal: a bare `!` then an ordinary link, never an image', () => {
    const content = firstParaContent('\\![x](y)')
    expect(content).toEqual([
      { type: 'text', text: '!' },
      { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'y' } }] },
    ])
    // No image node was produced.
    expect(content.some((n) => n.type === 'image')).toBe(false)
  })

  it('a lone `!` with no following `[` stays literal text', () => {
    const content = firstParaContent('hi! there')
    expect(content).toEqual([{ type: 'text', text: 'hi! there' }])
  })

  it('a `![alt](` with no closing `)` stays literal text (not an image)', () => {
    const content = firstParaContent('![alt](unclosed')
    expect(content.some((n) => n.type === 'image')).toBe(false)
  })
})

describe('image — serialize (#1434)', () => {
  it('serializes an image node back to `![alt](url)`', () => {
    expect(serialize(imageDoc('cat', 'https://x.com/c.png'))).toBe('![cat](https://x.com/c.png)')
  })

  it('serializes an empty-alt image to `![](url)`', () => {
    expect(serialize(imageDoc('', 'c.png'))).toBe('![](c.png)')
  })

  it('escapes a `]` in alt so the label shape survives reparse', () => {
    expect(serialize(imageDoc('a]b', 'c.png'))).toBe('![a\\]b](c.png)')
  })

  it('escapes an unbalanced `)` in the URL like the link serializer', () => {
    // `escapeUrl` backslash-escapes the unbalanced `)`.
    expect(serialize(imageDoc('a', 'c).png'))).toBe('![a](c\\).png)')
  })
})

describe('image — round-trip stability (#1434)', () => {
  it('parse → serialize is stable for `![cat](c.png)`', () => {
    const md = '![cat](c.png)'
    expect(serialize(parse(md))).toBe(md)
  })

  it('parse → serialize is stable for the empty-alt `![](c.png)`', () => {
    const md = '![](c.png)'
    expect(serialize(parse(md))).toBe(md)
  })

  it('serialize → parse → serialize is a fixed point (image + surrounding text)', () => {
    const md = 'see ![cat](c.png) here'
    expect(serialize(parse(md))).toBe(md)
  })

  it('an alt containing `]` round-trips loss-free both ways', () => {
    // serialize→parse→serialize fixed point, and the parsed alt is the literal `]`.
    const once = serialize(imageDoc('a]b', 'c.png'))
    expect(once).toBe('![a\\]b](c.png)')
    expect(serialize(parse(once))).toBe(once)
    const content = firstParaContent(once)
    expect(content).toEqual([{ type: 'image', attrs: { alt: 'a]b', src: 'c.png' } }])
  })

  it('a `[text](url)` link round-trips as a link, never an image', () => {
    const md = '[cat](https://x.com)'
    // bare-URL display autolinks; the important invariant is no image appears.
    const out = serialize(parse(md))
    expect(out).not.toContain('![')
    expect(firstParaContent(out).some((n) => n.type === 'image')).toBe(false)
  })

  it('a literal `!` before a link re-escapes on serialize, never becomes an image', () => {
    // Regression: `\![x](y)` parses to a literal `!` + a `[x](y)` LINK. The
    // serializer must NOT emit a bare `!` + `[x](y)` (that would reparse as an
    // image and silently mutate the content) — the `!` is re-escaped to `\!`.
    const md = '\\![x](y)'
    const out = serialize(parse(md))
    expect(out).toBe('\\![x](y)')
    // serialize → parse → serialize is a fixed point and no image is produced.
    expect(serialize(parse(out))).toBe(out)
    expect(firstParaContent(out)).toEqual([
      { type: 'text', text: '!' },
      { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'y' } }] },
    ])
  })

  it('a `!` mid-sentence (not before a link) is NOT over-escaped', () => {
    // The re-escape is surgical: a sentence-final `!` stays a bare `!`.
    expect(serialize(parse('hi!'))).toBe('hi!')
    expect(serialize(parse('a!b'))).toBe('a!b')
  })
})
