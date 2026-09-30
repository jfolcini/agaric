/**
 * #5160 N9 and N12: the inline syntax the editor reads the way CommonMark and
 * the tools it imports from write it, and the escapes the serializer writes
 * only where the parser would otherwise misread the text.
 *
 * Every serializer case also checks the stored form is a fixpoint: a form that
 * the parser reads differently is rewritten on the next save.
 */

import { describe, expect, it } from 'vitest'

import {
  bold,
  bulletList,
  doc,
  heading,
  highlight,
  italic,
  listItem,
  mathInline,
  paragraph,
  strike,
  table,
  tableCell,
  tableHeader,
  tableRow,
  task,
  text,
} from '@/editor/__tests__/builders'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode, InlineNode, PMMark } from '@/editor/types'

/** The inline content of a one-paragraph doc. */
function inline(md: string): readonly InlineNode[] | undefined {
  const block = parse(md).content?.[0]
  return block?.type === 'paragraph' ? block.content : undefined
}

function image(alt: string, src: string): InlineNode {
  return { type: 'image', attrs: { alt, src } }
}

function linked(t: string, href: string, marks: readonly PMMark[] = []): InlineNode {
  return text(t, [...marks, { type: 'link', attrs: { href } }])
}

/** `serialize(d)`, asserting the stored form reads back as itself. */
function stored(d: DocNode): string {
  const md = serialize(d)
  expect(serialize(parse(md)), `${JSON.stringify(md)} is not a fixpoint`).toBe(md)
  return md
}

const boldStrike = (t: string) => text(t, [{ type: 'bold' }, { type: 'strike' }])

describe('N9 E22: `*`, `**`, `~~` and `==` obey CommonMark flanking', () => {
  it.each([
    ['5 * 3 = 15 and 2 * 4 = 8'],
    ['if x == y and y == z'],
    ['a ~~ b ~~ c'],
    ['a ** b ** c'],
    // A run followed by whitespace cannot open, and one after whitespace cannot close.
    ['*a *'],
    ['** a**'],
    // Between a letter and punctuation a run neither opens nor closes.
    ['a**(b)**c'],
    ['a==(b)==c'],
    // A run never closes the mark it opened.
    ['a====b'],
    ['a****b'],
    ['a~~~~b'],
    ['(____)'],
  ])('%j stays literal text', (md) => {
    expect(inline(md)).toEqual([text(md)])
  })

  it.each([
    ['*a*', [italic('a')]],
    ['**a**', [bold('a')]],
    ['~~a~~', [strike('a')]],
    ['==a==', [highlight('a')]],
    // Intraword `*` runs are flanking on both sides.
    ['a**b**c', [text('a'), bold('b'), text('c')]],
    ['(**b**)', [text('('), bold('b'), text(')')]],
    ['***bi***', [text('bi', [{ type: 'bold' }, { type: 'italic' }])]],
    ['2 * 3 = *six*', [text('2 * 3 = '), italic('six')]],
    ['__a**b__', [bold('a**b')]],
  ])('%j still reads as emphasis', (md, expected) => {
    expect(inline(md)).toEqual(expected)
  })

  it('reads the neighbour of a run as a whole code point', () => {
    // An emoji is a symbol, so punctuation: `**` between a letter and one
    // cannot open, nor close between one and a letter. Read as a lone
    // surrogate half it would be a letter, and both would.
    expect(inline('a**😀b**')).toEqual([text('a**😀b**')])
    expect(inline('**b😀**c')).toEqual([text('**b😀**c')])
    expect(inline('😀**b**')).toEqual([text('😀'), bold('b')])
    expect(stored(doc(paragraph(bold('b😀'), text('c'))))).toBe('**b**😀c')
  })

  it('a flanking run inside link text is read against the text edges', () => {
    expect(inline('[a **b** c](https://x.com)')).toEqual([
      linked('a ', 'https://x.com'),
      linked('b', 'https://x.com', [{ type: 'bold' }]),
      linked(' c', 'https://x.com'),
    ])
    expect(inline('[a ** b](https://x.com)')).toEqual([linked('a ** b', 'https://x.com')])
  })
})

describe('N9 E22: the serializer moves a mark boundary until its delimiter reads back', () => {
  it.each([
    ['whitespace at the start of a span', paragraph(bold(' a')), ' **a**'],
    ['whitespace at the end of a span', paragraph(bold('a '), text('b')), '**a** b'],
    ['an italic span opening onto a space', paragraph(italic(' y')), ' *y*'],
    ['strike', paragraph(text('a'), strike(' b ')), 'a ~~b~~ '],
    ['highlight', paragraph(highlight(' b')), ' ==b=='],
    [
      'punctuation between a letter and the delimiter',
      paragraph(text('a'), bold('(b)'), text('c')),
      'a(**b**)c',
    ],
    [
      'a span of only punctuation drops the mark',
      paragraph(text('a'), bold('.'), text('b')),
      'a.b',
    ],
    [
      'a span of only whitespace drops the mark',
      paragraph(text('a'), italic(' '), text('b')),
      'a b',
    ],
    [
      'two stacked delimiter kinds against letters are staggered',
      paragraph(text('x'), boldStrike('abc'), text('y')),
      'x~~a**b**c~~y',
    ],
  ])('%s', (_label, p, expected) => {
    expect(stored(doc(p))).toBe(expected)
  })

  it('a boundary moves the same way in a heading, a task, a list item and a table cell', () => {
    expect(stored(doc(heading(1, bold(' a'))))).toBe('#  **a**')
    expect(stored(doc(task('TODO', bold(' a'))))).toBe('- [ ]  **a**')
    expect(stored(doc(bulletList(listItem(paragraph(italic(' y'))))))).toBe('-  *y*')
    expect(stored(doc(table(tableRow(tableHeader(paragraph(bold(' a '), text('b')))))))).toBe(
      '| **a** b |\n| --- |',
    )
  })

  it('a table cell whose moved whitespace lands at its edge still escapes the marker behind it', () => {
    expect(stored(doc(table(tableRow(tableHeader(paragraph(bold(' '), text('> x')))))))).toBe(
      '| \\> x |\n| --- |',
    )
  })

  it('an italic span opening onto a space never becomes a bullet marker', () => {
    const md = stored(doc(paragraph(italic(' y'))))
    expect(parse(md)).toEqual(doc(paragraph(text(' '), italic('y'))))
  })

  it('a fitted span keeps its mark on everything the delimiter can wrap', () => {
    expect(parse(stored(doc(paragraph(text('a'), bold('(b)'), text('c')))))).toEqual(
      doc(paragraph(text('a('), bold('b'), text(')c'))),
    )
  })

  it('a span inside link text is fitted against the text edges', () => {
    expect(stored(doc(paragraph(linked(' a', 'https://x.com', [{ type: 'bold' }]))))).toBe(
      '[ **a**](https://x.com)',
    )
  })

  it('an underline tag is punctuation to the delimiter beside it', () => {
    // `**` between `>` and `.` can open, so the bold keeps its `.`.
    const d = doc(paragraph(text('x'), text('.y', [{ type: 'underline' }, { type: 'bold' }])))
    expect(stored(d)).toBe('x<u>**.y**</u>')
    expect(parse(serialize(d))).toEqual(d)
  })

  it('an atom that emits nothing does not close the marks around it', () => {
    // Closing and reopening the italic around it would emit `*a**b*`, whose
    // `**` reads as bold.
    const md = stored(doc(paragraph(italic('a'), mathInline(' '), italic('b'))))
    expect(md).toBe('*ab*')
  })

  it('a delimiter next to a bare URL is fitted against the URL, not a bracket', () => {
    // `**a.**` then `https://…`: a closer after punctuation needs whitespace or
    // punctuation after it, and a bare URL starts with a letter.
    const md = stored(doc(paragraph(bold('a.'), linked('https://x.com', 'https://x.com'))))
    expect(md).toBe('**a**.https://x.com')
  })
})

describe('N9 E19: `$$…$$` mid-line is inline math', () => {
  it('pairs the opener with the next `$$` and stores the math as `$…$`', () => {
    const md = 'The value is $$x^2$$ here'
    expect(inline(md)).toEqual([text('The value is '), mathInline('x^2'), text(' here')])
    expect(serialize(parse(md))).toBe('The value is $x^2$ here')
  })

  it('trims the LaTeX, as the display form allows edge spaces', () => {
    expect(inline('a $$ x + y $$ b')).toEqual([text('a '), mathInline('x + y'), text(' b')])
  })

  it.each([['a $$ b'], ['a $$ $$ b'], ['cost $$5']])(
    '%j with no LaTeX pair stays literal',
    (md) => {
      expect(inline(md)).toEqual([text(md)])
      expect(serialize(parse(serialize(parse(md))))).toBe(serialize(parse(md)))
    },
  )

  it('a line of only `$$ … $$` is still a math block', () => {
    expect(parse('$$ x $$')).toEqual(doc({ type: 'math_block', attrs: { latex: 'x' } }))
  })
})

describe('N9 E20: link titles and `<…>` destinations', () => {
  it.each([
    ['[t](https://x.com "title")', 'https://x.com'],
    ["[t](https://x.com 'title')", 'https://x.com'],
    ['[t](https://x.com (title))', 'https://x.com'],
    ['[t](<https://x.com/a b>)', 'https://x.com/a b'],
    ['[t](<https://x.com> "title")', 'https://x.com'],
    ['[t]( https://x.com )', 'https://x.com'],
  ])('%j links to %j', (md, href) => {
    expect(inline(md)).toEqual([linked('t', href)])
  })

  it('an image drops its title too', () => {
    expect(inline('![a](https://x.com/i.png "Title")')).toEqual([
      { type: 'image', attrs: { alt: 'a', src: 'https://x.com/i.png' } },
    ])
  })

  it('decodes a backslash before any ASCII punctuation in a destination', () => {
    expect(inline('[t](https://x.com/a\\_b\\*c)')).toEqual([linked('t', 'https://x.com/a_b*c')])
  })

  it('keeps a parenthesised path that is not a title', () => {
    expect(inline('[t](https://ex.com/page(1))')).toEqual([linked('t', 'https://ex.com/page(1)')])
  })

  it.each([
    ['https://x.com "t"', '[t](<https://x.com "t">)'],
    ['https://x.com/a (1)', '[t](<https://x.com/a (1)>)'],
    [' https://x.com', '[t](< https://x.com>)'],
    ['<x>', '[t](<<x>>)'],
  ])('an href the bare form would misread (%j) is written in `<…>` form', (href, md) => {
    expect(stored(doc(paragraph(linked('t', href))))).toBe(md)
    expect(parse(md)).toEqual(doc(paragraph(linked('t', href))))
  })

  it('an ordinary href keeps the bare form', () => {
    expect(stored(doc(paragraph(linked('t', 'https://ex.com/a b'))))).toBe(
      '[t](https://ex.com/a b)',
    )
  })

  it('an image src the bare form would misread is written in `<…>` form', () => {
    const d = doc(paragraph(image('a', 'https://x.com/i.png "t"')))
    expect(stored(d)).toBe('![a](<https://x.com/i.png "t">)')
    expect(parse(serialize(d))).toEqual(d)
  })
})

describe('N9 E21: a backslash escapes any ASCII punctuation', () => {
  it('`\\(x\\)` reads as `(x)`, so the backslash cannot double on the next save', () => {
    expect(inline('\\(x\\)')).toEqual([text('(x)')])
    expect(serialize(parse('\\(x\\)'))).toBe('(x)')
  })

  it.each('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))('`\\%s` reads as the bare char', (ch) => {
    const md = `a\\${ch}b`
    expect(inline(md)).toEqual([text(`a${ch}b`)])
    const once = serialize(parse(md))
    expect(serialize(parse(once))).toBe(once)
  })

  it('a backslash before a letter is still literal', () => {
    expect(inline('\\alpha')).toEqual([text('\\alpha')])
  })
})

describe('N12: `=`, `~` and `|` are escaped only where they would parse', () => {
  it('writes ordinary prose unescaped', () => {
    expect(stored(doc(paragraph(text('x = 5, y ~ 3, a | b'))))).toBe('x = 5, y ~ 3, a | b')
  })

  it.each([
    ['a run between spaces cannot flank', 'a == b ~~ c', 'a == b ~~ c'],
    ['an intraword run could', 'a==b~~c', 'a\\=\\=b\\~\\~c'],
    ['a run at the text edge could', '==b', '\\=\\=b'],
    ['a run after punctuation could', '(==b', '(\\=\\=b'],
    ['any `~~~` is a Rust fence at a line start', 'a ~~~ b', 'a \\~\\~\\~ b'],
    ['`===` is not a fence', 'a === b', 'a === b'],
  ])('%s: %j', (_label, t, md) => {
    expect(stored(doc(paragraph(text(t))))).toBe(md)
    expect(parse(md)).toEqual(doc(paragraph(text(t))))
  })

  it.each([
    ['after a strike', paragraph(strike('a'), text('~b')), '~~a~~\\~b'],
    ['before a strike', paragraph(text('a~'), strike('b')), 'a\\~~~b~~'],
    ['inside a strike, at its start', paragraph(strike('~a')), '~~\\~a~~'],
    ['after a highlight', paragraph(highlight('a'), text('=b')), '==a==\\=b'],
    ['before a highlight', paragraph(text('a='), highlight('b')), 'a\\===b=='],
  ])('a single `~`/`=` next to the same delimiter is escaped: %s', (_label, p, md) => {
    expect(stored(doc(p))).toBe(md)
    expect(parse(md)).toEqual(doc(p))
  })

  it('a single `~`/`=` next to a different delimiter stays bare', () => {
    expect(stored(doc(paragraph(bold('a'), text('~b='), italic('c'))))).toBe('**a**~b=*c*')
  })

  it('`|` is escaped at a line start, where it would start a table', () => {
    expect(stored(doc(paragraph(text('| a'))))).toBe('\\| a')
    expect(stored(doc(paragraph(text('a'), { type: 'hardBreak' }, text('| b'))))).toBe('a\n\\| b')
    expect(parse('\\| a')).toEqual(doc(paragraph(text('| a'))))
  })

  it('`|` is escaped in a table cell, where it would end the cell', () => {
    const d = doc(table(tableRow(tableHeader(paragraph(text('a | b')))), tableRow(tableCell())))
    expect(stored(d)).toBe('| a \\| b |\n| --- |\n|  |')
  })
})
