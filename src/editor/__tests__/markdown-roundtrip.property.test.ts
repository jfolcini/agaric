/**
 * Property-based round-trip fixpoint tests for the markdown serializer
 * (fast-check), complementing `markdown-serializer.property.test.ts`.
 *
 * That suite fuzzes markdown STRINGS and paragraph-only docs; this one
 * generates random DOCUMENTS from the editor's full block/inline vocabulary —
 * headings, tasks, tables, blockquotes/callouts, lists (with task paragraphs
 * and nesting), code/math blocks, and every inline node kind including
 * hardBreak, math_inline, image and the ref atoms — and pins the storage
 * invariant behind the round-trip fidelity fixes:
 *
 *   serialize(doc) is ALREADY the canonical stored form — reparsing it and
 *   serializing again must be byte-identical (fixpoint), or the drift silently
 *   rewrites content on every open/close cycle.
 *
 * The generators are seeded (fast-check `examples`) with the fixed audit
 * shapes: hardBreak in table cells / headings / tasks, math_inline + digit
 * seam, cross-node `$` seam, `$`/edge-whitespace latex, literal `((ULID))`
 * text, adjacent sibling blockquotes/tables, and the task-in-listItem
 * `- - [ ]` shape.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  blockRef,
  blockquote,
  bold,
  bulletList,
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
import type {
  BlockLevelNode,
  BlockquoteNode,
  CodeBlockNode,
  DocNode,
  HeadingNode,
  InlineNode,
  ListItemNode,
  MathBlockNode,
  ParagraphNode,
  PMMark,
  TableNode,
  TodoState,
} from '@/editor/types'

// -- Configuration ------------------------------------------------------------

/**
 * Runs per property. Lower than the 500 of the string-fuzzing suite: each run
 * here builds and round-trips a full multi-block document.
 */
const NUM_RUNS = 300

// -- Generators ---------------------------------------------------------------

/**
 * Text alphabet: the mark/block delimiters of the locked grammar PLUS the
 * `$` / `!` / digit / paren chars behind the seam-escape fixes, so the
 * fixpoint property keeps re-exploring exactly the collision space the audit
 * findings came from.
 */
const INTERESTING_CHARS = 'abX 012*`#[\\]()_|~=<>u$!'

const arbText: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...INTERESTING_CHARS.split('')), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''))

/** Uppercase ULID (26 Crockford base32 chars). */
const arbUlid: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('')), {
    minLength: 26,
    maxLength: 26,
  })
  .map((chars) => chars.join(''))

const LINK_HREFS: readonly string[] = [
  'https://example.com',
  'https://a.com/path?q=1&x=2',
  'https://ex.com/page(1)',
]

/** A mark set (code exclusive, matching the serializer's contract). */
const arbMarks: fc.Arbitrary<PMMark[]> = fc
  .tuple(
    fc.subarray([
      { type: 'bold' } as PMMark,
      { type: 'italic' } as PMMark,
      { type: 'strike' } as PMMark,
      { type: 'highlight' } as PMMark,
      { type: 'underline' } as PMMark,
      { type: 'code' } as PMMark,
    ]),
    fc.option(fc.constantFrom(...LINK_HREFS), { nil: undefined }),
  )
  .map(([marks, href]) => {
    if (marks.some((m) => m.type === 'code')) return marks.filter((m) => m.type === 'code')
    return href === undefined ? marks : marks.concat({ type: 'link', attrs: { href } } as PMMark)
  })

const arbTextNode: fc.Arbitrary<InlineNode> = fc.tuple(arbText, arbMarks).map(([t, marks]) => {
  const node = { type: 'text' as const, text: t }
  return marks.length > 0 ? Object.assign({}, node, { marks }) : node
})

/**
 * math_inline latex: includes edge spaces, leading digits, `$` and backslashes
 * — exactly the shapes the latex sanitizer must defuse. Whitespace-only latex
 * is excluded: it emits NOTHING (pinned example-based), which can leave two
 * delimiter-wrapped neighbours (e.g. code spans) string-adjacent — an
 * invisible degenerate atom with no canonical string form of its own.
 */
const arbMathInline: fc.Arbitrary<InlineNode> = fc
  .array(fc.constantFrom(...'ab01 ^_\\$+='.split('')), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''))
  .filter((latex) => latex.trim() !== '')
  .map((latex) => ({ type: 'math_inline' as const, attrs: { latex } }))

const arbImage: fc.Arbitrary<InlineNode> = fc
  .tuple(arbText, fc.constantFrom(...LINK_HREFS))
  .map(([alt, src]) => ({ type: 'image' as const, attrs: { alt, src } }))

const arbInlineNode: fc.Arbitrary<InlineNode> = fc.oneof(
  { weight: 6, arbitrary: arbTextNode },
  { weight: 1, arbitrary: arbUlid.map((id) => ({ type: 'tag_ref' as const, attrs: { id } })) },
  { weight: 1, arbitrary: arbUlid.map((id) => ({ type: 'block_link' as const, attrs: { id } })) },
  { weight: 1, arbitrary: arbUlid.map((id) => ({ type: 'block_ref' as const, attrs: { id } })) },
  { weight: 2, arbitrary: arbMathInline },
  { weight: 1, arbitrary: arbImage },
  { weight: 1, arbitrary: fc.constant({ type: 'hardBreak' } as InlineNode) },
)

/** Order-insensitive signature of a mark set (for adjacency merging). */
function marksKey(marks: readonly PMMark[] | undefined): string {
  return [...(marks ?? [])]
    .map((m) => JSON.stringify(m))
    .toSorted()
    .join('|')
}

/**
 * Merge adjacent text nodes carrying identical marks — the parser-canonical
 * form (both the parser and a live PM doc coalesce them). Without this the
 * generator can build docs no editor produces, e.g. `code('a') + code('a')`,
 * which serialize as two separate backtick spans but reparse as one.
 */
function mergeAdjacentSameMarkText(content: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = []
  for (const node of content) {
    const last = merged.at(-1)
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      marksKey(last.marks) === marksKey(node.marks)
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + node.text }
    } else {
      merged.push(node)
    }
  }
  return merged
}

const arbInlineContent: fc.Arbitrary<InlineNode[]> = fc
  .array(arbInlineNode, { minLength: 1, maxLength: 5 })
  .map(mergeAdjacentSameMarkText)

const TODO_STATES: readonly TodoState[] = ['TODO', 'DOING', 'DONE', 'CANCELLED']

/**
 * KNOWN pre-existing exclusion (#1436, mirrored from the existing suite's
 * `paragraphStartsWithAmbiguousSyntax`): an italic whose text begins with a
 * space lands a bare `* ` at column 0 (`italic(' a')` → `* a*`). Emphasis
 * opening onto whitespace has no representation in this grammar, so such a
 * paragraph reparses as a bulletList wherever block dispatch runs (top level,
 * blockquote children). Probed via the production serializer so the check
 * cannot drift from the emission logic.
 */
function startsWithDelimiterBulletMarker(p: ParagraphNode): boolean {
  return serialize({ type: 'doc', content: [p] }).startsWith('* ')
}

/** A paragraph, occasionally carrying a todoState (a task block, #1435). */
const arbParagraph: fc.Arbitrary<ParagraphNode> = fc
  .tuple(arbInlineContent, fc.option(fc.constantFrom(...TODO_STATES), { nil: undefined }))
  .map(
    ([content, todoState]): ParagraphNode =>
      todoState === undefined
        ? { type: 'paragraph' as const, content }
        : { type: 'paragraph' as const, attrs: { todoState }, content },
  )
  .filter((p) => !startsWithDelimiterBulletMarker(p))

const arbPlainParagraph: fc.Arbitrary<ParagraphNode> = arbInlineContent
  .map((content): ParagraphNode => ({ type: 'paragraph' as const, content }))
  .filter((p) => !startsWithDelimiterBulletMarker(p))

const arbHeading: fc.Arbitrary<HeadingNode> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), arbInlineContent)
  .map(([level, content]) => ({ type: 'heading' as const, attrs: { level }, content }))

const arbCodeBlock: fc.Arbitrary<CodeBlockNode> = fc
  .tuple(
    fc
      .array(
        fc
          .array(fc.constantFrom(...'ab 01`'.split('')), { minLength: 0, maxLength: 6 })
          .map((chars) => chars.join('')),
        { minLength: 1, maxLength: 3 },
      )
      .map((lines) => lines.join('\n')),
    fc.option(fc.constantFrom('js', 'python'), { nil: undefined }),
  )
  .map(([code, language]) => {
    const attrs = language === undefined ? undefined : { language }
    if (code.length === 0) {
      return attrs ? { type: 'codeBlock' as const, attrs } : { type: 'codeBlock' as const }
    }
    return attrs
      ? { type: 'codeBlock' as const, attrs, content: [{ type: 'text' as const, text: code }] }
      : { type: 'codeBlock' as const, content: [{ type: 'text' as const, text: code }] }
  })

const arbBlockquote: fc.Arbitrary<BlockquoteNode> = fc
  .tuple(
    fc.array(arbPlainParagraph, { minLength: 1, maxLength: 2 }),
    fc.option(fc.constantFrom('info', 'warning'), { nil: undefined }),
  )
  .map(([content, calloutType]) =>
    calloutType === undefined
      ? { type: 'blockquote' as const, content }
      : { type: 'blockquote' as const, attrs: { calloutType }, content },
  )

const arbTable: fc.Arbitrary<TableNode> = fc
  .tuple(fc.integer({ min: 1, max: 2 }), fc.integer({ min: 1, max: 2 }))
  .chain(([rows, cols]) =>
    fc
      .array(
        fc.array(
          arbInlineContent.map((content) => ({ type: 'paragraph' as const, content })),
          { minLength: cols, maxLength: cols },
        ),
        { minLength: rows, maxLength: rows },
      )
      .map((rowCells) => ({
        type: 'table' as const,
        content: rowCells.map((cells, r) => ({
          type: 'tableRow' as const,
          content: cells.map((p) =>
            r === 0
              ? { type: 'tableHeader' as const, content: [p] }
              : { type: 'tableCell' as const, content: [p] },
          ),
        })),
      })),
  )

/** A list item: leading (possibly task) paragraph, occasionally a nested list. */
const arbListItem: fc.Arbitrary<ListItemNode> = fc
  .tuple(arbParagraph, fc.option(arbPlainParagraph, { nil: undefined }))
  .map(([para, nestedPara]) =>
    nestedPara === undefined
      ? { type: 'listItem' as const, content: [para] }
      : {
          type: 'listItem' as const,
          content: [
            para,
            {
              type: 'bulletList' as const,
              content: [{ type: 'listItem' as const, content: [nestedPara] }],
            },
          ],
        },
  )

const arbBulletList: fc.Arbitrary<BlockLevelNode> = fc
  .array(arbListItem, { minLength: 1, maxLength: 3 })
  .map((items) => ({ type: 'bulletList' as const, content: items }))

const arbOrderedList: fc.Arbitrary<BlockLevelNode> = fc
  .array(arbListItem, { minLength: 1, maxLength: 3 })
  .map((items) => ({ type: 'orderedList' as const, content: items }))

/** Block math latex (kept `$`-free and edge-trimmed: the block fence takes the
 * body verbatim and re-trims on parse, so only trimmed bodies are canonical). */
const arbMathBlock: fc.Arbitrary<MathBlockNode> = fc
  .array(fc.constantFrom(...'abx 01^\\'.split('')), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join('').trim())
  .filter((latex) => latex.length > 0)
  .map((latex) => ({ type: 'math_block' as const, attrs: { latex } }))

const arbBlock: fc.Arbitrary<BlockLevelNode> = fc.oneof(
  { weight: 5, arbitrary: arbParagraph },
  { weight: 2, arbitrary: arbHeading },
  { weight: 1, arbitrary: arbCodeBlock },
  { weight: 2, arbitrary: arbBlockquote },
  { weight: 2, arbitrary: arbTable },
  { weight: 2, arbitrary: arbBulletList },
  { weight: 1, arbitrary: arbOrderedList },
  { weight: 1, arbitrary: fc.constant({ type: 'horizontalRule' } as BlockLevelNode) },
  { weight: 1, arbitrary: arbMathBlock },
)

const arbDoc: fc.Arbitrary<DocNode> = fc
  .array(arbBlock, { minLength: 1, maxLength: 3 })
  .map((content) => ({ type: 'doc' as const, content }))

/**
 * Adjacent same-type siblings of the GREEDY block productions (blockquote,
 * table, orderedList) merge on reparse by canonical policy — for tables and
 * ordered lists the merge also normalizes the string (separator row dropped /
 * items renumbered), so those docs converge in one pass instead of already
 * being a fixpoint. They are exercised by the convergence property below and
 * excluded from the strict-fixpoint property.
 */
function hasGreedyAdjacency(d: DocNode): boolean {
  const greedy = new Set<string>(['blockquote', 'table', 'orderedList'])
  const content = d.content ?? []
  for (let i = 1; i < content.length; i++) {
    const prev = (content[i - 1] as BlockLevelNode).type
    const cur = (content[i] as BlockLevelNode).type
    if (prev === cur && greedy.has(cur)) return true
  }
  return false
}

// -- Seeds: the fixed round-trip audit shapes ----------------------------------

const ULID = '01HZ00000000000000000BLOCK'

/** Finding shapes whose serialization is already a strict fixpoint. */
const FIXPOINT_SEEDS: readonly DocNode[] = [
  // hardBreak inside a table cell (degrades to a space, table stays intact)
  doc(
    table(
      tableRow(
        tableHeader(paragraph(text('a'), hardBreak(), text('b'))),
        tableHeader(paragraph(text('h2'))),
      ),
      tableRow(tableCell(paragraph(text('c'))), tableCell(paragraph(text('d')))),
    ),
  ),
  // math_inline immediately followed by digit text (currency-closer seam)
  doc(paragraph(mathInline('x'), text('5 apples'))),
  // hardBreak inside a heading
  doc(heading(2, text('line one'), hardBreak(), text('line two'))),
  // hardBreak inside a task paragraph
  doc(task('TODO', text('buy milk'), hardBreak(), text('and eggs'))),
  // cross-node `$` seam (node-final literal `$` before a marked node)
  doc(paragraph(text('Prices: 5$'), bold(' or 10$'))),
  // math_inline latex containing `$` and edge whitespace
  doc(paragraph(mathInline('a$b'), text(' and '), mathInline(' x '))),
  // literal ((ULID)) text alongside a live block_ref
  doc(paragraph(text(`see ((${ULID})) here `), blockRef(ULID))),
  // adjacent sibling blockquotes (doc merges; the STRING is already stable)
  doc(blockquote(paragraph(text('first quote'))), blockquote(paragraph(text('second quote')))),
  // task paragraph as first child of a listItem (`- - [ ]`)
  doc(bulletList(listItem(task('TODO', text('buy milk'))), listItem(paragraph(text('plain'))))),
]

/** Shapes that normalize (string changes once) before becoming stable. */
const CONVERGENCE_SEEDS: readonly DocNode[] = [
  // adjacent sibling tables: the absorbed table's separator row drops once
  doc(
    table(tableRow(tableHeader(paragraph(text('a'))))),
    table(tableRow(tableHeader(paragraph(text('b'))))),
  ),
  // adjacent ordered lists: items renumber into one list
  doc(
    { type: 'orderedList', content: [listItem(paragraph(text('a')))] },
    { type: 'orderedList', content: [listItem(paragraph(text('b')))] },
  ),
]

// -- Properties ---------------------------------------------------------------

describe('property: serialize→parse→serialize is a strict fixpoint', () => {
  it('the first serialize of any generated doc is byte-identical after a reparse', () => {
    fc.assert(
      fc.property(
        arbDoc.filter((d) => !hasGreedyAdjacency(d)),
        (d) => {
          const md1 = serialize(d)
          const md2 = serialize(parse(md1))
          expect(md2).toBe(md1)
        },
      ),
      { numRuns: NUM_RUNS, examples: FIXPOINT_SEEDS.map((d) => [d] as [DocNode]) },
    )
  })
})

describe('property: one parse pass reaches the canonical fixed point', () => {
  // Docs WITH greedy same-type adjacency are allowed here: the sibling merge
  // may rewrite the string once (table separator drop, ordered renumbering),
  // after which serialize∘parse must be byte-stable forever.
  it('serialize(parse(·)) converges after at most one normalization pass', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const md1 = serialize(d)
        const md2 = serialize(parse(md1))
        const md3 = serialize(parse(md2))
        expect(md3).toBe(md2)
      }),
      {
        numRuns: NUM_RUNS,
        examples: [...FIXPOINT_SEEDS, ...CONVERGENCE_SEEDS].map((d) => [d] as [DocNode]),
      },
    )
  })
})

describe('property: structural round-trip for the fixed audit shapes', () => {
  // The generated-doc properties above assert the STRING invariant; the fixed
  // audit shapes additionally guarantee full doc identity (or the pinned
  // canonical normalization) — kept here as explicit generative seeds so a
  // future serializer change re-runs them under the same roof.
  it.each(FIXPOINT_SEEDS.map((d, i) => [i, d] as const))(
    'seed[%i] parse(serialize(doc)) re-serializes byte-identically',
    (_i, d) => {
      const md = serialize(d)
      expect(serialize(parse(md))).toBe(md)
    },
  )
})
