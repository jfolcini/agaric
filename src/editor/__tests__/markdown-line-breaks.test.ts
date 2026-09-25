/**
 * #5160 D2 — a single line break inside a block is a line of the same
 * paragraph, shown as a break; a blank line separates paragraphs.
 *
 * The editor's parser reads a stored `\n` inside a paragraph as a `hardBreak`
 * (what Rust already reads it as), and the serializer writes a `hardBreak`
 * back as `\n`. The legacy `\` + newline marker (#710-5) is still READ as a
 * hard break, and is still WRITTEN only where a bare `\n` would not read back:
 * next to an empty line (a blank line is a paragraph separator) and inside the
 * single-line productions (heading, task, list-item marker line), which do not
 * absorb a following line.
 */

import { describe, expect, it } from 'vitest'

import {
  blockquote,
  bulletList,
  doc,
  hardBreak,
  heading,
  italic,
  listItem,
  paragraph,
  task,
  text,
} from '@/editor/__tests__/builders'
import { computeContentDelta } from '@/editor/content-delta'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode, ParagraphNode } from '@/editor/types'

const twoLines = doc(paragraph(text('a'), hardBreak(), text('b')))

/**
 * A paragraph as the editor's `getJSON()` hands it over: the TipTap schema
 * fills `TaskParagraph`'s `todoState` attribute with its default `null`, so
 * a plain paragraph out of the editor carries `attrs`, not none.
 */
function editorParagraph(...nodes: Parameters<typeof paragraph>): ParagraphNode {
  return { ...paragraph(...nodes), attrs: { todoState: null } } as unknown as ParagraphNode
}

describe('a stored `\\n` inside a paragraph is a hard break (#5160 D2)', () => {
  it('parses `a\\nb` as one paragraph holding a hardBreak', () => {
    expect(parse('a\nb')).toEqual(twoLines)
  })

  it('reads the legacy `\\` + newline marker as the same hardBreak', () => {
    expect(parse('a\\\nb')).toEqual(twoLines)
  })

  it('writes a hardBreak as a bare `\\n`', () => {
    expect(serialize(twoLines)).toBe('a\nb')
  })

  it('rewrites the legacy marker to `\\n` on the first serialize, then stays', () => {
    const once = serialize(parse('a\\\nb'))
    expect(once).toBe('a\nb')
    expect(serialize(parse(once))).toBe(once)
  })

  it('keeps a line ending in an escaped literal backslash inside the paragraph', () => {
    // `a\\` is an even run (a literal `\`), not a hard-break marker; the bare
    // newline after it is the break.
    expect(parse('a\\\\\nb')).toEqual(doc(paragraph(text('a\\'), hardBreak(), text('b'))))
  })

  it('keeps trailing spaces before the break as text (Rust keeps them too)', () => {
    const d = doc(paragraph(text('line one  '), hardBreak(), text('line two')))
    expect(parse('line one  \nline two')).toEqual(d)
    expect(serialize(d)).toBe('line one  \nline two')
  })

  it('keeps a whitespace-only line as a line of the paragraph, not a blank', () => {
    const d = doc(paragraph(text('a'), hardBreak(), text('  '), hardBreak(), text('b')))
    expect(parse('a\n  \nb')).toEqual(d)
    expect(serialize(d)).toBe('a\n  \nb')
  })
})

describe('a blank line separates paragraphs', () => {
  const twoParagraphs = doc(paragraph(text('a')), paragraph(text('b')))

  it('parses `a\\n\\nb` as two paragraphs, with no empty paragraph between', () => {
    expect(parse('a\n\nb')).toEqual(twoParagraphs)
  })

  it('writes two sibling paragraphs with a blank line between them', () => {
    expect(serialize(twoParagraphs)).toBe('a\n\nb')
  })

  it('writes the same blank line for paragraphs out of the editor, whose `todoState` is null', () => {
    const fromEditor: DocNode = doc(editorParagraph(text('a')), editorParagraph(text('b')))
    expect(serialize(fromEditor)).toBe('a\n\nb')
    // So a focus + blur with no edit on a stored `a\n\nb` writes nothing,
    // instead of rewriting the two paragraphs into one with a line break.
    expect(computeContentDelta('a\n\nb', fromEditor).changed).toBe(false)
    const nested = ['p', 'a', 'b'].map((s) => editorParagraph(text(s)))
    expect(serialize(doc(bulletList(listItem(...nested))))).toBe('- p\n  a\n  \n  b')
  })

  it('reads the blank line after the separator as an empty paragraph, as the serializer writes one', () => {
    const withEmpty = doc(paragraph(text('a')), paragraph(), paragraph(text('b')))
    expect(serialize(withEmpty)).toBe('a\n\n\n\nb')
    expect(parse('a\n\n\n\nb')).toEqual(withEmpty)
    // A blank line after a non-paragraph block has no paragraph to separate.
    expect(parse('# h\n')).toEqual(doc(heading(1, text('h')), paragraph()))
    expect(serialize(doc(heading(1, text('h')), paragraph()))).toBe('# h\n')
  })

  it('drops a trailing newline after a paragraph and reads `\\n` as one empty paragraph', () => {
    expect(parse('a\n')).toEqual(doc(paragraph(text('a'))))
    expect(parse('\n')).toEqual(doc(paragraph()))
  })

  it('does not put a blank line between a paragraph and a block that interrupts it', () => {
    expect(serialize(doc(paragraph(text('a')), heading(1, text('h'))))).toBe('a\n# h')
    expect(serialize(doc(heading(1, text('h')), paragraph(text('a'))))).toBe('# h\na')
    expect(serialize(doc(paragraph(text('a')), task('TODO', text('t'))))).toBe('a\n- [ ] t')
  })
})

describe('a hard break next to an empty line keeps the legacy marker', () => {
  it.each([
    ['trailing', doc(paragraph(text('a'), hardBreak())), 'a\\\n'],
    ['leading', doc(paragraph(hardBreak(), text('a'))), '\\\na'],
    ['doubled', doc(paragraph(text('a'), hardBreak(), hardBreak(), text('b'))), 'a\\\n\\\nb'],
  ])('%s hardBreak round-trips through the marker form', (_name, d, md) => {
    expect(serialize(d)).toBe(md)
    expect(parse(md)).toEqual(d)
  })
})

describe('every line of a paragraph is guarded against block dispatch', () => {
  // A continuation line is now a line the block parser sees, so a line that
  // would START another block is escaped the way a first line already is.
  it.each([
    ['- b', 'a\n\\- b'],
    ['* b', 'a\n\\* b'],
    ['1. b', 'a\n1\\. b'],
    ['# b', 'a\n\\# b'],
    ['> b', 'a\n\\> b'],
    ['---', 'a\n\\---'],
    ['| b |', 'a\n\\| b \\|'],
    ['```', 'a\n\\`\\`\\`'],
    ['$$', 'a\n\\$$'],
    ['- [ ] b', 'a\n\\- \\[ \\] b'],
  ])('a continuation line reading %j survives as text', (line, md) => {
    const d = doc(paragraph(text('a'), hardBreak(), text(line)))
    expect(serialize(d)).toBe(md)
    expect(parse(md)).toEqual(d)
  })

  it('moves an italic opening onto a space off the continuation line start', () => {
    // `* b*` at a line start is a bullet marker (#4156); the defuse that keeps
    // it off the FIRST line keeps it off every line.
    const d = doc(paragraph(text('a'), hardBreak(), italic(' b')))
    const md = serialize(d)
    expect(md).toBe('a\n *b*')
    expect(serialize(parse(md))).toBe(md)
    expect(parse(md)).toEqual(doc(paragraph(text('a'), hardBreak(), text(' '), italic('b'))))
  })
})

describe('the other constructs keep their meaning', () => {
  it('a line that starts a list after a paragraph line is still a list', () => {
    // The conformance vector "a second line shaped like a bullet stays text"
    // is about the FLUSH (the block is not split); the parser still reads the
    // list, exactly as it does today.
    expect(parse('first\n- not a bullet')).toEqual(
      doc(paragraph(text('first')), bulletList(listItem(paragraph(text('not a bullet'))))),
    )
    expect(serialize(parse('first\n- not a bullet'))).toBe('first\n- not a bullet')
  })

  it('a heading does not absorb the next line, so its hard break keeps the marker', () => {
    const d = doc(heading(2, text('one'), hardBreak(), text('two')))
    expect(serialize(d)).toBe('## one\\\ntwo')
    expect(parse('## one\ntwo')).toEqual(doc(heading(2, text('one')), paragraph(text('two'))))
  })

  it('a task paragraph does not absorb the next line either', () => {
    const d = doc(task('TODO', text('milk'), hardBreak(), text('eggs')))
    expect(serialize(d)).toBe('- [ ] milk\\\neggs')
    expect(parse('- [ ] milk\neggs')).toEqual(
      doc(task('TODO', text('milk')), paragraph(text('eggs'))),
    )
  })

  it('a list item marker line keeps the marker; its nested lines join by `\\n`', () => {
    expect(serialize(doc(bulletList(listItem(paragraph(text('a'), hardBreak(), text('b'))))))).toBe(
      '- a\\\nb',
    )
    const nested = doc(
      bulletList(listItem(paragraph(text('p')), paragraph(text('a'), hardBreak(), text('b')))),
    )
    const md = serialize(nested)
    expect(md).toBe('- p\n  a\n  b')
    expect(parse(md)).toEqual(nested)
  })

  it('two paragraphs nested in a list item are separated by an indented blank line', () => {
    const d = doc(
      bulletList(listItem(paragraph(text('p')), paragraph(text('a')), paragraph(text('b')))),
    )
    const md = serialize(d)
    expect(md).toBe('- p\n  a\n  \n  b')
    expect(parse(md)).toEqual(d)
  })

  it('a blockquote separates its paragraphs with an empty quoted line', () => {
    const d = doc(blockquote(paragraph(text('a')), paragraph(text('b'))))
    const md = serialize(d)
    expect(md).toBe('> a\n> \n> b')
    expect(parse(md)).toEqual(d)
  })

  it('a quoted line break is a hard break inside the quote', () => {
    expect(parse('> a\n> b')).toEqual(doc(blockquote(paragraph(text('a'), hardBreak(), text('b')))))
  })

  it('a code fence keeps its newlines as code', () => {
    expect(serialize(parse('a\n```\nx\ny\n```'))).toBe('a\n```\nx\ny\n```')
  })
})
