/**
 * Markdown serializer for the agaric content format.
 *
 * Converts between ProseMirror JSON documents and a locked Markdown subset:
 *   blocks: # heading  ```code```
 *   marks:  **bold**  *italic*  `code`  [text](url)
 *   tokens: #[ULID]  [[ULID]]  ((ULID))
 *
 * Zero external dependencies. O(n) in both directions.
 */

import { toast } from 'sonner'
import { t } from '../lib/i18n'
import { logger } from '../lib/logger'
import type {
  BlockLevelNode,
  BlockLinkNode,
  BlockquoteNode,
  BlockRefNode,
  CodeBlockNode,
  DocNode,
  HeadingNode,
  HorizontalRuleNode,
  InlineNode,
  ListItemNode,
  OrderedListNode,
  ParagraphNode,
  PMMark,
  TableNode,
  TableRowNode,
  TagRefNode,
  TextNode,
} from './types'

// -- Constants ----------------------------------------------------------------

const ULID_RE = /^[0-9A-Z]{26}$/
const MAX_LINK_SCAN = 10_000
const CALLOUT_RE = /^\[!(\w+)\]\s?(.*)/i
/**
 * Maximum recursion depth for `parse()` to guard against pathological or
 * adversarial inputs (deeply nested blockquotes, link-display-text with
 * nested links, etc.). When exceeded, the input is returned as plain text
 * so the parser never blows the stack.
 */
const MAX_PARSE_DEPTH = 10

// -- Serialize (PM doc → Markdown) --------------------------------------------

/**
 * Module-scoped set of node types we've already toasted about this session.
 *
 * The serializer can be called many times per second on a typical doc; if 100
 * unknown nodes appear we don't want to spam 100 toasts. This Set rate-limits
 * to one toast per `type` per session (process lifetime).
 *
 * `logger.warn` is still emitted on every occurrence — only the user-facing
 * toast is rate-limited.
 *
 * Exported as `__resetUnknownNodeToastsForTests` so tests can reset between
 * cases. Not part of the public API.
 */
const toastedUnknownTypes = new Set<string>()

/** @internal — for tests only */
export function __resetUnknownNodeToastsForTests(): void {
  toastedUnknownTypes.clear()
}

function notifyUnknownNodeType(type: string): void {
  if (toastedUnknownTypes.has(type)) return
  toastedUnknownTypes.add(type)
  // The serializer is browser-only; sonner is mocked under vitest via the
  // global `vi.mock('sonner')` in `src/test-setup.ts`. A direct import is
  // safe and matches the rest of the codebase.
  try {
    toast.warning(t('editor.unknownNodeType', { type }))
  } catch (err) {
    // Defensive: if the toast layer is unavailable for any reason we still
    // want the serializer to succeed. The `logger.warn` already records the
    // dropped content for diagnostics.
    logger.warn('serializer', 'failed to surface unknown-node toast', { type }, err)
  }
}

function escapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    if (ch === '*' || ch === '`' || ch === '~' || ch === '=') {
      out += `\\${ch}`
      continue
    }
    // # before [ could be confused with tag_ref #[ULID] — escape the #
    if (ch === '#' && i + 1 < s.length && s[i + 1] === '[') {
      out += '\\#'
      continue
    }
    // [ could start a link or block_link — escape as \[
    if (ch === '[') {
      out += '\\['
      continue
    }
    // ] could close a link label — escape as \]
    if (ch === ']') {
      out += '\\]'
      continue
    }
    out += ch
  }
  return out
}

/**
 * Emit mark delimiters to transition from one active mark state to another.
 *
 * The parser greedily matches `**` before `*`, so we emit close delimiters
 * for inner marks first (italic before bold) and open delimiters for outer
 * marks first (bold before italic). This produces `***` at boundaries where
 * both marks change, which the parser interprets as `**` + `*` (toggle bold,
 * then toggle italic) — matching the intended semantics.
 */
function emitMarkTransition(from: ReadonlySet<string>, to: ReadonlySet<string>): string {
  let result = ''
  // Close marks no longer needed (inner first: highlight, strike, italic before bold)
  if (from.has('highlight') && !to.has('highlight')) result += '=='
  if (from.has('strike') && !to.has('strike')) result += '~~'
  if (from.has('italic') && !to.has('italic')) result += '*'
  if (from.has('bold') && !to.has('bold')) result += '**'
  // Open marks newly needed (outer first: bold, italic before strike, highlight)
  if (to.has('bold') && !from.has('bold')) result += '**'
  if (to.has('italic') && !from.has('italic')) result += '*'
  if (to.has('strike') && !from.has('strike')) result += '~~'
  if (to.has('highlight') && !from.has('highlight')) result += '=='
  return result
}

/** Close all active marks (inner first: highlight, strike, italic before bold). */
function emitCloseAll(active: ReadonlySet<string>): string {
  let result = ''
  if (active.has('highlight')) result += '=='
  if (active.has('strike')) result += '~~'
  if (active.has('italic')) result += '*'
  if (active.has('bold')) result += '**'
  return result
}

// -- Link mark helpers --------------------------------------------------------

/** Extract link href from a text node's marks (null if no link mark). */
function getLinkHref(node: InlineNode): string | null {
  if (node.type !== 'text' || !node.marks) return null
  for (const m of node.marks) {
    if (m.type === 'link') return m.attrs.href
  }
  return null
}

/** Return a copy of an InlineNode with the link mark stripped. */
function stripLinkMark(node: InlineNode): InlineNode {
  if (node.type !== 'text' || !node.marks) return node
  const marks = node.marks.filter((m) => m.type !== 'link')
  if (marks.length === 0) {
    return { type: 'text', text: node.text } as TextNode
  }
  return { ...node, marks } as TextNode
}

/** Group consecutive inline nodes by their link mark href. */
interface NodeGroup {
  href: string | null
  nodes: InlineNode[]
}

function groupByLink(content: readonly InlineNode[]): NodeGroup[] {
  const groups: NodeGroup[] = []
  for (const node of content) {
    const href = getLinkHref(node)
    const last = groups.length > 0 ? groups[groups.length - 1] : null
    if (last && last.href === href) {
      last.nodes.push(node)
    } else {
      groups.push({ href, nodes: [node] })
    }
  }
  return groups
}

/** Escape parentheses in URLs to prevent breaking `[text](url)` syntax.
 * Balanced parens are handled by the parser's depth tracking. Only
 * unbalanced `)` needs encoding.
 */
function escapeUrl(url: string): string {
  let depth = 0
  let result = ''
  for (const ch of url) {
    if (ch === '(') {
      depth++
      result += ch
    } else if (ch === ')') {
      if (depth > 0) {
        depth--
        result += ch
      } else {
        result += '%29'
      }
    } else {
      result += ch
    }
  }
  return result
}

// -- Serialize inline nodes (with mark coalescing) ----------------------------

/**
 * Emit `token` after closing all active marks, then reset the mark state.
 *
 * Used by every inline variant that is not subject to bold/italic/strike/
 * highlight marks (tag_ref, block_link, block_ref, hardBreak, and
 * unknown-node fallback). The caller provides the atom token to emit.
 */
function serializeInlineAtom(token: string, activeMarks: Set<string>): string {
  const out = emitCloseAll(activeMarks) + token
  activeMarks.clear()
  return out
}

/**
 * Serialize a single TextNode, coalescing its marks with the currently
 * active mark set. Mutates `activeMarks` to reflect the new active set
 * after this node is emitted.
 */
function serializeInlineText(child: TextNode, activeMarks: Set<string>): string {
  const marks = child.marks ?? []
  const hasCode = marks.some((m) => m.type === 'code')

  if (hasCode) {
    // Code is exclusive — close all active marks, emit backtick-wrapped content
    return serializeInlineAtom(`\`${child.text}\``, activeMarks)
  }

  // Compute desired bold/italic/strike/highlight mark set for this node
  const desired = markSetFromMarks(marks)

  // Emit delimiters for any mark changes, update state, then emit text
  const transition = emitMarkTransition(activeMarks, desired)
  activeMarks.clear()
  for (const m of desired) activeMarks.add(m)
  return transition + escapeText(child.text)
}

/** Pull the bold/italic/strike/highlight subset out of a mark list. */
function markSetFromMarks(marks: readonly PMMark[]): Set<string> {
  const desired = new Set<string>()
  for (const m of marks) {
    if (m.type === 'bold' || m.type === 'italic' || m.type === 'strike' || m.type === 'highlight') {
      desired.add(m.type)
    }
  }
  return desired
}

/**
 * Dispatch a single inline node to its per-variant serializer.
 *
 * Each variant handler is responsible for updating `activeMarks` so the
 * next node sees the correct mark state.
 */
function serializeInlineChild(child: InlineNode, activeMarks: Set<string>): string {
  if (child.type === 'text') return serializeInlineText(child, activeMarks)
  if (child.type === 'tag_ref') {
    return serializeInlineAtom(`#[${child.attrs.id}]`, activeMarks)
  }
  if (child.type === 'block_link') {
    return serializeInlineAtom(`[[${child.attrs.id}]]`, activeMarks)
  }
  if (child.type === 'block_ref') {
    return serializeInlineAtom(`((${child.attrs.id}))`, activeMarks)
  }
  if (child.type === 'hardBreak') return serializeInlineAtom('\n', activeMarks)
  const unknown = child as { type: string }
  logger.warn('serializer', `unknown inline node type: "${unknown.type}" — stripped`)
  notifyUnknownNodeType(unknown.type)
  return serializeInlineAtom('', activeMarks)
}

/**
 * Serialize a list of inline nodes with mark coalescing.
 *
 * Instead of wrapping each TextNode independently (which creates ambiguous
 * delimiter sequences like `*a****b****c*`), this tracks which marks are
 * currently "open" and only emits delimiters at actual mark boundaries.
 *
 * For `italic("a") + boldItalic("b") + italic("c")`:
 *   open italic → "a" → open bold → "b" → close bold → "c" → close italic
 *   = `*a**b**c*`
 */
function serializeInlineNodes(nodes: readonly InlineNode[]): string {
  let result = ''
  const activeMarks = new Set<string>()

  for (const child of nodes) {
    result += serializeInlineChild(child, activeMarks)
  }

  // Close any remaining open marks
  result += emitCloseAll(activeMarks)

  return result
}

/**
 * Serialize a paragraph's inline content.
 *
 * Groups consecutive nodes by link mark, wrapping linked spans in [text](url).
 */
function serializeParagraph(node: ParagraphNode): string {
  if (!node.content || node.content.length === 0) return ''

  const groups = groupByLink(node.content)
  let result = ''

  for (const group of groups) {
    if (group.href !== null) {
      // Serialize inner content with link marks stripped, then wrap
      const stripped = group.nodes.map(stripLinkMark)
      const inner = serializeInlineNodes(stripped)
      result += `[${inner}](${escapeUrl(group.href)})`
    } else {
      result += serializeInlineNodes(group.nodes)
    }
  }

  return result
}

function serializeHeading(node: HeadingNode): string {
  const prefix = `${'#'.repeat(node.attrs.level)} `
  if (!node.content || node.content.length === 0) return prefix
  return prefix + serializeParagraph({ type: 'paragraph', content: [...node.content] })
}

function serializeCodeBlock(node: CodeBlockNode): string {
  const code = node.content?.[0]?.text ?? ''
  const lang = node.attrs?.language ?? ''
  return `\`\`\`${lang}\n${code}\n\`\`\``
}

function serializeBlockquote(node: BlockquoteNode): string {
  if (!node.content || node.content.length === 0) {
    if (node.attrs?.calloutType) {
      return `> [!${node.attrs.calloutType.toUpperCase()}]`
    }
    return '> '
  }
  // Recursively serialize each child block, then prefix every line with "> "
  const inner = node.content
    .map((child) => {
      if (child.type === 'paragraph') return serializeParagraph(child)
      if (child.type === 'heading') return serializeHeading(child)
      if (child.type === 'codeBlock') return serializeCodeBlock(child)
      if (child.type === 'blockquote') return serializeBlockquote(child)
      if (child.type === 'table') return serializeTable(child)
      if (child.type === 'orderedList') return serializeOrderedList(child)
      if (child.type === 'horizontalRule') return serializeHorizontalRule(child)
      return ''
    })
    .join('\n')
  const lines = inner.split('\n')
  // Prepend [!TYPE] prefix to the first line when calloutType is set
  if (node.attrs?.calloutType) {
    const prefix = `[!${node.attrs.calloutType.toUpperCase()}]`
    lines[0] = lines[0] ? `${prefix} ${lines[0]}` : prefix
  }
  return lines.map((line) => `> ${line}`).join('\n')
}

function serializeTable(node: TableNode): string {
  if (!node.content || node.content.length === 0) return ''
  const rows = node.content
  const serializedRows: string[][] = []

  for (const row of rows) {
    const cells: string[] = []
    if (row.content) {
      for (const cell of row.content) {
        // `serializeParagraph` already routes text through `escapeText`,
        // which converts every literal `\` into `\\` before we see it
        // here. The only table-specific work left is escaping `|`, the
        // column separator. CodeQL's `js/incomplete-sanitization` flags
        // the bare `replace(/\|/g, '\\|')` because it cannot see across
        // the function boundary into `escapeText`; the alert is a known
        // false positive and is dismissed in the code-scanning UI.
        const text =
          cell.content && cell.content.length > 0
            ? serializeParagraph(cell.content[0] as ParagraphNode).replace(/\|/g, '\\|')
            : ''
        cells.push(text)
      }
    }
    serializedRows.push(cells)
  }

  if (serializedRows.length === 0) return ''

  const header = `| ${serializedRows[0]?.join(' | ')} |`
  const separator = `| ${serializedRows[0]?.map(() => '---').join(' | ')} |`
  const dataRows = serializedRows.slice(1).map((row) => `| ${row.join(' | ')} |`)

  return [header, separator, ...dataRows].join('\n')
}

function serializeOrderedList(node: OrderedListNode): string {
  if (!node.content || node.content.length === 0) return ''
  return node.content
    .map((item: ListItemNode, idx: number) => {
      const inner =
        item.content && item.content.length > 0
          ? item.content.map((p) => serializeParagraph(p)).join('\n')
          : ''
      return `${idx + 1}. ${inner}`
    })
    .join('\n')
}

function serializeHorizontalRule(_node: HorizontalRuleNode): string {
  return '---'
}

export function serialize(doc: DocNode): string {
  if (!doc.content || doc.content.length === 0) return ''
  return doc.content
    .map((node) => {
      if (node.type === 'paragraph') return serializeParagraph(node)
      if (node.type === 'heading') return serializeHeading(node)
      if (node.type === 'codeBlock') return serializeCodeBlock(node)
      if (node.type === 'blockquote') return serializeBlockquote(node)
      if (node.type === 'table') return serializeTable(node)
      if (node.type === 'orderedList') return serializeOrderedList(node)
      if (node.type === 'horizontalRule') return serializeHorizontalRule(node)
      const unknownType = (node as { type: string }).type
      logger.warn('serializer', `unknown top-level node type: "${unknownType}" — stripped`)
      notifyUnknownNodeType(unknownType)
      return ''
    })
    .join('\n')
}

// -- Parse (Markdown → PM doc) ------------------------------------------------

interface Scanner {
  readonly src: string
  pos: number
}

function peek(s: Scanner, offset = 0): string {
  return s.src[s.pos + offset] ?? ''
}

function remaining(s: Scanner): number {
  return s.src.length - s.pos
}

function tryConsumeToken(s: Scanner): TagRefNode | BlockLinkNode | BlockRefNode | null {
  // Tag ref: #[ULID]
  if (peek(s) === '#' && peek(s, 1) === '[' && remaining(s) >= 29) {
    const candidate = s.src.slice(s.pos + 2, s.pos + 28)
    if (candidate.length === 26 && ULID_RE.test(candidate) && s.src[s.pos + 28] === ']') {
      s.pos += 29
      return { type: 'tag_ref', attrs: { id: candidate } }
    }
  }
  // Block link: [[ULID]]
  if (peek(s) === '[' && peek(s, 1) === '[' && remaining(s) >= 30) {
    const candidate = s.src.slice(s.pos + 2, s.pos + 28)
    if (
      candidate.length === 26 &&
      ULID_RE.test(candidate) &&
      s.src[s.pos + 28] === ']' &&
      s.src[s.pos + 29] === ']'
    ) {
      s.pos += 30
      return { type: 'block_link', attrs: { id: candidate } }
    }
  }
  // Block ref: ((ULID))
  if (peek(s) === '(' && peek(s, 1) === '(' && remaining(s) >= 30) {
    const candidate = s.src.slice(s.pos + 2, s.pos + 28)
    if (
      candidate.length === 26 &&
      ULID_RE.test(candidate) &&
      s.src[s.pos + 28] === ')' &&
      s.src[s.pos + 29] === ')'
    ) {
      s.pos += 30
      return { type: 'block_ref', attrs: { id: candidate } }
    }
  }
  return null
}

// -- External link parsing ----------------------------------------------------

/**
 * Probe for a `[text](url)` external link starting at `s.pos`.
 * Returns match details without modifying scanner state, or null on failure.
 */
interface LinkMatch {
  displayText: string
  url: string
  endPos: number
}

/**
 * Scan `src` starting at `startPos` for the character `close` that balances a
 * single open paren/bracket of type `open` (the `open` char at `startPos - 1`
 * is assumed already consumed — i.e. depth starts at 1). Tracks nesting and
 * honors backslash escapes (`\x` skips the next char). Returns the index of
 * the matching `close`, or `-1` if not found within `maxPos`.
 */
function scanBalancedClose(
  src: string,
  startPos: number,
  open: string,
  close: string,
  maxPos: number,
): number {
  let depth = 1
  for (let i = startPos; i < maxPos; i++) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length) {
      i++ // skip escaped char
      continue
    }
    if (c === open) {
      depth++
    } else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function probeExternalLink(s: Scanner): LinkMatch | null {
  if (peek(s) !== '[' || peek(s, 1) === '[') return null

  const pos = s.pos + 1 // past [

  // Find matching ] (tracking bracket depth, capped to avoid O(n) on unclosed brackets)
  const maxBracketPos = Math.min(pos + MAX_LINK_SCAN, s.src.length)
  const textEnd = scanBalancedClose(s.src, pos, '[', ']', maxBracketPos)
  if (textEnd === -1) return null

  // Must have ( immediately after ]
  if (textEnd + 1 >= s.src.length || s.src[textEnd + 1] !== '(') return null

  // Find matching ) for URL (tracking paren depth)
  const urlStart = textEnd + 2
  const urlEnd = scanBalancedClose(s.src, urlStart, '(', ')', s.src.length)
  if (urlEnd === -1) return null

  return {
    displayText: s.src.slice(pos, textEnd),
    url: s.src.slice(urlStart, urlEnd),
    endPos: urlEnd + 1,
  }
}

/**
 * Unescape a URL: decode %29 → ) for unbalanced parens that were escaped during serialization.
 */
function unescapeUrl(url: string): string {
  return url.replace(/%29/g, ')')
}

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

  // Apply outer marks + link mark to all text nodes
  return innerContent.map((node: InlineNode): InlineNode => {
    if (node.type === 'text') {
      const existing = (node.marks ?? []) as PMMark[]
      const marks = [...outerMarks, ...existing, linkMark]
      return { ...node, marks }
    }
    // tag_ref, block_link, hardBreak — can't apply marks to atom nodes
    return node
  })
}

// -- Main parser --------------------------------------------------------------

function flushText(buf: string, marks: readonly PMMark[], nodes: InlineNode[]): string {
  if (buf.length > 0) {
    const node: TextNode = { type: 'text', text: buf }
    if (marks.length > 0) nodes.push({ ...node, marks: [...marks] })
    else nodes.push(node)
  }
  return ''
}

/**
 * Result from a block-level production parser: the blocks produced (0 or more)
 * and the number of source lines consumed. A `null` return means the production
 * did not match at the current position.
 */
interface BlockParseResult {
  readonly blocks: readonly BlockLevelNode[]
  readonly consumed: number
}

/** Fenced code block: ```[lang]\n ... \n``` */
export function parseCodeBlock(lines: readonly string[], i: number): BlockParseResult | null {
  const line = lines[i] as string
  if (!line.startsWith('```')) return null
  const rawLang = line.slice(3).trim() || null
  const language = rawLang && /^[a-zA-Z0-9_+\-#.]+$/.test(rawLang) ? rawLang : null
  const codeLines: string[] = []
  let j = i + 1 // skip opening fence
  while (j < lines.length && !lines[j]?.startsWith('```')) {
    codeLines.push(lines[j] as string)
    j++
  }
  if (j < lines.length) j++ // skip closing fence
  const code = codeLines.join('\n')
  const attrs = language ? { language } : undefined
  const block: CodeBlockNode = buildCodeBlock(code, attrs)
  return { blocks: [block], consumed: j - i }
}

function buildCodeBlock(code: string, attrs: { language: string } | undefined): CodeBlockNode {
  if (code.length === 0) {
    return attrs ? { type: 'codeBlock', attrs } : { type: 'codeBlock' }
  }
  return attrs
    ? { type: 'codeBlock', attrs, content: [{ type: 'text', text: code }] }
    : { type: 'codeBlock', content: [{ type: 'text', text: code }] }
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

function buildTableRows(tableLines: readonly string[], depth: number): TableRowNode[] {
  const rows: TableRowNode[] = []
  for (let r = 0; r < tableLines.length; r++) {
    const tableLine = tableLines[r] as string
    if (/^\|[\s\-:|]+\|$/.test(tableLine)) continue
    const cellTexts = tableLine
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim().replace(/\\\|/g, '|'))
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

/** Ordered list: consecutive `N. item` lines. */
export function parseOrderedList(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult | null {
  if (!/^\d+\. /.test(lines[i] as string)) return null
  const items: ListItemNode[] = []
  let j = i
  while (j < lines.length) {
    const itemMatch = (lines[j] as string).match(/^(\d+)\. (.*)$/)
    if (!itemMatch) break
    items.push(buildListItem(itemMatch[2] as string, depth))
    j++
  }
  const consumed = j - i
  if (items.length === 0) return { blocks: [], consumed }
  const block: OrderedListNode = { type: 'orderedList', content: items }
  return { blocks: [block], consumed }
}

function buildListItem(itemText: string, depth: number): ListItemNode {
  const inlineContent = parseLine(itemText, depth)
  const paragraph: ParagraphNode =
    inlineContent.length === 0
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: inlineContent }
  return { type: 'listItem', content: [paragraph] }
}

/** Fallback production: single-line paragraph. Always matches. */
export function parseParagraph(
  lines: readonly string[],
  i: number,
  depth: number,
): BlockParseResult {
  const line = lines[i] as string
  const inlineNodes = parseLine(line, depth)
  const block: ParagraphNode =
    inlineNodes.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content: inlineNodes }
  return { blocks: [block], consumed: 1 }
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
    parseBlockquote(lines, i, depth) ??
    parseHeading(lines, i, depth) ??
    parseTable(lines, i, depth) ??
    parseHorizontalRule(lines, i) ??
    parseOrderedList(lines, i, depth) ??
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
 * Mutable state for the inline scanner/parser. One instance is created per
 * `parseLine()` call and threaded through per-token scanner helpers.
 *
 * Exported for unit testing of the scanner helpers.
 */
export interface InlineState {
  readonly scanner: Scanner
  readonly depth: number
  buf: string
  readonly nodes: InlineNode[]
  inBold: boolean
  inItalic: boolean
  inCode: boolean
  inStrike: boolean
  inHighlight: boolean
  /** Position in source where the currently-open bold/italic delimiter started. */
  boldOpenPos: number
  italicOpenPos: number
  /** Snapshots of `nodes.length` at the moment a mark opened (for revert). */
  boldOpenNodeLen: number
  italicOpenNodeLen: number
  codeOpenNodeLen: number
  strikeOpenNodeLen: number
  highlightOpenNodeLen: number
}

export function createInlineState(line: string, depth: number): InlineState {
  return {
    scanner: { src: line, pos: 0 },
    depth,
    buf: '',
    nodes: [],
    inBold: false,
    inItalic: false,
    inCode: false,
    inStrike: false,
    inHighlight: false,
    boldOpenPos: -1,
    italicOpenPos: -1,
    boldOpenNodeLen: 0,
    italicOpenNodeLen: 0,
    codeOpenNodeLen: 0,
    strikeOpenNodeLen: 0,
    highlightOpenNodeLen: 0,
  }
}

/** Compute the currently active text marks from open toggle flags. */
function currentMarks(st: InlineState): PMMark[] {
  const m: PMMark[] = []
  if (st.inBold) m.push({ type: 'bold' })
  if (st.inItalic) m.push({ type: 'italic' })
  if (st.inStrike) m.push({ type: 'strike' })
  if (st.inHighlight) m.push({ type: 'highlight' })
  return m
}

/** Flush the accumulated plain-text buffer as a (possibly-marked) text node. */
function flushBuf(st: InlineState, marks: readonly PMMark[]): void {
  st.buf = flushText(st.buf, marks, st.nodes)
}

/**
 * Code span: a backtick toggles code mode. Returns `true` if consumed.
 * This helper handles both the opening/closing delimiter AND literal content
 * while inside a code span — the return value signals whether to `continue`
 * the outer loop.
 */
export function scanCodeSpan(st: InlineState): boolean {
  const ch = peek(st.scanner)
  if (ch === '`') {
    if (st.inCode) {
      flushBuf(st, [{ type: 'code' }])
      st.inCode = false
    } else {
      flushBuf(st, currentMarks(st))
      st.codeOpenNodeLen = st.nodes.length
      st.inCode = true
    }
    st.scanner.pos++
    return true
  }
  if (st.inCode) {
    st.buf += ch
    st.scanner.pos++
    return true
  }
  return false
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
    ch === '='
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

/** Bold toggle: `**`. */
export function scanBold(st: InlineState): boolean {
  if (peek(st.scanner) !== '*' || peek(st.scanner, 1) !== '*') return false
  flushBuf(st, currentMarks(st))
  if (st.inBold) {
    st.inBold = false
  } else {
    st.boldOpenPos = st.scanner.pos
    st.boldOpenNodeLen = st.nodes.length
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

/** Italic toggle: `*` (single star, not already matched as bold `**`). */
export function scanItalic(st: InlineState): boolean {
  if (peek(st.scanner) !== '*') return false
  flushBuf(st, currentMarks(st))
  if (st.inItalic) {
    st.inItalic = false
  } else {
    st.italicOpenPos = st.scanner.pos
    st.italicOpenNodeLen = st.nodes.length
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
  if (st.inCode) {
    const reverted = st.nodes.splice(st.codeOpenNodeLen)
    st.buf = `\`${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
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
    st.buf = `**${reverted.map(nodeToPlainText).join('')}${st.buf}`
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
  if (st.inBold && st.boldOpenPos > st.italicOpenPos) {
    const splitAt = st.boldOpenNodeLen - st.italicOpenNodeLen
    const before = reverted.slice(0, splitAt)
    const after = reverted.slice(splitAt)
    st.buf = `*${before.map(nodeToPlainText).join('')}**${after.map(nodeToPlainText).join('')}${st.buf}`
    st.inBold = false
  } else {
    st.buf = `*${reverted.map(nodeToPlainText).join('')}${st.buf}`
  }
}

/**
 * Flush the trailing plain-text buffer. When the last emitted node is also an
 * unmarked text node, merge into it rather than appending a sibling — this
 * keeps `nodes` in a canonical form without adjacent unmarked text.
 */
function flushRemainingBuf(st: InlineState): void {
  if (st.buf.length === 0) return
  const last = st.nodes.length > 0 ? st.nodes[st.nodes.length - 1] : null
  if (last && last.type === 'text' && (!last.marks || last.marks.length === 0)) {
    ;(st.nodes[st.nodes.length - 1] as { text: string }).text += st.buf
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
    if (scanTokenRef(st)) continue
    if (scanExternalLinkToken(st)) continue
    if (scanBold(st)) continue
    if (scanStrike(st)) continue
    if (scanHighlight(st)) continue
    if (scanItalic(st)) continue
    scanPlain(st)
  }
  revertUnclosedMarks(st)
  flushRemainingBuf(st)
  return st.nodes
}

// -- Helpers ------------------------------------------------------------------

/** Convert an inline node back to its plain-text representation (for unclosed mark revert). */
function nodeToPlainText(node: InlineNode): string {
  switch (node.type) {
    case 'text':
      return node.text
    case 'tag_ref':
      return `#[${node.attrs.id}]`
    case 'block_link':
      return `[[${node.attrs.id}]]`
    case 'block_ref':
      return `((${node.attrs.id}))`
    /* v8 ignore start -- hardBreak never appears during line parsing; default is type guard */
    case 'hardBreak':
      return '\n'
    default:
      return ''
    /* v8 ignore stop */
  }
}
