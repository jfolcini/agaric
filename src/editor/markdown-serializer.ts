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
    if (child.type === 'text') {
      const marks = child.marks ?? []
      const hasCode = marks.some((m) => m.type === 'code')

      if (hasCode) {
        // Code is exclusive — close all active marks, emit backtick-wrapped content
        result += emitCloseAll(activeMarks)
        activeMarks.clear()
        result += `\`${child.text}\``
        continue
      }

      // Compute desired bold/italic/strike/highlight mark set for this node
      const desired = new Set<string>()
      for (const m of marks) {
        if (
          m.type === 'bold' ||
          m.type === 'italic' ||
          m.type === 'strike' ||
          m.type === 'highlight'
        )
          desired.add(m.type)
      }

      // Emit delimiters for any mark changes
      result += emitMarkTransition(activeMarks, desired)
      activeMarks.clear()
      for (const m of desired) activeMarks.add(m)

      result += escapeText(child.text)
    } else if (child.type === 'tag_ref') {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      result += `#[${child.attrs.id}]`
    } else if (child.type === 'block_link') {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      result += `[[${child.attrs.id}]]`
    } else if (child.type === 'block_ref') {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      result += `((${child.attrs.id}))`
    } else if (child.type === 'hardBreak') {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      result += '\n'
    } else {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      const unknown = child as { type: string }
      logger.warn('serializer', `unknown inline node type: "${unknown.type}" — stripped`)
    }
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
      logger.warn(
        'serializer',
        `unknown top-level node type: "${(node as { type: string }).type}" — stripped`,
      )
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

function probeExternalLink(s: Scanner): LinkMatch | null {
  if (peek(s) !== '[' || peek(s, 1) === '[') return null

  const pos = s.pos + 1 // past [

  // Find matching ] (tracking bracket depth, capped to avoid O(n) on unclosed brackets)
  const maxPos = Math.min(pos + MAX_LINK_SCAN, s.src.length)
  let depth = 1
  let textEnd = -1
  for (let i = pos; i < maxPos; i++) {
    if (s.src[i] === '\\' && i + 1 < s.src.length) {
      i++ // skip escaped char
      continue
    }
    if (s.src[i] === '[') depth++
    if (s.src[i] === ']') {
      depth--
      if (depth === 0) {
        textEnd = i
        break
      }
    }
  }

  if (textEnd === -1) return null

  // Must have ( immediately after ]
  if (textEnd + 1 >= s.src.length || s.src[textEnd + 1] !== '(') return null

  // Find matching ) for URL (tracking paren depth)
  const urlStart = textEnd + 2
  let parenDepth = 1
  let urlEnd = -1
  for (let i = urlStart; i < s.src.length; i++) {
    if (s.src[i] === '\\' && i + 1 < s.src.length) {
      i++
      continue
    }
    if (s.src[i] === '(') parenDepth++
    if (s.src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        urlEnd = i
        break
      }
    }
  }

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

export function parse(markdown: string, depth = 0): DocNode {
  if (markdown.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] }

  // Depth guard: cap recursion to prevent stack overflow on pathological input
  // (deeply nested blockquotes, nested links in link display text, etc.).
  // Beyond the cap, fall back to returning the remaining input as plain text
  // so the caller always gets a valid DocNode.
  if (depth > MAX_PARSE_DEPTH) {
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: markdown }],
        },
      ],
    }
  }

  const lines = markdown.split('\n')
  const blocks: BlockLevelNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] as string

    // Fenced code block: ```
    if (line.startsWith('```')) {
      const rawLang = line.slice(3).trim() || null
      const language = rawLang && /^[a-zA-Z0-9_+\-#.]+$/.test(rawLang) ? rawLang : null
      const codeLines: string[] = []
      i++ // skip opening fence
      while (i < lines.length && !lines[i]?.startsWith('```')) {
        codeLines.push(lines[i] as string)
        i++
      }
      if (i < lines.length) i++ // skip closing fence
      const code = codeLines.join('\n')
      const attrs = language ? { language } : undefined
      if (code.length === 0) {
        blocks.push(attrs ? { type: 'codeBlock', attrs } : { type: 'codeBlock' })
      } else {
        blocks.push(
          attrs
            ? { type: 'codeBlock', attrs, content: [{ type: 'text', text: code }] }
            : { type: 'codeBlock', content: [{ type: 'text', text: code }] },
        )
      }
      continue
    }

    // Blockquote: > prefix (collect consecutive > lines)
    if (line.startsWith('> ') || line === '>') {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i]?.startsWith('> ') || lines[i] === '>')) {
        // Strip the "> " prefix (or lone ">")
        quoteLines.push(lines[i] === '>' ? '' : (lines[i]?.slice(2) as string))
        i++
      }
      // Detect callout syntax: [!TYPE] at the start of the first line
      let calloutType: string | undefined
      const calloutMatch = quoteLines[0]?.match(CALLOUT_RE)
      if (calloutMatch) {
        calloutType = (calloutMatch[1] as string).toLowerCase()
        // Strip the [!TYPE] prefix from the first line
        quoteLines[0] = calloutMatch[2] as string
        // If the first line is now empty and it's the only line, keep it (empty paragraph)
      }
      // Recursively parse the inner content
      const innerMarkdown = quoteLines.join('\n')
      const innerDoc = parse(innerMarkdown, depth + 1)
      const content = innerDoc.content
      if (!content || content.length === 0) {
        blocks.push(
          calloutType ? { type: 'blockquote', attrs: { calloutType } } : { type: 'blockquote' },
        )
      } else {
        blocks.push(
          calloutType
            ? { type: 'blockquote', attrs: { calloutType }, content }
            : { type: 'blockquote', content },
        )
      }
      continue
    }

    // Heading: # to ######
    const headingMatch = line.match(/^(#{1,6}) (.*)$/)
    if (headingMatch) {
      const level = headingMatch[1]?.length as number
      const content = headingMatch[2] as string
      const inlineNodes = parseLine(content, depth)
      if (inlineNodes.length === 0) {
        blocks.push({ type: 'heading', attrs: { level } })
      } else {
        blocks.push({ type: 'heading', attrs: { level }, content: inlineNodes })
      }
      i++
      continue
    }

    // Table: lines starting with |
    if (line.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]?.startsWith('|')) {
        tableLines.push(lines[i] as string)
        i++
      }
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
        const cells = cellTexts.map((cellText) => {
          const content = cellText
            ? [{ type: 'paragraph' as const, content: parseLine(cellText, depth) }]
            : []
          if (isHeader) {
            return { type: 'tableHeader' as const, content }
          }
          return { type: 'tableCell' as const, content }
        })
        rows.push({ type: 'tableRow', content: cells })
      }
      if (rows.length > 0) {
        blocks.push({ type: 'table', content: rows })
      }
      continue
    }

    // Horizontal rule: --- (three or more hyphens on its own line)
    if (/^-{3,}$/.test(line)) {
      blocks.push({ type: 'horizontalRule' })
      i++
      continue
    }

    // Ordered list: 1. item, 2. item, etc.
    const olMatch = line.match(/^(\d+)\. (.*)$/)
    if (olMatch) {
      const items: {
        type: 'listItem'
        content: { type: 'paragraph'; content?: InlineNode[] }[]
      }[] = []
      while (i < lines.length) {
        const olLine = lines[i] as string
        const itemMatch = olLine.match(/^(\d+)\. (.*)$/)
        if (!itemMatch) break
        const itemText = itemMatch[2] as string
        const inlineContent = parseLine(itemText, depth)
        if (inlineContent.length === 0) {
          items.push({ type: 'listItem', content: [{ type: 'paragraph' }] })
        } else {
          items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineContent }] })
        }
        i++
      }
      if (items.length > 0) {
        blocks.push({ type: 'orderedList', content: items })
      }
      continue
    }

    // Regular paragraph
    const inlineNodes = parseLine(line, depth)
    if (inlineNodes.length === 0) {
      blocks.push({ type: 'paragraph' })
    } else {
      blocks.push({ type: 'paragraph', content: inlineNodes })
    }
    i++
  }

  if (blocks.length === 0) return { type: 'doc' }
  return { type: 'doc', content: blocks }
}

/**
 * Parse a single line of inline content into InlineNode[].
 *
 * `depth` is threaded through so that recursive `parse()` calls inside
 * external-link display text (`consumeExternalLink`) increment the cap.
 */
function parseLine(line: string, depth = 0): InlineNode[] {
  const nodes: InlineNode[] = []
  const s: Scanner = { src: line, pos: 0 }
  let buf = ''
  let inBold = false
  let inItalic = false
  let inCode = false
  let inStrike = false
  let inHighlight = false

  // Track positions where marks were opened so we can revert if unclosed
  let boldOpenPos = -1
  let italicOpenPos = -1
  // Snapshots of nodes array length at mark open (for unclosed mark revert)
  let boldOpenNodeLen = 0
  let italicOpenNodeLen = 0
  let codeOpenNodeLen = 0
  let strikeOpenNodeLen = 0
  let highlightOpenNodeLen = 0

  function currentMarks(): PMMark[] {
    const m: PMMark[] = []
    if (inBold) m.push({ type: 'bold' })
    if (inItalic) m.push({ type: 'italic' })
    if (inStrike) m.push({ type: 'strike' })
    if (inHighlight) m.push({ type: 'highlight' })
    return m
  }

  while (s.pos < s.src.length) {
    const ch = peek(s)

    // Code span: backtick toggles, everything else inside is literal
    if (ch === '`') {
      if (inCode) {
        buf = flushText(buf, [{ type: 'code' }], nodes)
        inCode = false
        s.pos++
        continue
      }
      buf = flushText(buf, currentMarks(), nodes)
      codeOpenNodeLen = nodes.length
      inCode = true
      s.pos++
      continue
    }
    if (inCode) {
      buf += ch
      s.pos++
      continue
    }

    // Escape sequences (only outside code spans)
    if (ch === '\\' && s.pos + 1 < s.src.length) {
      const next = peek(s, 1)
      if (
        next === '*' ||
        next === '`' ||
        next === '\\' ||
        next === '#' ||
        next === '[' ||
        next === ']' ||
        next === '~' ||
        next === '='
      ) {
        buf += next
        s.pos += 2
        continue
      }
    }

    // Tokens: #[ULID] and [[ULID]]
    const token = tryConsumeToken(s)
    if (token) {
      buf = flushText(buf, currentMarks(), nodes)
      nodes.push(token)
      continue
    }

    // External link: [text](url) — single [ not followed by [
    if (ch === '[' && peek(s, 1) !== '[') {
      const linkMatch = probeExternalLink(s)
      if (linkMatch) {
        buf = flushText(buf, currentMarks(), nodes)
        const linkNodes = consumeExternalLink(s, linkMatch, currentMarks(), depth)
        nodes.push(...linkNodes)
        continue
      }
    }

    // Bold: **
    if (ch === '*' && peek(s, 1) === '*') {
      if (inBold) {
        // Close bold
        buf = flushText(buf, currentMarks(), nodes)
        inBold = false
        s.pos += 2
        continue
      }
      // Open bold
      buf = flushText(buf, currentMarks(), nodes)
      boldOpenPos = s.pos
      boldOpenNodeLen = nodes.length
      inBold = true
      s.pos += 2
      continue
    }

    // Strikethrough: ~~
    if (ch === '~' && peek(s, 1) === '~') {
      if (inStrike) {
        // Close strike
        buf = flushText(buf, currentMarks(), nodes)
        inStrike = false
        s.pos += 2
        continue
      }
      // Open strike
      buf = flushText(buf, currentMarks(), nodes)
      strikeOpenNodeLen = nodes.length
      inStrike = true
      s.pos += 2
      continue
    }

    // Highlight: ==
    if (ch === '=' && peek(s, 1) === '=') {
      if (inHighlight) {
        // Close highlight
        buf = flushText(buf, currentMarks(), nodes)
        inHighlight = false
        s.pos += 2
        continue
      }
      // Open highlight
      buf = flushText(buf, currentMarks(), nodes)
      highlightOpenNodeLen = nodes.length
      inHighlight = true
      s.pos += 2
      continue
    }

    // Italic: single *
    if (ch === '*') {
      if (inItalic) {
        // Close italic
        buf = flushText(buf, currentMarks(), nodes)
        inItalic = false
        s.pos++
        continue
      }
      // Open italic
      buf = flushText(buf, currentMarks(), nodes)
      italicOpenPos = s.pos
      italicOpenNodeLen = nodes.length
      inItalic = true
      s.pos++
      continue
    }

    buf += ch
    s.pos++
  }

  // End of line: handle unclosed marks by reverting to plain text
  // Process in reverse order of opening to properly revert nested unclosed marks
  if (inCode) {
    const revertedNodes = nodes.splice(codeOpenNodeLen)
    buf = `\`${revertedNodes.map(nodeToPlainText).join('')}${buf}`
  }

  if (inHighlight) {
    const revertedNodes = nodes.splice(highlightOpenNodeLen)
    buf = `==${revertedNodes.map(nodeToPlainText).join('')}${buf}`
  }

  if (inStrike) {
    const revertedNodes = nodes.splice(strikeOpenNodeLen)
    buf = `~~${revertedNodes.map(nodeToPlainText).join('')}${buf}`
  }

  if (inItalic) {
    const revertedNodes = nodes.splice(italicOpenNodeLen)
    if (inBold && boldOpenPos > italicOpenPos) {
      // Bold was opened inside this italic — reconstruct the ** delimiter
      const splitAt = boldOpenNodeLen - italicOpenNodeLen
      const before = revertedNodes.slice(0, splitAt)
      const after = revertedNodes.slice(splitAt)
      buf = `*${before.map(nodeToPlainText).join('')}**${after.map(nodeToPlainText).join('')}${buf}`
      inBold = false
    } else {
      buf = `*${revertedNodes.map(nodeToPlainText).join('')}${buf}`
    }
  }

  if (inBold) {
    const revertedNodes = nodes.splice(boldOpenNodeLen)
    buf = `**${revertedNodes.map(nodeToPlainText).join('')}${buf}`
  }

  // Flush remaining text — merge into last node if it's an unmarked text node
  if (buf.length > 0) {
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : null
    if (last && last.type === 'text' && (!last.marks || last.marks.length === 0)) {
      ;(nodes[nodes.length - 1] as { text: string }).text += buf
    } else {
      nodes.push({ type: 'text', text: buf })
    }
  }

  return nodes
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
