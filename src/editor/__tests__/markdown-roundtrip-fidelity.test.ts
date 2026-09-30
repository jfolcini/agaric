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
  boldItalic,
  bulletList,
  callout,
  blockquote,
  code,
  doc,
  hardBreak,
  heading,
  highlight,
  italic,
  listItem,
  mathInline,
  orderedList,
  paragraph,
  strike,
  table,
  tableCell,
  tableHeader,
  tableRow,
  task,
  text,
  underline,
} from '@/editor/__tests__/builders'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { InlineNode } from '@/editor/types'
import { parseEmbedToken } from '@/lib/embed-token'

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
    // The bold starts on a letter: `**` before a space cannot open (#5160 N9),
    // so a leading space would move out of the mark and away from the seam.
    const d = doc(paragraph(text('Prices: 5$'), bold('or 10$')))
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

// #4550 — the embed token's inner `((ULID))` rides finding 11's escape rule,
// and lands on the WRONG side of it if the picker ever writes plain text.
describe('#4550: the {{embed ((ULID))}} token', () => {
  it('serializes bare and reparses identically when the inner ref is a NODE', () => {
    const d = doc(paragraph(text('{{embed '), blockRef(ULID), text('}}')))
    const md = serialize(d)
    expect(md).toBe(`{{embed ((${ULID}))}}`)
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('parses back to a live embed token, so the render and the backlink both survive', () => {
    const md = serialize(doc(paragraph(text('{{embed '), blockRef(ULID), text('}}'))))
    expect(parseEmbedToken(md)).toEqual({ targetId: ULID })
  })

  it('is NOT what a plain-text token produces — the escape breaks it', () => {
    // Finding 11's rule applied to this shape: the inner ref escapes, and
    // `{{embed \((ULID))}}` matches neither `parseEmbedToken` here nor
    // `ULID_LINK_RE` in `reindex_block_links_conn`. The block would render as
    // inert text AND contribute no backlink — silently, on the first blur.
    // This is why the picker inserts a `block_ref` node, not a string.
    const md = serialize(doc(paragraph(text(`{{embed ((${ULID}))}}`))))
    expect(md).toBe(`{{embed \\((${ULID}))}}`)
    expect(parseEmbedToken(md)).toBeNull()
  })
})

describe('finding 12: adjacent sibling blockquotes/tables merge (pinned canonical policy)', () => {
  // The block grammar has no boundary the serializer could emit between two
  // sibling blockquotes (or tables) that would not itself become a block on
  // reparse — the merge is therefore the CANONICAL normalization: it happens in
  // one pass, and serialize∘parse is a byte-for-byte fixed point from there.
  // (Doc-side sibling merging at editor mount is tracked separately — it lives
  // outside the serializer.)
  //
  // #4012 item 1 asked for adjacent tables to SPLIT back apart instead. They
  // do — but only where the split is decidable (see the width-change case
  // below); a rectangular run keeps the merge pinned here, because the two
  // readings of one are provably indistinguishable.
  // #5160 D2: the merged quote's two lines are one paragraph with a hard
  // break, since a single quoted line break is a line of the same paragraph.
  it('two sibling blockquotes normalize to ONE blockquote with one two-line paragraph, stably', () => {
    const d = doc(
      blockquote(paragraph(text('first quote'))),
      blockquote(paragraph(text('second quote'))),
    )
    const md = serialize(d)
    expect(md).toBe('> first quote\n> second quote')
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(blockquote(paragraph(text('first quote'), hardBreak(), text('second quote')))),
    )
    expect(serialize(reparsed)).toBe(md)
  })

  it('a callout followed by a plain sibling quote absorbs the quote, stably', () => {
    const d = doc(callout('info', paragraph(text('note'))), blockquote(paragraph(text('plain'))))
    const md = serialize(d)
    const reparsed = parse(md)
    expect(reparsed).toEqual(
      doc(callout('info', paragraph(text('note'), hardBreak(), text('plain')))),
    )
    expect(serialize(reparsed)).toBe(md)
  })

  // #4012 item 1, SAME-WIDTH half. `parseTable` collects the whole run of
  // consecutive `|` lines with no lookahead, so two sibling tables typed (or
  // pasted) with no blank line between them land in ONE run: the second
  // table's header becomes a data row, and its delimiter — no longer at the
  // run's own index 1 (#3274 made that test positional) — survives as a data
  // row whose cell is the literal text `---`, escaped to `\---` on the way
  // back out.
  //
  // It stays that way because splitting HERE is a guess, not a deduction: the
  // string below has two legal readings (one table with two data rows, or the
  // two tables it was built from) and nothing in it decides between them. The
  // next test proves that ambiguity concretely on a bigger shape.
  it('two same-width sibling tables normalize to ONE table, stably from the canonical form', () => {
    const d = doc(
      table(tableRow(tableHeader(paragraph(text('a'))))),
      table(tableRow(tableHeader(paragraph(text('b'))))),
    )
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

  // The reason the run above is not split, made falsifiable: this ONE string
  // is the serialization of two different, both entirely legal, documents.
  //
  //   (a) one table with three data rows — `---` as the conventional "n/a"
  //       placeholder, which is GFM's own reading and what every other
  //       renderer shows;
  //   (b) a header-only table followed by a second table headed `x | 1`.
  //
  // Any rule that splits a rectangular run at a bare-dash row therefore
  // silently DELETES that row (it becomes table 2's delimiter) and promotes
  // `x | 1` to a header whenever reading (a) was the true one — valid GFM
  // corrupted on the ordinary render/edit path, which is the #3274/#4003 data
  // loss all over again. We keep reading (a) and lose nothing: every row the
  // author wrote is still there.
  it('a dash-only DATA row past index 1 stays data — the split cannot guess (#4012)', () => {
    const md = '| Name | Value |\n| --- | --- |\n| x | 1 |\n| --- | --- |\n| y | 2 |'
    // Reading (b): the same bytes, from two tables. This is what makes the
    // input ambiguous rather than merely awkward.
    expect(
      serialize(
        doc(
          table(
            tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
          ),
          table(
            tableRow(tableHeader(paragraph(text('x'))), tableHeader(paragraph(text('1')))),
            tableRow(tableCell(paragraph(text('y'))), tableCell(paragraph(text('2')))),
          ),
        ),
      ),
    ).toBe(md)
    // Reading (a) is the one we take: ONE table, all three data rows kept,
    // the dash row among them.
    const kept = doc(
      table(
        tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
        tableRow(tableCell(paragraph(text('x'))), tableCell(paragraph(text('1')))),
        tableRow(tableCell(paragraph(text('---'))), tableCell(paragraph(text('---')))),
        tableRow(tableCell(paragraph(text('y'))), tableCell(paragraph(text('2')))),
      ),
    )
    expect(parse(md)).toEqual(kept)
    const md2 = serialize(parse(md))
    expect(md2).toBe('| Name | Value |\n| --- | --- |\n| x | 1 |\n| \\--- | \\--- |\n| y | 2 |')
    expect(parse(md2)).toEqual(kept)
    expect(serialize(parse(md2))).toBe(md2)
  })

  // An absorbed table's delimiter is index 1 OF ITS OWN table, so the
  // earliest one can sit in a run is index 3 (`header, delimiter, header,
  // delimiter`). A split at index 2 would take the RUN's own delimiter as the
  // boundary, leaving a table with a header and no delimiter followed by one
  // whose header cell is the literal `---` — neither the one table this is,
  // nor the two tables nobody typed.
  it('a dash row at index 2 is a data row, not a split point (#4012)', () => {
    const md = '| a |\n| --- |\n| --- |'
    const kept = doc(
      table(
        tableRow(tableHeader(paragraph(text('a')))),
        tableRow(tableCell(paragraph(text('---')))),
      ),
    )
    expect(parse(md)).toEqual(kept)
    const md2 = serialize(parse(md))
    expect(md2).toBe('| a |\n| --- |\n| \\--- |')
    expect(parse(md2)).toEqual(kept)
    expect(serialize(parse(md2))).toBe(md2)
  })

  // #4012 item 1, DECIDABLE half — the case a rule can actually resolve. The
  // absorbed delimiter (and the header above it) are ONE cell wide where the
  // table they would join is TWO: as a data row of that table it is malformed
  // GFM (renderers truncate or pad it; the merged TableNode is ragged), while
  // as a second table it is well formed. Splitting there loses nothing, so it
  // happens — and the two-table doc is a strict fixpoint on the first pass.
  it('a table run that CHANGES WIDTH splits back into the two tables it came from', () => {
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('a'))), tableHeader(paragraph(text('b')))),
        tableRow(tableCell(paragraph(text('x'))), tableCell(paragraph(text('y')))),
      ),
      table(tableRow(tableHeader(paragraph(text('c')))), tableRow(tableCell(paragraph(text('z'))))),
    )
    const md = serialize(d)
    expect(md).toBe('| a | b |\n| --- | --- |\n| x | y |\n| c |\n| --- |\n| z |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('three tables of alternating widths split at every boundary, not just the first', () => {
    const d = doc(
      table(tableRow(tableHeader(paragraph(text('a'))))),
      table(tableRow(tableHeader(paragraph(text('b'))), tableHeader(paragraph(text('c'))))),
      table(tableRow(tableHeader(paragraph(text('d'))))),
    )
    const md = serialize(d)
    expect(md).toBe('| a |\n| --- |\n| b | c |\n| --- | --- |\n| d |\n| --- |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  // The escaping guarantee `splitTableRuns` leans on, pinned: OUR OWN output
  // never emits a bare `---` cell for genuine data — not even when the cell's
  // text carries surrounding whitespace, which `serializeTable` strips at the
  // NODE level (`canonicalCellParagraphs`) BEFORE `serializeParagraph`'s
  // `^-{3,}$` horizontal-rule guard runs, not on the emitted string after it.
  it('a `--- ` cell (untrimmed) is escaped too — the guard sees the trimmed text', () => {
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('a')))),
        tableRow(tableCell(paragraph(text('--- ')))),
      ),
    )
    expect(serialize(d)).toBe('| a |\n| --- |\n| \\--- |')
    // …and it round-trips to the trimmed cell, which re-emits identically.
    const trimmed = doc(
      table(
        tableRow(tableHeader(paragraph(text('a')))),
        tableRow(tableCell(paragraph(text('---')))),
      ),
    )
    expect(parse(serialize(d))).toEqual(trimmed)
    expect(serialize(parse(serialize(d)))).toBe(serialize(d))
  })

  it('a merge is not falsely triggered by a genuine `--` data row (not 3+ dashes)', () => {
    // `--` is a legal GFM delimiter cell shape but NOT the canonical `---`
    // `serializeTable` emits and `serializeParagraph`'s horizontal-rule guard
    // (`^-{3,}$`) does not escape it — so it is reachable as genuine,
    // unescaped data mid-table, and must not be misread as an absorbed
    // second table's separator.
    const d = doc(
      table(
        tableRow(tableHeader(paragraph(text('a'))), tableHeader(paragraph(text('b')))),
        tableRow(tableCell(paragraph(text('x'))), tableCell(paragraph(text('--')))),
      ),
    )
    const md = serialize(d)
    expect(md).toBe('| a | b |\n| --- | --- |\n| x | -- |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
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

describe('#4071/#4076: markdown-string convergence on the SECOND pass', () => {
  const passes = (s: string) => {
    const once = serialize(parse(s))
    return { once, twice: serialize(parse(once)) }
  }

  /**
   * #4071. Two ordered lists separated by a paragraph whose own text is
   * indented a whole nest level. The input's markers carry the CommonMark
   * 3-space tolerance, which puts the first item's content column at 5 — past
   * the paragraph's 4 — so the parse correctly keeps the three blocks siblings.
   * Serializing NORMALIZES the markers to column 0, dropping the content column
   * to 2, and the same paragraph is now deep enough to be swallowed as the
   * item's nested content: the two lists fuse and the second renumbers
   * (`1./1.` → `1./2.`) on the SECOND pass. The serializer defuses the
   * paragraph's leading indent so the emitted line starts at column 0.
   */
  it('#4071: two ordered lists split by an indented paragraph converge in ONE pass', () => {
    const { once, twice } = passes('   1. item\n    - item\n3. item')
    expect(once).toBe('1. item\n\\    \\- item\n1. item')
    expect(twice).toBe(once)
    // and the structure survives: still THREE sibling blocks, not one list
    expect((parse(once).content ?? []).map((b) => b.type)).toEqual([
      'orderedList',
      'paragraph',
      'orderedList',
    ])
  })

  /**
   * #4076.1. The same defect one level in, with a tab: the tab-indented
   * blockquote line is a sibling paragraph of a list whose markers are indented
   * on the way in, and the list's own normalization pulls it inside the item on
   * pass two — where the recursive parse re-reads the dedented text as a
   * BLOCKQUOTE and only then expands the tabs. The reported top-level form
   * (`> > > \t\t- item`) already converged in one pass; it is this
   * nested-in-a-list form that the #4052 foreign-import property generated.
   */
  it('#4076.1: a tab-indented blockquote line after a list converges in ONE pass', () => {
    const { once, twice } = passes('   - item\n\t    - item\n\t> > > \t\t- item\n- item')
    expect(once).toBe('- item\n  - item\n\\    > > > \t\t- item\n- item')
    expect(twice).toBe(once)
  })

  /**
   * #4076.2 is NOT a convergence failure and is NOT fixed here — pinned so the
   * distinction is on the record rather than rediscovered.
   *
   * `> > 3. item` converges in one pass; what it loses is the literal ordinal,
   * which the parser discards and the serializer regenerates from position.
   * That is the DOCUMENTED design, not an oversight: ordered numbers are
   * computed from a block's position among its siblings, never stored
   * (`docs/architecture/list-ergonomics.md` § Markdown round-trip, and
   * `src/lib/list-ordinals.ts`, which recomputes them for the block tree).
   * Carrying `start` through the markdown pair alone would make the two halves
   * disagree — markdown would say `3.` where the editor renders `1.` — so it is
   * a design change across the block model, not a serializer fix.
   *
   * Renumbering is lossy but IDEMPOTENT, which is why no property catches it.
   */
  it('#4076.2: an ordered list inside a blockquote renumbers from 1, and is stable', () => {
    const { once, twice } = passes('> > 3. item')
    expect(once).toBe('> > 1. item')
    expect(twice).toBe(once)
    // identical at the top level — nothing about this is blockquote-specific
    expect(passes('3. item').once).toBe('1. item')
  })

  /**
   * The OTHER half of the whitespace defuse, and the reason it cannot be
   * conditioned on a preceding list. Making a space/tab escapable (so `\ ` can
   * defuse the absorption above) also makes `\<tab>` decode — which is a way
   * to put a REAL tab at the start of a paragraph's stored text, somewhere no
   * plain markdown could put one. Emitted raw, that tab is leading whitespace
   * again and the importer rewrites it as the columns it occupies, so the pair
   * converges only on the second pass: exactly the defect these issues are
   * about, moved rather than removed. Export therefore escapes a leading
   * whitespace run containing a tab wherever the paragraph sits.
   *
   * An exhaustive sweep of every string of length ≤ 5 over
   * `{\\, space, tab, -, \n, a, >, ., 1}` (66 429 strings) finds 1 531
   * non-convergent without this arm and 0 with it.
   */
  it.each([
    ['\\\tx', '\\\tx'],
    ['\\\t- x', '\\\t- x'],
    ['\\\t> q', '\\\t> q'],
    ['\\ \tx', '\\ \tx'],
    // decoded inside a list item, where the paragraph's neighbour is not a list
    ['- a\n  \\\tx', '- a\n  \\\tx'],
    // …and inside a blockquote, where the `> ` strip runs first
    ['> \\\tx', '> \\\tx'],
    // a hardBreak puts the tab on a CONTINUATION line, which is a line too
    ['\\\n\\\t', '\\\n\\\t'],
  ])('a decoded leading tab is re-escaped: %j converges in one pass', (input, expected) => {
    const { once, twice } = passes(input)
    expect(once).toBe(expected)
    expect(twice).toBe(once)
  })

  it('a tab-leading paragraph round-trips as a DOC wherever it sits', () => {
    const tabbed = paragraph(text('\tx'))
    for (const d of [
      doc(tabbed),
      doc(paragraph(text('a')), tabbed),
      doc(blockquote(tabbed)),
      doc(bulletList(listItem(paragraph(text('a')), tabbed))),
    ]) {
      expect(parse(serialize(d))).toEqual(d)
      expect(serialize(parse(serialize(d)))).toBe(serialize(d))
    }
    // …except on a list item's MARKER line, where the tab is not a line's
    // leading whitespace at all and needs no escape.
    expect(serialize(doc(bulletList(listItem(tabbed))))).toBe('- \tx')
    expect(parse('- \tx')).toEqual(doc(bulletList(listItem(tabbed))))
  })
})

describe('#4072: a callout-shaped link at a blockquote head', () => {
  const LINK = 'https://example.com'
  const link = (t: string) => text(t, [{ type: 'link', attrs: { href: LINK } }])

  /**
   * #4072.1. A link whose visible text starts with `!` serializes to
   * `[!a](https://example.com)` — the exact shape of the `[!TYPE]` callout
   * marker with a destination glued to it. As the FIRST thing in a blockquote
   * that string was read back as a callout named `a`, so the label came out
   * upper-cased and `serializeBlockquote`'s `[!A] ` prefix put a SPACE between
   * the label and the destination, which also destroys the link
   * (`> [!a](url)a` → `> [!A] (url)a`).
   *
   * The marker and the link differ at exactly one character: a callout's `]` is
   * followed by nothing, whitespace, or its title, never by the `(` that opens
   * a link destination. `CALLOUT_RE` now refuses that one follower, so the two
   * productions no longer overlap and the link survives.
   */
  it('#4072.1: `[!a](url)` leading a blockquote stays a link, not a callout', () => {
    const d = doc(blockquote(paragraph(link('!a'), text('a'))))
    const md = serialize(d)
    expect(md).toBe('> [!a](https://example.com)a')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('#4072.1: …with the link as the whole paragraph', () => {
    const d = doc(blockquote(paragraph(link('!a'))))
    const md = serialize(d)
    expect(md).toBe('> [!a](https://example.com)')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('#4072.1: the same, reached from a string rather than a document', () => {
    // `> [](!a)` — an empty-text link whose DESTINATION is `!a` — serializes to
    // the callout-shaped `> [!a](!a)`, so it hit the same trap from the other
    // side. This is the shape the exhaustive sweep found.
    const once = serialize(parse('> [](!a)'))
    expect(once).toBe('> [!a](!a)')
    expect(serialize(parse(once))).toBe(once)
  })

  it('#4072.1: a real callout marker is untouched (only a `(` follower is refused)', () => {
    expect(parse('> [!note] title')).toEqual(doc(callout('note', paragraph(text('title')))))
    expect(parse('> [!NOTE]')).toEqual(doc(callout('note', paragraph())))
    // …and a callout whose BODY starts with such a link keeps both readings
    const d = doc(callout('info', paragraph(link('!a'), text('a'))))
    const md = serialize(d)
    expect(md).toBe('> [!INFO] [!a](https://example.com)a')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })
})

describe('#4072: whitespace at a table cell edge and the block-marker escape', () => {
  /**
   * #4072.2. A markdown cell is single-line, so a hardBreak inside one degrades
   * to a space, and the cell's own text is TRIMMED on both edges because
   * `parseTable` trims it. Those two rules used to run in the wrong order: the
   * break became a space at the NODE level, `serializeParagraph` then saw a
   * paragraph whose text began with a SPACE and so declined to escape the
   * leading block marker behind it, and only afterwards did the string `.trim()`
   * pull that space off — emitting a bare `>` (or `#`) at the cell edge. The
   * reparse stores the marker as plain text, whose own serialization DOES
   * escape it, so the second pass wrote `\>` where the first wrote `>`.
   *
   * The trim now happens at the node level, before any escaping decision, so
   * the paragraph the escape logic inspects is the one the parser will actually
   * store back. Any leading/trailing whitespace of an UNMARKED text node is in
   * scope; whitespace inside a mark's delimiters (`` `  x` ``) is content, not a
   * cell edge, and is left alone.
   */
  it.each([
    ['>', '| \\> |\n| --- |'],
    ['# x', '| \\# x |\n| --- |'],
    ['- x', '| \\- x |\n| --- |'],
    ['1. x', '| 1\\. x |\n| --- |'],
  ])('a leading hardBreak before %j is a fixpoint', (lead, expected) => {
    const d = doc(table(tableRow(tableHeader(paragraph(hardBreak(), text(lead))))))
    const md = serialize(d)
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
    // the break is gone by policy, but nothing else is
    expect(parse(md)).toEqual(doc(table(tableRow(tableHeader(paragraph(text(lead)))))))
  })

  it('the same holds for a plain leading space, which the cell also trims', () => {
    const d = doc(table(tableRow(tableHeader(paragraph(text(' >'))))))
    const md = serialize(d)
    expect(md).toBe('| \\> |\n| --- |')
    expect(serialize(parse(md))).toBe(md)
  })

  it('whitespace inside a mark is content, not a cell edge', () => {
    const d = doc(table(tableRow(tableHeader(paragraph(code(' x '))))))
    const md = serialize(d)
    // (the extra pad is CommonMark's code-span stripping rule, not a cell edge)
    expect(md).toBe('| `  x  ` |\n| --- |')
    expect(parse(md)).toEqual(d)
    expect(serialize(parse(md))).toBe(md)
  })

  it('a trailing hardBreak still keeps its neighbour unescaped', () => {
    const d = doc(table(tableRow(tableHeader(paragraph(text('$'), hardBreak())))))
    const md = serialize(d)
    expect(md).toBe('| $ |\n| --- |')
    expect(serialize(parse(md))).toBe(md)
  })

  /**
   * The same violation reached from a STRING rather than from a document — the
   * form the exhaustive sweep on this fix actually generated, and the form a
   * paste or an import arrives in. Every one of these used to alternate
   * `| > |` / `| \\> |` forever.
   */
  it.each([
    ['|\\ >', '| \\> |\n| --- |'],
    ['| \\ \\ >', '| \\> |\n| --- |'],
    ['| \\ # x |\n| --- |', '| \\# x |\n| --- |'],
  ])('the string %j converges in one pass', (input, expected) => {
    const once = serialize(parse(input))
    expect(once).toBe(expected)
    expect(serialize(parse(once))).toBe(once)
  })
})

/**
 * #4156, and #5160 N9 after it. An emphasis delimiter opening onto whitespace
 * used to be emitted as-is, and at a line start `* ` is a bullet marker, so
 * `italic(' y')` came back as a list. The first fix moved the italic's open
 * boundary past the space at a dispatched line start only. The parser now
 * reads `*`, `**`, `~~` and `==` by CommonMark flanking, so a delimiter before
 * whitespace is literal everywhere, and `fitMarksToFlanking` moves every such
 * boundary in every context. These are the #4156 shapes under that rule: each
 * converges on the first pass, and none becomes a list.
 */
describe('#4156: an emphasis span wrapping only whitespace', () => {
  const passes = (s: string) => {
    const once = serialize(parse(s))
    return { once, twice: serialize(parse(once)) }
  }

  const it_ = (t: string) => text(t, [{ type: 'italic' }])

  /**
   * The reported repro. `\ ` decodes to a space, and a `*` before whitespace
   * cannot close, so `*\ *` is literal text (as CommonMark reads it), stored
   * with both stars escaped. It was never a list, and it converges at once.
   */
  it('#4156: `*\\ *` converges on the FIRST pass, as a paragraph, not a list', () => {
    const { once, twice } = passes('*\\ *')
    expect(once).toBe('\\* \\*')
    expect(twice).toBe(once)
    expect(parse(once)).toEqual(doc(paragraph(text('* *'))))
  })

  /** The other 5 non-convergent inputs the issue's exhaustive sweep found. */
  it.each([
    [' *\\ *', ' \\* \\*'],
    // The closing `*` follows `|`, so it closes: the italic keeps the `|`.
    ['*\\ |*', ' *|*'],
    ['*\\ *`', '\\* \\*\\`'],
    ['_\\ *](x)](x)-_', ' *\\*\\](x)\\](x)-*'],
    // #5160 D2: the leading blank line is an empty paragraph, and the
    // serializer separates it from the next paragraph with a blank line.
    ['\n*\\ *', '\n\n\\* \\*'],
  ])('sibling shape %j converges on the FIRST pass', (input, expected) => {
    const { once, twice } = passes(input)
    expect(once).toBe(expected)
    expect(twice).toBe(once)
  })

  it('a whitespace-only italic doc node serializes with the mark dropped', () => {
    expect(serialize(doc(paragraph(italic(' '))))).toBe(' ')
    expect(serialize(doc(paragraph(italic('  '))))).toBe('  ')
  })

  /**
   * Not vacuous the other way: when the italic content has a non-whitespace
   * character to move the boundary onto, the mark SURVIVES — only the leading
   * whitespace itself (invisible either way) loses it.
   */
  it('an italic span starting with (but not only) whitespace keeps the mark on its content', () => {
    const d = doc(paragraph(italic(' y')))
    const md = serialize(d)
    expect(md).toBe(' *y*')
    expect(parse(md)).toEqual(doc(paragraph(text(' '), it_('y'))))
    expect(serialize(parse(md))).toBe(md)
  })

  /**
   * A plain-space PREFIX: the moved space joins it, so the line starts with
   * spaces and then an opening `*` followed by a letter, which no marker
   * production matches at any indent.
   */
  it.each([
    [1, '  *y*'],
    [2, '   *y*'],
    [3, '    *y*'],
    [4, '     *y*'],
  ])('a %i-space plain prefix before the italic is still defused', (n, expected) => {
    const md = serialize(doc(paragraph(text(' '.repeat(n)), italic(' y'))))
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
    expect((parse(md).content ?? []).map((b) => b.type)).toEqual(['paragraph'])
  })

  /**
   * …and a leading inline ATOM that serializes to nothing (#4195): a
   * whitespace-only `math_inline`, or a node of an unrecognized type, which
   * `serializeInlineChild` drops. Either is invisible at the line start.
   */
  it.each([
    ['a whitespace-only math_inline', doc(paragraph(mathInline('  '), italic(' y'))), ' *y*'],
    [
      'a mix of plain-space text and empty math atoms',
      doc(paragraph(text('  '), mathInline(' '), text(' '), italic(' y'))),
      '    *y*',
    ],
    [
      'an unrecognized inline node type',
      doc(paragraph({ type: 'video_embed' } as unknown as InlineNode, italic(' y'))),
      ' *y*',
    ],
  ])('%s before the italic is defused too', (_label, d, expected) => {
    const md = serialize(d)
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
    expect((parse(md).content ?? []).map((b) => b.type)).toEqual(['paragraph'])
  })

  /**
   * The boundary moves in every context, not just where the paragraph's text
   * starts a dispatched line: a `*` before a space is literal to the inline
   * parser wherever it sits, so a heading, a task, a list item's own
   * paragraph and a blockquote all store the same fitted span.
   */
  it.each([
    ['a blockquote child', doc(blockquote(paragraph(italic(' y')))), '>  *y*'],
    [
      "a bullet item's own leading paragraph",
      doc(bulletList(listItem(paragraph(italic(' y'))))),
      '-  *y*',
    ],
    ['an ordered item', doc(orderedList(listItem(paragraph(italic(' y'))))), '1.  *y*'],
    ['a heading', doc(heading(1, italic(' y'))), '#  *y*'],
    ["a task's checkbox marker", doc(task('TODO', italic(' y'))), '- [ ]  *y*'],
    [
      "a list item's later paragraph, whose moved space the whitespace defuse escapes (#4050)",
      doc(bulletList(listItem(paragraph(text('p')), paragraph(italic(' y'))))),
      '- p\n  \\ *y*',
    ],
  ])('%s keeps the mark on its content', (_label, d, expected) => {
    const md = serialize(d)
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
    expect(JSON.stringify(parse(md))).toContain('"text":"y","marks":[{"type":"italic"}]')
  })

  it('a whitespace-only italic in a bullet item drops the mark', () => {
    const md = serialize(doc(bulletList(listItem(paragraph(italic(' '))))))
    expect(md).toBe('-  ')
    expect(parse(md)).toEqual(doc(bulletList(listItem(paragraph(text(' '))))))
  })

  /**
   * Every flanking delimiter moves the same way; underline is a tag and code a
   * backtick span, neither of which the flanking rule reads, so both keep the
   * space inside.
   */
  it.each([
    ['bold', doc(paragraph(bold(' y'))), ' **y**'],
    ['bold+italic', doc(paragraph(boldItalic(' y'))), ' ***y***'],
    ['strike', doc(paragraph(strike(' y'))), ' ~~y~~'],
    ['highlight', doc(paragraph(highlight(' y'))), ' ==y=='],
    [
      'italic+link, whose text is read as a line of its own',
      doc(
        paragraph(
          text(' y', [
            { type: 'italic' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
      '[ *y*](https://example.com)',
    ],
    ['a leading TAB', doc(paragraph(italic('\ty'))), '\\\t*y*'],
    ['a leading NON-BREAKING space', doc(paragraph(italic(' y'))), ' *y*'],
  ])('%s opening onto whitespace is fitted', (_label, d, expected) => {
    const md = serialize(d)
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
  })

  it.each([
    ['underline', doc(paragraph(underline(' y'))), '<u> y</u>', doc(paragraph(underline(' y')))],
    [
      'italic+code, where code is exclusive',
      doc(paragraph(text(' y', [{ type: 'italic' }, { type: 'code' }]))),
      '`  y `',
      doc(paragraph(code(' y'))),
    ],
  ])('%s keeps the space inside', (_label, d, expected, reparsed) => {
    const md = serialize(d)
    expect(md).toBe(expected)
    expect(parse(md)).toEqual(reparsed)
  })

  /**
   * The boundary move carries the WHOLE italic run, not just the node it
   * starts on: the run's later nodes keep the mark, and a nested mark opening
   * inside it still emits its delimiters in the order `emitMarkTransition`
   * expects (`*y` then `**z`, closed `***`).
   */
  it('a multi-node italic run keeps every node past the moved boundary', () => {
    const d = doc(paragraph(italic(' y'), boldItalic('z')))
    const md = serialize(d)
    expect(md).toBe(' *y**z***')
    expect(parse(md)).toEqual(doc(paragraph(text(' '), it_('y'), boldItalic('z'))))
    expect(serialize(parse(md))).toBe(md)
  })

  it('an all-space first node passes the boundary to the next node in the run', () => {
    const d = doc(paragraph(italic(' '), boldItalic('z')))
    const md = serialize(d)
    expect(md).toBe(' ***z***')
    expect(parse(md)).toEqual(doc(paragraph(text(' '), boldItalic('z'))))
    expect(serialize(parse(md))).toBe(md)
  })

  /**
   * The block markers reachable from inside the moved span need no escape:
   * the line starts with a space and then a `*` that opens emphasis, so the
   * marker text is INSIDE the delimiters, where no block production sees it.
   */
  it.each([
    [' - x', ' *- x*'],
    [' 1. x', ' *1. x*'],
    [' # x', ' *# x*'],
    [' > x', ' *> x*'],
  ])('an italic wrapping the block marker %j stays inline', (t, expected) => {
    const md = serialize(doc(paragraph(italic(t))))
    expect(md).toBe(expected)
    expect(serialize(parse(md))).toBe(md)
    expect((parse(md).content ?? []).map((b) => b.type)).toEqual(['paragraph'])
  })

  /**
   * #4221: zero-length nodes in front of the space-leading italic. An empty
   * text node holds nothing but the delimiters it would emit, so the
   * serializer drops it, and an atom that emits nothing no longer closes the
   * marks around it; every shape below stores the one fitted span. The old
   * forms (`*** y*`, `***** y*`, `******* y*`) needed two passes to converge.
   */
  it.each([
    ['an empty italic TextNode', [it_('')]],
    ['several empty italic TextNodes', [it_(''), it_(''), it_('')]],
    ['an empty italic then an empty plain node', [it_(''), text('')]],
    ['an empty italic+bold node', [it_(''), text('', [{ type: 'italic' }, { type: 'bold' }])]],
    ['an empty bold-only node', [it_(''), text('', [{ type: 'bold' }])]],
    ['an empty non-text atom', [it_(''), mathInline('')]],
  ])('#4221: %s before a space-leading italic converges on the FIRST pass', (_label, lead) => {
    const md = serialize(doc(paragraph(...(lead as InlineNode[]), italic(' y'))))
    expect(md).toBe(' *y*')
    expect(parse(md)).toEqual(doc(paragraph(text(' '), it_('y'))))
    expect(serialize(parse(md))).toBe(md)
  })
})
