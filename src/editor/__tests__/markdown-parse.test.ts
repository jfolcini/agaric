/**
 * Tests for `markdown-parse.ts` behaviors not covered elsewhere.
 *
 * The bulk of `parse()` coverage lives in `markdown-serializer.test.ts` and
 * `markdown-serializer.property.test.ts`. This file pins behaviors that need
 * the logger mocked (FE-L-7: depth-limit truncation now emits a debug log).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  allStoredText,
  blockquote,
  bold,
  bulletList,
  callout,
  codeBlock,
  doc,
  hardBreak,
  heading,
  italic,
  listItem,
  orderedList,
  paragraph,
  table,
  tableCell,
  tableHeader,
  tableRow,
  task,
  text,
} from '@/editor/__tests__/builders'
import { parse } from '@/editor/markdown-parse'
import { serialize } from '@/editor/markdown-serialize'
import { logger } from '@/lib/logger'

describe('parse — depth-limit truncation (FE-L-7)', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear()
  })

  it('logs at debug level when depth exceeds MAX_PARSE_DEPTH', () => {
    // Calling parse with depth=11 directly trips the guard on the first
    // invocation, regardless of input shape.
    parse('> quoted', 11)

    expect(logger.debug).toHaveBeenCalledWith(
      'markdown-parse',
      'depth limit reached, truncating',
      expect.objectContaining({ depth: 11, maxDepth: 10, length: '> quoted'.length }),
    )
  })
})

describe('parse — GFM underscore emphasis (#211)', () => {
  it('parses _italic_ as an italic mark', () => {
    expect(parse('_italic_')).toEqual(doc(paragraph(italic('italic'))))
  })

  it('parses __bold__ as a bold mark', () => {
    expect(parse('__bold__')).toEqual(doc(paragraph(bold('bold'))))
  })

  it('leaves intraword snake_case literal (no marks)', () => {
    expect(parse('snake_case')).toEqual(doc(paragraph(text('snake_case'))))
  })

  it('leaves intraword a_b_c literal (no marks)', () => {
    expect(parse('a_b_c')).toEqual(doc(paragraph(text('a_b_c'))))
  })

  it('emphasises a word-bounded _bar_ in a sentence', () => {
    expect(parse('foo _bar_ baz')).toEqual(
      doc(paragraph(text('foo '), italic('bar'), text(' baz'))),
    )
  })

  it('handles mixed __bold__ and _italic_ in one line', () => {
    expect(parse('__bold__ and _italic_')).toEqual(
      doc(paragraph(bold('bold'), text(' and '), italic('italic'))),
    )
  })

  it('accepts both asterisk and underscore italic on one line', () => {
    expect(parse('*aster* _under_')).toEqual(
      doc(paragraph(italic('aster'), text(' '), italic('under'))),
    )
  })

  it('emphasises a standalone __dunder__ token (only word-flanked underscores stay literal)', () => {
    // Strict CommonMark: `__dunder__` opens/closes at line boundaries, so it IS
    // bold — same as `__bold__`. Only word-flanked `_` (snake_case) stays literal.
    expect(parse('__dunder__')).toEqual(doc(paragraph(bold('dunder'))))
  })

  it('reverts an unclosed _foo to literal text', () => {
    expect(parse('_foo')).toEqual(doc(paragraph(text('_foo'))))
  })

  it('reverts an unclosed __foo to literal text', () => {
    expect(parse('__foo')).toEqual(doc(paragraph(text('__foo'))))
  })

  it('serializes underscore italic back to canonical asterisk', () => {
    expect(serialize(parse('_italic_'))).toBe('*italic*')
  })

  it('serializes underscore bold back to canonical asterisk', () => {
    expect(serialize(parse('__bold__'))).toBe('**bold**')
  })

  it('serializes literal underscores WITHOUT backslash escaping', () => {
    expect(serialize(parse('snake_case'))).toBe('snake_case')
    expect(serialize(parse('a_b'))).toBe('a_b')
  })

  it('round-trips (parse∘serialize is stable) for underscore inputs', () => {
    for (const input of ['_italic_', '__bold__', 'snake_case', 'a_b_c', 'foo _bar_ baz']) {
      const once = serialize(parse(input))
      const twice = serialize(parse(once))
      expect(twice).toBe(once)
    }
  })

  it('leaves "_ italic _" literal (inner-space underscores never open/close)', () => {
    // CommonMark: a `_` followed by whitespace is not a left-flanking delimiter,
    // so it cannot open emphasis — the run stays literal plain text.
    expect(parse('_ italic _')).toEqual(doc(paragraph(text('_ italic _'))))
  })

  it('emphasises punctuation-flanked (_x_) inside parentheses', () => {
    expect(parse('(_x_)')).toEqual(doc(paragraph(text('('), italic('x'), text(')'))))
  })

  it('leaves cross-delimiter _foo* literal (never closes)', () => {
    expect(parse('_foo*')).toEqual(doc(paragraph(text('_foo*'))))
  })
})

describe('parse — bare-URL & angle autolinks (#1441)', () => {
  /** A text node carrying just a link mark (text === href is the common case). */
  const link = (t: string, href = t) => text(t, [{ type: 'link', attrs: { href } }])

  it('autolinks a bare https:// URL in text (acceptance criterion)', () => {
    expect(parse('https://example.com')).toEqual(doc(paragraph(link('https://example.com'))))
  })

  it('autolinks a bare http:// URL', () => {
    expect(parse('http://example.com')).toEqual(doc(paragraph(link('http://example.com'))))
  })

  it('autolinks a bare URL embedded in a sentence', () => {
    expect(parse('see https://example.com here')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text(' here'))),
    )
  })

  it('autolinks an <https://…> angle-bracket autolink', () => {
    expect(parse('<https://example.com>')).toEqual(doc(paragraph(link('https://example.com'))))
  })

  it('keeps a trailing period as text (GFM trailing-punctuation trim)', () => {
    expect(parse('https://example.com.')).toEqual(
      doc(paragraph(link('https://example.com'), text('.'))),
    )
  })

  it('keeps trailing sentence punctuation (comma) as text', () => {
    expect(parse('see https://example.com, ok')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text(', ok'))),
    )
  })

  it('does NOT re-link a URL already inside [text](url) syntax', () => {
    expect(parse('[text](https://example.com)')).toEqual(
      doc(paragraph(link('text', 'https://example.com'))),
    )
  })

  it('does NOT re-link a URL whose display text is the URL in [url](url)', () => {
    // The explicit link wins; the bare-URL scanner never sees the inner URL.
    expect(parse('[https://example.com](https://example.com)')).toEqual(
      doc(paragraph(link('https://example.com', 'https://example.com'))),
    )
  })

  it('does NOT autolink an intraword http (left boundary)', () => {
    expect(parse('ahttps://example.com')).toEqual(doc(paragraph(text('ahttps://example.com'))))
  })

  it('keeps a balanced trailing paren in a Wikipedia-style URL', () => {
    expect(parse('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(
      doc(paragraph(link('https://en.wikipedia.org/wiki/Foo_(bar)'))),
    )
  })

  it('does NOT autolink a URL inside a code span (backticks win)', () => {
    // scanCodeSpan runs before scanAutolink, so the URL is raw code, not a link.
    expect(parse('inline `https://example.com` only')).toEqual(
      doc(
        paragraph(text('inline '), text('https://example.com', [{ type: 'code' }]), text(' only')),
      ),
    )
  })

  it('does NOT swallow a closing bold delimiter into the href (#1441 regression)', () => {
    // The bare-URL body only hard-stops at whitespace/`<`/`\`; without trimming
    // trailing mark delimiters the URL would eat the closing `**`, leaving bold
    // unclosed (reverted to literal text). The trailing `**` must close bold and
    // the link mark must sit ON the bolded URL text.
    expect(parse('**https://example.com**')).toEqual(
      doc(
        paragraph(
          text('https://example.com', [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
    )
  })

  it('does NOT swallow a closing strike delimiter into the href (#1441)', () => {
    expect(parse('~~https://example.com~~')).toEqual(
      doc(
        paragraph(
          text('https://example.com', [
            { type: 'strike' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
    )
  })

  it('trims a trailing pipe/bracket and round-trips them as escaped text (#1441)', () => {
    // A bare URL followed by a structural delimiter (`|` table gate, `]` label
    // close) must not absorb it; the delimiter stays literal text. The serializer
    // escapes it (`\|`/`\]`) and the bare-URL scanner hard-stops at the `\`, so
    // the next parse re-globs the URL identically (idempotent, no escape pileup).
    expect(parse('see https://example.com| end')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text('| end'))),
    )
    expect(parse('see https://example.com] end')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text('] end'))),
    )
    for (const input of [
      'see https://example.com| end',
      'see https://example.com] end',
      'https://example.com/path*glob*',
      '**https://example.com**',
      '~~https://example.com~~',
    ]) {
      const once = serialize(parse(input))
      expect(serialize(parse(once))).toBe(once)
    }
  })

  it('round-trips (parse→serialize) bare and angle autolinks losslessly', () => {
    // A bare URL stays bare (not `[url](url)`); an angle autolink normalizes to
    // the bare URL (the serializer's canonical, link-preserving form).
    expect(serialize(parse('https://example.com'))).toBe('https://example.com')
    expect(serialize(parse('see https://example.com here'))).toBe('see https://example.com here')
    expect(serialize(parse('https://example.com.'))).toBe('https://example.com.')
    expect(serialize(parse('<https://example.com>'))).toBe('https://example.com')
    expect(serialize(parse('[text](https://example.com)'))).toBe('[text](https://example.com)')

    // parse∘serialize is a stable fixed point for each.
    for (const input of [
      'https://example.com',
      'see https://example.com here',
      'https://example.com.',
      '<https://example.com>',
      '[text](https://example.com)',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]) {
      const once = serialize(parse(input))
      expect(serialize(parse(once))).toBe(once)
    }
  })
})

describe('parse — GFM task lists (#1435)', () => {
  it('parses "- [ ] a" as a TODO task block', () => {
    expect(parse('- [ ] a')).toEqual(doc(task('TODO', text('a'))))
  })

  it('parses "- [x] b" as a DONE task block', () => {
    expect(parse('- [x] b')).toEqual(doc(task('DONE', text('b'))))
  })

  it('parses "- [/] c" as a DOING task block', () => {
    expect(parse('- [/] c')).toEqual(doc(task('DOING', text('c'))))
  })

  it('parses "- [-] d" as a CANCELLED task block', () => {
    expect(parse('- [-] d')).toEqual(doc(task('CANCELLED', text('d'))))
  })

  it('does NOT turn a plain bullet into a task', () => {
    expect(parse('- item')).toEqual(doc(bulletList(listItem(paragraph(text('item'))))))
  })

  it('imports a multi-item GFM task list', () => {
    expect(parse('- [ ] one\n- [x] two')).toEqual(
      doc(task('TODO', text('one')), task('DONE', text('two'))),
    )
  })

  it('round-trips each state through serialize→parse', () => {
    for (const state of ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const) {
      const original = doc(task(state, text('x')))
      expect(parse(serialize(original))).toEqual(original)
    }
  })
})

describe('parse — list-item hard breaks (#1885)', () => {
  it('keeps a hard-break continuation inside the SAME list-item paragraph', () => {
    // `- foo\` (odd trailing backslash) + `bar` on the next line is one item
    // whose paragraph holds [text "foo", hardBreak, text "bar"] — NOT two blocks.
    expect(parse('- foo\\\nbar')).toEqual(
      doc(bulletList(listItem(paragraph(text('foo'), hardBreak(), text('bar'))))),
    )
  })

  it('keeps TWO hard breaks inside one list-item paragraph', () => {
    expect(parse('- a\\\nb\\\nc')).toEqual(
      doc(
        bulletList(listItem(paragraph(text('a'), hardBreak(), text('b'), hardBreak(), text('c')))),
      ),
    )
  })

  it('keeps a hard break followed by a nested sub-list in the same item', () => {
    expect(parse('- foo\\\nbar\n  - baz')).toEqual(
      doc(
        bulletList(
          listItem(
            paragraph(text('foo'), hardBreak(), text('bar')),
            bulletList(listItem(paragraph(text('baz')))),
          ),
        ),
      ),
    )
  })

  it('keeps a hard break inside an ordered-list item', () => {
    expect(parse('1. foo\\\nbar')).toEqual(
      doc(orderedList(listItem(paragraph(text('foo'), hardBreak(), text('bar'))))),
    )
  })

  it('still splits a plain (no-backslash) continuation into a top-level paragraph', () => {
    // Regression guard: without the trailing backslash, `bar` is its own block.
    expect(parse('- foo\nbar')).toEqual(
      doc(bulletList(listItem(paragraph(text('foo')))), paragraph(text('bar'))),
    )
  })

  it('round-trips list-item hard breaks losslessly (serialize∘parse is identity)', () => {
    for (const md of ['- foo\\\nbar', '- a\\\nb\\\nc', '- foo\\\nbar\n  - baz', '1. foo\\\nbar']) {
      expect(serialize(parse(md))).toBe(md)
      // …and the structure is stable through a second round-trip.
      expect(parse(serialize(parse(md)))).toEqual(parse(md))
    }
  })
})

// -- #2209: disallowed link schemes are stripped at parse time ----------------
// A markdown link mark whose href carries a blocked scheme (javascript:, file:,
// data:, …) must never enter stored content — markdown import / peer sync bypass
// the input-time `validate` guard. `consumeExternalLink` drops the link mark and
// keeps the visible display text, so hostile URLs never reach `openUrl`.
describe('parse — disallowed link scheme normalization (#2209)', () => {
  it('strips a javascript: link mark, keeping the display text', () => {
    expect(parse('[click](javascript:alert(1))')).toEqual(doc(paragraph(text('click'))))
  })

  it('strips a file: link mark, keeping the display text', () => {
    expect(parse('[secret](file:///etc/passwd)')).toEqual(doc(paragraph(text('secret'))))
  })

  it('strips a data: link mark, keeping the display text', () => {
    expect(parse('[x](data:text/html,hi)')).toEqual(doc(paragraph(text('x'))))
  })

  it('preserves the display formatting while dropping a blocked link', () => {
    expect(parse('[**bold**](javascript:x)')).toEqual(doc(paragraph(bold('bold'))))
  })

  it('keeps an allowed https: link mark intact', () => {
    expect(parse('[ok](https://example.com)')).toEqual(
      doc(paragraph(text('ok', [{ type: 'link', attrs: { href: 'https://example.com' } }]))),
    )
  })
})

// -- #3274: a pasted table's separator line must not render as a blank block --
// pasteBlocks/parseIndentedMarkdown splits pasted markdown one block per LINE,
// so a pasted GFM table's `| --- | --- |` line lands in its OWN block and is
// parsed in isolation via this top-level `parse()`. It used to come back as a
// content-less doc (`{ type: 'doc' }`, no `content` key) — StaticBlock then had
// nothing to render and the block stayed permanently blank even though the
// source markdown was intact in storage.
describe('parse — a lone table-separator line pasted as its own block (#3274)', () => {
  it('is not blank: it parses as a one-row table (the delimiter row has no header above it to belong to)', () => {
    const result = parse('| --- | --- |')
    expect(result.content).toBeDefined()
    expect(result.content?.length).toBeGreaterThan(0)
    expect(result).toEqual(
      doc(
        table(tableRow(tableHeader(paragraph(text('---'))), tableHeader(paragraph(text('---'))))),
      ),
    )
  })
})

// -- #4003: an ambiguous dash-only row 1 in FOREIGN markdown --------------
// #3274 made the delimiter test POSITIONAL (only row 1 can be a separator),
// which is correct for markdown we produced ourselves: `serializeTable`
// always synthesizes `[header, separator, …data]`, so a real data row can
// never land at index 1. Foreign markdown carries no such guarantee — a
// table that never had a delimiter row, whose FIRST row of data happens to
// be dash-only, had that row read as the separator and dropped.
//
// The discriminator is the cell SHAPE, not its width: every legal GFM
// delimiter cell (`:?-+:?`) is honoured, and the sole carve-out is the row
// whose every cell is a bare `-` with nothing following it — the one form that
// reads equally well as a placeholder value. The boundary itself is pinned
// shape by shape in the describe below this one.
describe('parse — an ambiguous dash-only row 1 in foreign markdown (#4003)', () => {
  it('keeps a short-dash row 1 as DATA when nothing follows it', () => {
    // The reported shape. Both rows are the user's content; dropping row 1
    // silently destroyed half the pasted table.
    expect(parse('| Name | Value |\n| - | - |')).toEqual(
      doc(
        table(
          tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
          // Also pins the #4019 marker-tolerance interaction: a `-` cell is a
          // bullet-marker SHAPE, but cell text is parsed inline (`parseLine`),
          // never through the block productions, so it stays literal text and
          // does not become a `bulletList`.
          tableRow(tableCell(paragraph(text('-'))), tableCell(paragraph(text('-')))),
        ),
      ),
    )
  })

  it('the kept row survives serialization (a canonical delimiter is synthesized)', () => {
    const reparsed = parse('| Name | Value |\n| - | - |')
    const md = serialize(reparsed)
    expect(md).toBe('| Name | Value |\n| --- | --- |\n| - | - |')
    // Fixed point: the synthesized `---` is now at index 1, so the kept row
    // sits at index 2 where #3274's positional rule already protects it.
    expect(parse(md)).toEqual(reparsed)
    expect(serialize(parse(md))).toBe(md)
  })

  // The two arms below are the counterweight: without them the fix could
  // "pass" by never treating any row as a delimiter.
  it('still reads a CANONICAL `---` row 1 as the delimiter (our header-only table)', () => {
    expect(parse('| a |\n| --- |')).toEqual(doc(table(tableRow(tableHeader(paragraph(text('a')))))))
  })

  it('still reads a SHORT-dash row 1 as the delimiter when data rows follow it', () => {
    expect(parse('| Name | Value |\n| - | - |\n| a | b |')).toEqual(
      doc(
        table(
          tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
          tableRow(tableCell(paragraph(text('a'))), tableCell(paragraph(text('b')))),
        ),
      ),
    )
  })

  it('still reads an ALIGNED short-dash row 1 as the delimiter when data follows', () => {
    expect(parse('| Name | Value |\n| :- | -: |\n| a | b |')).toEqual(
      doc(
        table(
          tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value')))),
          tableRow(tableCell(paragraph(text('a'))), tableCell(paragraph(text('b')))),
        ),
      ),
    )
  })
})

// -- The delimiter/data boundary at row 1, pinned per SHAPE ------------------
// #4003's carve-out is narrow and the exact width of it matters, because both
// sides of the boundary are silent: too wide and a delimiter the author wrote
// renders as a junk data row; too narrow and a real data row is dropped.
//
// The rule `isSeparatorRow` implements: row 1 is the delimiter when EVERY cell
// is a legal GFM delimiter cell (optional colons around ONE or more dashes) —
// unless reading it as the delimiter would leave the table with no data at all
// AND the row is the single shape that reads equally well as content: every
// cell exactly `-`. Dash WIDTH is not the discriminator, so `--`, mixed widths
// and any colon-carrying form stay delimiters even in a two-line table.
describe('parse — the delimiter/data boundary at table row 1', () => {
  const HEADER = '| Name | Value |'
  const headerRow = () =>
    tableRow(tableHeader(paragraph(text('Name'))), tableHeader(paragraph(text('Value'))))
  const dataRow = (a: string, b: string) =>
    tableRow(tableCell(paragraph(text(a))), tableCell(paragraph(text(b))))

  // Every legal delimiter shape EXCEPT the minimal `-`-per-cell one. With
  // nothing following, each of these is a header-only table: honouring the
  // delimiter is what the author wrote, and keeping it would render a visible
  // junk row of dashes.
  const UNAMBIGUOUS_DELIMITERS: readonly [string, string][] = [
    ['2 dashes', '| -- | -- |'],
    ['3 dashes — canonical, what our own serializer emits', '| --- | --- |'],
    ['more than 3 dashes', '| ----- | ----- |'],
    ['mixed widths', '| --- | - |'],
    ['mixed widths, reversed', '| - | --- |'],
    ['left/right aligned short form', '| :- | -: |'],
    ['centre/right aligned canonical', '| :---: | ---: |'],
    ['a single colon-carrying cell alongside a bare dash', '| :- | - |'],
  ]

  it.each(UNAMBIGUOUS_DELIMITERS)(
    'row 1 (%s) is the delimiter even with NO rows following',
    (_shape, delimiter) => {
      expect(parse(`${HEADER}\n${delimiter}`)).toEqual(doc(table(headerRow())))
    },
  )

  it.each([...UNAMBIGUOUS_DELIMITERS, ['1 dash', '| - | - |'] as [string, string]])(
    'row 1 (%s) is the delimiter when a data row FOLLOWS',
    (_shape, delimiter) => {
      expect(parse(`${HEADER}\n${delimiter}\n| a | b |`)).toEqual(
        doc(table(headerRow(), dataRow('a', 'b'))),
      )
    },
  )

  it('the ONE exception — every cell exactly `-`, nothing following — is DATA (#4003)', () => {
    expect(parse(`${HEADER}\n| - | - |`)).toEqual(doc(table(headerRow(), dataRow('-', '-'))))
  })

  it('honours a delimiter written without the closing pipe, which GFM also allows', () => {
    // The rule is now per-CELL, so it no longer needs the row to end in `|` —
    // the previous whole-row shape regex did, and rejected this legal form.
    expect(parse('| Name | Value\n| --- | ---')).toEqual(doc(table(headerRow())))
  })

  it('a row of EMPTY cells is data — no cell carries a dash, so no cell is a delimiter (#3274)', () => {
    const result = parse(`${HEADER}\n|  |  |`)
    const block = result.content?.[0]
    const rows = block?.type === 'table' ? block.content : undefined
    expect(rows).toHaveLength(2)
    // An empty cell parses to `content: []`, which no builder emits, so this
    // arm asserts the shape directly rather than via `toEqual(doc(…))`.
    expect(rows?.[1]?.content?.map((cell) => cell.content)).toEqual([[], []])
  })

  // An EMPTY cell alongside dash cells is a MALFORMED delimiter (GFM wants one
  // cell per header column), not data — nobody writes `---` as a value. So an
  // empty cell neither qualifies nor disqualifies the row: the DASH cells
  // decide it, and the row of ONLY empty cells above still has no dash cell to
  // decide with, so it stays data.
  const SHORT_DELIMITERS: readonly [string, string][] = [
    ['a trailing empty cell', '| --- |  |'],
    ['a leading empty cell', '|  | --- |'],
    ['an empty cell beside an aligned cell', '| :---: |  |'],
  ]

  it.each(SHORT_DELIMITERS)(
    'row 1 (%s) is a malformed DELIMITER, not a junk data row, with NO rows following',
    (_shape, delimiter) => {
      expect(parse(`${HEADER}\n${delimiter}`)).toEqual(doc(table(headerRow())))
    },
  )

  it.each(SHORT_DELIMITERS)(
    'row 1 (%s) is a malformed DELIMITER, not a junk data row, when a data row FOLLOWS',
    (_shape, delimiter) => {
      expect(parse(`${HEADER}\n${delimiter}\n| a | b |`)).toEqual(
        doc(table(headerRow(), dataRow('a', 'b'))),
      )
    },
  )

  it('a bare-dash cell beside an empty one, nothing following, is still DATA (#4003)', () => {
    // The ambiguity carve-out judges the cells that carry dashes: every one of
    // them is a bare `-`, so the placeholder reading wins as it does for
    // `| - | - |`, and the row is kept rather than leaving an empty table.
    const result = parse(`${HEADER}\n| - |  |`)
    const block = result.content?.[0]
    const rows = block?.type === 'table' ? block.content : undefined
    expect(rows).toHaveLength(2)
    expect(rows?.[1]?.content?.map((cell) => cell.content)).toEqual([[paragraph(text('-'))], []])
  })

  it('a row of EMPTY cells stays data even when rows FOLLOW it (#3274)', () => {
    const result = parse(`${HEADER}\n|  |  |\n| a | b |`)
    const block = result.content?.[0]
    const rows = block?.type === 'table' ? block.content : undefined
    expect(rows).toHaveLength(3)
    expect(rows?.[1]?.content?.map((cell) => cell.content)).toEqual([[], []])
  })
})

// -- #4051: CRLF line endings -------------------------------------------------
// `parse` splits the document into lines, and every block production is
// anchored `^…$` against one of them. A `\r` left on the end of a line by a
// Windows-written document therefore defeats the production that should have
// matched it — and, worse, lands INSIDE a stored text node, so it survives into
// the database and back out.
//
// The rule: a CR that is part of a CRLF pair (or a CR in line-ending position
// at end of input) is a LINE ENDING and is consumed as one; a CR anywhere else
// is ordinary content and is preserved verbatim.

/**
 * One document per block production, written with LF. Each is re-issued with
 * CRLF endings and must parse to the IDENTICAL document — the productions are
 * `^…$`-anchored, so this is the arm that fails today.
 */
const LF_CORPUS: readonly [string, string][] = [
  ['a bullet list', '- a\n- b'],
  ['a nested bullet list', '- parent\n  - child'],
  ['an ordered list', '1. a\n2. b'],
  ['a task list', '- [ ] a\n- [x] b'],
  ['a heading then a paragraph', '# h\n\ntext'],
  ['a blockquote', '> quoted\n> more'],
  ['a callout', '> [!note] title\n> body'],
  ['a fenced code block', '```ts\nconst a = 1\n```'],
  ['a math block', '$$\nE = mc^2\n$$'],
  ['a table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['a horizontal rule', 'a\n\n---\n\nb'],
  ['a hard break', 'a\\\nb'],
  ['two paragraphs', 'a\n\nb'],
]

describe('parse — CRLF line endings (#4051)', () => {
  it.each(LF_CORPUS)('%s parses identically with CRLF endings', (_name, lf) => {
    expect(parse(lf.replaceAll('\n', '\r\n'))).toEqual(parse(lf))
  })

  it.each(LF_CORPUS)('%s stores no CR in any text node', (_name, lf) => {
    const stored = allStoredText(parse(lf.replaceAll('\n', '\r\n')))
    expect(stored.filter((t) => t.includes('\r'))).toEqual([])
  })

  it.each(LF_CORPUS)('%s serializes identically from either ending', (_name, lf) => {
    expect(serialize(parse(lf.replaceAll('\n', '\r\n')))).toBe(serialize(parse(lf)))
  })

  it('a CRLF bullet list is a list, not an escaped literal paragraph', () => {
    expect(parse('- a\r\n- b')).toEqual(
      doc(bulletList(listItem(paragraph(text('a'))), listItem(paragraph(text('b'))))),
    )
  })

  it('a CRLF nested list nests', () => {
    expect(parse('- parent\r\n  - child')).toEqual(
      doc(
        bulletList(
          listItem(paragraph(text('parent')), bulletList(listItem(paragraph(text('child'))))),
        ),
      ),
    )
  })

  it('a CRLF document with no trailing newline drops the final CR', () => {
    // A caller that pre-split the file on `\n` hands the last block exactly
    // this shape (`- b\r`); it is a line ending with no `\n` to pair with.
    expect(parse('- a\r\n- b\r')).toEqual(parse('- a\n- b'))
  })

  // The other arm: a CR that is NOT in line-ending position is content. We do
  // NOT follow CommonMark §2.3 (which makes a lone CR a line ending) — in a
  // document written this decade a stray CR is far likelier to be a control
  // char somebody pasted than a classic-Mac line break, and turning it into a
  // block boundary would be an unrecoverable rewrite of the user's text.
  it('a lone CR inside inline text is preserved, not eaten', () => {
    expect(parse('a\rb')).toEqual(doc(paragraph(text('a\rb'))))
  })

  it('a lone CR does not stop a line from being a list marker', () => {
    // `.` excludes `\r` in JavaScript, so a content matcher written `.` makes a
    // marker line unmatchable the moment it holds a lone CR. Content matchers
    // are `[^\n]` for exactly that reason.
    expect(parse('- a\rb')).toEqual(doc(bulletList(listItem(paragraph(text('a\rb'))))))
  })

  it('a lone CR in a callout title is preserved, not truncated away', () => {
    // `CALLOUT_RE` is the one production that is not anchored at the end, so a
    // `.`-matched title there does not merely fail to match on a lone CR — it
    // matches the PREFIX, and `extractCalloutType` overwrites the quote line
    // with that prefix, silently dropping everything from the CR onward. Its
    // title matcher is `[^\n]` for that reason, and the separator after `]` is
    // a space/tab rather than `\s` so it cannot swallow a leading CR either.
    expect(parse('> [!note] a\rb')).toEqual(doc(callout('note', paragraph(text('a\rb')))))
  })

  it('a lone CR immediately after a callout marker is content, not the separator', () => {
    expect(parse('> [!note]\rb')).toEqual(doc(callout('note', paragraph(text('\rb')))))
  })

  it('a lone CR survives serialize(parse(·)) unchanged', () => {
    expect(serialize(parse('a\rb'))).toBe('a\rb')
  })
})

// -- #4052: tab-indented lists ------------------------------------------------
// Indentation is measured in COLUMNS, not characters: a tab advances to the
// next 4-column tab stop (CommonMark §2.2). Two consequences worth stating
// because they are not obvious:
//
//  - A tab anywhere in a line's LEADING whitespace always lands the content at
//    column ≥ 4, because a tab at column c < 4 advances to exactly 4. So the
//    marker-indent tolerance (`MAX_MARKER_INDENT` = 3, spelled ` {0,3}` in
//    every marker regex) is ALREADY the exact column rule — a tab-indented
//    marker is not a marker, and the marker regexes need no `\t`.
//  - What makes a tab-indented SUB-list work is the dedent: `collectListItem`
//    strips one content column (2), which consumes half of the tab and leaves
//    2 residual columns, landing the child inside that same tolerance. The
//    tolerance is the single knob deciding both arms.

describe('parse — tab-indented lists (#4052)', () => {
  const parentWithChild = doc(
    bulletList(listItem(paragraph(text('parent')), bulletList(listItem(paragraph(text('child')))))),
  )

  it('a tab-indented sub-list nests', () => {
    expect(parse('- parent\n\t- child')).toEqual(parentWithChild)
  })

  it('a tab-indented sub-list parses as its 4-space twin does', () => {
    expect(parse('- parent\n\t- child')).toEqual(parse('- parent\n    - child'))
  })

  // THE BOUNDARY OF THE APPROXIMATION, pinned rather than left to be
  // discovered. `dedentColumns` leaves everything from the first non-whitespace
  // char verbatim — that is what keeps a tab inside fenced code content intact
  // — so a leading run that MIXES spaces and tabs across the dedent boundary
  // hands the recursion a tab whose stop is now counted from the dedented
  // column 0 instead of the document column. Strict CommonMark reads `  \t` as
  // 4 columns, i.e. 2 past the item's content column, which lands inside the
  // marker tolerance and makes a sublist; we read the surviving tab as 4
  // columns from the new base, which is past it, so the line stays the item's
  // continuation content. Fixing this needs the absolute column threaded
  // through the recursion AND the marker productions taught to measure
  // indentation in columns; the alternative that is cheap — materializing the
  // rest of the leading run as spaces — silently rewrites a tab-indented line
  // of a code block nested in a list item, which #4052 explicitly forbids.
  // Every PURE-tab indent (the shape foreign outliners actually emit) is exact.
  it('a leading run mixing spaces and tabs stays continuation content', () => {
    // (The residue is stored as columns, not as the raw tab — see the
    // leading-indent normalization pinned at the end of this block.)
    const withResidue = doc(
      bulletList(listItem(paragraph(text('parent')), paragraph(text('    - child')))),
    )
    expect(parse('- parent\n  \t- child')).toEqual(withResidue)
    expect(parse('- parent\n   \t- child')).toEqual(withResidue)
  })

  it('a tab-indented sub-list is a fixpoint after import', () => {
    const once = serialize(parse('- parent\n\t- child'))
    expect(once).toBe('- parent\n  - child')
    expect(serialize(parse(once))).toBe(once)
  })

  it('tab nesting composes to three levels', () => {
    expect(parse('- a\n\t- b\n\t\t- c')).toEqual(parse('- a\n    - b\n        - c'))
    expect(parse('- a\n\t- b\n\t\t- c')).toEqual(
      doc(
        bulletList(
          listItem(
            paragraph(text('a')),
            bulletList(listItem(paragraph(text('b')), bulletList(listItem(paragraph(text('c')))))),
          ),
        ),
      ),
    )
  })

  it('an ordered and a task sub-list nest under a tab too', () => {
    expect(parse('- parent\n\t1. child')).toEqual(
      doc(
        bulletList(
          listItem(paragraph(text('parent')), orderedList(listItem(paragraph(text('child'))))),
        ),
      ),
    )
    expect(parse('- parent\n\t- [x] child')).toEqual(
      doc(bulletList(listItem(paragraph(text('parent')), task('DONE', text('child'))))),
    )
  })

  // The other arm: past the tolerance, a tab is not structure — the line stays
  // a paragraph / the item's continuation content, never a marker.
  it('a top-level tab-indented marker is not a marker — a tab is 4 columns', () => {
    expect(parse('\t- x')).toEqual(parse('    - x'))
    expect(parse('\t- x')).toEqual(doc(paragraph(text('    - x'))))
  })

  it('a doubly-tab-indented line stays continuation content, not a sub-list', () => {
    // 8 columns; one content column of dedent leaves ≥ 4, past the tolerance.
    expect(parse('- p\n\t\t- deep')).toEqual(
      doc(bulletList(listItem(paragraph(text('p')), paragraph(text('    - deep'))))),
    )
  })

  // A paragraph is the one production that keeps a line's indentation as
  // stored TEXT, so that indentation — and only it — is normalized to columns:
  // otherwise a tab-indented paragraph has no fixed point at all, because
  // `collectListItem` captures it as a preceding item's continuation and
  // dedents the tab away while the serializer re-emits the indent as spaces.
  it('a paragraph stores its indentation as columns', () => {
    expect(parse('\tx')).toEqual(doc(paragraph(text('    x'))))
    expect(parse('  \tx')).toEqual(doc(paragraph(text('    x'))))
    expect(serialize(parse('\tx'))).toBe('    x')
    expect(serialize(parse(serialize(parse('\tx'))))).toBe('    x')
  })

  // Tabs that are not indentation are preserved verbatim — this is what keeps
  // the normalization out of the interior of fenced code blocks without the
  // parser needing to know where a fence is.
  it('a tab inside inline text is untouched', () => {
    expect(parse('a\tb')).toEqual(doc(paragraph(text('a\tb'))))
    expect(serialize(parse('a\tb'))).toBe('a\tb')
  })

  it('tab-indented fenced code content is untouched at the top level', () => {
    expect(parse('```\n\tcode\n```')).toEqual(doc(codeBlock('\tcode')))
  })

  it('tab-indented fenced code content is untouched inside a list item', () => {
    expect(parse('- item\n  ```\n  \tcode\n  ```')).toEqual(
      doc(bulletList(listItem(paragraph(text('item')), codeBlock('\tcode')))),
    )
  })

  it('a tab-indented list inside a blockquote nests', () => {
    expect(parse('> - parent\n> \t- child')).toEqual(
      doc(blockquote(...(parentWithChild.content ?? []))),
    )
  })

  it('a tab-indented heading is not a heading — its production is at column 0', () => {
    expect(parse('\t# h')).toEqual(doc(paragraph(text('    # h'))))
    expect(parse('# h')).toEqual(doc(heading(1, text('h'))))
  })
})
