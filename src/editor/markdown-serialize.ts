/**
 * Serialize half of the markdown serializer (PM doc → Markdown).
 *
 * Extracted from the original `markdown-serializer.ts` monolith
 * (MAINT-117). The public API is still exposed via the
 * `markdown-serializer.ts` barrel — every existing
 * `import { serialize } from './markdown-serializer'` site continues to
 * resolve unchanged.
 *
 * Zero external dependencies. O(n) in the document size.
 *
 * Unknown node types (anything outside the locked block/inline grammar)
 * are dropped from the output. Callers who want a user-facing notification
 * pass an `onUnknownNode` callback to `serialize`; see the
 * `markdown-serialize-toast` helper for the production wiring (toast +
 * structured log + per-session dedup) that MAINT-183 extracted out of
 * this file.
 */

import { underscoreRunFlank } from './markdown-common'
import type {
  BlockquoteNode,
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
  TextNode,
} from './types'

// -- Serialize (PM doc → Markdown) --------------------------------------------

function escapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    // `|` is the table-cell separator AND the table block gate
    // (`startsWith('|')`) — unescaped it can turn a paragraph into a table
    // on reparse (#710-4).
    if (ch === '*' || ch === '`' || ch === '~' || ch === '=' || ch === '|') {
      out += `\\${ch}`
      continue
    }
    // `_` is an emphasis delimiter (GFM) — escape exactly the runs the
    // parser's flanking rule could treat as delimiters (#710-1), so a
    // literal `_foo_` survives the round-trip while intraword underscores
    // (`snake_case`) stay readable and unescaped. `'unknown'` edges: this
    // node may be concatenated with neighboring marked nodes, so a run at a
    // node edge is escaped pessimistically. Inserted backslash escapes never
    // flip a flank verdict: every escapable char is punctuation (non-word,
    // non-whitespace), exactly like the backslash replacing it.
    if (ch === '_') {
      const { canOpen, canClose } = underscoreRunFlank(s, i, 'unknown')
      out += canOpen || canClose ? `\\${ch}` : ch
      continue
    }
    // `<u>` / `</u>` are the underline storage tokens (#211 P2-5) — escape the
    // leading `<` so literal angle-bracket text round-trips as text instead of
    // re-parsing into an underline mark.
    if (ch === '<' && (s.slice(i + 1, i + 3) === 'u>' || s.slice(i + 1, i + 4) === '/u>')) {
      out += '\\<'
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
  // Close marks no longer needed (inner first → outer last: highlight, strike,
  // italic, bold, then underline which is the outermost wrapper).
  if (from.has('highlight') && !to.has('highlight')) result += '=='
  if (from.has('strike') && !to.has('strike')) result += '~~'
  if (from.has('italic') && !to.has('italic')) result += '*'
  if (from.has('bold') && !to.has('bold')) result += '**'
  if (from.has('underline') && !to.has('underline')) result += '</u>'
  // Open marks newly needed (outer first → inner last: underline, then bold,
  // italic, strike, highlight).
  if (to.has('underline') && !from.has('underline')) result += '<u>'
  if (to.has('bold') && !from.has('bold')) result += '**'
  if (to.has('italic') && !from.has('italic')) result += '*'
  if (to.has('strike') && !from.has('strike')) result += '~~'
  if (to.has('highlight') && !from.has('highlight')) result += '=='
  return result
}

/** Close all active marks (inner first → outer last; underline outermost). */
function emitCloseAll(active: ReadonlySet<string>): string {
  let result = ''
  if (active.has('highlight')) result += '=='
  if (active.has('strike')) result += '~~'
  if (active.has('italic')) result += '*'
  if (active.has('bold')) result += '**'
  if (active.has('underline')) result += '</u>'
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
 *
 * Balanced parens are handled by the parser's depth tracking
 * (`scanBalancedClose`), so they stay raw. Unbalanced parens are
 * backslash-escaped — `scanBalancedClose` honours `\x` pairs, so an escaped
 * paren neither opens nor closes the link URL. Literal backslashes are
 * doubled so `unescapeUrl` can decode unambiguously.
 *
 * #710-6: the previous implementation percent-encoded an unbalanced `)` as
 * `%29`, and `unescapeUrl` decoded EVERY `%29` — corrupting URLs in which the
 * user literally typed `%29`. Backslash escaping is invertible without
 * touching user-typed percent sequences.
 */
function escapeUrl(url: string): string {
  // Pass 1: find the unbalanced parens (unmatched `)` and unclosed `(`).
  const unbalanced = new Set<number>()
  const openStack: number[] = []
  for (let i = 0; i < url.length; i++) {
    const ch = url[i]
    if (ch === '(') {
      openStack.push(i)
    } else if (ch === ')') {
      if (openStack.length > 0) openStack.pop()
      else unbalanced.add(i)
    }
  }
  for (const i of openStack) unbalanced.add(i)
  // Pass 2: emit, escaping backslashes and the unbalanced parens.
  let result = ''
  for (let i = 0; i < url.length; i++) {
    const ch = url[i]
    if (ch === '\\') result += '\\\\'
    else if (unbalanced.has(i)) result += `\\${ch}`
    else result += ch
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
 * Wrap inline-code content in a backtick run that cannot collide with
 * backticks inside the content (#710-2). CommonMark: pick a delimiter run
 * one longer than the longest backtick run in the content, and pad with a
 * single space when the content starts/ends with a backtick (or with a
 * space, which the parser would otherwise strip).
 */
function serializeInlineCode(text: string): string {
  const runs = text.match(/`+/g)
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0
  const fence = '`'.repeat(longest + 1)
  // Pad when the content could be confused with the delimiter (leading or
  // trailing backtick) or when a boundary space would be stripped by the
  // parser's CommonMark space-trimming rule. All-space content is NOT
  // padded — the parser only strips when the trimmed content is non-empty.
  const needsPad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    ((text.startsWith(' ') || text.endsWith(' ')) && text.trim() !== '')
  return needsPad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`
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
    return serializeInlineAtom(serializeInlineCode(child.text), activeMarks)
  }

  // Compute desired bold/italic/strike/highlight mark set for this node
  const desired = markSetFromMarks(marks)

  // Emit delimiters for any mark changes, update state, then emit text
  const transition = emitMarkTransition(activeMarks, desired)
  activeMarks.clear()
  for (const m of desired) activeMarks.add(m)
  return transition + escapeText(child.text)
}

/** Pull the bold/italic/strike/highlight/underline subset out of a mark list. */
function markSetFromMarks(marks: readonly PMMark[]): Set<string> {
  const desired = new Set<string>()
  for (const m of marks) {
    if (
      m.type === 'bold' ||
      m.type === 'italic' ||
      m.type === 'strike' ||
      m.type === 'highlight' ||
      m.type === 'underline'
    ) {
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
function serializeInlineChild(
  child: InlineNode,
  activeMarks: Set<string>,
  onUnknownNode?: (type: string) => void,
): string {
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
  // #710-5: a CommonMark backslash hard break (`\` + newline) — distinct from
  // the bare `\n` block separator, so a Shift+Enter line break round-trips as
  // ONE paragraph instead of being split into two blocks on blur. The parser
  // recognises an odd trailing-backslash run (escapeText doubles literal
  // backslashes, so serializer output can only end a line with an odd run via
  // this token).
  if (child.type === 'hardBreak') return serializeInlineAtom('\\\n', activeMarks)
  const unknown = child as { type: string }
  onUnknownNode?.(unknown.type)
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
function serializeInlineNodes(
  nodes: readonly InlineNode[],
  onUnknownNode?: (type: string) => void,
): string {
  let result = ''
  const activeMarks = new Set<string>()

  for (const child of nodes) {
    result += serializeInlineChild(child, activeMarks, onUnknownNode)
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
function serializeParagraph(node: ParagraphNode, onUnknownNode?: (type: string) => void): string {
  if (!node.content || node.content.length === 0) return ''

  const groups = groupByLink(node.content)
  let result = ''

  for (const group of groups) {
    if (group.href !== null) {
      // Serialize inner content with link marks stripped, then wrap
      const stripped = group.nodes.map(stripLinkMark)
      const inner = serializeInlineNodes(stripped, onUnknownNode)
      result += `[${inner}](${escapeUrl(group.href)})`
    } else {
      result += serializeInlineNodes(group.nodes, onUnknownNode)
    }
  }

  // A paragraph whose text begins with an ordered-list marker (`N. `) would
  // re-parse as an orderedList — escape the dot (the parser accepts `\.`)
  // so the text stays a paragraph. Only the start of the paragraph can
  // trigger the list production (hard-break continuation lines are consumed
  // by the paragraph parser before the list production ever sees them).
  return result.replace(/^(\d+)\. /, '$1\\. ')
}

function serializeHeading(node: HeadingNode, onUnknownNode?: (type: string) => void): string {
  const prefix = `${'#'.repeat(node.attrs.level)} `
  if (!node.content || node.content.length === 0) return prefix
  return (
    prefix + serializeParagraph({ type: 'paragraph', content: [...node.content] }, onUnknownNode)
  )
}

function serializeCodeBlock(node: CodeBlockNode): string {
  const code = node.content?.[0]?.text ?? ''
  const lang = node.attrs?.language ?? ''
  // CommonMark: pick a fence longer than the longest run of backticks in the
  // code, so the closing fence cannot collide with content. Default to 3.
  const runs = code.match(/`+/g)
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${code}\n${fence}`
}

function serializeBlockquote(node: BlockquoteNode, onUnknownNode?: (type: string) => void): string {
  if (!node.content || node.content.length === 0) {
    if (node.attrs?.calloutType) {
      return `> [!${node.attrs.calloutType.toUpperCase()}]`
    }
    return '> '
  }
  // Recursively serialize each child block, then prefix every line with "> "
  const inner = node.content
    .map((child) => {
      if (child.type === 'paragraph') return serializeParagraph(child, onUnknownNode)
      if (child.type === 'heading') return serializeHeading(child, onUnknownNode)
      if (child.type === 'codeBlock') return serializeCodeBlock(child)
      if (child.type === 'blockquote') return serializeBlockquote(child, onUnknownNode)
      if (child.type === 'table') return serializeTable(child, onUnknownNode)
      if (child.type === 'orderedList') return serializeOrderedList(child, onUnknownNode)
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

/**
 * Escape any `|` in a serialized cell that is not already escaped, scanning
 * escape-aware (`\x` pairs are copied verbatim). `escapeText` already emits
 * `\|` for plain text (#710-4), so this pass only catches pipes from paths
 * that bypass `escapeText` — inline-code content and link URLs.
 */
function escapeCellPipes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1]
      i++
      continue
    }
    out += ch === '|' ? '\\|' : ch
  }
  return out
}

function serializeTable(node: TableNode, onUnknownNode?: (type: string) => void): string {
  if (!node.content || node.content.length === 0) return ''
  const rows = node.content
  const serializedRows: string[][] = []

  for (const row of rows) {
    const cells: string[] = []
    if (row.content) {
      for (const cell of row.content) {
        // A markdown table cell is single-line, but Enter inside a table
        // (#725) can leave multiple paragraphs in a PM cell — serialize all
        // of them (joined with a space) instead of silently dropping
        // everything after the first.
        const text =
          cell.content && cell.content.length > 0
            ? escapeCellPipes(
                cell.content
                  .map((p) => serializeParagraph(p as ParagraphNode, onUnknownNode))
                  .join(' '),
              )
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

function serializeOrderedList(
  node: OrderedListNode,
  onUnknownNode?: (type: string) => void,
): string {
  if (!node.content || node.content.length === 0) return ''
  return node.content
    .map((item: ListItemNode, idx: number) => {
      const inner =
        item.content && item.content.length > 0
          ? item.content.map((p) => serializeParagraph(p, onUnknownNode)).join('\n')
          : ''
      return `${idx + 1}. ${inner}`
    })
    .join('\n')
}

function serializeHorizontalRule(_node: HorizontalRuleNode): string {
  return '---'
}

export function serialize(doc: DocNode, onUnknownNode?: (type: string) => void): string {
  if (!doc.content || doc.content.length === 0) return ''
  return doc.content
    .map((node) => {
      if (node.type === 'paragraph') return serializeParagraph(node, onUnknownNode)
      if (node.type === 'heading') return serializeHeading(node, onUnknownNode)
      if (node.type === 'codeBlock') return serializeCodeBlock(node)
      if (node.type === 'blockquote') return serializeBlockquote(node, onUnknownNode)
      if (node.type === 'table') return serializeTable(node, onUnknownNode)
      if (node.type === 'orderedList') return serializeOrderedList(node, onUnknownNode)
      if (node.type === 'horizontalRule') return serializeHorizontalRule(node)
      const unknownType = (node as { type: string }).type
      onUnknownNode?.(unknownType)
      return ''
    })
    .join('\n')
}
