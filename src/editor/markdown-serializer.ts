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
  // Close marks no longer needed (inner first: italic before bold)
  if (from.has('italic') && !to.has('italic')) result += '*'
  if (from.has('bold') && !to.has('bold')) result += '**'
  // Open marks newly needed (outer first: bold before italic)
  if (to.has('bold') && !from.has('bold')) result += '**'
  if (to.has('italic') && !from.has('italic')) result += '*'
  return result
}

/** Close all active marks (inner first: italic before bold). */
function emitCloseAll(active: ReadonlySet<string>): string {
  let result = ''
  if (active.has('italic')) result += '*'
  if (active.has('bold')) result += '**'
  return result
}

/**
 * Serialize a paragraph's inline content with mark coalescing.
 *
 * Instead of wrapping each TextNode independently (which creates ambiguous
 * delimiter sequences like `*a****b****c*`), this tracks which marks are
 * currently "open" and only emits delimiters at actual mark boundaries.
 *
 * For `italic("a") + boldItalic("b") + italic("c")`:
 *   open italic → "a" → open bold → "b" → close bold → "c" → close italic
 *   = `*a**b**c*`
 */
function serializeParagraph(node: ParagraphNode): string {
  if (!node.content || node.content.length === 0) return ''

  let result = ''
  const activeMarks = new Set<string>()

  for (const child of node.content) {
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

      // Compute desired bold/italic mark set for this node
      const desired = new Set<string>()
      for (const m of marks) {
        if (m.type === 'bold' || m.type === 'italic') desired.add(m.type)
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
    } else if (child.type === 'hardBreak') {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      result += '\n'
    } else {
      result += emitCloseAll(activeMarks)
      activeMarks.clear()
      const unknown = child as { type: string }
      console.warn(`[serializer] unknown inline node type: "${unknown.type}" — stripped`)
    }
  }

  // Close any remaining open marks
  result += emitCloseAll(activeMarks)

  return result
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
      inItalic = false
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

  /* v8 ignore next -- split('\n') always yields ≥1 element; unreachable */
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
    /* v8 ignore start -- hardBreak never appears during line parsing; default is type guard */
    case 'hardBreak':
      return '\n'
    default:
      return ''
    /* v8 ignore stop */
  }
}
