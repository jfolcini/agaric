/**
 * Serialize half of the markdown serializer (PM doc → Markdown).
 *
 * Extracted from the original `markdown-serializer.ts` monolith
 *. The public API is still exposed via the
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
 * Structured log + per-session dedup) that extracted out of
 * this file.
 */

import { isAutolinkableUrl, scanBareUrl, underscoreRunFlank, WORD_CHAR_RE } from './markdown-common'
import type {
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
  TextNode,
} from './types'

// -- Serialize (PM doc → Markdown) --------------------------------------------

/**
 * Whether a literal `$` at index `i` in `s` would open an inline-math span on
 * the next parse (#1437) — i.e. the following char is a non-space, non-digit
 * (a digit is currency like `$5`, which the parser leaves literal). Such a `$`
 * is escaped to `\$` so it survives the round-trip as text, never math.
 */
function dollarOpensMath(s: string, i: number): boolean {
  const next = i + 1 < s.length ? (s[i + 1] as string) : ''
  return next !== '' && next !== ' ' && next !== '\t' && !/[0-9]/.test(next)
}

/**
 * Single-char escapes whose verdict is context-free: the char is always
 * rewritten to `\<char>` regardless of neighbours. `|` is the table-cell
 * separator AND the table block gate (`startsWith('|')`); `*`/`` ` ``/`~`/`=`
 * are mark/code/strike/highlight delimiters; `[`/`]` open/close link labels;
 * `\` itself doubles. Kept as a table so the per-char loop stays flat.
 */
const ALWAYS_ESCAPE: Record<string, string> = {
  '\\': '\\\\',
  '*': '\\*',
  '`': '\\`',
  '~': '\\~',
  '=': '\\=',
  '|': '\\|',
  '[': '\\[',
  ']': '\\]',
}

/**
 * Defuse a bare `http(s)://…` URL inside PLAIN (unlinked) text so it does not
 * re-autolink on the next parse (#1441). Returns the escaped slice + the index
 * to resume from when `s[i]` opens such a URL at a left boundary, else `null`.
 * We escape the scheme colon (`https\://…`): `\:` round-trips to `:`, but
 * `https\:/` no longer matches the `://` autolink trigger. Only fires at a left
 * boundary (start of node or non-word char before), mirroring the parser's
 * autolink left-flank rule, so we never touch an intraword `http`.
 */
function escapeBareUrl(s: string, i: number): { text: string; next: number } | null {
  const ch = s[i]
  if (ch !== 'h' && ch !== 'H') return null
  if (scanBareUrl(s, i) === -1) return null
  const before = i > 0 ? (s[i - 1] as string) : null
  if (before !== null && WORD_CHAR_RE.test(before)) return null
  const colon = s.indexOf(':', i)
  return { text: `${s.slice(i, colon)}\\:`, next: colon }
}

/**
 * Escape verdict for a single char at index `i` whose decision depends on the
 * surrounding text. Returns the replacement string, or `null` to emit the char
 * verbatim. Mirrors the per-rule comments inline below.
 */
function escapeContextChar(s: string, i: number): string | null {
  const ch = s[i] as string
  // `$` is the inline-math delimiter (#1437). Escape a literal `$` exactly when
  // the parser's inline-math OPEN rule could fire — next char is non-space,
  // non-digit (a digit means currency like `$5`, left literal). `\$` round-trips
  // back to `$`, so this is lossless and stops `$x … $` re-parsing as math.
  if (ch === '$') return dollarOpensMath(s, i) ? '\\$' : null
  // `_` is an emphasis delimiter (GFM) — escape exactly the runs the parser's
  // flanking rule could treat as delimiters (#710-1), so `_foo_` survives the
  // round-trip while intraword underscores (`snake_case`) stay readable.
  // `'unknown'` edges: this node may be concatenated with neighboring marked
  // nodes, so a run at a node edge is escaped pessimistically. Inserted escapes
  // never flip a flank verdict: every escapable char is punctuation, like `\`.
  if (ch === '_') {
    const { canOpen, canClose } = underscoreRunFlank(s, i, 'unknown')
    return canOpen || canClose ? '\\_' : null
  }
  // `<u>` / `</u>` are the underline storage tokens (#211 P2-5) — escape the
  // leading `<` so literal angle-bracket text round-trips as text instead of
  // re-parsing into an underline mark.
  if (ch === '<' && (s.slice(i + 1, i + 3) === 'u>' || s.slice(i + 1, i + 4) === '/u>')) {
    return '\\<'
  }
  // `#` before `[` could be confused with tag_ref `#[ULID]` — escape the `#`.
  if (ch === '#' && s[i + 1] === '[') return '\\#'
  // `!` before `[` is the image discriminator (#1434): `![…](…)` parses as an
  // image, so a LITERAL `!` preceding a `[` must be escaped or it turns `!` +
  // a literal `[…]` into an image on reparse. (`\!` decodes back to `!`, so the
  // escape is lossless; an interior `!` NOT before `[` stays readable.) The
  // cross-NODE case is defused at the node join in `serializeInlineNodes`.
  if (ch === '!' && s[i + 1] === '[') return '\\!'
  return null
}

function escapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string
    const url = escapeBareUrl(s, i)
    if (url) {
      out += url.text
      i = url.next
      continue
    }
    const always = ALWAYS_ESCAPE[ch]
    if (always !== undefined) {
      out += always
      continue
    }
    const ctx = escapeContextChar(s, i)
    out += ctx ?? ch
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

/**
 * Raw concatenated text of a link span (link mark already stripped) when it is
 * made up entirely of plain text nodes carrying NO other marks — else `null`.
 * Used to decide whether a `text === href` link can be emitted as a bare URL
 * (#1441), comparing against the unescaped href.
 */
function linkSpanPlainText(nodes: readonly InlineNode[]): string | null {
  let out = ''
  for (const node of nodes) {
    if (node.type !== 'text') return null
    if (node.marks && node.marks.length > 0) return null
    out += node.text
  }
  return out
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
    const last = groups.length > 0 ? groups.at(-1) : null
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

/**
 * Escape the alt text of an `![alt](url)` image (#1434). The alt is an opaque
 * string (not parsed for marks on the way back in), so only the chars that would
 * break the `![…]` label shape on reparse are escaped: a literal `\` is doubled
 * (so it does not consume the next char as an escape on parse) and a literal `]`
 * is backslash-escaped (so it does not close the alt label early). `scanEscape`
 * / `scanBalancedClose` honour both, so the alt round-trips exactly.
 */
function escapeImageAlt(alt: string): string {
  let out = ''
  for (const ch of alt) {
    if (ch === '\\' || ch === ']') out += `\\${ch}`
    else out += ch
  }
  return out
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
  // Inline math (#1437): emit the raw LaTeX wrapped in `$…$`. The LaTeX is not
  // escaped (it is verbatim math source, taken raw by the parser between the
  // delimiters); a math node never carries text marks, so it behaves as an atom.
  if (child.type === 'math_inline') {
    return serializeInlineAtom(`$${child.attrs.latex}$`, activeMarks)
  }
  // Image (#1434): emit `![alt](url)`. The alt is escaped for the chars that
  // could break the `![…](…)` shape on reparse (`\` and `]`); the URL reuses the
  // link serializer's `escapeUrl` (unbalanced-paren backslash escaping). An
  // image is an atom and never carries text marks, so it serializes as an atom.
  if (child.type === 'image') {
    const alt = escapeImageAlt(child.attrs.alt)
    return serializeInlineAtom(`![${alt}](${escapeUrl(child.attrs.src)})`, activeMarks)
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
    const piece = serializeInlineChild(child, activeMarks, onUnknownNode)
    // Cross-node image-discriminator guard (#1434): if the running output ends
    // with a LITERAL `!` and the next node serializes to a `[`-leading token
    // (a link group never reaches here, but a `block_link` `[[ULID]]` does), the
    // concatenation `!` + `[…` would reparse as an image. `escapeText` already
    // handles `![` within a single text node; this defuses the seam between
    // nodes. A trailing `\!` (already escaped) ends in `!` too but is preceded
    // by a backslash, so it is left alone.
    result = defuseImageSeam(result, piece)
  }

  // Close any remaining open marks
  result += emitCloseAll(activeMarks)

  return result
}

/**
 * Append `piece` to `result`, escaping a trailing literal `!` on `result` when
 * `piece` starts with `[` so the seam cannot reparse as an `![…](…)` image
 * (#1434). A `!` already part of a `\!` escape (preceded by an odd backslash
 * run) is left untouched.
 */
function defuseImageSeam(result: string, piece: string): string {
  if (result.endsWith('!') && piece.startsWith('[') && !endsWithEscapedBang(result)) {
    return `${result.slice(0, -1)}\\!${piece}`
  }
  return result + piece
}

/** Whether `result` ends with a `\!` escape (odd run of backslashes before the `!`). */
function endsWithEscapedBang(result: string): boolean {
  if (!result.endsWith('!')) return false
  let n = 0
  let i = result.length - 2
  while (i >= 0 && result[i] === '\\') {
    n++
    i--
  }
  return n % 2 === 1
}

/**
 * Serialize a paragraph's inline content.
 *
 * Groups consecutive nodes by link mark, wrapping linked spans in [text](url).
 */
/**
 * GFM task-list markers for each `todo_state` (#1435). TODO/DONE are standard
 * GFM (`[ ]`/`[x]`); DOING/CANCELLED reuse the Obsidian-Tasks extension
 * markers (`[/]`/`[-]`) so the full TODO→DOING→DONE→CANCELLED cycle survives
 * a markdown round-trip without polluting the task text with keywords.
 */
const TASK_MARKER: Record<NonNullable<ParagraphNode['attrs']>['todoState'], string> = {
  TODO: '- [ ] ',
  DOING: '- [/] ',
  DONE: '- [x] ',
  CANCELLED: '- [-] ',
}

function serializeParagraph(node: ParagraphNode, onUnknownNode?: (type: string) => void): string {
  const taskPrefix = node.attrs?.todoState ? TASK_MARKER[node.attrs.todoState] : ''

  if (!node.content || node.content.length === 0) {
    // An empty task block still emits its checkbox marker so the state
    // round-trips; the trailing space is trimmed to keep `- [ ]` canonical.
    return taskPrefix ? taskPrefix.trimEnd() : ''
  }

  const groups = groupByLink(node.content)
  let result = ''

  for (const group of groups) {
    if (group.href !== null) {
      // Serialize inner content with link marks stripped, then wrap
      const stripped = group.nodes.map(stripLinkMark)
      // Lossless round-trip for autolinks (#1441): a link whose RAW visible
      // text is exactly its href and which the importer would re-autolink in
      // full is emitted as the bare URL, so an imported `https://x.com`
      // survives round-tripping instead of bloating to `[url](url)`. We compare
      // the raw text (not the escaped `inner`, which defuses the URL) and
      // require the span to be a single plain text node (no other marks).
      const rawText = linkSpanPlainText(stripped)
      if (rawText !== null && rawText === group.href && isAutolinkableUrl(group.href)) {
        result = defuseImageSeam(result, group.href)
      } else {
        const inner = serializeInlineNodes(stripped, onUnknownNode)
        // A link group leads with `[`, so a literal `!` ending the previous
        // group would reparse as an image (#1434) — defuse the seam.
        result = defuseImageSeam(result, `[${inner}](${escapeUrl(group.href)})`)
      }
    } else {
      result = defuseImageSeam(result, serializeInlineNodes(group.nodes, onUnknownNode))
    }
  }

  // A paragraph whose text begins with a leading BLOCK marker would re-parse
  // as that other block kind, breaking serialize→parse→serialize idempotence
  // (#711): the first serialize emits the marker verbatim, the reparse turns
  // the paragraph into a heading / ordered list / bullet list, and the second
  // serialize then escapes the marker — a byte drift. Escape the marker on the
  // way out so the text stays a paragraph. The parser accepts `\#`, `\.` and
  // `\-` as literal escapes (`-` was made escapable for #1436; `\>` is still
  // NOT recognized, but the parser only produces a blockquote from `> `, and
  // `escapeText` already escapes a leading `|` table gate plus every literal
  // `*` (so a `* ` bullet marker can never lead a paragraph). Heading,
  // ordered-list and bullet-list (`- `) are the remaining gaps closed here.
  // Only the START of the paragraph can trigger a block production (hard-break
  // continuation lines are consumed by the paragraph parser before any block
  // production sees them).
  const escaped = result
    .replace(/^(\d+)\. /, '$1\\. ')
    .replace(/^(#{1,6}) /, '\\$1 ')
    .replace(/^- /, '\\- ')
  // The task prefix (#1435) is prepended AFTER block-marker escaping so the
  // leading-`-` escape only sees the user text, never our own `- [ ] ` marker.
  return taskPrefix + escaped
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

/**
 * Block (display) math (#1437): emit the LaTeX as a `$$`-fenced block. The
 * multi-line form (`$$` / body / `$$`) is canonical and round-trips through
 * `parseMathBlock`. The LaTeX body is emitted verbatim (it is raw math source).
 */
function serializeMathBlock(node: MathBlockNode): string {
  return `$$\n${node.attrs.latex}\n$$`
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
      if (child.type === 'bulletList') return serializeBulletList(child, onUnknownNode)
      if (child.type === 'horizontalRule') return serializeHorizontalRule(child)
      if (child.type === 'math_block') return serializeMathBlock(child)
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
        // Trim surrounding whitespace from the serialized cell BEFORE pipe-
        // escaping: the table parser trims each cell (`c.trim()` in
        // parseTable), so a cell whose content has leading/trailing spaces
        // (e.g. paragraph text ending in `"2. "`) would serialize to
        // `...2.  |`, re-parse to the trimmed `...2.`, and re-serialize to
        // `...2. |` — a one-space drift that breaks serialize→parse→serialize
        // idempotence (#711). Trimming here makes the emitted cell already the
        // parser-canonical form, so the round-trip is a fixed point. (Interior
        // whitespace is untouched; only the cell boundaries are normalized,
        // matching the parser.)
        const text =
          cell.content && cell.content.length > 0
            ? escapeCellPipes(
                cell.content
                  .map((p) => serializeParagraph(p as ParagraphNode, onUnknownNode))
                  .join(' ')
                  .trim(),
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

// Nested lists (created by `Tab`/`sinkListItem`) are indented by this many
// spaces per level. The parser dedents by the same width, so indented lists
// round-trip without loss (#1513). Two spaces is the bullet-marker width and
// is enough for the parser to recognize a continuation line.
const LIST_NEST_INDENT = '  '

/** Prefix every line of `text` with `indent`. */
function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n')
}

/**
 * Serialize one list item: its leading paragraph(s) followed by any nested
 * `bulletList`/`orderedList` children, each indented one level. The item's
 * marker (e.g. `- ` or `3. `) is supplied by the caller and prefixed to the
 * first line; nested lines are indented one level so they round-trip back into
 * the same nested structure (#1513).
 */
function serializeListItem(
  item: ListItemNode,
  marker: string,
  onUnknownNode?: (type: string) => void,
): string {
  const lines: string[] = []
  for (const child of item.content ?? []) {
    if (child.type === 'orderedList') {
      lines.push(indentLines(serializeOrderedList(child, onUnknownNode), LIST_NEST_INDENT))
    } else if (child.type === 'bulletList') {
      lines.push(indentLines(serializeBulletList(child, onUnknownNode), LIST_NEST_INDENT))
    } else {
      lines.push(serializeParagraph(child, onUnknownNode))
    }
  }
  return `${marker}${lines.join('\n')}`
}

function serializeOrderedList(
  node: OrderedListNode,
  onUnknownNode?: (type: string) => void,
): string {
  if (!node.content || node.content.length === 0) return ''
  return node.content
    .map((item: ListItemNode, idx: number) =>
      serializeListItem(item, `${idx + 1}. `, onUnknownNode),
    )
    .join('\n')
}

function serializeBulletList(node: BulletListNode, onUnknownNode?: (type: string) => void): string {
  if (!node.content || node.content.length === 0) return ''
  return node.content
    .map((item: ListItemNode) => serializeListItem(item, '- ', onUnknownNode))
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
      if (node.type === 'bulletList') return serializeBulletList(node, onUnknownNode)
      if (node.type === 'horizontalRule') return serializeHorizontalRule(node)
      if (node.type === 'math_block') return serializeMathBlock(node)
      const unknownType = (node as { type: string }).type
      onUnknownNode?.(unknownType)
      return ''
    })
    .join('\n')
}
