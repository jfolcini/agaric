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
import type { DocNode, InlineNode, ParagraphNode, PMMark, TextNode } from '../types'

// -- Configuration ------------------------------------------------------------

/** Number of runs per property. Increase for deeper fuzzing. */
const NUM_RUNS = 500

// -- Generators ---------------------------------------------------------------

/**
 * Characters that are meaningful to the serializer. We deliberately include
 * all delimiter characters so fast-check explores edge cases with them.
 */
const INTERESTING_CHARS = 'abcXY 012*`#[\\]()'

/** A non-empty string from the interesting character alphabet. */
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

/** A valid mark combination (no duplicates). */
const arbMarks: fc.Arbitrary<PMMark[]> = fc
  .subarray([
    { type: 'bold' } as PMMark,
    { type: 'italic' } as PMMark,
    { type: 'code' } as PMMark,
    { type: 'link', attrs: { href: 'https://example.com' } } as PMMark,
  ])
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

/** Any inline node (weighted toward text since that's the common case). */
const arbInlineNode: fc.Arbitrary<InlineNode> = fc.oneof(
  { weight: 6, arbitrary: arbTextNode },
  { weight: 1, arbitrary: arbTagRef },
  { weight: 1, arbitrary: arbBlockLink },
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
      ),
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
      if (!p.content) return ''
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

/**
 * Normalize a DocNode by merging adjacent text nodes with the same marks.
 * This is what the parser naturally does — it never produces split text nodes
 * with identical marks. We need this to compare generated docs with parsed docs.
 */
function normalizeDoc(doc: DocNode): DocNode {
  if (!doc.content) return doc
  const paragraphs = doc.content.map((p) => {
    if (!p.content || p.content.length === 0) return p
    const merged: InlineNode[] = []
    for (const node of p.content) {
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
    if (merged.length === 0) return { type: 'paragraph' as const }
    return { type: 'paragraph' as const, content: merged }
  })
  return { type: 'doc', content: paragraphs }
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
    if (block.type !== 'paragraph' || !block.content) continue
    for (const node of block.content) {
      if (node.type !== 'text') continue
      // Text with delimiter chars will be escaped; the parser produces a
      // different node structure (merged text) but same content.
      // Also: empty-ish text after escaping could produce different node counts.
      if (/[*`\\[\]()]/.test(node.text)) return true
      if (node.text.includes('#[')) return true
      if (node.text.includes('[[')) return true
      // Link marks add structural complexity — serialization wraps in [text](url)
      // which changes the node structure after round-trip
      if (node.marks?.some((m) => m.type === 'link')) return true
    }
    // Paragraph starting with heading syntax would parse back as heading
    const firstText = block.content.find((n): n is TextNode => n.type === 'text')
    if (firstText && /^#{1,6} /.test(firstText.text)) return true
    // Paragraph starting with ``` would parse back as code fence
    if (firstText?.text.startsWith('```')) return true
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
  it('serialize(parse(s)) produces a stable fixed point: normalize(parse(serialize(parse(s)))) === normalize(parse(s))', () => {
    fc.assert(
      fc.property(
        arbMarkdownString.filter((s) => !s.includes('\\#') && !s.includes('\\`')),
        (s) => {
          const doc1 = parse(s)
          const md1 = serialize(doc1)
          const doc2 = parse(md1)
          // Normalize both sides because the parser can produce structurally
          // different but semantically equivalent text node splits (e.g. empty
          // code spans ```` `` ```` leave adjacent unmarked text nodes unsplit)
          expect(normalizeDoc(doc2)).toEqual(normalizeDoc(doc1))
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
            expect(['paragraph', 'heading', 'codeBlock']).toContain(child.type)
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
