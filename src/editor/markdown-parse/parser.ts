/**
 * The co-recursive Markdown → PM parser core: block-level productions
 * (`parse` and the `parseX` productions) and the per-line inline scanner
 * (`parseLine` and the `scanX` token scanners).
 *
 * Block and inline parsing are mutually recursive — block productions parse
 * their inline content via `parseLine`, and an external-link display text is
 * re-parsed via `parse` (`consumeExternalLink`) — so they live together in one
 * module; splitting them would close an import cycle. Constants, the scanner
 * primitive, the result/state shapes and the parse-independent pure helpers
 * live in the `./vocab` leaf.
 *
 * Extracted from the original `markdown-parse.ts` monolith. The
 * public API is still exposed via the `markdown-parse.ts` barrel.
 *
 * Zero external dependencies. O(n) in the input length.
 */

import { logger } from '../../lib/logger'
import { scanBareUrl, underscoreRunFlank, WORD_CHAR_RE } from '../markdown-common'
import type {
  BlockLevelNode,
  BlockquoteNode,
  BulletListNode,
  CodeBlockNode,
  DocNode,
  HeadingNode,
  HorizontalRuleNode,
  InlineNode,
  ListItemNode,
  MathBlockNode,
  OrderedListNode,
  ParagraphNode,
  PMMark,
  TableNode,
  TableRowNode,
  TodoState,
} from '../types'
import {
  BULLET_ITEM_RE,
  BULLET_TASK_RE,
  buildCodeBlock,
  CALLOUT_RE,
  createInlineState,
  currentMarks,
  flushBuf,
  type InlineState,
  type LinkMatch,
  MAX_LINK_SCAN,
  MAX_PARSE_DEPTH,
  nodeToPlainText,
  peek,
  probeExternalLink,
  scanBalancedClose,
  type Scanner,
  TASK_ITEM_RE,
  TASK_MARKER_TO_STATE,
  trailingBackslashRun,
  tryConsumeToken,
  type BlockParseResult,
  unescapeImageAlt,
  unescapeUrl,
} from './vocab'

// -- External link parsing ----------------------------------------------------

/**
 * Consume a matched external link and return InlineNode[] with link marks applied.
 * Parses inner display text recursively for bold/italic/code/tokens.
 *
 * `depth` tracks the current recursion depth in `parse()` — it is incremented
 * when delegating to `parse(match.displayText, depth + 1)` so pathological
 * nested-link inputs cannot blow the stack.
 */
function consumeExternalLink(
  s: Scanner,
  match: LinkMatch,
  outerMarks: PMMark[],
  depth: number,
): InlineNode[] {
  s.pos = match.endPos
  const href = unescapeUrl(match.url)
  const linkMark: PMMark = { type: 'link' as const, attrs: { href } }

  if (match.displayText.length === 0) {
    // Empty display text — use URL as text
    const marks = [...outerMarks, linkMark]
    return [{ type: 'text', text: href, marks }]
  }

  // Parse inner display text (handles bold/italic/code/tokens)
  const innerDoc = parse(match.displayText, depth + 1)
  const innerContent = innerDoc.content?.[0]?.content as readonly InlineNode[] | undefined

  if (!innerContent || innerContent.length === 0) {
    const marks = [...outerMarks, linkMark]
    return [{ type: 'text', text: match.displayText, marks }]
  }

  // Apply outer marks + link mark to all text nodes. Strip any link mark the
  // inner parse produced (a bare URL in the display text autolinks during the
  // recursive parse) — a link cannot nest a link in the schema, so the OUTER
  // link wins and the autolink is discarded (#1441).
  return innerContent.map((node: InlineNode): InlineNode => {
    if (node.type === 'text') {
      const existing = (node.marks ?? []).filter((m) => m.type !== 'link') as PMMark[]
      const marks = [...outerMarks, ...existing, linkMark]
      return { type: 'text', text: node.text, marks }
    }
    // tag_ref, block_link, hardBreak — can't apply marks to atom nodes
    return node
  })
}

// -- Main parser --------------------------------------------------------------

/**
 * Fenced code block. CommonMark variable-length fence: opening fence is a run
 * of 3+ backticks optionally followed by an info string (the language). The
 * info string may not contain backticks (CommonMark §4.5). The closing fence
 * is a line containing only a run of backticks at least as long as the
 * opening, optionally followed by trailing whitespace.
 */
export function parseCodeBlock(lines: readonly string[], i: number): BlockParseResult | null {
  const line = lines[i] as string
  // Opening fence: leading run of 3+ backticks, then an info string with no
  // backticks. Rejects e.g. "x```" (non-backtick before fence) and "``` ```"
  // (info string containing backticks).
  const openMatch = line.match(/^(`{3,})([^`]*)$/)
  if (!openMatch) return null
  const fenceLen = (openMatch[1] as string).length
  const rawLang = (openMatch[2] as string).trim() || null
  const language = rawLang && /^[a-zA-Z0-9_+\-#.]+$/.test(rawLang) ? rawLang : null
  const closeRe = new RegExp(`^\`{${fenceLen},}\\s*$`)
  const codeLines: string[] = []
  let j = i + 1 // skip opening fence
  while (j < lines.length && !closeRe.test(lines[j] as string)) {
    codeLines.push(lines[j] as string)
    j++
  }
  if (j < lines.length) j++ // skip closing fence
  const code = codeLines.join('\n')
  const attrs = language ? { language } : undefined
  const block: CodeBlockNode = buildCodeBlock(code, attrs)
  return { blocks: [block], consumed: j - i }
}

/**
 * Block (display) math (#1437): a `$$`-fenced block, rendered via KaTeX in
 * display mode. Two accepted forms (both round-trip; the serializer emits the
 * multi-line form):
 *
 *   - single line:  `$$ E = mc^2 $$`  (opening `$$` and closing `$$` share a line)
 *   - multi line:   a line of exactly `$$`, the LaTeX body lines, then a line
 *                   of exactly `$$`.
 *
 * The body is taken raw (the LaTeX source). An opening `$$` with no closing
 * fence falls through to `null` so the lines are parsed as ordinary text rather
 * than being silently swallowed.
 */
export function parseMathBlock(lines: readonly string[], i: number): BlockParseResult | null {
  const line = lines[i] as string
  if (!line.startsWith('$$')) return null

  // Single-line form: `$$ … $$` (closing `$$` is on the same line, after at
  // least the opening one — and the line is not the bare opening fence `$$`).
  const rest = line.slice(2)
  const closeIdx = rest.lastIndexOf('$$')
  if (closeIdx >= 0 && rest.slice(closeIdx + 2).trim() === '') {
    const latex = rest.slice(0, closeIdx).trim()
    if (latex.length > 0) {
      const block: MathBlockNode = { type: 'math_block', attrs: { latex } }
      return { blocks: [block], consumed: 1 }
    }
  }

  // Multi-line form: the opening line must be exactly `$$` (allowing trailing
  // whitespace). Anything after `$$` on the opening line that wasn't a valid
  // single-line close is treated as the first body char only if the line is the
  // bare fence — otherwise reject so we don't swallow e.g. `$$x` text.
  if (line.trim() !== '$$') return null
  const bodyLines: string[] = []
  let j = i + 1
  while (j < lines.length && (lines[j] as string).trim() !== '$$') {
    bodyLines.push(lines[j] as string)
    j++
  }
  // No closing fence found → not a math block (let the lines parse as text).
  if (j >= lines.length) return null
  j++ // consume the closing `$$`
  const latex = bodyLines.join('\n').trim()
  if (latex.length === 0) return null
  const block: MathBlockNode = { type: 'math_block', attrs: { latex } }
  return { blocks: [block], consumed: j - i }
}

/** Blockquote: `> ` prefix (optionally with a `[!TYPE]` callout marker). */
export function parseBlockquote(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  const line = lines[i] as string
  if (!line.startsWith('> ') && line !== '>') return null
  const quoteLines: string[] = []
  let j = i
  while (j < lines.length && (lines[j]?.startsWith('> ') || lines[j] === '>')) {
    quoteLines.push(lines[j] === '>' ? '' : (lines[j]?.slice(2) as string))
    j++
  }
  const calloutType = extractCalloutType(quoteLines)
  const innerDoc = parse(quoteLines.join('\n'), depth + 1)
  const block = buildBlockquote(innerDoc.content, calloutType)
  return { blocks: [block], consumed: j - i }
}

/**
 * Detect a `[!TYPE]` callout prefix on the first line of a blockquote. When
 * found, mutates `quoteLines[0]` to strip the prefix and returns the callout
 * type (lowercased). Returns undefined when absent.
 */
function extractCalloutType(quoteLines: string[]): string | undefined {
  const calloutMatch = quoteLines[0]?.match(CALLOUT_RE)
  if (!calloutMatch) return undefined
  quoteLines[0] = calloutMatch[2] as string
  return (calloutMatch[1] as string).toLowerCase()
}

function buildBlockquote(
  content: readonly BlockLevelNode[] | undefined,
  calloutType: string | undefined,
): BlockquoteNode {
  if (!content || content.length === 0) {
    return calloutType ? { type: 'blockquote', attrs: { calloutType } } : { type: 'blockquote' }
  }
  return calloutType
    ? { type: 'blockquote', attrs: { calloutType }, content }
    : { type: 'blockquote', content }
}

/** Heading: `#`…`######` followed by a space and inline content. */
export function parseHeading(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  const line = lines[i] as string
  const headingMatch = line.match(/^(#{1,6}) (.*)$/)
  if (!headingMatch) return null
  const level = headingMatch[1]?.length as number
  const content = headingMatch[2] as string
  const inlineNodes = parseLine(content, depth)
  const block: HeadingNode =
    inlineNodes.length === 0
      ? { type: 'heading', attrs: { level } }
      : { type: 'heading', attrs: { level }, content: inlineNodes }
  return { blocks: [block], consumed: 1 }
}

/** Table: consecutive lines starting with `|`. First non-separator row is the header. */
export function parseTable(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  const line = lines[i] as string
  if (!line.startsWith('|')) return null
  const tableLines: string[] = []
  let j = i
  while (j < lines.length && lines[j]?.startsWith('|')) {
    tableLines.push(lines[j] as string)
    j++
  }
  const rows = buildTableRows(tableLines, depth)
  const consumed = j - i
  if (rows.length === 0) return { blocks: [], consumed }
  const block: TableNode = { type: 'table', content: rows }
  return { blocks: [block], consumed }
}

/**
 * Split a table row on UNESCAPED `|` separators only (#710-3). The previous
 * `.split('|')` ran before the `\|` unescape, so an escaped pipe inside a
 * cell (`a\|b`) was treated as a column boundary. Backslash pairs (`\x`) are
 * copied verbatim so `\\` (escaped backslash) never shields a real separator.
 */
function splitRowOnUnescapedPipes(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1]
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells
}

function buildTableRows(tableLines: readonly string[], depth: number): TableRowNode[] {
  const rows: TableRowNode[] = []
  for (let r = 0; r < tableLines.length; r++) {
    const tableLine = tableLines[r] as string
    // Separator rows must contain at least one `-`/`:` — a row of empty
    // cells (`|  |`, serialized from an empty-cell table row) is data, not
    // a separator, and used to be silently dropped here.
    if (/^\|[\s|]*[-:][\s\-:|]*\|$/.test(tableLine)) continue
    // Drop the leading/trailing empty segments produced by the row's outer
    // `| … |` delimiters, then trim and unescape each cell. The `\|` → `|`
    // unescape runs BEFORE parseLine so pipes inside inline code spans and
    // link URLs (which bypass scanEscape) are restored too.
    const segments = splitRowOnUnescapedPipes(tableLine)
    if (segments.length > 0 && segments[0]?.trim() === '') segments.shift()
    // Keep at least one cell so a degenerate `|` line still yields an empty
    // cell (matching the previous `.replace(...).split('|')` behaviour).
    if (segments.length > 1 && segments.at(-1)?.trim() === '') segments.pop()
    const cellTexts = segments.map((c) => c.trim().replace(/\\\|/g, '|'))
    const isHeader = r === 0
    const cells = cellTexts.map((cellText) => buildTableCell(cellText, isHeader, depth))
    rows.push({ type: 'tableRow', content: cells })
  }
  return rows
}

function buildTableCell(
  cellText: string,
  isHeader: boolean,
  depth: number,
):
  | { type: 'tableHeader'; content: ParagraphNode[] }
  | { type: 'tableCell'; content: ParagraphNode[] } {
  const content: ParagraphNode[] = cellText
    ? [{ type: 'paragraph', content: parseLine(cellText, depth) }]
    : []
  return isHeader ? { type: 'tableHeader', content } : { type: 'tableCell', content }
}

/** Horizontal rule: 3+ hyphens on their own line. */
export function parseHorizontalRule(lines: readonly string[], i: number): BlockParseResult | null {
  const line = lines[i] as string
  if (!/^-{3,}$/.test(line)) return null
  const block: HorizontalRuleNode = { type: 'horizontalRule' }
  return { blocks: [block], consumed: 1 }
}

const ORDERED_ITEM_RE = /^(\d+)\. (.*)$/

/**
 * Number of leading spaces on a line (its indentation). A line with no leading
 * space (an item marker at this list's level) has indent 0; nested content
 * lines emitted by the serializer are indented further (see LIST_NEST_INDENT
 * in markdown-serialize.ts).
 */
function leadingIndent(line: string): number {
  const m = line.match(/^ +/)
  return m ? m[0].length : 0
}

/**
 * Convert a list of paragraph lines (the first being the marker text, the rest
 * being hard-break continuations) into inline nodes, inserting a `hardBreak`
 * between successive lines. Each non-final line carries an odd trailing
 * backslash run as its hard-break marker, which is stripped before inline
 * parsing — mirroring `parseParagraph` so list-item and top-level paragraphs
 * round-trip identically (#1885).
 */
function parseHardBreakLines(textLines: readonly string[], depth: number): InlineNode[] {
  const inlineNodes: InlineNode[] = []
  for (let k = 0; k < textLines.length; k++) {
    const line = textLines[k] as string
    if (k === textLines.length - 1) {
      inlineNodes.push(...parseLine(line, depth))
    } else {
      inlineNodes.push(...parseLine(line.slice(0, -1), depth), { type: 'hardBreak' })
    }
  }
  return inlineNodes
}

/**
 * Collect the lines belonging to one list item that begins at `lines[start]`:
 * the marker line, any hard-break continuation lines (each preceding line
 * ending in an odd trailing backslash run — #1885), plus all subsequent
 * more-indented (nested) lines. Returns the item's paragraph lines (the marker
 * text followed by its continuations), the dedented nested lines, and the index
 * just past the item. `markerRe` must capture the item text in group 1 for
 * bullets and group 2 for ordered items (selected via `textGroup`).
 */
function collectListItem(
  lines: readonly string[],
  start: number,
  markerRe: RegExp,
  textGroup: number,
): { textLines: string[]; nested: string[]; next: number } | null {
  const itemMatch = (lines[start] as string).match(markerRe)
  if (!itemMatch) return null
  const textLines = [(itemMatch[textGroup] ?? '') as string]
  let j = start + 1
  // A hard break inside the item's paragraph serializes as an odd trailing
  // backslash run with the continuation on the next (unindented) line. Consume
  // those continuations into the item's paragraph so the hard break survives the
  // round-trip, exactly as `parseParagraph` does for top-level paragraphs.
  while (j < lines.length && trailingBackslashRun(textLines.at(-1) as string) % 2 === 1) {
    textLines.push(lines[j] as string)
    j++
  }
  const nestedRaw: string[] = []
  while (j < lines.length && leadingIndent(lines[j] as string) > 0) {
    nestedRaw.push(lines[j] as string)
    j++
  }
  // Dedent the nested block by its own minimum indentation so the recursive
  // parse sees the nested list at column 0 (round-trips the serializer's
  // per-level indentation; #1513).
  const minIndent = nestedRaw.reduce(
    (min, line) => Math.min(min, leadingIndent(line)),
    Number.POSITIVE_INFINITY,
  )
  const nested = Number.isFinite(minIndent)
    ? nestedRaw.map((line) => line.slice(minIndent))
    : nestedRaw
  return { textLines, nested, next: j }
}

/** Ordered list: consecutive `N. item` lines, with nested (indented) lists. */
export function parseOrderedList(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  if (!ORDERED_ITEM_RE.test(lines[i] as string)) return null
  const items: ListItemNode[] = []
  let j = i
  while (j < lines.length) {
    const collected = collectListItem(lines, j, ORDERED_ITEM_RE, 2)
    if (!collected) break
    items.push(buildListItem(collected.textLines, collected.nested, depth))
    j = collected.next
  }
  const consumed = j - i
  if (items.length === 0) return { blocks: [], consumed }
  const block: OrderedListNode = { type: 'orderedList', content: items }
  return { blocks: [block], consumed }
}

export function parseTask(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  const match = (lines[i] as string).match(TASK_ITEM_RE)
  if (!match) return null
  const todoState = TASK_MARKER_TO_STATE[match[1] as string] as TodoState
  const text = (match[2] ?? '') as string
  const inlineContent = parseLine(text, depth)
  const block: ParagraphNode =
    inlineContent.length === 0
      ? { type: 'paragraph', attrs: { todoState } }
      : { type: 'paragraph', attrs: { todoState }, content: inlineContent }
  return { blocks: [block], consumed: 1 }
}

export function parseBulletList(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  const first = lines[i] as string
  if (!BULLET_ITEM_RE.test(first) || BULLET_TASK_RE.test(first)) return null
  const items: ListItemNode[] = []
  let j = i
  while (j < lines.length) {
    const line = lines[j] as string
    if (BULLET_TASK_RE.test(line)) break
    const collected = collectListItem(lines, j, BULLET_ITEM_RE, 1)
    if (!collected) break
    items.push(buildListItem(collected.textLines, collected.nested, depth))
    j = collected.next
  }
  const consumed = j - i
  if (items.length === 0) return { blocks: [], consumed }
  const block: BulletListNode = { type: 'bulletList', content: items }
  return { blocks: [block], consumed }
}

/**
 * Build a list item from its marker text and any nested (dedented) lines. The
 * leading paragraph is always present; nested lines are recursively parsed and
 * any resulting `bulletList`/`orderedList` blocks are appended so that
 * `Tab`/`sinkListItem` nesting round-trips without loss (#1513).
 */
function buildListItem(itemTextLines: string[], nested: string[], depth: number): ListItemNode {
  const inlineContent = parseHardBreakLines(itemTextLines, depth)
  const paragraph: ParagraphNode =
    inlineContent.length === 0
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: inlineContent }
  if (nested.length === 0) {
    return { type: 'listItem', content: [paragraph] }
  }
  const nestedDoc = parse(nested.join('\n'), depth + 1)
  const nestedBlocks = nestedDoc.content ?? []
  const content: (ParagraphNode | OrderedListNode | BulletListNode)[] = [paragraph]
  for (const block of nestedBlocks) {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      content.push(block)
    }
  }
  return { type: 'listItem', content }
}

/**
 * Fallback production: paragraph. Always matches.
 *
 * A line whose trailing backslash run is odd ends with a hard-break marker
 * (#710-5) — the following line is part of the SAME paragraph, joined by a
 * `hardBreak` node, so Shift+Enter line breaks no longer split the block on
 * blur. A trailing backslash on the LAST line stays literal (CommonMark:
 * a backslash at end of input is not a hard break) — the serializer always
 * emits a newline after the marker, so this case never comes from our own
 * output.
 */
export function parseParagraph(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult {
  const inlineNodes: InlineNode[] = []
  let j = i
  for (;;) {
    const line = lines[j] as string
    if (j + 1 >= lines.length || trailingBackslashRun(line) % 2 === 0) {
      inlineNodes.push(...parseLine(line, depth))
      break
    }
    inlineNodes.push(...parseLine(line.slice(0, -1), depth), { type: 'hardBreak' })
    j++
  }
  const block: ParagraphNode =
    inlineNodes.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content: inlineNodes }
  return { blocks: [block], consumed: j - i + 1 }
}

/**
 * Dispatch to the first matching block-level production. Paragraph is the
 * always-matching fallback.
 */
function dispatchBlockProduction(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult {
  return (
    parseCodeBlock(lines, i) ??
    parseMathBlock(lines, i) ??
    parseBlockquote(lines, i, depth) ??
    parseHeading(lines, i, depth) ??
    parseTable(lines, i, depth) ??
    parseHorizontalRule(lines, i) ??
    parseOrderedList(lines, i, depth) ??
    parseTask(lines, i, depth) ??
    parseBulletList(lines, i, depth) ??
    parseParagraph(lines, i, depth)
  )
}

export function parse(markdown: string, depth = 0): DocNode {
  if (markdown.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] }
  // Depth guard: cap recursion to prevent stack overflow on pathological input
  // (deeply nested blockquotes, nested links in link display text, etc.).
  // Beyond the cap, fall back to returning the remaining input as plain text
  // so the caller always gets a valid DocNode.
  if (depth > MAX_PARSE_DEPTH) {
    // FE-L-7: log truncation at debug level to help diagnose pathological pastes.
    logger.debug('markdown-parse', 'depth limit reached, truncating', {
      depth,
      maxDepth: MAX_PARSE_DEPTH,
      length: markdown.length,
    })
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
    }
  }

  const lines = markdown.split('\n')
  const blocks: BlockLevelNode[] = []
  let i = 0
  while (i < lines.length) {
    const result = dispatchBlockProduction(lines, i, depth)
    blocks.push(...result.blocks)
    i += result.consumed
  }

  if (blocks.length === 0) return { type: 'doc' }
  return { type: 'doc', content: blocks }
}

/**
 * Code span (CommonMark §6.1, single-line subset): a run of N backticks opens
 * a span that is closed by the next run of EXACTLY N backticks. Content is
 * taken raw (no escapes, no nested marks). When the content begins AND ends
 * with a space and is not all spaces, one space is stripped from each side —
 * the serializer pads with those spaces when the content starts/ends with a
 * backtick or space (#710-2: `` `a`b` `` used to reparse corrupted; it now
 * serializes as ``` ``a`b`` ``` and round-trips).
 *
 * A run with no matching closer makes the rest of the line literal text
 * (preserving the old unclosed-backtick revert semantics).
 */
export function scanCodeSpan(st: InlineState): boolean {
  const s = st.scanner
  if (peek(s) !== '`') return false
  let runLen = 1
  while (peek(s, runLen) === '`') runLen++
  // Find the next backtick run of exactly `runLen` (longer/shorter runs are
  // content, per CommonMark).
  const src = s.src
  let i = s.pos + runLen
  while (i < src.length) {
    if (src[i] !== '`') {
      i++
      continue
    }
    let closeLen = 1
    while (src[i + closeLen] === '`') closeLen++
    if (closeLen === runLen) {
      let content = src.slice(s.pos + runLen, i)
      if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
        content = content.slice(1, -1)
      }
      flushBuf(st, currentMarks(st))
      if (content.length > 0) {
        st.nodes.push({ type: 'text', text: content, marks: [{ type: 'code' }] })
      }
      s.pos = i + closeLen
      return true
    }
    i += closeLen
  }
  // No closer: the rest of the line is literal text (delimiter included).
  st.buf += src.slice(s.pos)
  s.pos = src.length
  return true
}

/**
 * Inline math (#1437): a `$…$` span whose content is raw LaTeX, rendered via
 * KaTeX. Follows the common CommonMark-math (pandoc / remark-math) inline rule
 * so a currency amount is NOT mistaken for math:
 *
 *   - the opening `$` must be IMMEDIATELY followed by a non-space char
 *     (`$ x$` is not math) and not by a digit (`$5` is currency, not math);
 *   - the closing `$` must be IMMEDIATELY preceded by a non-space char
 *     (`$x $` is not math);
 *   - a closing `$` that is immediately followed by a digit is rejected
 *     (so `cost is $5 and $10` stays literal — the `$` between `5 and $1` is
 *     not treated as a closer);
 *   - no newline inside (line-scoped — inline parsing is per-line anyway);
 *   - an escaped `\$` inside the span does NOT close it (and `\$` outside is
 *     handled by `scanEscape`, which runs first, so a literal `\$` never
 *     reaches here).
 *
 * Empty math (`$$` with nothing between) is not inline math (it is the start of
 * a `$$` block when alone on a line; mid-line it falls through to literal text).
 * A `$` with no valid closer on the line is emitted as a literal `$`.
 */
export function scanMathInline(st: InlineState): boolean {
  const s = st.scanner
  if (peek(s) !== '$') return false
  const src = s.src
  const openNext = src[s.pos + 1] ?? ''
  // Opening `$` must be followed by a non-space, non-digit char (digit ⇒ currency).
  if (openNext === '' || openNext === ' ' || openNext === '\t' || /[0-9]/.test(openNext)) {
    return false
  }
  // Find the closing `$`, honouring `\$` escapes inside the span.
  let i = s.pos + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2 // skip the escaped char (e.g. `\$`, `\\`)
      continue
    }
    if (ch === '$') {
      const prev = src[i - 1] ?? ''
      const after = src[i + 1] ?? ''
      // Closing `$` must be preceded by a non-space and NOT followed by a digit
      // (so `$5 and $10` does not treat the 2nd `$` as a closer).
      if (prev !== ' ' && prev !== '\t' && !/[0-9]/.test(after)) {
        const latex = src.slice(s.pos + 1, i)
        if (latex.length > 0) {
          flushBuf(st, currentMarks(st))
          st.nodes.push({ type: 'math_inline', attrs: { latex } })
          s.pos = i + 1
          return true
        }
      }
      // Not a valid closer — keep scanning for a later `$`.
    }
    i++
  }
  // No valid closer on this line: emit the `$` as literal text.
  st.buf += '$'
  s.pos += 1
  return true
}

/** Backslash escape for any parser-significant char. */
export function scanEscape(st: InlineState): boolean {
  if (peek(st.scanner) !== '\\' || st.scanner.pos + 1 >= st.scanner.src.length) return false
  const next = peek(st.scanner, 1)
  if (!isEscapableChar(next)) return false
  st.buf += next
  st.scanner.pos += 2
  return true
}

function isEscapableChar(ch: string): boolean {
  return (
    ch === '*' ||
    ch === '`' ||
    ch === '\\' ||
    ch === '#' ||
    ch === '[' ||
    ch === ']' ||
    ch === '~' ||
    ch === '=' ||
    // `!` is escapable so a literal `!` immediately before `[` round-trips as
    // text instead of opening an `![alt](url)` image (#1434). `\!` emits a bare
    // `!`; any following `[…](…)` then parses as an ordinary link, never an image.
    ch === '!' ||
    // `$` is escapable so a literal dollar sign round-trips as text (`\$`)
    // instead of opening an inline-math span (#1437) — this is what keeps a
    // currency amount like `$5` literal once the serializer has escaped it.
    ch === '$' ||
    // `_`/`|` are escapable so literal underscores and pipes round-trip
    // (#710-1, #710-4) — escapeText emits `\_` / `\|` and this accepts them.
    ch === '_' ||
    ch === '|' ||
    // `.` is escapable so a paragraph beginning with `N. ` round-trips as
    // text (serialized `N\. `) instead of re-parsing as an ordered list.
    ch === '.' ||
    // `-` is escapable so a paragraph beginning with `- ` round-trips as
    // text (serialized `\- `) instead of re-parsing as a bullet list (#1436).
    ch === '-' ||
    // `<` is escapable so a literal `<u>`/`</u>` in text (serialized as `\<u>`)
    // round-trips as text instead of opening an underline mark (#211 P2-5).
    ch === '<' ||
    // `>` is escapable so a paragraph beginning with `> ` (or a bare `>`)
    // round-trips as text (serialized `\> `) instead of re-parsing as a
    // blockquote. Symmetric with `-` (#1436): no serializer output contained a
    // literal `\>` before, so accepting it here cannot break an existing pair.
    ch === '>' ||
    // `:` is escapable so the serializer can defuse a bare `http(s)://…` URL
    // that lives in PLAIN (unlinked) text — emitting the scheme colon as `\:`
    // breaks the `://` autolink trigger on reparse while `\:` round-trips back
    // to `:`. Without this, a URL substring inside escaped literal text (e.g.
    // `\](https://x.com)`) would re-autolink on the next parse, breaking
    // serialize∘parse idempotence (#1441).
    ch === ':'
  )
}

/** Atomic ref tokens: `#[ULID]`, `[[ULID]]`, `((ULID))`. */
export function scanTokenRef(st: InlineState): boolean {
  const token = tryConsumeToken(st.scanner)
  if (!token) return false
  flushBuf(st, currentMarks(st))
  st.nodes.push(token)
  return true
}

/**
 * Image (#1434): `![alt](url)`. The leading `!` is the discriminator that sets
 * an image apart from a `[text](url)` link — the `!` MUST be immediately
 * followed by `[`, and the `[…](…)` that follows must form a valid link shape
 * (balanced `]` then `(…)`). The alt text is taken raw (an opaque string; it is
 * not parsed for nested marks — an image is an atom), and the URL is unescaped
 * with the same `unescapeUrl` the link path uses so an escaped `\)` round-trips.
 *
 * A literal `\![…]` never reaches here: `scanEscape` runs first and consumes the
 * `\!` into a bare `!`, so the following `[…](…)` parses as a normal link.
 *
 * Ordered BEFORE `scanExternalLinkToken` in the scanner chain so `![x](y)` is
 * matched as an image rather than `!` + a `[x](y)` link.
 */
export function scanImage(st: InlineState): boolean {
  const s = st.scanner
  if (peek(s) !== '!' || peek(s, 1) !== '[') return false

  // Find the matching `]` for the alt label (bracket-balanced, capped).
  const altStart = s.pos + 2 // past `![`
  const maxBracketPos = Math.min(altStart + MAX_LINK_SCAN, s.src.length)
  const altEnd = scanBalancedClose(s.src, altStart, '[', ']', maxBracketPos)
  if (altEnd === -1) return false

  // Must have `(` immediately after `]`.
  if (altEnd + 1 >= s.src.length || s.src[altEnd + 1] !== '(') return false

  // Find the matching `)` for the URL (paren-balanced).
  const urlStart = altEnd + 2
  const urlEnd = scanBalancedClose(s.src, urlStart, '(', ')', s.src.length)
  if (urlEnd === -1) return false

  const alt = unescapeImageAlt(s.src.slice(altStart, altEnd))
  const src = unescapeUrl(s.src.slice(urlStart, urlEnd))

  flushBuf(st, currentMarks(st))
  st.nodes.push({ type: 'image', attrs: { alt, src } })
  s.pos = urlEnd + 1
  return true
}

/** External link: `[text](url)` when not followed by another `[`. */
export function scanExternalLinkToken(st: InlineState): boolean {
  if (peek(st.scanner) !== '[' || peek(st.scanner, 1) === '[') return false
  const match = probeExternalLink(st.scanner)
  if (!match) return false
  flushBuf(st, currentMarks(st))
  const linkNodes = consumeExternalLink(st.scanner, match, currentMarks(st), st.depth)
  st.nodes.push(...linkNodes)
  return true
}

/** Push a `[url](url)` link node (text === href) at the current cursor. */
function pushAutolink(st: InlineState, url: string): void {
  flushBuf(st, currentMarks(st))
  const linkMark: PMMark = { type: 'link' as const, attrs: { href: url } }
  st.nodes.push({ type: 'text', text: url, marks: [...currentMarks(st), linkMark] })
}

/**
 * Autolink bare `http(s)://…` URLs and `<scheme://…>` angle-bracket autolinks
 * in text runs into link marks (text === href), so importing/pasting Markdown
 * that contains a raw URL produces the SAME link mark as `[text](url)` (#1441).
 *
 * `[text](url)` and escaped brackets are handled by earlier scanners, so a URL
 * already inside link syntax is consumed before this scanner ever sees it — it
 * never double-links.
 */
export function scanAutolink(st: InlineState): boolean {
  const s = st.scanner
  const ch = peek(s)

  // `<scheme://…>` angle-bracket autolink: text and href are the inner URL.
  if (ch === '<') {
    const close = s.src.indexOf('>', s.pos + 1)
    if (close !== -1) {
      const inner = s.src.slice(s.pos + 1, close)
      // Must be a whole bare URL with no inner whitespace/`<` (scanBareUrl
      // stops at those, so requiring it consume all of `inner` enforces it).
      if (scanBareUrl(inner, 0) === inner.length && inner.length > 0) {
        pushAutolink(st, inner)
        s.pos = close + 1
        return true
      }
    }
    return false
  }

  // Bare URL. Only at a left boundary: the char before must not be a Unicode
  // word char (so `ahttps://x` / `foohttps://x` stay literal, matching GFM).
  if (ch !== 'h' && ch !== 'H') return false
  const before = s.pos > 0 ? (s.src[s.pos - 1] as string) : null
  if (before !== null && WORD_CHAR_RE.test(before)) return false
  const end = scanBareUrl(s.src, s.pos)
  if (end === -1) return false
  pushAutolink(st, s.src.slice(s.pos, end))
  s.pos = end
  return true
}

/**
 * CommonMark-aligned flanking test for an underscore delimiter run at the
 * scanner cursor (the cursor may sit mid-run if an earlier `_` was already
 * emitted as literal — e.g. the 2nd `_` of `a__b__c`). Thin wrapper over the
 * shared `underscoreRunFlank` (also used by the serializer's escape decision,
 * #710-1, so the two halves cannot drift). `*` runs use the naive asterisk
 * toggle and have no such guard.
 */
function underscoreFlank(s: Scanner): { canOpen: boolean; canClose: boolean } {
  return underscoreRunFlank(s.src, s.pos)
}

/** Bold toggle: `**` (asterisk, naive) or `__` (underscore, CommonMark flanking). */
export function scanBold(st: InlineState): boolean {
  const ch = peek(st.scanner)
  if ((ch !== '*' && ch !== '_') || peek(st.scanner, 1) !== ch) return false
  if (ch === '_') {
    // Underscore obeys CommonMark flanking; only `__` can close a `__` run.
    const { canOpen, canClose } = underscoreFlank(st.scanner)
    if (st.inBold) {
      if (st.boldDelim !== '_' || !canClose) return false
    } else if (!canOpen) {
      return false // neither a valid open nor a close → literal text
    }
  } else if (st.inBold && st.boldDelim !== '*') {
    // `*` open run can only be closed by `*` (no `__…**` crossing).
    return false
  }
  flushBuf(st, currentMarks(st))
  if (st.inBold) {
    st.inBold = false
    st.boldDelim = null
  } else {
    st.boldOpenPos = st.scanner.pos
    st.boldOpenNodeLen = st.nodes.length
    st.boldDelim = ch
    st.inBold = true
  }
  st.scanner.pos += 2
  return true
}

/** Strikethrough toggle: `~~`. */
export function scanStrike(st: InlineState): boolean {
  if (peek(st.scanner) !== '~' || peek(st.scanner, 1) !== '~') return false
  flushBuf(st, currentMarks(st))
  if (st.inStrike) {
    st.inStrike = false
  } else {
    st.strikeOpenNodeLen = st.nodes.length
    st.inStrike = true
  }
  st.scanner.pos += 2
  return true
}

/** Highlight toggle: `==`. */
export function scanHighlight(st: InlineState): boolean {
  if (peek(st.scanner) !== '=' || peek(st.scanner, 1) !== '=') return false
  flushBuf(st, currentMarks(st))
  if (st.inHighlight) {
    st.inHighlight = false
  } else {
    st.highlightOpenNodeLen = st.nodes.length
    st.inHighlight = true
  }
  st.scanner.pos += 2
  return true
}

/**
 * Underline: paired HTML tags `<u>` … `</u>` (there is no idiomatic Markdown
 * underline delimiter — #211 P2-5). Unlike the toggle marks, open and close
 * are distinct tokens, so we only open when not already inside and only close
 * when inside; a stray `<u>`/`</u>` falls through to literal text via
 * `scanPlain` and is reverted at end-of-line by `revertUnclosedMarks`.
 */
export function scanUnderline(st: InlineState): boolean {
  const s = st.scanner
  if (
    st.inUnderline &&
    peek(s) === '<' &&
    peek(s, 1) === '/' &&
    peek(s, 2) === 'u' &&
    peek(s, 3) === '>'
  ) {
    flushBuf(st, currentMarks(st))
    st.inUnderline = false
    s.pos += 4
    return true
  }
  if (!st.inUnderline && peek(s) === '<' && peek(s, 1) === 'u' && peek(s, 2) === '>') {
    flushBuf(st, currentMarks(st))
    st.underlineOpenNodeLen = st.nodes.length
    st.inUnderline = true
    s.pos += 3
    return true
  }
  return false
}

/** Italic toggle: `*` (single star) or `_` (single underscore, CommonMark flanking). */
export function scanItalic(st: InlineState): boolean {
  const ch = peek(st.scanner)
  if (ch !== '*' && ch !== '_') return false
  // `**`/`__` are bold (handled by scanBold, which runs first).
  if (ch === '_') {
    // Underscore obeys CommonMark flanking; only `_` can close a `_` run.
    const { canOpen, canClose } = underscoreFlank(st.scanner)
    if (st.inItalic) {
      if (st.italicDelim !== '_' || !canClose) return false
    } else if (!canOpen) {
      return false // neither a valid open nor a close → literal text
    }
  } else if (st.inItalic && st.italicDelim !== '*') {
    // `*` open run can only be closed by `*` (no `_…*` crossing).
    return false
  }
  flushBuf(st, currentMarks(st))
  if (st.inItalic) {
    st.inItalic = false
    st.italicDelim = null
  } else {
    st.italicOpenPos = st.scanner.pos
    st.italicOpenNodeLen = st.nodes.length
    st.italicDelim = ch
    st.inItalic = true
  }
  st.scanner.pos++
  return true
}

/** Accept any other character as literal text. */
function scanPlain(st: InlineState): void {
  st.buf += peek(st.scanner)
  st.scanner.pos++
}

/**
 * At end-of-line, revert any unclosed marks back into their literal
 * delimiter + underlying plain text. Runs in reverse order of opening so that
 * nested unclosed marks are handled correctly.
 */
function revertUnclosedMarks(st: InlineState): void {
  // (Code spans need no revert: scanCodeSpan resolves open/close eagerly and
  // emits unmatched delimiter runs as literal text on the spot.)
  if (st.inHighlight) {
    const reverted = st.nodes.splice(st.highlightOpenNodeLen)
    st.buf = `==${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
  if (st.inStrike) {
    const reverted = st.nodes.splice(st.strikeOpenNodeLen)
    st.buf = `~~${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
  revertUnclosedItalic(st)
  if (st.inBold) {
    const reverted = st.nodes.splice(st.boldOpenNodeLen)
    // Revert to the literal delimiter that opened the run (`**` or `__`).
    const lit = st.boldDelim === '_' ? '__' : '**'
    st.buf = `${lit}${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
  // Underline is the outermost mark (opened first) → reverted last so the
  // inner reverts above have already folded their nodes back into `buf`.
  if (st.inUnderline) {
    const reverted = st.nodes.splice(st.underlineOpenNodeLen)
    st.buf = `<u>${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
}

/**
 * Italic revert is the only case that interacts with bold — if bold opened
 * *inside* an unclosed italic, the bold `**` delimiter must be preserved
 * verbatim in the reverted text (and `inBold` cleared so it isn't reverted
 * a second time).
 */
function revertUnclosedItalic(st: InlineState): void {
  if (!st.inItalic) return
  const reverted = st.nodes.splice(st.italicOpenNodeLen)
  // Revert to the literal delimiter that opened each run (`*`/`_`, `**`/`__`).
  const italicLit = st.italicDelim === '_' ? '_' : '*'
  if (st.inBold && st.boldOpenPos > st.italicOpenPos) {
    const boldLit = st.boldDelim === '_' ? '__' : '**'
    const splitAt = st.boldOpenNodeLen - st.italicOpenNodeLen
    const before = reverted.slice(0, splitAt)
    const after = reverted.slice(splitAt)
    st.buf = `${italicLit}${before.map(nodeToPlainText).join('')}${boldLit}${after.map(nodeToPlainText).join('')}${st.buf}`
    st.inBold = false
  } else {
    st.buf = `${italicLit}${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
}

/**
 * Flush the trailing plain-text buffer. When the last emitted node is also an
 * unmarked text node, merge into it rather than appending a sibling — this
 * keeps `nodes` in a canonical form without adjacent unmarked text.
 */
function flushRemainingBuf(st: InlineState): void {
  if (st.buf.length === 0) return
  const last = st.nodes.length > 0 ? st.nodes.at(-1) : null
  if (last && last.type === 'text' && (!last.marks || last.marks.length === 0)) {
    ;(st.nodes.at(-1) as { text: string }).text += st.buf
  } else {
    st.nodes.push({ type: 'text', text: st.buf })
  }
}

/**
 * Parse a single line of inline content into InlineNode[].
 *
 * `depth` is threaded through so that recursive `parse()` calls inside
 * external-link display text (`consumeExternalLink`) increment the cap.
 */
function parseLine(line: string, depth = 0): InlineNode[] {
  const st = createInlineState(line, depth)
  while (st.scanner.pos < st.scanner.src.length) {
    if (scanCodeSpan(st)) continue
    if (scanEscape(st)) continue
    if (scanMathInline(st)) continue
    if (scanTokenRef(st)) continue
    if (scanImage(st)) continue
    if (scanExternalLinkToken(st)) continue
    if (scanAutolink(st)) continue
    if (scanBold(st)) continue
    if (scanStrike(st)) continue
    if (scanHighlight(st)) continue
    if (scanUnderline(st)) continue
    if (scanItalic(st)) continue
    scanPlain(st)
  }
  revertUnclosedMarks(st)
  flushRemainingBuf(st)
  return st.nodes
}
