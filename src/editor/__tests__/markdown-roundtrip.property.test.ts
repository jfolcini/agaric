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
  .map(([content, todoState]): ParagraphNode =>
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
  // #4019: a list followed by a sibling paragraph whose text starts with a
  // SPACE. `- \\` + `\n` + ` a` — the item text is an escaped backslash, so the
  // trailing run is even and the next line is not a hard-break continuation
  // either. The one-space line must stay a sibling paragraph; the parser used
  // to absorb any non-zero indent as nested item content and re-emit it at the
  // two-space nest indent. Both the one-space form and its two-space twin
  // (genuinely nested content) are pinned as strings in
  // `markdown-serializer.test.ts`.
  doc(bulletList(listItem(paragraph(text('\\')))), paragraph(text(' a'))),
  // the two-space twin: the paragraph IS nested content of the item
  doc(bulletList(listItem(paragraph(text('\\')), paragraph(text('a'))))),
  // #4019, the marker-indent twin (found by fuzzing the same adjacency): a
  // sibling paragraph indented past the parser's 3-space marker tolerance is
  // absorbed as nested content and comes back DEDENTED into that tolerance, so
  // the leading marker must be escaped at every indent, not only at 0-3.
  doc(bulletList(listItem(paragraph(text('a')))), paragraph(text('     - [x] a'))),
]

/** Shapes that normalize (string changes once) before becoming stable. */
const CONVERGENCE_SEEDS: readonly DocNode[] = [
  // adjacent sibling tables: the absorbed table's header becomes a data row
  // and its separator becomes a literal (escaped) `---` data row (#3274)
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
  // may rewrite the string once (absorbed table row escaping, ordered renumbering),
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

// -- #4019: the marker-indent / nesting instrument ----------------------------
/**
 * The generators that discriminated the #4019 fix, committed so the evidence is
 * reproducible by a reviewer and re-run by CI against future changes.
 *
 * The properties above fuzz DOCUMENTS at one nesting level over our own output.
 * The fix #4019 landed is about the two places that is not enough:
 *
 *  - the serializer's leading-marker escape must be strictly WIDER than the
 *    parser's marker-indent tolerance, because a paragraph nested in a list
 *    item is emitted indented and re-parsed dedented by the item's content
 *    column — so marker-ness has to be invariant under that dedent at every
 *    depth, not just at depth 1 (P2), and
 *  - `collectListItem`'s dedent must be the exact inverse of `indentLines` for
 *    heterogeneous item children and deep structures (P1), including for
 *    FOREIGN indentation the exporter never emits (P3: tabs, CRLF, 0-8-space
 *    nesting steps, nested blockquotes).
 *
 * All three run at a FIXED SEED. They are a deterministic replay, not a new
 * source of random CI reddening: #4049 (open) is a live seed-dependent fixpoint
 * violation reachable from this suite's own alphabet, so an unseeded property
 * here would be able to redden an unrelated PR. When #4049 lands, the seed can
 * be dropped and `hasKnownIssue4049Drift` deleted with it.
 */

/**
 * Runs per property — 15 000 executions in total. Chosen by measurement on this
 * machine, not by feel; test time for this FILE, everything else held fixed:
 *
 *   without these properties  0.10s
 *   2 000 runs                0.61s
 *   5 000 runs                1.27s   ← chosen
 *  10 000 runs                2.41s
 *  20 000 runs                4.56s   (the 60 000-execution sweep from the PR)
 *
 * Growth is linear, so the knob is purely "how much of the original sweep do we
 * pay for on every CI run". 5 000 buys a quarter of it for ~1.2s against a
 * 160s full frontend suite (<1%), i.e. it does not dominate; the 20 000 that
 * reproduces the full sweep is a visible tax on every push. Re-run the higher
 * rows by hand when touching the parse/serialize pair.
 */
const NESTING_NUM_RUNS = 5000

/**
 * Fixed fast-check seed — see the block comment above. Any value works; this
 * one is the issue number so its provenance is obvious.
 */
const NESTING_SEED = 4019

/**
 * KNOWN OPEN BUG, EXCLUDED BY NAME: #4049 — "markdown fixpoint still violated
 * for a 2-space-indented paragraph after a list (underscore flanking flips
 * under the dedent)".
 *
 * `underscoreRunFlank` (`markdown-common.ts`) classifies a `_` run at the START
 * of a string differently from one preceded by a space, so a line that is both
 * INDENTED and contains an underscore can change its escape decision when
 * `collectListItem` dedents it — `  _ ` serializes clean but re-serializes as
 * `  \_ `. That is a pre-existing inline-escape bug, orthogonal to the
 * structural invariant these properties are the instrument for, and it is
 * tracked and diagnosed in #4049 (with the exact repro and fix).
 *
 * The exclusion is deliberately visible rather than silent: DELETE this
 * predicate and its three call sites when #4049 lands, and these properties
 * should stay green.
 */
function hasKnownIssue4049Drift(md: string): boolean {
  return md.split('\n').some((line) => /^[ \t]/.test(line) && line.includes('_'))
}

// -- P1: deep, heterogeneous list structures ---------------------------------

/** Deepest list nesting generated. The serializer indents one level per step. */
const MAX_GENERATED_LIST_DEPTH = 4

/**
 * A list item's NON-leading children — the "heterogeneous item children" arm.
 * A list item is not just "paragraph + sub-list": the serializer indents every
 * non-leading child by one `LIST_NEST_INDENT`, and the parser must dedent each
 * back by exactly one content column whatever its kind. Code blocks and
 * blockquotes are the interesting ones: their own productions are anchored at
 * column 0, so they can only survive the round trip if the dedent restores that
 * column exactly.
 */
function arbListItemChild(depth: number): fc.Arbitrary<BlockLevelNode> {
  const kinds: fc.Arbitrary<BlockLevelNode>[] = [arbPlainParagraph, arbCodeBlock, arbBlockquote]
  if (depth < MAX_GENERATED_LIST_DEPTH) kinds.push(arbNestedList(depth + 1))
  return fc.oneof(...kinds)
}

/** A bullet/ordered list whose items carry heterogeneous children, to `depth`. */
function arbNestedList(depth: number): fc.Arbitrary<BlockLevelNode> {
  const arbItem: fc.Arbitrary<ListItemNode> = fc
    .tuple(
      arbParagraph,
      fc.array(arbListItemChild(depth), { minLength: 0, maxLength: depth === 1 ? 2 : 1 }),
    )
    .map(([lead, rest]) => ({ type: 'listItem' as const, content: [lead, ...rest] }))
  return fc
    .tuple(fc.boolean(), fc.array(arbItem, { minLength: 1, maxLength: 2 }))
    .map(([ordered, items]) => ({
      type: ordered ? ('orderedList' as const) : ('bulletList' as const),
      content: items,
    }))
}

/**
 * `hasGreedyAdjacency` applies the greedy-sibling-merge rule to the DOC's
 * children; inside a list item the same rule applies to the item's children
 * (two adjacent blockquotes merge, and a callout absorbed into a plain quote
 * has its `[!INFO]` re-emitted as escaped literal text). Same pre-existing
 * canonical-merge policy, one level down — a one-pass normalization, not a
 * fixpoint, so it belongs to the convergence property rather than this one.
 */
function hasGreedyAdjacencyAnywhere(node: BlockLevelNode | DocNode | ListItemNode): boolean {
  const children = (node.content ?? []) as readonly BlockLevelNode[]
  const greedy = new Set<string>(['blockquote', 'table', 'orderedList', 'bulletList'])
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1] as BlockLevelNode
    const cur = children[i] as BlockLevelNode
    if (prev.type === cur.type && greedy.has(cur.type)) return true
  }
  return children.some(
    (c) => typeof c === 'object' && 'content' in c && hasGreedyAdjacencyAnywhere(c),
  )
}

const arbDeepListDoc: fc.Arbitrary<DocNode> = fc
  .array(arbNestedList(1), { minLength: 1, maxLength: 2 })
  .map((content) => ({ type: 'doc' as const, content }))
  // Adjacent ordered-list siblings merge and renumber (a one-pass
  // normalization, covered by the convergence property above), so they are not
  // strict fixpoints and belong to that property, not this one.
  .filter((d) => !hasGreedyAdjacency(d) && !hasGreedyAdjacencyAnywhere(d))

describe('property (#4019): deep, heterogeneous list nesting is a strict fixpoint', () => {
  it('a depth-4 list with mixed item children re-serializes byte-identically', () => {
    fc.assert(
      fc.property(arbDeepListDoc, (d) => {
        const md1 = serialize(d)
        fc.pre(!hasKnownIssue4049Drift(md1))
        expect(serialize(parse(md1))).toBe(md1)
      }),
      { numRuns: NESTING_NUM_RUNS, seed: NESTING_SEED },
    )
  })
})

// -- P2: marker-ness is invariant under the item dedent ----------------------

/** The three leading list markers, at every indent from 0 to past the tolerance. */
const arbMarkerLikeText: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 7 }),
    fc.constantFrom('- ', '* ', '1. ', '7. ', '- [ ] ', '- [x] ', '- [/] '),
    fc.constantFrom('x', 'a b', 'y1'),
  )
  .map(([indent, marker, body]) => `${' '.repeat(indent)}${marker}${body}`)

/**
 * A paragraph whose literal TEXT looks like a list marker, buried at a random
 * depth in a list. This is the shape the fix is about: it is emitted indented
 * by `depth` levels and re-parsed dedented one level per recursion step, so an
 * indent too deep to be a marker on the way out can land inside the parser's
 * tolerance on the way back in. It must come back a PARAGRAPH — structural
 * identity, not merely a stable string.
 */
const arbBuriedMarkerDoc: fc.Arbitrary<DocNode> = fc
  .tuple(arbMarkerLikeText, fc.integer({ min: 0, max: MAX_GENERATED_LIST_DEPTH }))
  .map(([markerText, depth]) => {
    let node: BlockLevelNode = { type: 'paragraph', content: [{ type: 'text', text: markerText }] }
    for (let i = 0; i < depth; i++) {
      node = {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'p' }] }, node],
          },
        ],
      }
    }
    return { type: 'doc' as const, content: [node] }
  })

describe('property (#4019): a marker-like paragraph never resurrects as a list', () => {
  it('survives as a paragraph at every indent and nesting depth', () => {
    fc.assert(
      fc.property(arbBuriedMarkerDoc, (d) => {
        const md = serialize(d)
        expect(parse(md)).toEqual(d)
        expect(serialize(parse(md))).toBe(md)
      }),
      { numRuns: NESTING_NUM_RUNS, seed: NESTING_SEED },
    )
  })
})

// -- P3: foreign markdown import converges in one pass ------------------------

/**
 * Markdown as a FOREIGN tool writes it, which is where the marker-indent
 * tolerance earns its keep — indentation our own exporter never emits (tabs,
 * 4- and 8-space nesting steps), CRLF line endings, and blockquote nesting
 * around all of it. Import is allowed to NORMALIZE such a document once (that
 * is what canonical storage means); it must then be a fixed point forever, or
 * every open/close cycle rewrites the user's content.
 *
 * The alphabet is deliberately narrow — the inline grammar is fuzzed by the
 * properties above; what is under test here is line SHAPE.
 */
const arbForeignLine: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('', ' ', '  ', '   ', '    ', '      ', '        ', '\t', '\t\t'),
    fc.constantFrom('', '> ', '> > ', '> > > '),
    fc.constantFrom(
      '- item',
      '* item',
      '+ item',
      '1. item',
      '3. item',
      '- [ ] task',
      '- [x] task',
      'plain text',
      '# heading',
      '> quote',
      '```',
      'a | b',
      '---',
      '',
    ),
  )
  .map(([indent, quote, body]) => `${quote}${indent}${body}`)

const arbForeignMarkdown: fc.Arbitrary<string> = fc
  .tuple(fc.array(arbForeignLine, { minLength: 1, maxLength: 8 }), fc.constantFrom('\n', '\r\n'))
  .map(([lines, eol]) => lines.join(eol))

describe('property (#4019): foreign markdown import converges in one pass', () => {
  it('serialize(parse(·)) is a fixed point after the first normalization', () => {
    fc.assert(
      fc.property(arbForeignMarkdown, (md) => {
        const md1 = serialize(parse(md))
        fc.pre(!hasKnownIssue4049Drift(md1))
        const md2 = serialize(parse(md1))
        expect(md2).toBe(md1)
      }),
      { numRuns: NESTING_NUM_RUNS, seed: NESTING_SEED },
    )
  })
})
