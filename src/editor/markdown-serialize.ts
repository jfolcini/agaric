/**
 * Serialize half of the markdown serializer (PM doc → Markdown).
 *
 * Extracted from the original `markdown-serializer.ts` monolith. The
 * public API is still exposed via the
 * `markdown-serializer.ts` barrel — every existing
 * `import { serialize } from '@/editor/markdown-serializer'` site continues to
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

import {
  blockLinkToken,
  codePointAt,
  codePointBefore,
  flankClass,
  isAutolinkableUrl,
  leadingIndent,
  linkDestination,
  LIST_NEST_INDENT,
  runFlank,
  scanBareUrl,
  ULID_RE,
  underscoreNeedsEscape,
  WORD_CHAR_RE,
} from '@/editor/markdown-common'
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
  TextNode,
} from '@/editor/types'
import { TASK_STATE_TO_MARKER } from '@/lib/task-states'

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
 * rewritten to `\<char>` regardless of neighbours. `*`/`` ` `` are mark and
 * code delimiters, `[`/`]` open and close link labels, and `\` itself doubles.
 * `~`, `=` and `|` are escaped only where they would parse (#5160 N12): see
 * `delimiterRunNeedsEscape`, `escapeLeadingBlockMarker` and `escapeCellPipes`.
 */
const ALWAYS_ESCAPE: Record<string, string> = {
  '\\': '\\\\',
  '*': '\\*',
  '`': '\\`',
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
  // `_` is an emphasis delimiter (GFM) — escape every run that is not INTRAWORD
  // (#710-1, #4049), so `_foo_` survives the round-trip while `snake_case` stays
  // readable. Deliberately coarser than the parser's flanking rule, and
  // invariant under the dedents/trims/coalescing the round trip performs: see
  // `underscoreNeedsEscape`. Inserted escapes never flip the verdict — every
  // escapable char is punctuation, like `\`.
  if (ch === '_') return underscoreNeedsEscape(s, i) ? '\\_' : null
  // `<u>` / `</u>` are the underline storage tokens (#211 P2-5) — escape the
  // leading `<` so literal angle-bracket text round-trips as text instead of
  // re-parsing into an underline mark.
  if (ch === '<' && (s.slice(i + 1, i + 3) === 'u>' || s.slice(i + 1, i + 4) === '/u>')) {
    return '\\<'
  }
  // `#` before `[` could be confused with tag_ref `#[ULID]` — escape the `#`.
  if (ch === '#' && s[i + 1] === '[') return '\\#'
  // `((` + uppercase ULID + `))` is byte-identical to a live block_ref token —
  // a LITERAL occurrence in text would resurrect as a block_ref node on every
  // reparse. Escape the opening `(` (the parser decodes `\(` back to `(`),
  // mirroring the `#`+`[` tag_ref guard above; `[[ULID]]` text is already
  // covered by ALWAYS_ESCAPE's `[`.
  if (ch === '(' && opensBlockRefToken(s, i)) return '\\('
  // `!` before `[` is the image discriminator (#1434): `![…](…)` parses as an
  // image, so a LITERAL `!` preceding a `[` must be escaped or it turns `!` +
  // a literal `[…]` into an image on reparse. (`\!` decodes back to `!`, so the
  // escape is lossless; an interior `!` NOT before `[` stays readable.) The
  // cross-NODE case is defused at the node join in `serializeInlineNodes`.
  if (ch === '!' && s[i + 1] === '[') return '\\!'
  return null
}

/** Whether `s[i]` opens a literal `((ULID))` block_ref token shape. */
function opensBlockRefToken(s: string, i: number): boolean {
  return (
    s[i + 1] === '(' &&
    s[i + 28] === ')' &&
    s[i + 29] === ')' &&
    ULID_RE.test(s.slice(i + 2, i + 28))
  )
}

/**
 * Whether the `~`/`=` run `s[start, end)` would parse as a strike or highlight
 * delimiter (#5160 N12): it joins the same char just outside the text, or it
 * is two or more that could flank. Any `~~~` is escaped too, since the import
 * reads one at a line start as a code fence. `x = 5` and `a == b` stay bare.
 */
function delimiterRunNeedsEscape(
  s: string,
  start: number,
  end: number,
  before: string,
  after: string,
): boolean {
  const ch = s[start]
  const prev = start > 0 ? codePointBefore(s, start) : before
  const next = end < s.length ? codePointAt(s, end) : after
  if (prev === ch || next === ch) return true
  if (end - start < 2) return false
  if (ch === '~' && end - start > 2) return true
  const { canOpen, canClose } = runFlank(flankClass(prev), flankClass(next))
  return canOpen || canClose
}

/**
 * Escape a text node's text. `before` and `after` are the chars emitted just
 * outside it (`''` at a line edge), which decide a `~`/`=` run at its edge.
 */
function escapeText(s: string, before: string, after: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string
    const url = escapeBareUrl(s, i)
    if (url) {
      out += url.text
      i = url.next
      continue
    }
    if (ch === '~' || ch === '=') {
      let end = i + 1
      while (s[end] === ch) end++
      const run = s.slice(i, end)
      out += delimiterRunNeedsEscape(s, i, end, before, after) ? run.replaceAll(ch, `\\${ch}`) : run
      i = end - 1
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

/** Emphasis marks innermost first, the order their delimiters close in; they open in reverse. */
const MARK_ORDER = ['highlight', 'strike', 'italic', 'bold', 'underline'] as const
type EmphasisMark = (typeof MARK_ORDER)[number]

const OPEN_DELIMITER: Record<EmphasisMark, string> = {
  highlight: '==',
  strike: '~~',
  italic: '*',
  bold: '**',
  underline: '<u>',
}
const CLOSE_DELIMITER: Record<EmphasisMark, string> = { ...OPEN_DELIMITER, underline: '</u>' }

interface Delimiter {
  mark: EmphasisMark
  open: boolean
  text: string
}

/**
 * The mark delimiters that move from one active mark state to another: closes
 * first, innermost to outermost, then opens, outermost to innermost.
 *
 * The parser greedily matches `**` before `*`, so we emit close delimiters
 * for inner marks first (italic before bold) and open delimiters for outer
 * marks first (bold before italic). This produces `***` at boundaries where
 * both marks change, which the parser interprets as `**` + `*` (toggle bold,
 * then toggle italic) — matching the intended semantics.
 */
function markTransition(from: ReadonlySet<string>, to: ReadonlySet<string>): Delimiter[] {
  const closes = MARK_ORDER.filter((mark) => from.has(mark) && !to.has(mark)).map((mark) => ({
    mark,
    open: false,
    text: CLOSE_DELIMITER[mark],
  }))
  const opens = MARK_ORDER.toReversed()
    .filter((mark) => to.has(mark) && !from.has(mark))
    .map((mark) => ({ mark, open: true, text: OPEN_DELIMITER[mark] }))
  return [...closes, ...opens]
}

function emitMarkTransition(from: ReadonlySet<string>, to: ReadonlySet<string>): string {
  return markTransition(from, to)
    .map((d) => d.text)
    .join('')
}

/** Close all active marks (inner first → outer last; underline outermost). */
function emitCloseAll(active: ReadonlySet<string>): string {
  return emitMarkTransition(active, new Set())
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

/**
 * A link group whose visible text is exactly its href, as one plain text
 * node, and which the importer would re-autolink in full: it can be written
 * as the bare URL (#1441). We compare the raw text, not the escaped one, which
 * defuses the URL.
 */
function isBareUrlGroup(group: NodeGroup): boolean {
  const rawText = linkSpanPlainText(group.nodes.map(stripLinkMark))
  return rawText !== null && rawText === group.href && isAutolinkableUrl(group.href)
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
 * A link or image destination the parser reads back as `url`
 * (`linkDestination`). The bare form would drop a title-like tail
 * (`https://x.com "t"`), edge whitespace or one layer of `<…>`, so such a URL
 * is written in `<…>` form instead (#5160 N9).
 */
function linkDestinationText(url: string): string {
  const escaped = escapeUrl(url)
  return linkDestination(escaped) === url ? escaped : `<${escaped}>`
}

/**
 * Escape the alt text of an `![alt](url)` image (#1434). The alt is an opaque
 * string (not parsed for marks on the way back in), so only the chars that
 * would break the `![…]` label shape on reparse are escaped: a literal `\` is
 * doubled (so it does not consume the next char as an escape on parse), a
 * literal `]` would close the alt label early, and a literal `[` would open a
 * nesting level in `scanBalancedClose` that an UNBALANCED alt (e.g. alt `[`)
 * never closes — degrading the whole image to garbled text. All three are
 * backslash-escaped; `scanBalancedClose` honours `\x` pairs and
 * `unescapeImageAlt` decodes them, so the alt round-trips exactly.
 */
function escapeImageAlt(alt: string): string {
  let out = ''
  for (const ch of alt) {
    if (ch === '\\' || ch === ']' || ch === '[') out += `\\${ch}`
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
  // An atom that emits nothing is not there. Closing the marks around it would
  // put a close and a reopen side by side: `*a**b*` reads the `**` as bold.
  if (token === '') return ''
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
 * Sanitize inline-math LaTeX for `$…$` emission. The parser's open/close
 * rules reject exactly three shapes the raw MathNodeView source input can
 * produce, each of which silently truncated or degraded the node on reparse:
 *
 *  - edge whitespace (`$ x$` fails the open rule, `$x $` the close rule) —
 *    trimmed;
 *  - an interior unescaped `$` (`$a$b$` closes at the interior `$`) — escaped
 *    to `\$`, which the parser keeps verbatim inside a span (so an already-
 *    escaped `\$` is copied through unchanged and the pass is idempotent);
 *  - a dangling final `\` (would escape the closing `$` away) — doubled;
 *  - a leading digit (`$0…` reads as currency under the open rule, so the
 *    span could never reparse) — the latex is wrapped in `{…}`, a KaTeX
 *    grouping no-op that renders identically.
 */
function sanitizeInlineMathLatex(latex: string): string {
  const trimmed = latex.trim()
  let out = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] as string
    if (ch === '\\') {
      // Copy `\x` pairs verbatim; double a dangling final `\`.
      out += i + 1 < trimmed.length ? ch + (trimmed[i + 1] as string) : '\\\\'
      i++
      continue
    }
    out += ch === '$' ? '\\$' : ch
  }
  const first = out[0] ?? ''
  return first >= '0' && first <= '9' ? `{${out}}` : out
}

/**
 * Serialize a single TextNode, coalescing its marks with the currently
 * active mark set. Mutates `activeMarks` to reflect the new active set
 * after this node is emitted. `before` and `after` are the chars emitted just
 * outside the node (`escapeText`).
 */
function serializeInlineText(
  child: TextNode,
  activeMarks: Set<string>,
  before = '',
  after = '',
): string {
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
  const prev = transition === '' ? before : (transition.at(-1) as string)
  return transition + escapeText(child.text, prev, after)
}

/** A text node that emits mark delimiters around its escaped text: not code, which is an atom. */
function isDelimitedText(node: InlineNode | undefined): node is TextNode {
  return node?.type === 'text' && !(node.marks ?? []).some((m) => m.type === 'code')
}

/**
 * The first char emitted after the delimited text node `nodes[i]`: the next
 * delimiter, else the next atom or text, else `after`, the char past the run
 * of nodes.
 */
function charAfterText(nodes: readonly InlineNode[], i: number, after: string): string {
  const marks = markSetFromMarks((nodes[i] as TextNode).marks ?? [])
  for (const next of nodes.slice(i + 1)) {
    if (isDelimitedText(next)) {
      const delimiters = emitMarkTransition(marks, markSetFromMarks(next.marks ?? []))
      return delimiters === '' ? codePointAt(next.text, 0) : (delimiters[0] as string)
    }
    const token = serializeInlineChild(next, new Set())
    if (token !== '') return emitCloseAll(marks)[0] ?? codePointAt(token, 0)
  }
  return emitCloseAll(marks)[0] ?? after
}

// -- Flanking (#5160 N9) ------------------------------------------------------

/** One char of a node run's emission that a delimiter run can see: a delimiter, or the edge char of a text or an atom. */
interface Cell {
  ch: string
  delimiter?: Delimiter
  /** The text node whose mark the delimiter opens or closes. */
  node?: number
}

/**
 * The delimiters `serializeInlineNodes` emits for `nodes`, between the chars
 * next to them. Only a text's first and last char can touch a delimiter, and
 * an underline tag is punctuation to a `*`, `~` or `=` run beside it.
 */
function delimiterCells(nodes: readonly InlineNode[], before: string, after: string): Cell[] {
  const cells: Cell[] = [{ ch: before }]
  let active: ReadonlySet<string> = new Set()
  let last = -1
  const move = (to: ReadonlySet<string>, opening: number) => {
    for (const delimiter of markTransition(active, to)) {
      if (delimiter.mark === 'underline') cells.push({ ch: '<' }, { ch: '>' })
      else {
        const node = delimiter.open ? opening : last
        cells.push({ ch: delimiter.text[0] as string, delimiter, node })
      }
    }
    active = to
  }
  for (const [i, node] of nodes.entries()) {
    const token = isDelimitedText(node) ? node.text : serializeInlineChild(node, new Set())
    if (token === '') continue
    move(isDelimitedText(node) ? markSetFromMarks(node.marks ?? []) : new Set(), i)
    cells.push({ ch: codePointAt(token, 0) }, { ch: codePointBefore(token, token.length) })
    if (isDelimitedText(node)) last = i
  }
  move(new Set(), -1)
  cells.push({ ch: after })
  return cells
}

/** A delimiter the parser would read as text: `open`s `mark` at the start of `nodes[index]`, or closes it at its end. */
interface UnreadableDelimiter {
  index: number
  mark: EmphasisMark
  open: boolean
}

/** The first delimiter of `nodes` whose run does not flank the way it must (`runFlank`). */
function firstUnreadable(
  nodes: readonly InlineNode[],
  before: string,
  after: string,
): UnreadableDelimiter | null {
  const cells = delimiterCells(nodes, before, after)
  for (let k = 1; k < cells.length - 1; k++) {
    const ch = (cells[k] as Cell).ch
    if (!(cells[k] as Cell).delimiter) continue
    let end = k
    while ((cells[end] as Cell).delimiter && (cells[end] as Cell).ch === ch) end++
    const prev = (cells[k - 1] as Cell).ch
    const { canOpen, canClose } = runFlank(flankClass(prev), flankClass((cells[end] as Cell).ch))
    for (const { delimiter, node } of cells.slice(k, end)) {
      const { mark, open } = delimiter as Delimiter
      if (!(open ? canOpen : canClose)) return { index: node as number, mark, open }
    }
    k = end - 1
  }
  return null
}

/** `node` over `text`, without `mark`. */
function withoutMark(node: TextNode, mark: string, text: string): TextNode {
  const marks = (node.marks ?? []).filter((m) => m.type !== mark)
  return marks.length > 0 ? { ...node, text, marks } : { type: 'text', text }
}

/** `nodes` with the unreadable delimiter's mark moved inward, off the char at the edge of its span. */
function moveBoundaryInward(
  nodes: readonly InlineNode[],
  { index, mark, open }: UnreadableDelimiter,
): InlineNode[] {
  const node = nodes[index] as TextNode
  const edge = open ? codePointAt(node.text, 0) : codePointBefore(node.text, node.text.length)
  const cut = open ? edge.length : node.text.length - edge.length
  const head = node.text.slice(0, cut)
  const tail = node.text.slice(cut)
  const pieces = open
    ? [withoutMark(node, mark, head), { ...node, text: tail }]
    : [{ ...node, text: head }, withoutMark(node, mark, tail)]
  return [
    ...nodes.slice(0, index),
    ...pieces.filter((n) => n.text !== ''),
    ...nodes.slice(index + 1),
  ]
}

/**
 * Move each emphasis mark boundary inward until the delimiter run it emits
 * can be read back (#5160 N9). The parser toggles a mark only through a run
 * that flanks the right way, so `** a**` or `a**(b)**c` would come back as
 * literal stars; the mark instead loses the char at its edge until its run
 * reads: ` **a**`, `a(**b**)c`. A span left with nothing the delimiter can
 * wrap drops the mark, and two delimiter kinds stacked against a letter are
 * staggered (`x~~a**b**c~~y`). Lossy, but only for shapes the grammar cannot
 * spell. `bare` tells which link groups are written as a bare URL, whose
 * letters flank differently from the `[`…`)` of a bracketed link.
 */
function fitMarksToFlanking(
  content: readonly InlineNode[],
  bare: (group: NodeGroup, index: number) => boolean,
): readonly InlineNode[] {
  let nodes = content
  for (;;) {
    const miss = firstUnreadableInParagraph(nodes, bare)
    if (!miss) return nodes
    nodes = coalesceSameMarkText(moveBoundaryInward(nodes, miss))
  }
}

/** `firstUnreadable` over a paragraph's link groups, each read as the parser reads it. */
function firstUnreadableInParagraph(
  nodes: readonly InlineNode[],
  bare: (group: NodeGroup, index: number) => boolean,
): UnreadableDelimiter | null {
  const groups = groupByLink(nodes)
  let offset = 0
  for (const [index, group] of groups.entries()) {
    const miss =
      group.href === null
        ? firstUnreadable(
            group.nodes,
            edgeChar(groups[index - 1], index - 1, bare, 'last'),
            edgeChar(groups[index + 1], index + 1, bare, 'first'),
          )
        : bare(group, index)
          ? null
          : // A link's text is parsed as a line of its own.
            firstUnreadable(group.nodes.map(stripLinkMark), '', '')
    if (miss) return { ...miss, index: miss.index + offset }
    offset += group.nodes.length
  }
  return null
}

/** The first or last char a link group emits next to a plain one: `[`/`)`, or the bare URL's. */
function edgeChar(
  group: NodeGroup | undefined,
  index: number,
  bare: (group: NodeGroup, index: number) => boolean,
  edge: 'first' | 'last',
): string {
  if (!group?.href) return ''
  if (!bare(group, index)) return edge === 'first' ? '[' : ')'
  return edge === 'first'
    ? codePointAt(group.href, 0)
    : codePointBefore(group.href, group.href.length)
}

/** Pull the bold/italic/strike/highlight/underline subset out of a mark list. */
export function markSetFromMarks(marks: readonly PMMark[]): Set<string> {
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
    return serializeInlineAtom(blockLinkToken(child.attrs.id, child.attrs.label), activeMarks)
  }
  if (child.type === 'block_ref') {
    return serializeInlineAtom(`((${child.attrs.id}))`, activeMarks)
  }
  // Inline math (#1437): emit the LaTeX wrapped in `$…$`, sanitized so the
  // emitted token always re-parses as the same math span (edge whitespace,
  // interior `$` and a dangling `\` would otherwise truncate or degrade the
  // node — see sanitizeInlineMathLatex). Whitespace-only LaTeX has no
  // parseable inline form (`$$` is the block fence) and emits nothing. A math
  // node never carries text marks, so it behaves as an atom.
  if (child.type === 'math_inline') {
    const latex = sanitizeInlineMathLatex(child.attrs.latex)
    return serializeInlineAtom(latex === '' ? '' : `$${latex}$`, activeMarks)
  }
  // Image (#1434): emit `![alt](url)`. The alt is escaped for the chars that
  // could break the `![…](…)` shape on reparse (`\` and `]`); the URL is written
  // as a link's is (`linkDestinationText`). An image is an atom and never
  // carries text marks, so it serializes as an atom.
  if (child.type === 'image') {
    const alt = escapeImageAlt(child.attrs.alt)
    return serializeInlineAtom(`![${alt}](${linkDestinationText(child.attrs.src)})`, activeMarks)
  }
  // A line break inside the paragraph (#5160 D2). Emitted as a bare newline
  // here; `finishParagraphLine` decides per line whether it stays bare or
  // takes the legacy `\` + newline marker (#710-5).
  if (child.type === 'hardBreak') return serializeInlineAtom('\n', activeMarks)
  const unknown = child as { type: string }
  onUnknownNode?.(unknown.type)
  return serializeInlineAtom('', activeMarks)
}

/** Mark identity for the merge: the href is what makes two link marks differ. */
function markKey(node: TextNode): string {
  return (node.marks ?? [])
    .map((m) => JSON.stringify(m))
    .toSorted()
    .join()
}

/**
 * Merge adjacent text nodes carrying the same marks (#4731). `escapeText`
 * decides per NODE, so an intraword `_` the parser happened to leave at a node
 * boundary looks edge-adjacent and gets escaped: the same rendered run then
 * serializes differently depending on where the split fell, and the fixpoint
 * breaks. Same-marked neighbours are emitted back to back with no delimiter
 * between them, so the split is invisible in the output and merging it away is
 * lossless; a mark change or an atom is a real delimiter position and keeps its
 * boundary. Two `code` nodes are two backtick spans, so they never merge. An
 * empty text node is dropped: it holds nothing but the delimiters it would
 * emit. Applied at the paragraph entry so every pass below — the escaping
 * walk, `fitMarksToFlanking`, `groupByLink` — reads the same nodes.
 */
function coalesceSameMarkText(nodes: readonly InlineNode[]): readonly InlineNode[] {
  const merged: InlineNode[] = []
  for (const node of nodes) {
    const prev = merged.at(-1)
    if (node.type === 'text' && node.text === '') continue
    if (isDelimitedText(node) && isDelimitedText(prev) && markKey(prev) === markKey(node)) {
      merged[merged.length - 1] = { ...prev, text: prev.text + node.text }
    } else {
      merged.push(node)
    }
  }
  return merged
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
 *
 * `before` and `after` are the chars emitted just outside the run (`''` at a
 * line edge).
 */
function serializeInlineNodes(
  nodes: readonly InlineNode[],
  onUnknownNode?: (type: string) => void,
  before = '',
  after = '',
): string {
  let result = ''
  const activeMarks = new Set<string>()
  let prevTail: SeamTail = 'text'

  for (const [i, child] of nodes.entries()) {
    const piece = isDelimitedText(child)
      ? serializeInlineText(
          child,
          activeMarks,
          result === '' ? before : codePointBefore(result, result.length),
          charAfterText(nodes, i, after),
        )
      : serializeInlineChild(child, activeMarks, onUnknownNode)
    // Cross-node seam guards (#1434 image discriminator, #1437 `$` seams):
    // `escapeText` decides per NODE, so meaning-changing char pairs that only
    // exist across the join are defused here — see joinInlinePieces.
    result = joinInlinePieces(result, piece, prevTail)
    if (piece !== '') prevTail = child.type === 'math_inline' ? 'math' : 'text'
  }

  // Close any remaining open marks — through the seam guard too: a node-final
  // literal `$` followed by a closing delimiter (`</u>`, `**`, …) is exactly
  // the shape the math OPEN rule accepts across the join.
  result = joinInlinePieces(result, emitCloseAll(activeMarks), prevTail)

  return result
}

/**
 * What the previously appended piece's tail means for `$` seam decisions:
 *  - `'math'` — it ends with a math atom's closing `$`, which must stay bare
 *    (escaping it would destroy the math) but is invalidated by an immediately
 *    following digit (the parser's currency closer rule);
 *  - `'url'`  — it is a bare-URL autolink emission whose trailing chars belong
 *    to the href; gluing is handled by the #2385 revalidation loop, never by
 *    escaping into the href;
 *  - `'text'` — anything else: a trailing unescaped `$` is a literal dollar.
 */
type SeamTail = 'text' | 'math' | 'url'

/**
 * Append `piece` to `result`, defusing cross-piece seams that would change
 * meaning on reparse:
 *
 *  - a literal `!` + a `[`-leading piece would reparse as an `![…](…)` image
 *    (#1434) — the `!` is escaped;
 *  - a literal trailing `$` (unescaped because it was node-final, where
 *    `dollarOpensMath` cannot see the neighbour) + a piece whose first char
 *    satisfies the math OPEN rule would let a later `$` on the assembled line
 *    close a bogus math span (#1437) — the `$` is escaped;
 *  - a math atom's closing `$` + a digit-leading piece would un-math the atom
 *    on reparse (currency closer rule) — the digit is escaped instead (`\5`
 *    decodes back to `5`).
 *
 * A `!`/`$` already part of an escape (odd backslash run before it) is left
 * untouched.
 */
function joinInlinePieces(result: string, piece: string, prevTail: SeamTail): string {
  if (piece === '') return result
  if (result.endsWith('!') && piece.startsWith('[') && !endsWithEscapedBang(result)) {
    return `${result.slice(0, -1)}\\!${piece}`
  }
  const first = piece[0] as string
  if (prevTail === 'math' && first >= '0' && first <= '9') {
    return `${result}\\${piece}`
  }
  if (
    prevTail === 'text' &&
    endsWithUnescapedDollar(result) &&
    first !== ' ' &&
    first !== '\t' &&
    !(first >= '0' && first <= '9')
  ) {
    return `${result.slice(0, -1)}\\$${piece}`
  }
  return result + piece
}

/** Whether `result` ends with an unescaped `$` (even backslash run before it). */
function endsWithUnescapedDollar(result: string): boolean {
  if (!result.endsWith('$')) return false
  let n = 0
  let i = result.length - 2
  while (i >= 0 && result[i] === '\\') {
    n++
    i--
  }
  return n % 2 === 0
}

/**
 * Seam tail of a plain (unlinked) node group: `'math'` when its last node is a
 * math atom that actually emitted a token (whitespace-only latex emits
 * nothing, leaving whatever came before it as the real tail — treated as
 * `'text'`, the conservative default).
 */
function groupTail(nodes: readonly InlineNode[]): SeamTail {
  const last = nodes.at(-1)
  return last?.type === 'math_inline' && sanitizeInlineMathLatex(last.attrs.latex) !== ''
    ? 'math'
    : 'text'
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
function serializeParagraph(
  node: ParagraphNode,
  onUnknownNode?: (type: string) => void,
  atLineStart = true,
): string {
  const taskPrefix = node.attrs?.todoState
    ? `- [${TASK_STATE_TO_MARKER[node.attrs.todoState]}] `
    : ''

  if (!node.content || node.content.length === 0) {
    // An empty task block still emits its checkbox marker so the state
    // round-trips; the trailing space is trimmed to keep `- [ ]` canonical.
    return taskPrefix ? taskPrefix.trimEnd() : ''
  }

  // A task's own `- [ ] ` marker consumes the line start, so its text is never
  // dispatched as a block either — same as the callers that pass
  // `atLineStart: false`.
  const dispatched = atLineStart && taskPrefix === ''

  // #2385: a bare-URL autolink emission is only unambiguous when re-scanning
  // it in its final surroundings consumes exactly the href again. When the
  // NEXT emitted text begins with URL-body characters (`)`, `#`, `[`, …),
  // `scanBareUrl` glues it into the href on reparse — e.g. a bare
  // `https://x.com` followed by literal `)#[[ULID]]` reparses as one long
  // link, so the second serialize escapes what the first left raw and
  // idempotence breaks. Emit first, then validate every bare emission with
  // the parser's own scanner (the oracle — no heuristic drift) and demote
  // gluing ones to the explicit `[url](url)` form. Demotion only ever shrinks
  // the bare set, so the retry loop terminates; the common safe followers
  // (space, end-of-text, sentence punctuation the scanner trims back off)
  // keep the compact bare form. A demotion only turns a letter beside a
  // plain group into a bracket, which flanks at least as well, so the marks
  // fitted before it stay readable.
  const forceBracketed = new Set<number>()
  const bare = (group: NodeGroup, index: number) =>
    !forceBracketed.has(index) && isBareUrlGroup(group)
  let content = coalesceSameMarkText(node.content)
  let result = ''
  for (let retry = true; retry;) {
    retry = false
    content = fitMarksToFlanking(content, bare)
    const groups = groupByLink(content)
    result = ''
    let prevTail: SeamTail = 'text'
    const bareEmits: Array<{ index: number; start: number; href: string }> = []
    for (const [index, group] of groups.entries()) {
      if (group.href !== null) {
        // Lossless round-trip for autolinks (#1441): a link whose RAW visible
        // text is exactly its href and which the importer would re-autolink in
        // full is emitted as the bare URL, so an imported `https://x.com`
        // survives round-tripping instead of bloating to `[url](url)`.
        if (bare(group, index)) {
          result = joinInlinePieces(result, group.href, prevTail)
          bareEmits.push({ index, start: result.length - group.href.length, href: group.href })
          prevTail = 'url'
        } else {
          // Serialize inner content with link marks stripped, then wrap
          const inner = serializeInlineNodes(group.nodes.map(stripLinkMark), onUnknownNode)
          // A link group leads with `[`, so a literal `!` ending the previous
          // group would reparse as an image (#1434), and a trailing literal `$`
          // could close a bogus math span across the seam — defuse both.
          const link = `[${inner}](${linkDestinationText(group.href)})`
          result = joinInlinePieces(result, link, prevTail)
          prevTail = 'text'
        }
      } else {
        const piece = serializeInlineNodes(
          group.nodes,
          onUnknownNode,
          codePointBefore(result, result.length),
          edgeChar(groups[index + 1], index + 1, bare, 'first'),
        )
        result = joinInlinePieces(result, piece, prevTail)
        if (piece !== '') prevTail = groupTail(group.nodes)
      }
    }
    for (const emit of bareEmits) {
      if (scanBareUrl(result, emit.start) !== emit.start + emit.href.length) {
        forceBracketed.add(emit.index)
        retry = true
      }
    }
  }

  // A `\n` in the inline string is a hardBreak atom (text nodes hold none), so
  // splitting on it yields the paragraph's lines.
  const escaped = result
    .split('\n')
    .map((line, k, lines) => finishParagraphLine(line, k, lines, dispatched))
    .join('\n')
  // The task prefix (#1435) is prepended AFTER block-marker escaping so the
  // leading-`-` escape only sees the user text, never our own `- [ ] ` marker.
  // Content that serializes to NOTHING (e.g. a whitespace-only math atom) gets
  // the same canonical `- [ ]` (no trailing space) as the empty-content case,
  // so the emitted form matches what its reparse re-serializes to.
  if (taskPrefix && escaped === '') return taskPrefix.trimEnd()
  return taskPrefix + escaped
}

/**
 * One line of a paragraph as emitted: its leading block marker escaped where
 * the block parser would read the line, and its hard break spelled so the
 * parser reads it back as one (#5160 D2).
 *
 * A DISPATCHED paragraph (see `serializeParagraph`'s `dispatched`) is read by
 * the paragraph production, which takes a plain following line as its own, so
 * a hard break is a bare newline there and EVERY line gets the marker escape.
 * Two exceptions keep the legacy `\` + newline marker (#710-5), which the
 * parser still reads: a break next to an EMPTY line, because an empty line is
 * the blank-line block separator; and every break in a heading, task or
 * list-item paragraph, whose single-line productions absorb only marker
 * continuations and would read a bare newline as the next block. Only the
 * first line of those is dispatched, so only it needs the escape.
 */
function finishParagraphLine(
  line: string,
  k: number,
  lines: readonly string[],
  dispatched: boolean,
): string {
  const escaped = k === 0 || dispatched ? escapeLeadingBlockMarker(line) : line
  if (k === lines.length - 1) return escaped
  const bare = dispatched && line !== '' && lines[k + 1] !== ''
  return bare ? escaped : `${escaped}\\`
}

/**
 * A paragraph line whose text begins with a leading BLOCK marker would re-parse
 * as that other block kind, breaking serialize→parse→serialize idempotence
 * (#711): the first serialize emits the marker verbatim, the reparse turns
 * the paragraph into a heading / ordered list / bullet list, and the second
 * serialize then escapes the marker — a byte drift. Escape the marker on the
 * way out so the text stays a paragraph. The parser accepts `\#`, `\.` and
 * `\-`, `\>` as literal escapes (`-` was made escapable for #1436, `>` for
 * the blockquote gap). `escapeText` already escapes every literal `*` (so a
 * `* ` bullet marker can never lead a paragraph). Heading, ordered list,
 * bullet list (`- `), blockquote (`> ` or a bare `>`), the all-dashes
 * horizontal rule (`---`) and the `|` table gate are the gaps closed here.
 *
 * The two LIST markers are additionally escaped after ANY leading indent,
 * because the parser tolerates up to three spaces before a marker
 * (CommonMark's 3-space rule, `MAX_MARKER_INDENT` in
 * `markdown-parse/vocab.ts`, which is what keeps a 4-space-nested import a
 * real sub-list). The escape has to be WIDER than that tolerance: a
 * paragraph nested in a list item is emitted indented and re-parsed
 * DEDENTED by the item's content column, so an indent that is too deep to be
 * a marker on the way out (`     - x`) lands inside the tolerance on the way
 * back in (`   - x`) and would re-parse as a list — the marker-ness of a line
 * has to be invariant under that dedent, and only escaping at every indent
 * makes it so. Heading / blockquote / horizontal rule need no such widening:
 * their productions are anchored at column 0, so an indented one is never a
 * marker at any depth.
 *
 * A leading `*` from an OPENED italic mark (rather than literal text) never
 * reaches here followed by a space: an opener before whitespace cannot flank,
 * so `fitMarksToFlanking` has already moved it past the space (#4156).
 */
function escapeLeadingBlockMarker(line: string): string {
  return (
    line
      .replace(/^( *)(\d+)\. /, '$1$2\\. ')
      .replace(/^(#{1,6})([ \t]|$)/, '\\$1$2')
      .replace(/^( *)- /, '$1\\- ')
      // Horizontal rule: a line of only 3+ dashes (`/^-{3,}$/`). Escaping the
      // first dash (`\---`) drops out of the rule pattern; the parser unescapes
      // `\-` back to `-`, so the run survives as paragraph text.
      .replace(/^(-{3,})$/, '\\$1')
      // Blockquote: `> ` or a bare `>`. `\>` round-trips to `>` (parser change).
      .replace(/^>( |$)/, '\\>$1')
      // Table: a line starting with `|` is a table row (#5160 N12).
      .replace(/^\|/, '\\|')
  )
}

function serializeHeading(node: HeadingNode, onUnknownNode?: (type: string) => void): string {
  const prefix = `${'#'.repeat(node.attrs.level)} `
  if (!node.content || node.content.length === 0) return prefix
  // `atLineStart: false` — the `#{1,6} ` prefix consumes the line start, so the
  // heading's text is never re-dispatched as a block.
  return (
    prefix +
    serializeParagraph({ type: 'paragraph', content: [...node.content] }, onUnknownNode, false)
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
  // Recursively serialize each child block (via the shared block dispatch so
  // the grammar is enumerated in one place, #2219), then prefix every line
  // with "> ".
  const inner = joinBlocks(node.content, serializeBlockSequence(node.content, onUnknownNode))
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
 * escape-aware (`\x` pairs are copied verbatim). A `|` would end the cell
 * wherever it sits in the row, in plain text, inline code or a link URL alike
 * (#710-4); outside a table it is escaped only at a line start (#5160 N12).
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

/**
 * Replace each hardBreak atom in a table-cell paragraph with a single space
 * (markdown cells are single-line — see the call site in serializeTable).
 * Node-level so downstream escaping sees the real neighbour: e.g. a cell of
 * `text('$') + hardBreak` must emit `$` (space follows, no math risk), not an
 * escaped `\$` keyed on a hardBreak token that the cell then strips.
 */
function degradeCellHardBreaks(p: ParagraphNode): ParagraphNode {
  if (!p.content || !p.content.some((n) => n.type === 'hardBreak')) return p
  return {
    ...p,
    content: p.content.map((n) => (n.type === 'hardBreak' ? { type: 'text', text: ' ' } : n)),
  }
}

/**
 * Drop the whitespace at one EDGE of a cell's inline sequence, at the node
 * level (#4072).
 *
 * `parseTable` trims every cell, so that whitespace has no representation to
 * survive into and the emitted string is trimmed anyway (see serializeTable).
 * Doing it here instead of only on the string is what keeps the two halves
 * honest: `serializeParagraph` escapes a leading BLOCK marker only when the
 * marker is genuinely first, so a degraded hardBreak sitting in front of a `>`
 * or `#` used to talk it out of the escape — and the string trim then removed
 * the very space that had justified the decision, emitting a bare marker whose
 * reparse (plain text now, with no space in front) re-serializes ESCAPED. One
 * pass wrote `| > |`, the next `| \> |`.
 *
 * Only UNMARKED text nodes are trimmed. Whitespace inside a mark's delimiters
 * (`` `  x  ` ``, `** a**`) is content, not a cell edge: it is not at the edge
 * of the emitted string at all, and stripping it would silently rewrite the
 * cell.
 */
function trimCellEdge(nodes: readonly InlineNode[], edge: 'start' | 'end'): InlineNode[] {
  const out = [...nodes]
  while (out.length > 0) {
    const index = edge === 'start' ? 0 : out.length - 1
    const node = out[index]
    if (node?.type !== 'text' || (node.marks?.length ?? 0) > 0) break
    const trimmed = edge === 'start' ? node.text.replace(/^\s+/, '') : node.text.replace(/\s+$/, '')
    if (trimmed === '') {
      out.splice(index, 1)
      continue
    }
    if (trimmed !== node.text) out[index] = { ...node, text: trimmed }
    break
  }
  return out
}

/**
 * A cell paragraph with its marks fitted (`fitMarksToFlanking`) before the
 * edge trim, so whitespace moved out of a mark at the cell edge is trimmed
 * before any escape decision sees it (#4072).
 */
function fitCellParagraph(p: ParagraphNode): ParagraphNode {
  if (!p.content) return p
  return { ...p, content: [...fitMarksToFlanking(coalesceSameMarkText(p.content), isBareUrlGroup)] }
}

/**
 * A cell's paragraphs in the form the parser will store them back as: hardBreaks
 * degraded to spaces, marks fitted, and the cell's leading/trailing whitespace
 * already gone.
 * Whitespace BETWEEN paragraphs is untouched — the `join(' ')` below puts it
 * back as interior text, where no block-marker escape keys on it.
 */
function canonicalCellParagraphs(paragraphs: readonly ParagraphNode[]): ParagraphNode[] {
  const out = paragraphs.map(degradeCellHardBreaks).map(fitCellParagraph)
  for (let i = 0; i < out.length; i++) {
    const content = trimCellEdge((out[i] as ParagraphNode).content ?? [], 'start')
    out[i] = { ...(out[i] as ParagraphNode), content }
    if (content.length > 0) break
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const content = trimCellEdge((out[i] as ParagraphNode).content ?? [], 'end')
    out[i] = { ...(out[i] as ParagraphNode), content }
    if (content.length > 0) break
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
        //
        // A table row must stay a single line, too: a hardBreak inside a cell
        // paragraph would embed its `\`+newline token in the row, splitting it
        // and destroying the whole table on reparse. Degrade the break to a
        // single space — the same policy as the multi-paragraph join below.
        // Both normalizations happen at the NODE level
        // (`canonicalCellParagraphs`), not on the emitted string, so the
        // escape/seam decisions see the content the cell will actually hold
        // rather than a space that is about to be deleted. The `.trim()` below
        // stays as the finisher for whitespace produced downstream of those
        // decisions (an emptied paragraph's `join(' ')` seam), which is why it
        // can no longer contradict them.
        const text =
          cell.content && cell.content.length > 0
            ? escapeCellPipes(
                canonicalCellParagraphs(cell.content)
                  // `atLineStart: false` — a cell sits behind `| `, so its text
                  // is inline content the row production owns.
                  .map((p) => serializeParagraph(p, onUnknownNode, false))
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

// Nested lists (created by `Tab`/`sinkListItem`) are indented by
// `LIST_NEST_INDENT` per level. The parser recognizes a nested block by that
// same width and dedents by whole multiples of it, so indented lists round-trip
// without loss (#1513, #4019) — hence the constant's canonical home in
// `markdown-common`, shared by both halves.

/** Prefix every line of `text` with `indent`. */
function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n')
}

/**
 * Serialize one list item: its leading paragraph followed by any further
 * block-level children (nested lists, code blocks, headings, blockquotes, …).
 * The item's marker (e.g. `- ` or `3. `) is supplied by the caller and prefixed
 * to the first line; every subsequent block is indented one level so the parser
 * reads it back as nested content belonging to this item (round-trips via
 * `collectListItem`'s indent-preserving rule; #1513, #2213).
 *
 * The TipTap `ListItem` schema is `paragraph block*`, so a list item can hold a
 * `codeBlock`, `heading`, `blockquote`, `table`, `math_block` or
 * `horizontalRule` in addition to the leading paragraph and nested lists
 * (#2213). Each child is routed through the shared {@link serializeBlockNode}
 * dispatch so none of those block kinds are silently dropped (which previously
 * lost code fences and `#` heading prefixes when a code block / heading was
 * toggled inside a list item).
 */
function serializeListItem(
  item: ListItemNode,
  marker: string,
  onUnknownNode?: (type: string) => void,
): string {
  const children = item.content ?? []
  // The item's children are a block SEQUENCE like any other, so a paragraph
  // following a nested list inside the item needs the same leading-indent
  // defusing (#4071/#4076) — the recursive parse of the item's nested lines
  // sees exactly these strings, dedented back to column 0.
  const [lead = '', ...rest] = serializeBlockSequence(children, onUnknownNode, true)
  if (children.length <= 1) return `${marker}${lead}`
  // The first child sits on the marker line (no indent); every later block is
  // indented one level so it round-trips back into this item as nested content
  // rather than leaking out as a sibling block. The nested blocks are joined as
  // the parser separates them (`joinBlocks`): the blank line between two
  // nested paragraphs is emitted indented too, so `collectListItem` keeps it
  // inside the item.
  const nested = joinBlocks(children.slice(1), rest)
  return `${marker}${lead}\n${indentLines(nested, LIST_NEST_INDENT)}`
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

// -- Shared block dispatch (#2219) --------------------------------------------

/**
 * The single authoritative block-node → serializer table. Every block-level
 * call site — the top-level {@link serialize}, {@link serializeBlockquote}'s
 * child loop, and each list item ({@link serializeListItem}) — routes through
 * {@link serializeBlockNode}, which reads this table, so the locked block
 * grammar is enumerated in exactly one place instead of the four parallel
 * hand-maintained switches that previously had to stay in lockstep.
 *
 * The mapped type keyed by `BlockLevelNode['type']` is exhaustive at compile
 * time: adding a new block node type to the `BlockLevelNode` union turns this
 * object literal into a `tsc` error (missing property) until a handler is
 * supplied — so a new block kind can no longer compile while being silently
 * dropped by a switch that forgot it.
 */
type BlockSerializerTable = {
  [K in BlockLevelNode['type']]: (
    node: Extract<BlockLevelNode, { type: K }>,
    onUnknownNode?: (type: string) => void,
  ) => string
}

const BLOCK_SERIALIZERS: BlockSerializerTable = {
  paragraph: serializeParagraph,
  heading: serializeHeading,
  codeBlock: serializeCodeBlock,
  blockquote: serializeBlockquote,
  table: serializeTable,
  orderedList: serializeOrderedList,
  bulletList: serializeBulletList,
  horizontalRule: serializeHorizontalRule,
  math_block: serializeMathBlock,
}

/**
 * Serialize one block-level node through the shared {@link BLOCK_SERIALIZERS}
 * table. A node whose runtime `type` falls outside the compiled taxonomy is
 * reported via `onUnknownNode` and dropped (empty string) — the same fallback
 * the top-level `serialize` always used, now applied uniformly at every block
 * call site (previously blockquote and list-item children dropped an unknown
 * type silently; #2219).
 */
function serializeBlockNode(node: BlockLevelNode, onUnknownNode?: (type: string) => void): string {
  const handler = BLOCK_SERIALIZERS[node.type] as
    | ((n: BlockLevelNode, cb?: (type: string) => void) => string)
    | undefined
  if (!handler) {
    onUnknownNode?.((node as { type: string }).type)
    return ''
  }
  return handler(node, onUnknownNode)
}

/**
 * Serialize a SEQUENCE of sibling blocks — the doc's children, a blockquote's
 * children, or a list item's children — defusing the one way a sibling can be
 * swallowed by its predecessor on reparse (#4071, #4076).
 *
 * The hazard. A paragraph is the only block whose stored text can BEGIN with
 * whitespace, and it is emitted verbatim; but indentation is also how a list
 * item's nested content is spelled (`collectListItem` absorbs every following
 * line indented to at least the item's content column). So a paragraph
 * following a list, whose own text starts with one whole {@link
 * LIST_NEST_INDENT} of whitespace, re-parses as that list's nested content:
 * it is re-parented into the last item, dedented, and re-dispatched — which
 * merges the list with whatever ordered list followed (renumbering it, #4071)
 * and can re-read the dedented text as a different block kind entirely (a
 * blockquote, #4076).
 *
 * Why it survives one pass and bites on the next — the reason both issues were
 * reported as "converges only on the SECOND serialize". On the way IN, the
 * list's markers may be indented (CommonMark's 1-3 space tolerance, or a
 * deeper foreign indent), which pushes the item's content column past the
 * paragraph's indent, so the parse correctly keeps them siblings. Serializing
 * then NORMALIZES the markers to column 0, dropping the content column to 2 —
 * and the very same paragraph, byte for byte, is now deep enough to be
 * swallowed. The document that comes back is not the one that went out.
 *
 * The fix is to make the paragraph's leading whitespace unambiguously CONTENT:
 * prefix a backslash escape, so the emitted line starts at column 0 and no
 * indentation the parser sees is anything but structure. `\ ` (and `\<tab>`)
 * decode back to the bare character (`isEscapableChar`), so the text is
 * unchanged and the escape is stable under re-serialization.
 *
 * There are three ways the leading whitespace fails to come back, and the
 * escape has to cover ALL — accepting `\<tab>` in `isEscapableChar` without emitting
 * it for the second would simply move the non-convergence rather than remove
 * it (a foreign `\<tab>x` would decode to a tab-leading paragraph the
 * serializer then emitted raw, which pass two expands to spaces):
 *
 *  1. ABSORPTION, after a list and at one whole nest level or more — the case
 *     the two issues were filed for. Deliberately narrow: only a list absorbs a
 *     following indented line (a heading, table, quote, fence or paragraph in
 *     that position ends the run, so a paragraph after one of those keeps its
 *     plain form), and less than one whole level is not nested content either
 *     (#4019 pins `- x` + a paragraph ` a` as siblings, one space intact).
 *  2. TAB EXPANSION, wherever the paragraph sits. A line's leading whitespace
 *     run is rewritten by the parser as the COLUMNS it occupies
 *     (`dedentColumns`, #4052), so a run containing a tab NEVER survives
 *     verbatim — with or without a list in front of it. This one needs no
 *     predecessor and no threshold.
 *  3. THE ITEM DEDENT, for a list item's non-leading child. Such a child is
 *     emitted indented (`serializeListItem`) and dedented back out by
 *     `collectListItem`, which leaves any excess as indentation the parser
 *     drops rather than stores (#4050). Per line like hazard 2, and with no
 *     threshold at all: one space is already lost.
 *
 * Hazard 2 is per LINE, not per block: a paragraph holding a `hardBreak` emits
 * more than one line, and every one of them starts a line the parser measures.
 * Absorption (hazard 1) is first-line-only by contrast — a run that already
 * started at column 0 is a paragraph run, and its later lines are lazy
 * continuations no list can claim.
 *
 * `skipFirst` is for a list item's children: its first child's FIRST line is
 * emitted on the MARKER line, where no hazard exists — the marker consumes
 * the line start, so that text's own leading whitespace is not a line's leading
 * whitespace at all (`- <tab>x` round-trips as-is) and there is no preceding
 * sibling to absorb it. Its later lines are ordinary lines again. The same
 * "the marker owns this line start" fact is what keeps that paragraph's hard
 * breaks in the legacy marker form (`serializeParagraph`'s `atLineStart`).
 */
function serializeBlockSequence(
  nodes: readonly BlockLevelNode[],
  onUnknownNode?: (type: string) => void,
  skipFirst = false,
): string[] {
  return nodes.map((node, idx) => {
    const onMarkerLine = idx === 0 && skipFirst
    // A paragraph on the marker line is not at a line start the parser
    // dispatches — one notion of "this text owns the start of its line", used
    // by this defuse and by `serializeParagraph`'s `atLineStart`.
    const serialized =
      onMarkerLine && node.type === 'paragraph'
        ? serializeParagraph(node, onUnknownNode, false)
        : serializeBlockNode(node, onUnknownNode)
    if (node.type !== 'paragraph') return serialized
    const prev = nodes[idx - 1]
    // Hazard 3, DEDENT (#4050): a list item's non-leading child is emitted
    // indented (`serializeListItem`), and the parser drops whatever indentation
    // such a paragraph line still carries once the item dedent has run — so
    // EVERY line of it, not just the first, has to say that its own leading
    // whitespace is text. Like hazard 2 this is per line and needs no
    // threshold; unlike it, one space is already enough.
    const dedentedOnTheWayBack = skipFirst && idx > 0
    return serialized
      .split('\n')
      .map((line, lineIdx) => {
        if (dedentedOnTheWayBack) return leadingIndent(line) > 0 ? `\\${line}` : line
        if (lineIdx === 0) {
          return onMarkerLine || !needsWhitespaceDefuse(line, prev) ? line : `\\${line}`
        }
        // Continuation lines: tab expansion only (see above).
        return LEADING_TAB_RE.test(line) ? `\\${line}` : line
      })
      .join('\n')
  })
}

/** A leading whitespace run that contains a tab — hazard 2 above. */
const LEADING_TAB_RE = /^ *\t/

/** Whether a paragraph's first line needs its leading whitespace defused. */
function needsWhitespaceDefuse(firstLine: string, prev: BlockLevelNode | undefined): boolean {
  if (LEADING_TAB_RE.test(firstLine)) return true
  if (!prev || (prev.type !== 'bulletList' && prev.type !== 'orderedList')) return false
  return leadingIndent(firstLine) >= LIST_NEST_INDENT.length
}

/**
 * A paragraph the parser's paragraph production reads (no task marker). Read
 * by truthiness, as `serializeParagraph` reads the prefix: a paragraph out of
 * the editor carries the schema default `todoState: null`, not no `attrs`.
 */
function isPlainParagraph(node: BlockLevelNode | undefined): boolean {
  return node?.type === 'paragraph' && !node.attrs?.todoState
}

/**
 * Join sibling blocks the way the parser separates them (#5160 D2): a blank
 * line between two plain paragraphs, which a bare newline would read back as
 * ONE paragraph with a hard break, and a bare newline everywhere else, where
 * the second block's first line interrupts the first (a task's `- [ ] ` marker
 * included). A list item's nested blocks are joined the same way; the
 * caller indents the blank line, so it stays inside the item.
 */
function joinBlocks(nodes: readonly BlockLevelNode[], serialized: readonly string[]): string {
  let out = ''
  for (const [idx, text] of serialized.entries()) {
    if (idx > 0) {
      out += isPlainParagraph(nodes[idx - 1]) && isPlainParagraph(nodes[idx]) ? '\n\n' : '\n'
    }
    out += text
  }
  return out
}

export function serialize(doc: DocNode, onUnknownNode?: (type: string) => void): string {
  if (!doc.content || doc.content.length === 0) return ''
  return joinBlocks(doc.content, serializeBlockSequence(doc.content, onUnknownNode))
}
