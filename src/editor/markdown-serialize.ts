/**
 * Serialize half of the markdown serializer (PM doc → Markdown).
 *
 * Extracted from the original `markdown-serializer.ts` monolith
 * (REVIEW-LATER MAINT-117). The public API is still exposed via the
 * `markdown-serializer.ts` barrel — every existing
 * `import { serialize } from './markdown-serializer'` site continues to
 * resolve unchanged.
 *
 * Zero external dependencies. O(n) in the document size.
 */

import { toast } from 'sonner'
import { t } from '../lib/i18n'
import { logger } from '../lib/logger'
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
  // CommonMark: pick a fence longer than the longest run of backticks in the
  // code, so the closing fence cannot collide with content. Default to 3.
  const runs = code.match(/`+/g)
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${code}\n${fence}`
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
