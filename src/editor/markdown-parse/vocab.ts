/**
 * Shared vocabulary for the Markdown → PM parser: constants, the scanner
 * primitive, the per-production result/match shapes, the inline-scanner state,
 * and the pure helpers that depend on NONE of the co-recursive parse machinery
 * (`parse` / `parseLine`).
 *
 * Extracted from `markdown-parse.ts` so the parser core can import these from a
 * leaf module WITHOUT importing back from the core (which would close an import
 * cycle the `frontend import cycles (zero)` hook forbids). The public API is
 * still surfaced via the `markdown-parse.ts` barrel (and the
 * `markdown-serializer.ts` barrel above it).
 *
 * Zero external dependencies. Moved verbatim from the original monolith.
 */

import type {
  BlockLevelNode,
  BlockLinkNode,
  BlockRefNode,
  CodeBlockNode,
  InlineNode,
  PMMark,
  TagRefNode,
  TextNode,
  TodoState,
} from '../types'

// -- Constants ----------------------------------------------------------------

export const ULID_RE = /^[0-9A-Z]{26}$/
export const MAX_LINK_SCAN = 10_000
export const CALLOUT_RE = /^\[!(\w+)\]\s?(.*)/i
/**
 * Maximum recursion depth for `parse()` to guard against pathological or
 * adversarial inputs (deeply nested blockquotes, link-display-text with
 * nested links, etc.). When exceeded, the input is returned as plain text
 * so the parser never blows the stack.
 */
export const MAX_PARSE_DEPTH = 10

/**
 * GFM task list item (#1435): `- [ ] `, `- [x] `, `- [/] `, `- [-] ` (either
 * `-` or `*` marker). Parses to a SINGLE paragraph carrying `attrs.todoState`
 * so the checkbox state round-trips with the block's `todo_state`. Markers map
 * to the app's fixed cycle:
 *   `[ ]` → TODO   `[/]` → DOING   `[x]`/`[X]` → DONE   `[-]` → CANCELLED
 *
 * Runs BEFORE `parseBulletList` in dispatch; `parseBulletList` excludes these
 * lines via `BULLET_TASK_RE` so they never collapse into a plain bullet list.
 * A single line only (one task = one block), mirroring how the editor models a
 * task as one block with a `todo_state` property.
 */
// The text part is optional so an EMPTY task (`- [ ]`, no trailing space —
// which is how the serializer emits an empty task block) still parses back to
// a task and round-trips. With content, a separating space is required.
export const TASK_ITEM_RE = /^[-*] \[([ xX/-])\](?: (.*))?$/
export const TASK_MARKER_TO_STATE: Record<string, TodoState> = {
  ' ': 'TODO',
  '/': 'DOING',
  x: 'DONE',
  X: 'DONE',
  '-': 'CANCELLED',
}

/**
 * Bullet (unordered) list: consecutive `- item` / `* item` lines.
 *
 * Mirrors {@link parseOrderedList}. Two carve-outs preserve existing
 * behaviour:
 *  - A GFM task line (`- [ ] ` / `- [x] ` / `- [/] ` / `- [-] `, either `-`
 *    or `*` marker) is a task (#1435) handled by `parseTask` and must stay out
 *    of the list — `BULLET_TASK_RE` excludes it so it falls through.
 *  - `---` (and longer hyphen runs) is a horizontal rule, handled by
 *    `parseHorizontalRule` which runs BEFORE this production in dispatch, so
 *    `- ` here only matches a hyphen FOLLOWED by a space + content.
 */
export const BULLET_ITEM_RE = /^[-*] (.*)$/
// Matches a task line so the bullet production excludes it (both `- [ ] text`
// and the empty `- [ ]` with no trailing space — kept in sync with
// `TASK_ITEM_RE`).
export const BULLET_TASK_RE = /^[-*] \[[ xX/-]\](?: |$)/

// -- Scanner ------------------------------------------------------------------

export interface Scanner {
  readonly src: string
  pos: number
}

export function peek(s: Scanner, offset = 0): string {
  return s.src[s.pos + offset] ?? ''
}

export function remaining(s: Scanner): number {
  return s.src.length - s.pos
}

export function tryConsumeToken(s: Scanner): TagRefNode | BlockLinkNode | BlockRefNode | null {
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
export interface LinkMatch {
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
export function scanBalancedClose(
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

export function probeExternalLink(s: Scanner): LinkMatch | null {
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
 * Unescape a URL: decode the backslash escapes (`\\`, `\(`, `\)`) that
 * `escapeUrl` emits for literal backslashes and unbalanced parens.
 *
 * #710-6: the previous implementation decoded EVERY `%29` → `)`, corrupting
 * URLs in which the user literally typed `%29`. Percent sequences are now
 * left untouched; only the serializer's own backslash escapes are decoded.
 */
export function unescapeUrl(url: string): string {
  let out = ''
  for (let i = 0; i < url.length; i++) {
    const ch = url[i]
    const next = url[i + 1]
    if (ch === '\\' && (next === '\\' || next === '(' || next === ')')) {
      out += next
      i++
      continue
    }
    out += ch
  }
  return out
}

/**
 * Unescape an image alt label (#1434): decode the `\]` and `\\` escapes that
 * `escapeImageAlt` emits, mirroring it exactly so an alt containing `]` or `\`
 * round-trips. Other backslash sequences are left verbatim (the serializer only
 * ever emits these two).
 */
export function unescapeImageAlt(alt: string): string {
  let out = ''
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i]
    const next = alt[i + 1]
    if (ch === '\\' && (next === ']' || next === '\\')) {
      out += next
      i++
      continue
    }
    out += ch
  }
  return out
}

// -- Inline state -------------------------------------------------------------

export function flushText(buf: string, marks: readonly PMMark[], nodes: InlineNode[]): string {
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
export interface BlockParseResult {
  readonly blocks: readonly BlockLevelNode[]
  readonly consumed: number
}

export function buildCodeBlock(
  code: string,
  attrs: { language: string } | undefined,
): CodeBlockNode {
  if (code.length === 0) {
    return attrs ? { type: 'codeBlock', attrs } : { type: 'codeBlock' }
  }
  return attrs
    ? { type: 'codeBlock', attrs, content: [{ type: 'text', text: code }] }
    : { type: 'codeBlock', content: [{ type: 'text', text: code }] }
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
  inStrike: boolean
  inHighlight: boolean
  inUnderline: boolean
  /** Position in source where the currently-open bold/italic delimiter started. */
  boldOpenPos: number
  italicOpenPos: number
  /**
   * Which delimiter char opened the currently-open bold/italic run — `'*'` or
   * `'_'` (GFM accepts both). Only the matching char closes, so `*foo_` /
   * `_foo*` don't cross-close. `null` when not open. Also drives the
   * unclosed-mark revert so an unclosed `_`/`__` reverts to the right literal.
   */
  boldDelim: '*' | '_' | null
  italicDelim: '*' | '_' | null
  /** Snapshots of `nodes.length` at the moment a mark opened (for revert). */
  boldOpenNodeLen: number
  italicOpenNodeLen: number
  strikeOpenNodeLen: number
  highlightOpenNodeLen: number
  underlineOpenNodeLen: number
}

export function createInlineState(line: string, depth: number): InlineState {
  return {
    scanner: { src: line, pos: 0 },
    depth,
    buf: '',
    nodes: [],
    inBold: false,
    inItalic: false,
    inStrike: false,
    inHighlight: false,
    inUnderline: false,
    boldOpenPos: -1,
    italicOpenPos: -1,
    boldDelim: null,
    italicDelim: null,
    boldOpenNodeLen: 0,
    italicOpenNodeLen: 0,
    strikeOpenNodeLen: 0,
    highlightOpenNodeLen: 0,
    underlineOpenNodeLen: 0,
  }
}

/** Compute the currently active text marks from open toggle flags. */
export function currentMarks(st: InlineState): PMMark[] {
  const m: PMMark[] = []
  if (st.inUnderline) m.push({ type: 'underline' })
  if (st.inBold) m.push({ type: 'bold' })
  if (st.inItalic) m.push({ type: 'italic' })
  if (st.inStrike) m.push({ type: 'strike' })
  if (st.inHighlight) m.push({ type: 'highlight' })
  return m
}

/** Flush the accumulated plain-text buffer as a (possibly-marked) text node. */
export function flushBuf(st: InlineState, marks: readonly PMMark[]): void {
  st.buf = flushText(st.buf, marks, st.nodes)
}

/**
 * Length of the trailing backslash run of a line. An ODD run means the last
 * backslash is a hard-break marker (#710-5): `escapeText` doubles every
 * literal backslash, so serializer output only ends a line with an odd run
 * when `serializeInlineChild` emitted the `\` + newline hardBreak token.
 */
export function trailingBackslashRun(line: string): number {
  let n = 0
  while (n < line.length && line[line.length - 1 - n] === '\\') n++
  return n
}

// -- Helpers ------------------------------------------------------------------

/** Convert an inline node back to its plain-text representation (for unclosed mark revert). */
export function nodeToPlainText(node: InlineNode): string {
  switch (node.type) {
    case 'text': {
      return node.text
    }
    case 'tag_ref': {
      return `#[${node.attrs.id}]`
    }
    case 'block_link': {
      return `[[${node.attrs.id}]]`
    }
    case 'block_ref': {
      return `((${node.attrs.id}))`
    }
    case 'math_inline': {
      return `$${node.attrs.latex}$`
    }
    case 'image': {
      return `![${node.attrs.alt}](${node.attrs.src})`
    }
    /* v8 ignore start -- hardBreak never appears during line parsing; default is type guard */
    case 'hardBreak': {
      return '\n'
    }
    default: {
      return ''
    }
    /* v8 ignore stop */
  }
}
