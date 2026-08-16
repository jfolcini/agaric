/**
 * Round-trip fidelity regression suite for the markdown serialize/parse pair.
 *
 * Each `finding N` group pins one serialize→parse asymmetry from the round-trip
 * audit: constructs the editor can legitimately produce (hard breaks in
 * headings/tasks/table cells, math atoms adjacent to digits, cross-node `$`
 * seams, literal `((ULID))` text, task paragraphs nested in list items) that
 * previously corrupted silently on the first blur/reopen cycle.
 *
 * The invariant pinned throughout: `parse(serialize(doc))` is the identity for
 * these doc shapes (or, where a construct normalizes by design — e.g. a
 * hardBreak inside a table cell degrading to a space, adjacent sibling
 * blockquotes merging — the normalized form is reached in ONE pass and
 * `serialize` is a byte-for-byte fixed point from there).
 */
import { describe, expect, it } from 'vitest'

import {
  blockRef,
  bold,
  bulletList,
  callout,
  blockquote,
  doc,
  hardBreak,
  heading,
  listItem,
  mathInline,
  paragraph,
  table,
  tableCell,
  tableHeader,
  tableRow,
  task,
  text,
} from '@/editor/__tests__/builders'
import { parse, serialize } from '@/editor/markdown-serializer'

const ULID = '01HZ00000000000000000BLOCK'

describe('finding 5: hardBreak inside a table cell must not destroy the table', () => {
  it('keeps every row a single `|`-prefixed line (break degrades to a space)', () => {
    const d = doc(
      table(
        tableRow(
          tableHeader(paragraph(text('a'), hardBreak(), text('b'))),
          tableHeader(paragraph(text('h2'))),
        ),
        tableRow(tableCell(paragraph(text('c'))), tableCell(paragraph(text('d')))),
      ),
    )
    const md = serialize(d)
    for (const line of md.split('\n')) {
      expect(line.startsWith('|')).toBe(true)
    }
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(
        table(
          tableRow(tableHeader(paragraph(text('a b'))), tableHeader(paragraph(text('h2')))),
          tableRow(tableCell(paragraph(text('c'))), tableCell(paragraph(text('d')))),
        ),
      ),
    )
    expect(serialize(reparsed)).toBe(md)
  })

  it('a cell-final hardBreak is dropped (parser-canonical trim), table intact', () => {
    const d = doc(
      table(tableRow(tableHeader(paragraph(text('a'), hardBreak())), tableHeader(paragraph()))),
    )
    const md = serialize(d)
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(table(tableRow(tableHeader(paragraph(text('a'))), { type: 'tableHeader', content: [] }))),
    )
    expect(serialize(reparsed)).toBe(md)
  })
})

describe('finding 6: math_inline followed by digit text', () => {
  it('round-trips as math + text (identity)', () => {
    const d = doc(paragraph(mathInline('x'), text('5 apples')))
    const md = serialize(d)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('non-digit following text needs no defusing and stays identity', () => {
    const d = doc(paragraph(mathInline('x'), text('apples')))
    expect(parse(serialize(d))).toEqual(d)
  })
})

describe('finding 7: hardBreak inside a heading', () => {
  it('round-trips as ONE heading with a hardBreak (no split, no stray backslash)', () => {
    const d = doc(heading(2, text('line one'), hardBreak(), text('line two')))
    const md = serialize(d)
    expect(md).toBe('## line one\\\nline two')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('a heading line ending in an EVEN backslash run does not swallow the next block', () => {
    const d = doc(heading(1, text('ends in backslash\\')), paragraph(text('separate')))
    const md = serialize(d)
    expect(parse(md)).toEqual(d)
  })
})

describe('finding 8: hardBreak inside a task paragraph', () => {
  it('round-trips as ONE task paragraph (todoState kept, no split)', () => {
    const d = doc(task('TODO', text('buy milk'), hardBreak(), text('and eggs')))
    const md = serialize(d)
    expect(md).toBe('- [ ] buy milk\\\nand eggs')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('all four todo states survive a hardBreak round-trip', () => {
    for (const state of ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const) {
      const d = doc(task(state, text('a'), hardBreak(), text('b')))
      expect(parse(serialize(d))).toEqual(d)
    }
  })
})

describe('finding 9: cross-node `$` seam', () => {
  it('literal `$` at a text-node edge before a marked node never becomes math', () => {
    const d = doc(paragraph(text('Prices: 5$'), bold(' or 10$')))
    const md = serialize(d)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('literal `$` at a text-node edge before a math atom never merges into it', () => {
    const d = doc(paragraph(text('a$'), mathInline('x')))
    const md = serialize(d)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('node-final `$` at paragraph end stays bare (pinned canonical form)', () => {
    const d = doc(paragraph(text('costs 5$')))
    expect(serialize(d)).toBe('costs 5$')
    expect(parse('costs 5$')).toEqual(d)
  })
})

describe('finding 10: math_inline latex containing `$` or edge whitespace', () => {
  it('an interior `$` is escaped so the span cannot close early (one-pass normalize, then stable)', () => {
    const md = serialize(doc(paragraph(mathInline('a$b'))))
    expect(md).toBe('$a\\$b$')
    const reparsed = parse(md)
    // Parser keeps the `\$` verbatim inside the span (pinned by markdown-math
    // tests) — the node survives as ONE math atom and is stable thereafter.
    expect(reparsed).toEqual(doc(paragraph(mathInline('a\\$b'))))
    expect(serialize(reparsed)).toBe(md)
  })

  it('already-escaped `\\$` inside latex round-trips as identity', () => {
    const d = doc(paragraph(mathInline('a\\$b')))
    const md = serialize(d)
    expect(md).toBe('$a\\$b$')
    expect(parse(md)).toEqual(d)
  })

  it('leading whitespace in latex is trimmed instead of degrading the node to text', () => {
    const md = serialize(doc(paragraph(mathInline(' x'))))
    expect(md).toBe('$x$')
    expect(parse(md)).toEqual(doc(paragraph(mathInline('x'))))
  })

  it('trailing whitespace in latex is trimmed instead of degrading the node to text', () => {
    const md = serialize(doc(paragraph(mathInline('x '))))
    expect(md).toBe('$x$')
    expect(parse(md)).toEqual(doc(paragraph(mathInline('x'))))
  })

  it('an odd trailing backslash run in latex cannot escape the closing `$`', () => {
    const md = serialize(doc(paragraph(mathInline('x\\'))))
    expect(md).toBe('$x\\\\$')
    const reparsed = parse(md)
    expect(reparsed).toEqual(doc(paragraph(mathInline('x\\\\'))))
    expect(serialize(reparsed)).toBe(md)
  })

  it('whitespace-only latex serializes to nothing rather than a degenerate `$$`', () => {
    expect(serialize(doc(paragraph(mathInline(' '), text('after'))))).toBe('after')
  })
})

describe('finding 11: literal ((ULID)) text vs live block_ref', () => {
  it('literal ((ULID)) TEXT round-trips as text (escaped, symmetric with [[ and #[)', () => {
    const d = doc(paragraph(text(`see ((${ULID})) here`)))
    const md = serialize(d)
    expect(md).toBe(`see \\((${ULID})) here`)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('a real block_ref NODE still serializes bare and parses back to a block_ref', () => {
    const d = doc(paragraph(text('see '), blockRef(ULID), text(' here')))
    const md = serialize(d)
    expect(md).toBe(`see ((${ULID})) here`)
    expect(parse(md)).toEqual(d)
  })

  it('non-token parens are not escaped (lowercase ULID / ordinary text)', () => {
    const d = doc(paragraph(text('not ((01hz00000000000000000block)) and ((plain))')))
    expect(serialize(d)).toBe('not ((01hz00000000000000000block)) and ((plain))')
    expect(parse(serialize(d))).toEqual(d)
  })
})

describe('finding 12: adjacent sibling blockquotes/tables merge (pinned canonical policy)', () => {
  // The block grammar has no boundary the serializer could emit between two
  // sibling blockquotes (or tables) that would not itself become a block on
  // reparse — the merge is therefore the CANONICAL normalization: it happens in
  // one pass, and serialize∘parse is a byte-for-byte fixed point from there.
  // (Doc-side sibling merging at editor mount is tracked separately — it lives
  // outside the serializer.)
  it('two sibling blockquotes normalize to ONE blockquote with both paragraphs, stably', () => {
    const d = doc(
      blockquote(paragraph(text('first quote'))),
      blockquote(paragraph(text('second quote'))),
    )
    const md = serialize(d)
    expect(md).toBe('> first quote\n> second quote')
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(blockquote(paragraph(text('first quote')), paragraph(text('second quote')))),
    )
    expect(serialize(reparsed)).toBe(md)
  })

  it('a callout followed by a plain sibling quote absorbs the quote, stably', () => {
    const d = doc(callout('info', paragraph(text('note'))), blockquote(paragraph(text('plain'))))
    const md = serialize(d)
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(callout('info', paragraph(text('note')), paragraph(text('plain')))),
    )
    expect(serialize(reparsed)).toBe(md)
  })

  it('two sibling tables normalize to ONE table, stably from the canonical form', () => {
    const d = doc(
      table(tableRow(tableHeader(paragraph(text('a'))))),
      table(tableRow(tableHeader(paragraph(text('b'))))),
    )
    // The second table's header becomes an ordinary DATA row of the merged
    // table (unchanged). Its separator, however, is no longer swallowed
    // (#3274 — the separator heuristic is positional, only row 1 of the run
    // qualifies): it survives as a THIRD row whose cell is the literal text
    // `---`. The pre-existing horizontal-rule guard in serializeParagraph
    // (`^-{3,}$`) already escapes that cell on the way back out, so it can
    // never be mistaken for a separator again.
    const merged = doc(
      table(
        tableRow(tableHeader(paragraph(text('a')))),
        tableRow(tableCell(paragraph(text('b')))),
        tableRow(tableCell(paragraph(text('---')))),
      ),
    )
    const reparsed = parse(serialize(d))
    expect(reparsed).toEqual(merged)
    // The doc shape is already the fixed point after one pass; the STRING
    // gains the `---` cell's escape on this second serialize, then is stable.
    const md2 = serialize(reparsed)
    expect(md2).toBe('| a |\n| --- |\n| b |\n| \\--- |')
    expect(parse(md2)).toEqual(merged)
    expect(serialize(parse(md2))).toBe(md2)
  })
})

describe('finding 13: a table DATA row of only dashes/colons is not the separator (#3274)', () => {
  // parser.ts's separator heuristic used to fire on ANY row of the table run,
  // not just the one immediately after the header — so a data row a user
  // filled with `-` as a "no value" placeholder was silently dropped on
  // reparse, destroying it on the next edit's persist.
  it('a data row with one dash-only cell round-trips (parse keeps it; stable)', () => {
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
        tableRow(tableCell(paragraph(text('a'))), tableCell(paragraph(text('-')))),
      ),
    )
    const md = serialize(d)
    expect(md).toBe('| Name | Value |\n| --- | --- |\n| a | - |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('a data row whose EVERY cell is dash-only round-trips (the reported #3274 shape)', () => {
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
        tableRow(tableCell(paragraph(text('-'))), tableCell(paragraph(text('-')))),
      ),
    )
    const md = serialize(d)
    expect(md).toBe('| Name | Value |\n| --- | --- |\n| - | - |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })
})

describe('fuzz-found seams (property-suite counterexamples, pinned)', () => {
  it('link display text that looks like a BLOCK production stays inline', () => {
    // `parse(displayText)` used to hit the blockquote production and cast its
    // block children to inline nodes, vaporizing the link on the next pass.
    const link = [{ type: 'link' as const, attrs: { href: 'https://example.com' } }]
    for (const display of ['>', '# x', '1. item', '> ~a']) {
      const d = doc(paragraph(text(display, link)))
      const md = serialize(d)
      expect(parse(md)).toEqual(d)
      expect(serialize(parse(md))).toBe(md)
    }
  })

  it('image alt containing an unbalanced `[` round-trips', () => {
    const d = doc(
      paragraph({ type: 'image', attrs: { alt: '[', src: 'https://example.com' } }, text('a')),
    )
    const md = serialize(d)
    expect(md).toBe('![\\[](https://example.com)a')
    expect(parse(md)).toEqual(d)
  })

  it('math latex with a leading digit is brace-wrapped so it cannot read as currency', () => {
    const md = serialize(doc(paragraph(mathInline('0'))))
    expect(md).toBe('${0}$')
    const reparsed = parse(md)
    expect(reparsed).toEqual(doc(paragraph(mathInline('{0}'))))
    expect(serialize(reparsed)).toBe(md)
  })

  it('cell of `$` + hardBreak keeps the `$` unescaped (break degrades to a REAL space)', () => {
    // The hardBreak→space degrade must happen at the node level: escaping `$`
    // against the hardBreak token and then string-stripping the token would
    // leave a stray `\$` that the next pass emits bare — a byte drift.
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('$'), hardBreak())), tableHeader(paragraph(text('h')))),
      ),
    )
    const md = serialize(d)
    expect(md).toBe('| $ | h |\n| --- | --- |')
    expect(serialize(parse(md))).toBe(md)
  })

  it('node-final `$` before the closing mark delimiters never opens math', () => {
    const d = doc(
      paragraph(
        text('$', [{ type: 'underline' }]),
        text('a', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        text('$'),
      ),
    )
    const md = serialize(d)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })
})

describe('finding 13: task paragraph as first child of a listItem', () => {
  it('`- - [ ] x` round-trips as bulletList > listItem > task paragraph (identity)', () => {
    const d = doc(bulletList(listItem(task('TODO', text('buy milk')))))
    const md = serialize(d)
    expect(md).toBe('- - [ ] buy milk')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('mixed list (task item + plain item) round-trips', () => {
    const d = doc(
      bulletList(listItem(task('DONE', text('done thing'))), listItem(paragraph(text('plain')))),
    )
    expect(parse(serialize(d))).toEqual(d)
  })

  it('ordered list item whose paragraph is a task round-trips', () => {
    const d = doc({
      type: 'orderedList',
      content: [listItem(task('DOING', text('in progress')))],
    })
    const md = serialize(d)
    expect(md).toBe('1. - [/] in progress')
    expect(parse(md)).toEqual(d)
  })

  it('LITERAL `- [ ]` text in a list item paragraph stays literal (escaped)', () => {
    const d = doc(bulletList(listItem(paragraph(text('- [ ] not a task')))))
    const md = serialize(d)
    expect(md).toBe('- \\- \\[ \\] not a task')
    expect(parse(md)).toEqual(d)
  })

  it('task with hardBreak inside a listItem round-trips (findings 8 + 13 combined)', () => {
    const d = doc(bulletList(listItem(task('TODO', text('a'), hardBreak(), text('b')))))
    expect(parse(serialize(d))).toEqual(d)
  })
})
