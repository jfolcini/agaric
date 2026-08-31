/**
 * Tests for `block-type-convert` (#264) — the shared markdown block-type
 * conversion used by both the `/turn` slash command and the context-menu
 * "Turn into" group.
 */

import { describe, expect, it } from 'vitest'

import { doc, paragraph, text } from '@/editor/__tests__/builders'
import { parse } from '@/editor/markdown-parse'
import { MAX_MARKER_INDENT } from '@/editor/markdown-parse/vocab'
import {
  convertBlockContent,
  detectBlockType,
  stripBlockMarker,
  turnIdToBlockType,
} from '@/lib/block-type-convert'

describe('stripBlockMarker', () => {
  it('strips heading, quote, callout, ordered and bullet markers', () => {
    expect(stripBlockMarker('# heading')).toBe('heading')
    expect(stripBlockMarker('### h3')).toBe('h3')
    expect(stripBlockMarker('> quote')).toBe('quote')
    expect(stripBlockMarker('> [!INFO] note')).toBe('note')
    expect(stripBlockMarker('1. item')).toBe('item')
    expect(stripBlockMarker('- bullet')).toBe('bullet')
  })

  it('leaves plain text untouched (idempotent)', () => {
    expect(stripBlockMarker('plain text')).toBe('plain text')
    expect(stripBlockMarker(stripBlockMarker('## twice'))).toBe('twice')
  })
})

describe('detectBlockType', () => {
  it.each([
    ['plain', 'paragraph'],
    ['# h1', 'h1'],
    ['## h2', 'h2'],
    ['### h3', 'h3'],
    ['> a quote', 'quote'],
    ['> [!WARNING] careful', 'callout'],
    ['1. first', 'numbered-list'],
    ['- a bullet', 'bullet-list'],
    ['* a bullet', 'bullet-list'],
    ['+ a bullet', 'bullet-list'],
    // `---` (divider) must NOT be read as a bullet — BULLET_RE requires a space.
    ['---', 'paragraph'],
    ['```\ncode\n```', 'code'],
  ])('detects %j as %s', (content, expected) => {
    expect(detectBlockType(content)).toBe(expected)
  })

  it('falls back to paragraph for empty content', () => {
    expect(detectBlockType('')).toBe('paragraph')
  })
})

// -- #4019 follow-up: agree with the parser's marker-indent tolerance ---------
// `detectBlockType` / `stripBlockMarker` and the markdown parser must classify
// the same string the same way, or the Turn-into menu reports "paragraph" for a
// block the editor renders as a list. The parser tolerates up to
// `MAX_MARKER_INDENT` spaces before a LIST marker (CommonMark; a fourth space
// is indented-code territory), so these do too — and only for the list markers:
// heading / quote / callout productions are anchored at column 0 on both sides.
describe('marker-indent tolerance agrees with the markdown parser', () => {
  const TOLERATED = Array.from({ length: MAX_MARKER_INDENT + 1 }, (_, n) => ' '.repeat(n))
  const PAST_TOLERANCE = ' '.repeat(MAX_MARKER_INDENT + 1)

  it.each(TOLERATED)('detects a bullet indented by %j', (pad) => {
    expect(detectBlockType(`${pad}- x`)).toBe('bullet-list')
  })

  it.each(TOLERATED)('detects an ordered marker indented by %j', (pad) => {
    expect(detectBlockType(`${pad}1. x`)).toBe('numbered-list')
  })

  it.each(TOLERATED)('strips a bullet / ordered marker indented by %j', (pad) => {
    expect(stripBlockMarker(`${pad}- x`)).toBe('x')
    expect(stripBlockMarker(`${pad}1. x`)).toBe('x')
  })

  it('one space past the tolerance is plain text on both sides', () => {
    expect(detectBlockType(`${PAST_TOLERANCE}- x`)).toBe('paragraph')
    expect(detectBlockType(`${PAST_TOLERANCE}1. x`)).toBe('paragraph')
    expect(stripBlockMarker(`${PAST_TOLERANCE}- x`)).toBe(`${PAST_TOLERANCE}- x`)
    expect(stripBlockMarker(`${PAST_TOLERANCE}1. x`)).toBe(`${PAST_TOLERANCE}1. x`)
  })

  it('does NOT extend the tolerance to the column-0-anchored productions', () => {
    // The parser's heading / blockquote productions match at column 0 only, so
    // an indented one is paragraph text there and must be here too.
    expect(detectBlockType('  # h')).toBe('paragraph')
    expect(detectBlockType('  > q')).toBe('paragraph')
    expect(detectBlockType('  > [!INFO] c')).toBe('paragraph')
    expect(stripBlockMarker('  # h')).toBe('  # h')
    expect(stripBlockMarker('  > q')).toBe('  > q')
  })

  it.each([...TOLERATED, PAST_TOLERANCE])('classifies %j the same way the parser does', (pad) => {
    // The cross-check itself: same string, same verdict on both sides.
    const parsedIsList = (parse(`${pad}- x`).content?.[0]?.type ?? '') === 'bulletList'
    expect(detectBlockType(`${pad}- x`) === 'bullet-list').toBe(parsedIsList)
  })
})

describe('convertBlockContent', () => {
  it('converts a paragraph to each heading level', () => {
    expect(convertBlockContent('text', 'h1')).toBe('# text')
    expect(convertBlockContent('text', 'h3')).toBe('### text')
  })

  it('round-trips between types by stripping the prior marker first', () => {
    // h1 -> quote should not leave the hash behind
    expect(convertBlockContent('# title', 'quote')).toBe('> title')
    // quote -> paragraph removes the marker
    expect(convertBlockContent('> said', 'paragraph')).toBe('said')
    // callout -> h2
    expect(convertBlockContent('> [!INFO] hi', 'h2')).toBe('## hi')
  })

  it('converts to an info callout', () => {
    expect(convertBlockContent('heads up', 'callout')).toBe('> [!INFO] heads up')
  })

  // #4552 slice 2 — `numbered-list` / `bullet-list` no longer add a `1. ` /
  // `- ` markdown marker: list-ness moved to the `listStyle` block property
  // (the caller applies `listStyleForBlockType` + `setListStyle` alongside
  // this content edit), so the transform is marker-free, identical to
  // `'paragraph'`.
  it('numbered-list / bullet-list leave the text bare — no markdown marker', () => {
    expect(convertBlockContent('do this', 'numbered-list')).toBe('do this')
    expect(convertBlockContent('do this', 'bullet-list')).toBe('do this')
  })

  it('numbered-list / bullet-list still strip a PRIOR marker (e.g. converting off a heading)', () => {
    expect(convertBlockContent('# title', 'numbered-list')).toBe('title')
    expect(convertBlockContent('> said', 'bullet-list')).toBe('said')
  })

  it('wraps content in a fenced code block', () => {
    expect(convertBlockContent('const x = 1', 'code')).toBe('```\nconst x = 1\n```')
  })

  it('unwraps a fenced code block when converting back to paragraph', () => {
    expect(convertBlockContent('```\nconst x = 1\n```', 'paragraph')).toBe('const x = 1')
  })
})

describe('convertBlockContent — multi-line content is never dropped', () => {
  // Multi-line code blocks are the normal case: Enter inside a fence inserts
  // newlines (#725), so Turn-into must not truncate to the first line.
  const fencedMulti = '```\nline1\nline2\nline3\n```'

  it('preserves every inner line when unwrapping a multi-line code block to a paragraph', () => {
    expect(convertBlockContent(fencedMulti, 'paragraph')).toBe('line1\nline2\nline3')
  })

  it('re-marks only the first line for headings, keeping the rest', () => {
    expect(convertBlockContent(fencedMulti, 'h2')).toBe('## line1\nline2\nline3')
  })

  it('numbered-list / bullet-list keep every line bare (no marker, #4552 slice 2)', () => {
    expect(convertBlockContent(fencedMulti, 'numbered-list')).toBe('line1\nline2\nline3')
    expect(convertBlockContent(fencedMulti, 'bullet-list')).toBe('line1\nline2\nline3')
  })

  it('marks every line when converting to quote/callout so the whole block stays quoted', () => {
    expect(convertBlockContent(fencedMulti, 'quote')).toBe('> line1\n> line2\n> line3')
    expect(convertBlockContent(fencedMulti, 'callout')).toBe('> [!INFO] line1\n> line2\n> line3')
  })

  it('preserves a multi-line table verbatim when converting to paragraph', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |'
    expect(convertBlockContent(table, 'paragraph')).toBe(table)
  })

  it('preserves a multi-line math block when converting to paragraph', () => {
    expect(convertBlockContent('$$\nx^2\n$$', 'paragraph')).toBe('$$\nx^2\n$$')
  })

  it('strips the per-line quote markers when converting a multi-line quote/callout', () => {
    expect(convertBlockContent('> l1\n> l2', 'paragraph')).toBe('l1\nl2')
    expect(convertBlockContent('> [!INFO] title\n> body', 'h1')).toBe('# title\nbody')
  })

  it('keeps every line (markers stripped) when wrapping multi-line content in a code fence', () => {
    expect(convertBlockContent('> l1\n> l2', 'code')).toBe('```\nl1\nl2\n```')
  })
})

describe('turnIdToBlockType', () => {
  it('maps valid turn- ids to block-type tokens', () => {
    expect(turnIdToBlockType('turn-paragraph')).toBe('paragraph')
    expect(turnIdToBlockType('turn-h2')).toBe('h2')
    expect(turnIdToBlockType('turn-numbered-list')).toBe('numbered-list')
    expect(turnIdToBlockType('turn-bullet-list')).toBe('bullet-list')
    expect(turnIdToBlockType('turn-callout')).toBe('callout')
  })

  it('returns null for non-turn or unknown ids', () => {
    expect(turnIdToBlockType('h1')).toBeNull()
    expect(turnIdToBlockType('turn-bogus')).toBeNull()
  })
})

describe('list button — content is bare, no in-block list node (#2999, superseded by #4552 slice 2)', () => {
  // #2999 was the ORIGINAL "marker and content land on the same line" bug in
  // model A (the marker rendered on its own line above the content — a CSS
  // issue, not a doc-structure one). #4552 slice 2 supersedes model A for the
  // list button entirely: `handleNumberedList`/`handleBulletList` now call
  // `setListStyle` instead of prepending a markdown marker
  // (`useSlashCommandStructural.ts`), and `convertBlockContent` no longer
  // marks `numbered-list`/`bullet-list` targets at all — so there is no
  // longer an in-block list node for #2999's failure mode to reappear in.
  // These tests pin the NEW contract: the content transform leaves plain text
  // bare (single line in, single line out), and it parses back to a plain
  // paragraph, not a list.
  it('numbered-list: turning a plain-text block leaves the text bare, one line, one paragraph', () => {
    const markdown = convertBlockContent('buy milk', 'numbered-list')
    expect(markdown).toBe('buy milk')
    expect(markdown.split('\n')).toHaveLength(1)
    expect(parse(markdown)).toEqual(doc(paragraph(text('buy milk'))))
  })

  it('bullet-list: turning a plain-text block leaves the text bare, one line', () => {
    const markdown = convertBlockContent('buy milk', 'bullet-list')
    expect(markdown).toBe('buy milk')
    expect(markdown.split('\n')).toHaveLength(1)
  })

  it('numbered-list: clicking on an EMPTY block yields empty content, no marker', () => {
    // The most common repro path — clicking the list button on a fresh,
    // still-empty block. `readCurrentContent` returns '' here, mirrored by
    // converting from an empty string. The marker no longer lives in
    // content, so this is simply empty (`listStyleForBlockType` + the
    // separate `setListStyle` call carries the 'ordered' write).
    const markdown = convertBlockContent('', 'numbered-list')
    expect(markdown).toBe('')
    expect(markdown.split('\n')).toHaveLength(1)
    expect(parse(markdown)).toEqual(doc(paragraph()))
  })
  // The `content-regex-allow` markers on ORDERED_RE / BULLET_RE claim these
  // patterns cannot splice into user prose, because they are `^`-anchored with
  // no `g`/`m` flag and interpolate only a compile-time constant. This is that
  // claim as a test rather than as a comment: a marker-looking sequence in the
  // MIDDLE of a line must survive untouched, and so must one past the 3-space
  // tolerance. Both are the #3313 shape (a matcher eating text it should not),
  // which is what the guard exists to prevent.
  it('strips a marker only at the start of the line, never mid-prose', () => {
    expect(stripBlockMarker('see item 1. below')).toBe('see item 1. below')
    expect(stripBlockMarker('a - b - c')).toBe('a - b - c')
    expect(stripBlockMarker('Notebook - shopping list')).toBe('Notebook - shopping list')
  })

  it('leaves an over-indented marker alone, matching the parser cutoff', () => {
    // Four spaces is past MAX_MARKER_INDENT, so the parser reads it as text.
    expect(stripBlockMarker('    - x')).toBe('    - x')
    expect(stripBlockMarker('   - x')).toBe('x')
  })
})

// -- #4552 slice 1: a real marker's OWN TEXT must not be double-stripped -----
// `stripBlockMarker` used to chain `.replace()` calls, each running on the
// PREVIOUS call's output. After the real (first) marker was stripped, a LATER
// pattern in the chain could match again against the block's own leftover
// text and strip a second, purely coincidental "marker" that was never
// structural — silently losing those literal characters. A block's text is
// legitimately allowed to start with `- ` or `1. ` once its real marker is
// gone (`list-ergonomics.md:181-188`).
describe('#4552 slice 1: only the real (first) marker is stripped', () => {
  it('a heading titled with a literal ordered-list prefix keeps its text intact', () => {
    expect(stripBlockMarker('# 1. groceries')).toBe('1. groceries')
    expect(convertBlockContent('# 1. groceries', 'paragraph')).toBe('1. groceries')
  })

  it('a heading titled with a literal bullet prefix keeps its text intact', () => {
    expect(stripBlockMarker('# - to buy')).toBe('- to buy')
    expect(convertBlockContent('# - to buy', 'paragraph')).toBe('- to buy')
  })

  it('an ordered-list item whose text starts with a literal bullet keeps it', () => {
    expect(stripBlockMarker('1. - grocery item')).toBe('- grocery item')
  })

  it('a quote whose body starts with a literal bullet keeps it', () => {
    expect(stripBlockMarker('> - quoted dash')).toBe('- quoted dash')
  })

  it('a quote whose body starts with a literal ordered prefix keeps it', () => {
    expect(stripBlockMarker('> 1. quoted number')).toBe('1. quoted number')
  })
})

// -- #4072: a callout-shaped link is a QUOTE, on both sides ------------------
// A link whose visible text begins with `!` serializes to `[!a](url)` — the
// exact bytes of a `[!TYPE]` marker with a destination glued on. The parser was
// taught to refuse that one follower (`CALLOUT_RE` in `markdown-parse/vocab.ts`
// grew a `(?!\()`), so this module has to refuse it too: otherwise the
// Turn-into menu highlights "Callout" for a block the editor renders as a plain
// quote, and `stripBlockMarker` eats the `[!a]` that IS the link's text.
describe('#4072: `[!x](…)` is a link, not a callout marker', () => {
  const LINK = '> [!a](https://example.com)a'

  it('detects it as a quote, not a callout', () => {
    expect(detectBlockType(LINK)).toBe('quote')
    expect(detectBlockType('> [!a](https://example.com)')).toBe('quote')
  })

  it('strips only the `> `, leaving the link intact', () => {
    expect(stripBlockMarker(LINK)).toBe('[!a](https://example.com)a')
    expect(convertBlockContent(LINK, 'paragraph')).toBe('[!a](https://example.com)a')
  })

  it('agrees with the parser about which one it is', () => {
    // The cross-check, not a restatement of the regex: same string, same
    // verdict here and in the markdown parser.
    const calloutTypeOf = (md: string) =>
      (parse(md).content?.[0] as { attrs?: { calloutType?: string } } | undefined)?.attrs
        ?.calloutType ?? null
    expect(calloutTypeOf(LINK)).toBeNull()
    expect(detectBlockType(LINK)).toBe('quote')
    expect(calloutTypeOf('> [!INFO] hi')).toBe('info')
    expect(detectBlockType('> [!INFO] hi')).toBe('callout')
  })

  it('a real marker keeps working — only a `(` follower is refused', () => {
    expect(detectBlockType('> [!NOTE] t')).toBe('callout')
    expect(detectBlockType('> [!NOTE]')).toBe('callout')
    // …including a real callout whose BODY starts with such a link
    expect(stripBlockMarker('> [!INFO] [!a](https://example.com)a')).toBe(
      '[!a](https://example.com)a',
    )
  })
})
