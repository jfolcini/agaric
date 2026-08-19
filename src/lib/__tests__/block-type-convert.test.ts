/**
 * Tests for `block-type-convert` (#264) — the shared markdown block-type
 * conversion used by both the `/turn` slash command and the context-menu
 * "Turn into" group.
 */

import { describe, expect, it } from 'vitest'

import { doc, listItem, orderedList, paragraph, text } from '@/editor/__tests__/builders'
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

  it('converts to a numbered list and an info callout', () => {
    expect(convertBlockContent('do this', 'numbered-list')).toBe('1. do this')
    expect(convertBlockContent('heads up', 'callout')).toBe('> [!INFO] heads up')
  })

  it('converts to a bullet list and round-trips off it', () => {
    expect(convertBlockContent('do this', 'bullet-list')).toBe('- do this')
    // bullet → numbered strips the `- ` marker first
    expect(convertBlockContent('- do this', 'numbered-list')).toBe('1. do this')
    expect(convertBlockContent('- do this', 'paragraph')).toBe('do this')
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

  it('re-marks only the first line for headings and lists, keeping the rest', () => {
    expect(convertBlockContent(fencedMulti, 'h2')).toBe('## line1\nline2\nline3')
    expect(convertBlockContent(fencedMulti, 'numbered-list')).toBe('1. line1\nline2\nline3')
    expect(convertBlockContent(fencedMulti, 'bullet-list')).toBe('- line1\nline2\nline3')
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

describe('list button — marker and content land on the SAME line (#2999)', () => {
  // The toolbar/slash list button (`useSlashCommandStructural`'s
  // `handleNumberedList`/`handleBulletList`, and the `TurnIntoMenu` /
  // `TURN_INTO_BLOCK` path via `convertBlockContent`) both funnel through
  // this exact "prepend the marker to the current content" shape:
  // `` `1. ${content}` `` / `` `- ${content}` ``. These tests pin that the
  // generated markdown is a SINGLE line, and that parsing it back produces
  // exactly ONE list item with exactly ONE paragraph child — i.e. the
  // marker and the typed text belong to the same node, not two. This rules
  // out a data-model split as the cause of #2999 (the marker rendering on
  // its own line above the content): the split was a CSS
  // `list-style-position: inside` + block-level `<p>` child issue in
  // `.ProseMirror ol/ul` (src/index.css), not a markdown/doc structure bug.
  it('numbered-list: turning a plain-text block produces one line, one paragraph', () => {
    const markdown = convertBlockContent('buy milk', 'numbered-list')
    expect(markdown).toBe('1. buy milk')
    expect(markdown.split('\n')).toHaveLength(1)
    expect(parse(markdown)).toEqual(doc(orderedList(listItem(paragraph(text('buy milk'))))))
  })

  it('bullet-list: turning a plain-text block produces one line, one paragraph', () => {
    const markdown = convertBlockContent('buy milk', 'bullet-list')
    expect(markdown).toBe('- buy milk')
    expect(markdown.split('\n')).toHaveLength(1)
  })

  it('numbered-list: clicking on an EMPTY block still yields one line, one item', () => {
    // The most common repro path — clicking the list button on a fresh,
    // still-empty block. `readCurrentContent` returns '' here, mirrored by
    // converting from an empty string.
    const markdown = convertBlockContent('', 'numbered-list')
    expect(markdown).toBe('1. ')
    expect(markdown.split('\n')).toHaveLength(1)
    expect(parse(markdown)).toEqual(doc(orderedList(listItem(paragraph()))))
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
