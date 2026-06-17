/**
 * Property-based tests for the markdown serializer (fast-check).
 *
 * These complement the example-based tests with generative fuzzing.
 * Instead of hand-picked inputs, fast-check explores thousands of random
 * cases per property and shrinks failures to minimal reproducers.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parse, serialize } from '../markdown-serializer'
import type { CodeBlockNode, DocNode, InlineNode, ParagraphNode, PMMark, TextNode } from '../types'

// -- Configuration ------------------------------------------------------------

/** Number of runs per property. Increase for deeper fuzzing. */
const NUM_RUNS = 500

// -- Generators ---------------------------------------------------------------

/**
 * Characters that are meaningful to the serializer. We deliberately include
 * all delimiter characters so fast-check explores edge cases with them.
 * `_ | ~ =` were added with #710 — the round-trip corruption family showed
 * the old alphabet couldn't catch underscore/pipe/strike/highlight bugs.
 * `< > u` were added with #898 so `<u>` / `</u>` underline tokens (#211 P2-5)
 * emerge from the single-char alphabet too.
 */
const INTERESTING_CHARS = 'abcXY 012*`#[\\]()_|~=<>u'

/**
 * Multi-character tokens for the #898 alphabet extension — the non-CommonMark
 * delimiter families behind the #710/#711 corruption set. Splicing them in as
 * atomic units (rather than relying on the single-char alphabet to randomly
 * assemble them) makes fast-check reliably explore the mark-delimiter
 * collisions: strikethrough (`~~`), highlight (`==`), underline tags
 * (`<u>` / `</u>`), and the escape/hard-break interaction (`\` runs).
 */
const INTERESTING_TOKENS = ['~~', '==', '<u>', '</u>', '\\', '\\\\', '\\\\\\']

/**
 * A non-empty string from the interesting character alphabet, occasionally
 * spliced with one of the multi-char delimiter tokens. The tokens land mid-text
 * (not at the start) so this generator keeps producing *inline* content — the
 * leading-marker block-production cases (`#`, `N. `, `|`) are exercised through
 * arbMarkdownString, which the fixed-point properties normalize.
 */
const arbText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom(...INTERESTING_CHARS.split('')) },
      // #1333: raised from 1→3 so adversarial multi-char delimiter runs
      // (`~~`, `==`, `<u>`, `\` chains) are spliced in far more often — the
      // longest-delimiter-run collision cases were previously under-generated.
      { weight: 3, arbitrary: fc.constantFrom(...INTERESTING_TOKENS) },
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((chars) => chars.join(''))

/** Uppercase ULID (26 Crockford base32 chars). */
const arbUlid: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('')), {
    minLength: 26,
    maxLength: 26,
  })
  .map((chars) => chars.join(''))

/**
 * Candidate hrefs for the link mark. #1333: previously a single fixed
 * `https://example.com` left link-mark serialization shallowly tested. Vary the
 * href — empty string, delimiter-bearing and paren/space-bearing URLs — so the
 * `[text](href)` wrapping logic is fuzzed against URLs that themselves collide
 * with the link syntax (`)`, `(`, spaces) or are degenerate (empty).
 */
const LINK_HREFS: readonly string[] = [
  'https://example.com',
  '',
  'https://a.com/path?q=1&x=2',
  'https://ex.com/page(1)',
  'https://ex.com/a b',
  'https://ex.com/~~==',
  'mailto:user@example.com',
  '#anchor',
]

const arbHref: fc.Arbitrary<string> = fc.constantFrom(...LINK_HREFS)

/** A valid mark combination (no duplicates). */
const arbMarks: fc.Arbitrary<PMMark[]> = fc
  .tuple(
    fc.subarray([
      { type: 'bold' } as PMMark,
      { type: 'italic' } as PMMark,
      { type: 'code' } as PMMark,
      { type: 'link' } as PMMark,
    ]),
    arbHref,
  )
  .map(([marks, href]) =>
    marks.map((m) => (m.type === 'link' ? ({ type: 'link', attrs: { href } } as PMMark) : m)),
  )
  .filter((marks) => {
    // Code mark is exclusive — if present, drop bold/italic (serializer does this)
    if (marks.some((m) => m.type === 'code')) {
      return marks.filter((m) => m.type !== 'link').length === 1
    }
    return true
  })

/** A text node with random marks. */
const arbTextNode: fc.Arbitrary<TextNode> = fc.tuple(arbText, arbMarks).map(([text, marks]) => {
  const node: TextNode = { type: 'text' as const, text }
  if (marks.length > 0) return { ...node, marks }
  return node
})

/** A tag_ref node. */
const arbTagRef = arbUlid.map((id) => ({ type: 'tag_ref' as const, attrs: { id } }))

/** A block_link node. */
const arbBlockLink = arbUlid.map((id) => ({ type: 'block_link' as const, attrs: { id } }))

/** A block_ref node (atomic inline — no content). */
const arbBlockRef = arbUlid.map((id) => ({
  type: 'block_ref' as const,
  attrs: { id },
  content: undefined,
}))

/** Any inline node (weighted toward text since that's the common case). */
const arbInlineNode: fc.Arbitrary<InlineNode> = fc.oneof(
  { weight: 6, arbitrary: arbTextNode },
  { weight: 1, arbitrary: arbTagRef },
  { weight: 1, arbitrary: arbBlockLink },
  { weight: 1, arbitrary: arbBlockRef },
  // Omit hardBreak — it becomes \n which splits paragraphs in the parser,
  // making structural equality comparison complex. Tested separately.
)

/** A paragraph with 1-5 inline nodes. */
const arbParagraph: fc.Arbitrary<ParagraphNode> = fc
  .array(arbInlineNode, { minLength: 1, maxLength: 5 })
  .map((content) => ({ type: 'paragraph' as const, content }))

/** A document with 1-3 paragraphs. */
const arbDoc: fc.Arbitrary<DocNode> = fc
  .array(arbParagraph, { minLength: 1, maxLength: 3 })
  .map((content) => ({ type: 'doc' as const, content }))

/**
 * Arbitrary content for a code block. Deliberately mixes plain text with runs
 * of backticks of various lengths (3, 4, 5+) at arbitrary positions, including
 * stand-alone fence-shaped lines like "```", "````python", "```\n```". This
 * exercises the variable-length CommonMark fence logic in
 * serializeCodeBlock / parseCodeBlock (BUG-1).
 */
const arbCodeBlockContent: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      // Plain text line (no backticks) — keeps content readable
      fc
        .array(fc.constantFrom(...'abcXY 012'.split('')), { minLength: 0, maxLength: 8 })
        .map((chars) => chars.join('')),
      // A line that is exactly a backtick fence of length 3-6, optionally with
      // a fake info string. These are the adversarial inputs for BUG-1.
      fc
        .tuple(
          fc.integer({ min: 3, max: 6 }),
          fc.constantFrom('', 'js', 'python', 'markdown', 'sh'),
        )
        .map(([n, lang]) => `${'`'.repeat(n)}${lang}`),
      // A short string with embedded backtick runs (1-7 backticks anywhere)
      fc
        .array(
          fc.oneof(
            fc.constantFrom('a', 'b', ' ', 'x'),
            fc.integer({ min: 1, max: 7 }).map((n) => '`'.repeat(n)),
          ),
          { minLength: 0, maxLength: 5 },
        )
        .map((parts) => parts.join('')),
    ),
    { minLength: 0, maxLength: 6 },
  )
  .map((lines) => lines.join('\n'))

/** A code block with random content and an optional language. */
const arbCodeBlock: fc.Arbitrary<CodeBlockNode> = fc
  .tuple(
    arbCodeBlockContent,
    fc.option(fc.constantFrom('js', 'python', 'rust', 'markdown'), { nil: undefined }),
  )
  .map(([code, language]) => {
    if (code.length === 0) {
      return language
        ? { type: 'codeBlock' as const, attrs: { language } }
        : { type: 'codeBlock' as const }
    }
    if (language) {
      return {
        type: 'codeBlock' as const,
        attrs: { language },
        content: [{ type: 'text' as const, text: code }] as const,
      }
    }
    return {
      type: 'codeBlock' as const,
      content: [{ type: 'text' as const, text: code }] as const,
    }
  })

/**
 * Arbitrary string that exercises the parser — a mix of markdown-significant
 * characters plus regular text. This tests parse() with truly random input.
 */
const arbMarkdownString: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        '**',
        '*',
        '`',
        '\\*',
        '\\`',
        '\\\\',
        '\\#',
        '\\[',
        '\\]',
        '#[',
        '[[',
        ']]',
        ']',
        '(',
        ')',
        // #710 alphabet extension: emphasis underscores, strike, highlight,
        // table pipes, ordered-list prefixes, and their escapes.
        '_',
        '__',
        '~~',
        '==',
        '|',
        '\\_',
        '\\|',
        '1. ',
        '2. ',
        // #898 alphabet extension: underline storage tokens (#211 P2-5),
        // multi-char escape / hard-break runs, and the strike/highlight escapes.
        '<u>',
        '</u>',
        '\\\\',
        '\\\\\\',
        '\\~',
        '\\=',
        '\\<',
      ),
      // #898: leading block markers at paragraph start. These reparse into a
      // *different block kind* (heading / ordered-list / table) on the first
      // round-trip — exactly the block-production-on-reparse asymmetry behind
      // the #710/#711 family. Generated as a marker + a short clean tail so the
      // construct is well-formed; the fixed-point/idempotence properties
      // (which normalize) must still stabilise on these.
      fc
        .tuple(
          fc.constantFrom('# ', '## ', '### ', '1. ', '2. ', '|'),
          fc
            .array(fc.constantFrom(...'abcXY 012'.split('')), { minLength: 1, maxLength: 6 })
            .map((chars) => chars.join('')),
        )
        .map(([marker, tail]) => `${marker}${tail}`),
      fc
        .array(fc.constantFrom(...'abcXY 012'.split('')), { minLength: 1, maxLength: 6 })
        .map((chars) => chars.join('')),
      // Occasionally inject a valid ULID token
      arbUlid.map((id) => `#[${id}]`),
      arbUlid.map((id) => `[[${id}]]`),
      // Occasionally inject a valid external link
      fc.constantFrom('[link](https://example.com)', '[text](https://a.com)'),
    ),
    { minLength: 0, maxLength: 10 },
  )
  .map((parts) => parts.join(''))

// -- Helpers ------------------------------------------------------------------

/** Extract all plain text content from a DocNode, ignoring marks and structure. */
function extractText(doc: DocNode): string {
  if (!doc.content) return ''
  return doc.content
    .map((p) => {
      if (!('content' in p) || !p.content) return ''
      return p.content
        .map((n) => {
          if (n.type === 'text') return n.text
          if (n.type === 'tag_ref') return n.attrs.id
          if (n.type === 'block_link') return n.attrs.id
          return ''
        })
        .join('')
    })
    .join('')
}

/** Check if two mark arrays are equivalent. */
function marksEqual(a: readonly PMMark[] | undefined, b: readonly PMMark[] | undefined): boolean {
  const ma = a ?? []
  const mb = b ?? []
  if (ma.length !== mb.length) return false
  const sortedA = [...ma].map((m) => JSON.stringify(m)).sort()
  const sortedB = [...mb].map((m) => JSON.stringify(m)).sort()
  return sortedA.every((t, i) => t === sortedB[i])
}

/** Merge adjacent text nodes with identical marks (parser-canonical form). */
function mergeAdjacentTextNodes(content: readonly InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = []
  for (const node of content) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null
    if (node.type === 'text' && last?.type === 'text' && marksEqual(last.marks, node.marks)) {
      // Merge into previous text node
      const combined: TextNode = { type: 'text', text: last.text + node.text }
      if (last.marks && last.marks.length > 0) {
        merged[merged.length - 1] = { ...combined, marks: [...last.marks] }
      } else {
        merged[merged.length - 1] = combined
      }
    } else {
      merged.push(node)
    }
  }
  return merged
}

function normalizeParagraphNode(p: ParagraphNode): ParagraphNode {
  if (!p.content || p.content.length === 0) return p
  const merged = mergeAdjacentTextNodes(p.content)
  if (merged.length === 0) return { type: 'paragraph' }
  return { type: 'paragraph', content: merged }
}

/**
 * Normalize a DocNode by merging adjacent text nodes with the same marks.
 * This is what the parser naturally does — it never produces split text nodes
 * with identical marks. We need this to compare generated docs with parsed
 * docs. Recurses into ordered-list items and table cells (reachable since
 * the #710 alphabet extension added `1. ` / `|` tokens) — e.g. two adjacent
 * same-href link nodes in a list item serialize as ONE `[text](url)` and
 * reparse as a single merged node.
 */
function normalizeDoc(doc: DocNode): DocNode {
  if (!doc.content) return doc
  const paragraphs = doc.content
    .map((p) => {
      if (p.type === 'paragraph') return normalizeParagraphNode(p)
      // #898: a leading `# ` token now produces headings, whose inline content
      // is subject to the same adjacent-same-mark merge as paragraphs — e.g.
      // `# a[t](u)[t](u)` serializes to one merged `[tt](u)` and reparses as a
      // single node. Merge heading children so the fixed-point comparison sees
      // the parser-canonical form. (Serializer output is already a fixed point;
      // only the un-merged generated/intermediate doc differs structurally.)
      if (p.type === 'heading' && p.content) {
        return { ...p, content: mergeAdjacentTextNodes(p.content) }
      }
      if (p.type === 'orderedList' && p.content) {
        return {
          ...p,
          content: p.content.map((item) =>
            item.content ? { ...item, content: item.content.map(normalizeParagraphNode) } : item,
          ),
        }
      }
      if (p.type === 'table' && p.content) {
        return {
          ...p,
          content: p.content.map((row) =>
            row.content
              ? {
                  ...row,
                  content: row.content.map((cell) =>
                    cell.content
                      ? { ...cell, content: cell.content.map(normalizeParagraphNode) }
                      : cell,
                  ),
                }
              : row,
          ),
        }
      }
      return p
    })
    // Strip empty paragraphs — these serialize to "" which parses back as
    // no content at all, so they must be removed for structural equality.
    // e.g. "****" parses to an empty paragraph, serializes to "", and
    // re-parses as { type: 'doc' } with no content property.
    .filter((p) => 'content' in p && p.content && p.content.length > 0)
  if (paragraphs.length === 0) return { type: 'doc' }
  return { type: 'doc', content: paragraphs }
}

/**
 * Check whether a single text node has content that would be ambiguous on
 * round-trip. Delimiter characters get escaped, `#[` / `[[` could introduce
 * token boundaries, and link marks wrap in `[text](url)` syntax.
 */
function textNodeHasAmbiguity(node: TextNode): boolean {
  if (/[*`\\[\]()]/.test(node.text)) return true
  if (node.text.includes('#[')) return true
  if (node.text.includes('[[')) return true
  if (node.marks?.some((m) => m.type === 'link')) return true
  return false
}

/**
 * Check whether a paragraph starts with syntax that would be re-parsed as a
 * different block kind (heading, fenced code block). Splitting this out of
 * hasStructuralAmbiguity keeps each function under the complexity threshold.
 */
function paragraphStartsWithAmbiguousSyntax(block: ParagraphNode): boolean {
  if (!block.content) return false
  const firstText = block.content.find((n): n is TextNode => n.type === 'text')
  if (!firstText) return false
  // #984: a leading run of mark delimiters (`==` highlight, `~~` strike) can form
  // a degenerate/empty pair (e.g. `====# a`) that collapses on round-trip, exposing
  // a following block marker (`# a` → heading). Strip such a run first so these
  // reparse-into-a-different-block cases are flagged. (No leading run → unchanged.)
  const lead = firstText.text.replace(/^[=~]+/, '')
  // #898: leading block markers reparse a *paragraph* into a different block kind
  // (heading / fenced code / blockquote / ordered list / table row), so a paragraph
  // carrying one is structurally ambiguous on round-trip and must be excluded from
  // doc→text→doc structural-equality properties. The fixed-point / idempotence
  // properties (which compare serializer output, not structure) still exercise them.
  if (/^#{1,6} /.test(lead)) return true
  if (lead.startsWith('```')) return true
  if (lead.startsWith('>')) return true
  if (/^\d+\. /.test(lead)) return true
  if (lead.startsWith('|')) return true
  // #1436: a paragraph whose SERIALIZED form begins with a bullet marker
  // (`- ` / `* `) reparses as a bulletList. The marker can come either from
  // literal text (`- foo`) OR from an emphasis DELIMITER landing at column 0
  // followed by a space (`italic(' ')` → `* *`, `bold(' ')` → `** **`). The
  // leading-text inspection above cannot see delimiter-induced markers, so
  // serialize the paragraph and test the actual emitted prefix. (Literal `- `
  // is escaped to `\- ` by the serializer, so a literal-dash paragraph is NOT
  // flagged here — only the genuinely ambiguous delimiter-space case is.)
  if (/^[-*] /.test(serializeParagraphForAmbiguity(block))) return true
  return false
}

/**
 * Serialize a paragraph in isolation to inspect its emitted leading syntax.
 * Wrapping it in a one-paragraph doc reuses the production serializer exactly.
 */
function serializeParagraphForAmbiguity(block: ParagraphNode): string {
  return serialize({ type: 'doc', content: [block] })
}

/**
 * Check whether any text node within a paragraph has ambiguous content.
 */
function paragraphHasAmbiguousTextNode(block: ParagraphNode): boolean {
  if (!block.content) return false
  for (const node of block.content) {
    if (node.type === 'text' && textNodeHasAmbiguity(node)) return true
  }
  return false
}

/**
 * Check whether a doc contains text nodes whose content has characters that
 * would be ambiguous when serialized — e.g. a text node containing `*` that
 * gets escaped, but escaping changes the round-trip structure.
 *
 * We don't filter these out from correctness tests — the serializer SHOULD
 * handle them. But we filter from structural equality checks because the
 * parser may merge/split text nodes differently than the original doc.
 */
function hasStructuralAmbiguity(doc: DocNode): boolean {
  if (!doc.content) return false
  for (const block of doc.content) {
    if (block.type !== 'paragraph') continue
    if (paragraphHasAmbiguousTextNode(block)) return true
    if (paragraphStartsWithAmbiguousSyntax(block)) return true
  }
  return false
}

// -- Properties ---------------------------------------------------------------

describe('property: parse safety', () => {
  it('parse never throws for any string input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        // Lines with \n are valid — they become multi-paragraph docs
        const result = parse(s)
        expect(result.type).toBe('doc')
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('parse never throws for markdown-shaped strings', () => {
    fc.assert(
      fc.property(arbMarkdownString, (s) => {
        const result = parse(s)
        expect(result.type).toBe('doc')
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('property: serialize safety', () => {
  it('serialize never throws for any valid doc', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const result = serialize(d)
        expect(typeof result).toBe('string')
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('property: round-trip (text → doc → text stabilizes)', () => {
  it('serialize(parse(s)) produces a stable fixed point: the canonicalized form re-parses unchanged', () => {
    fc.assert(
      fc.property(
        arbMarkdownString.filter((s) => !s.includes('\\#') && !s.includes('\\`')),
        (s) => {
          // #984 / tilde-fence flake: the FIRST parse of the raw input is NOT
          // necessarily the fixed point. A leading run of mark delimiters that
          // forms a *degenerate* pair (`~~~~`, `====`) collapses to nothing on
          // serialize — which only THEN exposes a following block marker
          // (`~~~~### a` → paragraph `### a` on first parse, but `### a` re-parses
          // as a *heading*). Comparing the raw `parse(s)` against its reparse
          // therefore spuriously fails on seed-dependent inputs that pair a
          // collapsing `~`/`=` lead with a heading/list/table marker.
          //
          // The genuine "stable fixed point" claim is that once the input has
          // been canonicalized by ONE serialize pass (reaching the form that is
          // actually written back to storage), every subsequent
          // parse→serialize→parse is structurally identical. We anchor the
          // comparison at that canonical form `md1` rather than at the raw input.
          const md1 = serialize(parse(s))
          const docCanonical = parse(md1)
          const docReparsed = parse(serialize(docCanonical))
          // Normalize both sides because the parser can produce structurally
          // different but semantically equivalent text node splits (e.g. empty
          // code spans ```` `` ```` leave adjacent unmarked text nodes unsplit)
          expect(normalizeDoc(docReparsed)).toEqual(normalizeDoc(docCanonical))
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('idempotent: serialize(parse(serialize(parse(s)))) === serialize(parse(s))', () => {
    fc.assert(
      fc.property(arbMarkdownString, (s) => {
        const once = serialize(parse(s))
        const twice = serialize(parse(once))
        expect(twice).toBe(once)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('property: round-trip (doc → text → doc)', () => {
  it('parse(serialize(normalize(doc))) equals normalize(doc) for docs without structural ambiguities', () => {
    fc.assert(
      fc.property(
        arbDoc.filter((d) => {
          const n = normalizeDoc(d)
          return !hasStructuralAmbiguity(n)
        }),
        (d) => {
          const normalized = normalizeDoc(d)
          const md = serialize(normalized)
          const reparsed = parse(md)
          expect(reparsed).toEqual(normalized)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('property: content preservation', () => {
  it('all ULID token IDs survive a round-trip', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const md = serialize(d)
        // Every ULID that was in the original doc should appear in the markdown
        if (!d.content) return
        for (const para of d.content) {
          if (!para.content) continue
          for (const node of para.content) {
            if (node.type === 'tag_ref') {
              expect(md).toContain(`#[${node.attrs.id}]`)
            }
            if (node.type === 'block_link') {
              expect(md).toContain(`[[${node.attrs.id}]]`)
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('text content is preserved across parse→serialize (no silent data loss)', () => {
    fc.assert(
      fc.property(
        arbMarkdownString.filter((s) => {
          // Escaped # or ``` can produce heading/code-fence syntax after one round-trip
          // which is intentional markdown behavior, not data loss
          return !s.includes('\\#') && !s.includes('\\`')
        }),
        (s) => {
          const doc1 = parse(s)
          const md1 = serialize(doc1)
          // All text content from parsed doc should appear in serialized output
          const textFromDoc = extractText(doc1)
          const textFromReserialized = extractText(parse(md1))
          expect(textFromReserialized).toBe(textFromDoc)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('property: structural invariants', () => {
  it('parse always produces doc with valid block-level children', () => {
    fc.assert(
      fc.property(arbMarkdownString, (s) => {
        const result = parse(s)
        if (result.content) {
          for (const child of result.content) {
            // The full set of block-level nodes `parse` can emit at the doc
            // top level. The list previously omitted `bulletList`, `blockquote`,
            // and `horizontalRule`, so a fast-check input containing `* a`,
            // `> q`, or `---` flaked this assertion (counterexample `["* a"]`,
            // seed -1171359990). All are legitimate block-level children.
            expect([
              'paragraph',
              'heading',
              'codeBlock',
              'table',
              'orderedList',
              'bulletList',
              'blockquote',
              'horizontalRule',
            ]).toContain(child.type)
          }
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('serialize output round-trips for normalized docs without structural ambiguities', () => {
    fc.assert(
      fc.property(
        arbDoc.filter((d) => {
          const n = normalizeDoc(d)
          return !hasStructuralAmbiguity(n)
        }),
        (d) => {
          const normalized = normalizeDoc(d)
          const md = serialize(normalized)
          const reparsed = parse(md)
          expect(reparsed).toEqual(normalized)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('parse result text nodes always have non-empty text', () => {
    fc.assert(
      fc.property(arbMarkdownString, (s) => {
        const result = parse(s)
        if (!result.content) return
        for (const para of result.content) {
          if (!para.content) continue
          for (const node of para.content) {
            if (node.type === 'text') {
              expect(node.text.length).toBeGreaterThan(0)
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('serialized output has same number of newlines as paragraphs minus one', () => {
    fc.assert(
      fc.property(arbDoc, (d) => {
        const md = serialize(d)
        if (!d.content || d.content.length === 0) {
          expect(md).toBe('')
          return
        }
        // Count newlines in the serialized markdown
        const newlineCount = (md.match(/\n/g) ?? []).length
        // Should be paragraphs - 1 (join with \n)
        expect(newlineCount).toBe(d.content.length - 1)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- code block fence variable-length (BUG-1) ---------------------------------

describe('property: code block round-trip handles backtick content (BUG-1)', () => {
  it('serialize(parse(serialize(codeBlock))) is a fixed point — no truncation', () => {
    fc.assert(
      fc.property(arbCodeBlock, (block) => {
        const md = serialize({ type: 'doc', content: [block] })
        const reparsed = parse(md)
        // The reparsed doc must contain exactly one block — the original code
        // block (i.e. the closing fence wasn't matched against an internal line).
        expect(reparsed.content).toHaveLength(1)
        expect(reparsed.content?.[0]).toEqual(block)
        // And the round-trip must be idempotent.
        expect(serialize(reparsed)).toBe(md)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('emitted fence is always longer than the longest backtick run in content', () => {
    fc.assert(
      fc.property(arbCodeBlock, (block) => {
        const md = serialize({ type: 'doc', content: [block] })
        // The emitted markdown begins with a run of backticks (the opening fence)
        const fenceMatch = md.match(/^(`+)/)
        expect(fenceMatch).not.toBeNull()
        const fenceLen = (fenceMatch as RegExpMatchArray)[0].length
        expect(fenceLen).toBeGreaterThanOrEqual(3)
        // No backtick run inside the content may be >= the fence length
        const code = block.content?.[0]?.text ?? ''
        const runs = code.match(/`+/g) ?? []
        for (const r of runs) {
          expect(r.length).toBeLessThan(fenceLen)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- delimiter-collision extremes (#1333) -------------------------------------

/**
 * #1333: a generator targeting the *adversarial extreme* of mark-delimiter
 * collisions — a long run of a single delimiter family, then text, then another
 * long run. These tight `~~~~...text...~~~~` / all-backtick / all-tilde /
 * all-underscore / long-`\` patterns are the worst case for the longest-run
 * logic (escape doubling, fence sizing, degenerate-pair collapse). The plain
 * single-char alphabet almost never assembles runs this long, so we build them
 * explicitly with N/M repetition counts up to 8.
 */
const arbDelimiterExtreme: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('~~', '==', '`', '_', '<u>', '\\'),
    fc.integer({ min: 1, max: 8 }),
    fc.integer({ min: 0, max: 8 }),
    fc
      .array(fc.constantFrom(...'abcXY 012'.split('')), { minLength: 0, maxLength: 6 })
      .map((chars) => chars.join('')),
  )
  .map(([delim, n, m, text]) => `${delim.repeat(n)}${text}${delim.repeat(m)}`)

describe('property: delimiter-collision extremes round-trip (#1333)', () => {
  it('serialize(parse(s)) is a stable fixed point for long single-family delimiter runs', () => {
    fc.assert(
      fc.property(arbDelimiterExtreme, (s) => {
        // Reuse the canonical-fixed-point pattern from the text→doc→text suite:
        // anchor at md1 (the form written back to storage) and assert the next
        // parse→serialize→parse is structurally identical (no silent rewrite).
        const md1 = serialize(parse(s))
        const docCanonical = parse(md1)
        const docReparsed = parse(serialize(docCanonical))
        expect(normalizeDoc(docReparsed)).toEqual(normalizeDoc(docCanonical))
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('text content is preserved across parse→serialize for delimiter extremes (no data loss)', () => {
    fc.assert(
      fc.property(
        // Escaped #/``` can legitimately produce heading/code-fence syntax on a
        // round-trip; the bare delimiter families here never do, but we keep the
        // same exclusion the text-preservation property uses for parity.
        arbDelimiterExtreme.filter((s) => !s.includes('\\#') && !s.includes('\\`')),
        (s) => {
          const doc1 = parse(s)
          const md1 = serialize(doc1)
          const textFromDoc = extractText(doc1)
          const textFromReserialized = extractText(parse(md1))
          expect(textFromReserialized).toBe(textFromDoc)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- hardBreak full-doc integration (#1333) -----------------------------------

/**
 * #1333: hardBreak was omitted from arbInlineNode (a `\`+newline token splits a
 * paragraph for naive structural comparison), so it was never fuzzed inside a
 * full document. This generator builds a paragraph that interleaves clean,
 * unambiguous text nodes with hardBreak atoms — the canonical Shift+Enter shape
 * — keeping each text run free of delimiter/escape characters so the only
 * structural variable under test is the hardBreak itself.
 */
const arbCleanText: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcXY 012'.split('')), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''))

const arbHardBreakParagraph: fc.Arbitrary<ParagraphNode> = fc
  .array(arbCleanText, { minLength: 2, maxLength: 4 })
  .map((segments) => {
    const content: InlineNode[] = []
    segments.forEach((text, idx) => {
      if (idx > 0) content.push({ type: 'hardBreak' })
      content.push({ type: 'text', text })
    })
    return { type: 'paragraph' as const, content }
  })

const arbHardBreakDoc: fc.Arbitrary<DocNode> = fc
  .array(arbHardBreakParagraph, { minLength: 1, maxLength: 3 })
  .map((content) => ({ type: 'doc' as const, content }))

describe('property: hardBreak full-doc round-trip (#1333)', () => {
  it('parse(serialize(doc)) preserves doc shape for docs containing hardBreaks', () => {
    fc.assert(
      fc.property(arbHardBreakDoc, (doc) => {
        // Reuse the file's doc→text→doc shape assertion: serialize then parse
        // and compare against the normalized original (adjacent same-mark text
        // nodes merge in the parser; hardBreak atoms keep the runs distinct).
        const normalized = normalizeDoc(doc)
        const md = serialize(normalized)
        const reparsed = parse(md)
        expect(reparsed).toEqual(normalized)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- parse recursion depth guard (MAINT-11) -----------------------------------

describe('property: parse recursion depth guard', () => {
  /**
   * Build a deeply nested blockquote markdown string with N leading `> `
   * repetitions. This is the canonical input that used to risk unbounded
   * recursion before the MAX_PARSE_DEPTH cap.
   */
  function buildNestedBlockquote(depth: number, leaf: string): string {
    return `${'> '.repeat(depth)}${leaf}`
  }

  /**
   * Build a link-in-link-in-link chain (each new wrapper puts the previous
   * text inside another `[text](url)` external link). Exercises the
   * consumeExternalLink recursion path which is the second site the depth
   * guard protects.
   */
  function buildNestedLinks(depth: number, leaf: string): string {
    let out = leaf
    for (let i = 0; i < depth; i++) {
      out = `[${out}](https://example.com/${i})`
    }
    return out
  }

  it('never throws for arbitrarily deep nested blockquotes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (depth, leaf) => {
          // The leaf must avoid characters that would themselves trigger
          // parsing branches (e.g. leading `>` would compound the depth).
          const safeLeaf = leaf.replace(/[>`*[\]#|\\]/g, 'x')
          const input = buildNestedBlockquote(depth, safeLeaf || 'x')
          expect(() => parse(input)).not.toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })

  it('never throws for arbitrarily deep nested external-link display text', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.string({ minLength: 1, maxLength: 6 }),
        (depth, leaf) => {
          const safeLeaf = leaf.replace(/[>`*[\]#|\\()]/g, 'x')
          const input = buildNestedLinks(depth, safeLeaf || 'x')
          expect(() => parse(input)).not.toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })
})

// -- Smoke tests for ambiguity helpers ----------------------------------------

describe('hasStructuralAmbiguity helpers', () => {
  it('textNodeHasAmbiguity: flags delimiter characters, token prefixes, and link marks', () => {
    expect(textNodeHasAmbiguity({ type: 'text', text: 'hello' })).toBe(false)
    expect(textNodeHasAmbiguity({ type: 'text', text: 'has *bold*' })).toBe(true)
    expect(textNodeHasAmbiguity({ type: 'text', text: 'has `code`' })).toBe(true)
    expect(textNodeHasAmbiguity({ type: 'text', text: 'tag #[X]' })).toBe(true)
    expect(textNodeHasAmbiguity({ type: 'text', text: 'link [[X]]' })).toBe(true)
    expect(
      textNodeHasAmbiguity({
        type: 'text',
        text: 'plain',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      }),
    ).toBe(true)
  })

  it('paragraphStartsWithAmbiguousSyntax: flags heading and code-fence starts', () => {
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: '# heading' }],
      }),
    ).toBe(true)
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: '```js' }],
      }),
    ).toBe(true)
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: 'plain content' }],
      }),
    ).toBe(false)
    // #898: leading block markers (blockquote `>`, ordered-list `N. `, table
    // `|`) reparse a paragraph into a different block kind — also ambiguous.
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: '> quote' }],
      }),
    ).toBe(true)
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: '1. item' }],
      }),
    ).toBe(true)
    expect(
      paragraphStartsWithAmbiguousSyntax({
        type: 'paragraph',
        content: [{ type: 'text', text: '| cell' }],
      }),
    ).toBe(true)
    // Edge case: empty paragraph has no ambiguity signal.
    expect(paragraphStartsWithAmbiguousSyntax({ type: 'paragraph' })).toBe(false)
  })

  it('paragraphHasAmbiguousTextNode: inspects each inline node', () => {
    expect(
      paragraphHasAmbiguousTextNode({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain' },
          { type: 'text', text: 'also plain' },
        ],
      }),
    ).toBe(false)
    expect(
      paragraphHasAmbiguousTextNode({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain' },
          { type: 'text', text: 'has *bold*' },
        ],
      }),
    ).toBe(true)
    // Edge case: empty paragraph has nothing ambiguous to find.
    expect(paragraphHasAmbiguousTextNode({ type: 'paragraph' })).toBe(false)
  })

  it('hasStructuralAmbiguity: composes the paragraph checks across the doc', () => {
    const cleanDoc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain content' }] }],
    }
    expect(hasStructuralAmbiguity(cleanDoc)).toBe(false)

    const ambiguousTextDoc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'has *bold*' }] }],
    }
    expect(hasStructuralAmbiguity(ambiguousTextDoc)).toBe(true)

    const headingStartDoc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '## Tasks' }] }],
    }
    expect(hasStructuralAmbiguity(headingStartDoc)).toBe(true)

    // Edge case: empty doc has no ambiguity.
    expect(hasStructuralAmbiguity({ type: 'doc' })).toBe(false)
  })
})

// -- Serializer-level idempotence firewall (#711 zero-edit rewrite) -----------

/**
 * A golden corpus of realistic *stored* markdown — the shape of strings that
 * actually live in the database/content layer. Each snippet exercises one or
 * more of the constructs the #898 alphabet extension targets: headings,
 * ordered / unordered lists, tables, strike / highlight / underline, links,
 * inline code & code blocks, blockquotes, nested marks, and hard breaks.
 *
 * These are NOT random — they are hand-authored canonical forms (already a
 * serializer fixed point) so the guard below is a tight, fast firewall rather
 * than a fuzzer. It complements the property tests above.
 */
const GOLDEN_CORPUS: readonly string[] = [
  // Headings
  '# Heading one',
  '## Heading two\n### Heading three',
  '# Title\nA paragraph beneath the title.',
  // Unordered list
  '- alpha\n- beta\n- gamma',
  '- item with **bold**\n- item with `code`',
  // Ordered list
  '1. first\n2. second\n3. third',
  '1. **bold item**\n2. *italic item*',
  // Tables
  '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |',
  '| **Header** | *Cell* |\n| --- | --- |\n| a | b |',
  // Table with escaped pipe in a cell
  '| A\\|B | plain |\n| --- | --- |\n| 1\\|2 | ok |',
  // Strike / highlight / underline (the non-CommonMark marks)
  '~~deleted~~',
  '==important==',
  '<u>underlined</u>',
  'mix of ~~strike~~ and ==highlight== and <u>underline</u>',
  // Nested marks (underline outermost, then bold/italic, then strike/highlight)
  '<u>**bold underline**</u>',
  '**bold and ~~struck~~ together**',
  // Mark-nesting order is canonicalized on the first pass (italic ends up
  // outside highlight: `*==highlighted italic==*`) and stable thereafter —
  // the firewall asserts the SECOND pass is byte-identical, not that the input
  // is already canonical.
  '==*highlighted italic*==',
  // Links
  '[external link](https://example.com)',
  'see [the docs](https://example.com/docs) for more',
  // Inline code & code blocks
  'use `inline code` here',
  '```js\nconst x = 1\nconsole.log(x)\n```',
  '```\nplain fenced block\n```',
  // Code block whose content contains a backtick run (variable-length fence)
  '````\na ``` fence inside\n````',
  // Blockquotes
  '> a simple quote',
  '> line one\n> line two',
  '> **strong** quote with [a link](https://example.com)',
  // Callout (blockquote variant)
  '> [!INFO] an informational callout',
  // Hard break inside a paragraph
  'line one\\\nline two',
  // Tokens (tag_ref / block_link)
  '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]',
  '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]',
  // Mixed realistic document
  '# Project notes\n\nSome intro text.',
  // Literal `[ ]` is outside the locked subset, so it is escaped to `\[ \]` on
  // the first pass (the serializer has no task-list checkbox); stable after.
  '## Tasks\n- [ ] one\n- [ ] two',
  // Plain paragraphs
  'just a plain paragraph with no markup at all',
  'a paragraph\nfollowed by another paragraph',
]

describe('serializer idempotence firewall: serialize(parse(x)) is a byte-for-byte fixed point (#711)', () => {
  /**
   * The #711 "zero-edit rewrite" guarantee at the serializer boundary: once a
   * stored string has been normalized by one parse→serialize pass, a SECOND
   * pass must be byte-identical. If this ever drifts, opening-and-closing a
   * document silently rewrites its bytes — the exact corruption class behind
   * #710/#711. We assert on the serialized string (not the parsed structure)
   * because the *bytes* are what get written back to storage.
   */
  it.each(GOLDEN_CORPUS.map((md, i) => [i, md] as const))(
    'corpus[%i] stabilizes after one normalization pass',
    (_i, md) => {
      const once = serialize(parse(md))
      const twice = serialize(parse(once))
      expect(twice).toBe(once)
    },
  )

  it('the whole corpus concatenated into one document is also a fixed point', () => {
    // Realistic stored content is multi-block; concatenating exercises
    // block-boundary interactions (e.g. a heading immediately after a table)
    // that single snippets miss.
    const combined = GOLDEN_CORPUS.join('\n\n')
    const once = serialize(parse(combined))
    const twice = serialize(parse(once))
    expect(twice).toBe(once)
  })
})
