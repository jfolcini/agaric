/**
 * Markdown serializer for the block-notes content format (ADR-20).
 *
 * Converts between ProseMirror JSON documents and a locked Markdown subset:
 *   marks:  **bold**  *italic*  `code`
 *   tokens: #[ULID]  [[ULID]]
 *
 * Zero external dependencies. O(n) in both directions.
 */

import type {
  BlockLinkNode,
  DocNode,
  InlineNode,
  ParagraphNode,
  PMMark,
  TagRefNode,
  TextNode,
} from './types'

// -- Constants ----------------------------------------------------------------

const ULID_RE = /^[0-9A-Z]{26}$/

/** Stable mark ordering: bold before italic before code. */
const MARK_ORDER: Record<string, number> = { bold: 0, italic: 1, code: 2 }

// -- Serialize (PM doc → Markdown) --------------------------------------------

function escapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    if (ch === '*' || ch === '`') {
      out += `\\${ch}`
      continue
    }
    // #[ could be confused with tag_ref — escape the # as \#[
    if (ch === '#' && i + 1 < s.length && s[i + 1] === '[') {
      out += '\\#['
      i++ // skip [
      continue
    }
    // [[ could be confused with block_link — escape as \[[
    if (ch === '[' && i + 1 < s.length && s[i + 1] === '[') {
      out += '\\[['
      i++ // skip second [
      continue
    }
    out += ch
  }
  return out
}

function sortedMarks(marks: readonly PMMark[]): readonly PMMark[] {
  if (marks.length <= 1) return marks
  return [...marks].sort((a, b) => (MARK_ORDER[a.type] ?? 99) - (MARK_ORDER[b.type] ?? 99))
}

function serializeTextNode(node: TextNode): string {
  const marks = node.marks ? sortedMarks(node.marks) : []
  const hasCode = marks.some((m) => m.type === 'code')

  // Code mark: content is literal (no escaping inside backticks)
  if (hasCode) {
    return `\`${node.text}\``
  }

  let result = escapeText(node.text)
  // Wrap in marks from inside out (last mark in sorted order wraps first)
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    if (m.type === 'bold') result = `**${result}**`
    else if (m.type === 'italic') result = `*${result}*`
  }
  return result
}

function serializeInlineNode(node: InlineNode): string {
  switch (node.type) {
    case 'text':
      return serializeTextNode(node)
    case 'tag_ref':
      return `#[${node.attrs.id}]`
    case 'block_link':
      return `[[${node.attrs.id}]]`
    case 'hardBreak':
      return '\n'
    default: {
      const unknown = node as { type: string }
      console.warn(`[serializer] unknown inline node type: "${unknown.type}" — stripped`)
      return ''
    }
  }
}

function serializeParagraph(node: ParagraphNode): string {
  if (!node.content || node.content.length === 0) return ''
  return node.content.map(serializeInlineNode).join('')
}

export function serialize(doc: DocNode): string {
  if (!doc.content || doc.content.length === 0) return ''
  return doc.content
    .map((node) => {
      if (node.type === 'paragraph') return serializeParagraph(node)
      console.warn(`[serializer] unknown top-level node type: "${node.type}" — stripped`)
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

function tryConsumeToken(s: Scanner): TagRefNode | BlockLinkNode | null {
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
  return null
}

function flushText(buf: string, marks: readonly PMMark[], nodes: InlineNode[]): string {
  if (buf.length > 0) {
    const node: TextNode = { type: 'text', text: buf }
    if (marks.length > 0) nodes.push({ ...node, marks: [...marks] })
    else nodes.push(node)
  }
  return ''
}

export function parse(markdown: string): DocNode {
  if (markdown.length === 0) return { type: 'doc' }

  const lines = markdown.split('\n')
  const paragraphs: ParagraphNode[] = []

  for (const line of lines) {
    const nodes: InlineNode[] = []
    const s: Scanner = { src: line, pos: 0 }
    let buf = ''
    let inBold = false
    let inItalic = false
    let inCode = false

    // Track positions where marks were opened so we can revert if unclosed
    let boldOpenPos = -1
    let italicOpenPos = -1
    // Snapshots of nodes array length at mark open (for unclosed mark revert)
    let boldOpenNodeLen = 0
    let italicOpenNodeLen = 0
    let codeOpenNodeLen = 0

    function currentMarks(): PMMark[] {
      const m: PMMark[] = []
      if (inBold) m.push({ type: 'bold' })
      if (inItalic) m.push({ type: 'italic' })
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
        if (next === '*' || next === '`' || next === '\\' || next === '#' || next === '[') {
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
      inCode = false
    }

    if (inItalic) {
      const revertedNodes = nodes.splice(italicOpenNodeLen)
      buf = `*${revertedNodes.map(nodeToPlainText).join('')}${buf}`
      inItalic = false
      if (inBold && boldOpenPos > italicOpenPos) {
        inBold = false
      }
    }

    if (inBold) {
      const revertedNodes = nodes.splice(boldOpenNodeLen)
      buf = `**${revertedNodes.map(nodeToPlainText).join('')}${buf}`
      inBold = false
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

    if (nodes.length === 0) {
      paragraphs.push({ type: 'paragraph' })
    } else {
      paragraphs.push({ type: 'paragraph', content: nodes })
    }
  }

  if (paragraphs.length === 0) return { type: 'doc' }
  return { type: 'doc', content: paragraphs }
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
    case 'hardBreak':
      return '\n'
    default:
      return ''
  }
}
