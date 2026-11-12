/**
 * In-page replace (#6608): rewrite a block's stored Markdown for matches find
 * counted over the text the block renders (`block-text.ts`).
 *
 * The block is parsed to its document, the matches are replaced in its text
 * nodes, and the document is serialised again, as a typed edit is saved, so no
 * offset in the rendered text has to be mapped back into the Markdown. A match
 * is replaced only when it lies wholly in the block's own text: one touching a
 * chip (a tag, a page link, a block reference: ids, whose shown title is not
 * the block's text), a line break or the gap between two paragraphs is left as
 * it is and counted as skipped. A match across marks (`**ne**edle`) takes the
 * marks of its first character.
 */

import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import {
  findTextPieces,
  type FindTextPiece,
  hasFindText,
  type MarkdownNode,
} from '@/lib/in-page-find/block-text'
import {
  type CompiledQuery,
  type FindOptions,
  REGEX_NODE_MAX,
  REGEX_NODE_SCAN_MAX,
} from '@/lib/in-page-find/matcher'

export interface ReplaceSpec {
  query: string
  toggles: FindOptions
  /** Inserted as typed; in regex mode `$1`, `$<name>`, `$&` and `$$` expand as in `String.replace`. */
  replacement: string
}

export interface ReplaceRange {
  start: number
  end: number
  /** What goes in place of `[start, end)`. */
  text: string
}

export interface ContentReplacement {
  /** The block's new Markdown; the input when nothing was replaced. */
  content: string
  replaced: number
  /** Matches left as they are: not wholly in the block's own text. */
  skipped: number
}

type ScanQuery = Extract<CompiledQuery, { kind: 'literal' | 'regex' }>

/** What replaces the match `[start, end)` of `text`, a block's find text or one DOM text node. */
export function replacementFor(
  text: string,
  range: { start: number; end: number },
  spec: ReplaceSpec,
): string {
  if (!spec.toggles.isRegex) return spec.replacement
  // The scan saw at most this much of the text (`scanRegex`); a lookahead must see the same.
  const scanned = text.length > REGEX_NODE_SCAN_MAX ? text.slice(0, REGEX_NODE_SCAN_MAX) : text
  // Sticky, so the one replacement `String.replace` makes is the match at `start`, expanded natively.
  // content-regex-allow: the user's own find pattern, replacing the one match find showed them
  const re = new RegExp(spec.query, spec.toggles.caseSensitive ? 'uy' : 'iuy')
  re.lastIndex = range.start
  const out = scanned.replace(re, spec.replacement)
  return out.slice(range.start, out.length - (scanned.length - range.end))
}

/** Whether `[start, end)` lies wholly in text nodes, with no chip, break or gap inside it. */
function ownText(pieces: readonly FindTextPiece[], start: number, end: number): boolean {
  // An empty piece strictly inside the range overlaps it too.
  return pieces.every((piece) => piece.node !== null || piece.start >= end || piece.end <= start)
}

function replaceIn(pieces: readonly FindTextPiece[], range: ReplaceRange): void {
  let first = true
  for (const piece of pieces) {
    if (piece.node === null || piece.end <= range.start || piece.start >= range.end) continue
    const text = piece.node.text ?? ''
    const from = Math.max(range.start - piece.start, 0)
    const to = Math.min(range.end, piece.end) - piece.start
    piece.node.text = text.slice(0, from) + (first ? range.text : '') + text.slice(to)
    first = false
  }
}

/** The ranges to replace: overlapping ones keep the first, and one not wholly own text is skipped. */
function selectRanges<R extends { start: number; end: number }>(
  pieces: readonly FindTextPiece[],
  ranges: readonly R[],
): { applied: R[]; skipped: number } {
  const applied: R[] = []
  let skipped = 0
  let reached = 0
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    if (range.start < reached) continue
    if (!ownText(pieces, range.start, range.end)) {
      skipped += 1
      continue
    }
    applied.push(range)
    reached = range.end
  }
  return { applied, skipped }
}

/** How many of `ranges` (over `content`'s find text) a replace leaves as they are. */
export function skippedMatches(
  content: string | null,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  resolveTitle: (id: string) => string,
): number {
  if (!hasFindText(content) || ranges.length === 0) return 0
  return selectRanges(findTextPieces(parse(content) as MarkdownNode, resolveTitle).pieces, ranges)
    .skipped
}

/**
 * `content` with `ranges` (over its find text, `blockFindText`) replaced.
 * Overlapping ranges keep the first; each one not wholly in the block's own
 * text is skipped.
 */
export function replaceInContent(
  content: string,
  ranges: readonly ReplaceRange[],
  resolveTitle: (id: string) => string,
): ContentReplacement {
  if (!hasFindText(content) || ranges.length === 0) return { content, replaced: 0, skipped: 0 }
  const doc = parse(content) as MarkdownNode
  const { pieces } = findTextPieces(doc, resolveTitle)
  const { applied, skipped } = selectRanges(pieces, ranges)
  if (applied.length === 0) return { content, replaced: 0, skipped }
  // Right to left: a range's offsets stay valid while only text after it has changed.
  for (const range of applied.toReversed()) replaceIn(pieces, range)
  return { content: serialize(doc as DocNode), replaced: applied.length, skipped }
}

/** Every match of `compiled` in a block, replaced as {@link replaceInContent} does. */
export function replaceAllInContent(
  content: string,
  compiled: ScanQuery,
  spec: ReplaceSpec,
  textOf: (content: string) => string,
  resolveTitle: (id: string) => string,
): ContentReplacement {
  const text = textOf(content)
  // As `findInBlocks`: a regex never runs over a block this long.
  if (compiled.kind === 'regex' && text.length > REGEX_NODE_MAX) {
    return { content, replaced: 0, skipped: 0 }
  }
  const ranges = compiled
    .matcher(text)
    .map(({ start, end }) => ({ start, end, text: replacementFor(text, { start, end }, spec) }))
  return replaceInContent(content, ranges, resolveTitle)
}

/**
 * The index in `matches` (block order, `order` giving each block's place) of
 * the first match at or after `offset` in block `blockId`, wrapping to the first
 * match; -1 when there is none. Replace moves on to it, past the text it put in.
 */
export function indexAfter(
  matches: ReadonlyArray<{ blockId: string; start: number }>,
  order: ReadonlyMap<string, number>,
  blockId: string,
  offset: number,
): number {
  if (matches.length === 0) return -1
  const at = order.get(blockId) ?? -1
  const index = matches.findIndex((m) => {
    const place = order.get(m.blockId) ?? -1
    return place > at || (place === at && m.start >= offset)
  })
  return index === -1 ? 0 : index
}
