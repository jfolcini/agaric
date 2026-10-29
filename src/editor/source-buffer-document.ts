/**
 * Edit as Markdown's Document dialect (#5691), as the Rust grammar reads it
 * (`import::parse_document_text` and `parse_document_outline`, the
 * `ParseMode::Document` branches of `Scan` in `agaric-engine/src/import.rs`),
 * and as a paste reads it (`import::parse_pasted_text`, #6190), and the
 * escapes its writer shares with that reading. It follows the grammar
 * and defines none: `conformance/document-lines.vectors.json`, which Rust
 * authors, pins it.
 *
 * Measured as Rust measures: an indent's columns are its UTF-8 bytes plus one
 * per tab (`indent_columns`), and every trim is `char::is_whitespace`'s, which
 * JavaScript's `\s` is not.
 */

import { FOLDED_RESERVED_KEYS, foldPropertyKey } from '@/lib/inline-property-parse'
import { TASK_STATE_TO_MARKER, type TodoState, taskStateFromMarker } from '@/lib/task-states'

const WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WS_CHAR = new RegExp(`^[${WS}]`)
const LEADING_WS = new RegExp(`^[${WS}]+`)
const TRAILING_WS = new RegExp(`[${WS}]+$`)
const LEADING_WS_OR_BACKSLASH = new RegExp(`^[${WS}\\\\]+`)
const ID = '[0-9A-HJKMNP-TV-Z]{26}'
const ULID = new RegExp(`^${ID}$`)
/** What `BlockId::from_string` reads: Crockford base32, either case, in 128 bits. */
const BLOCK_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
/** Whether a 26-character `^word` is a block's id. Rust's are ULIDs; the mock's, such as `…BLOCK01`, are not. */
export type IsId = (word: string) => boolean
const isUlid: IsId = (word) => ULID.test(word)
/** Any 26 capitals and digits: which of them is an id is `IsId`'s to say. */
const WORD = '([0-9A-Z]{26})'
/** `ANCHOR_LINE_RE`: a block's `^ID` alone on its line. */
const ANCHOR_LINE = new RegExp(`^\\^${WORD}$`)
/** `TRAILING_ANCHOR_RE`: the ` ^ID` a buffer writes at the end of a line. */
const TRAILING_ANCHOR = new RegExp(`[${WS}]\\^${WORD}[${WS}]*$`)
const anchorLine = (text: string, isId: IsId): boolean => isId(ANCHOR_LINE.exec(text)?.[1] ?? '')
const trailingAnchor = (text: string, isId: IsId): boolean =>
  isId(TRAILING_ANCHOR.exec(text)?.[1] ?? '')
/** `OBSIDIAN_BLOCK_ANCHOR_RE`: the `^word` a block's text ends with. */
const BLOCK_ANCHOR = new RegExp(`(?:^|[${WS}])\\^([A-Za-z0-9-]+)[${WS}]*$`)

const isWhitespace = (c: string): boolean => WS_CHAR.test(c)
const trimStart = (text: string): string => text.replace(LEADING_WS, '')
const trim = (text: string): string => trimStart(text).replace(TRAILING_WS, '')
/** `text` past its leading whitespace and backslashes, the shape every escape is tested on. */
const bodyOf = (text: string): string => text.replace(LEADING_WS_OR_BACKSLASH, '')

/** A code fence's character and the length of its opening run (`FenceRun`). */
export interface FenceRun {
  ch: string
  len: number
}

/** `fence_run`: three or more backticks or tildes, a backtick fence's info holding none. */
function fenceRun(text: string): FenceRun | null {
  const ch = text.charAt(0)
  if (ch !== '`' && ch !== '~') return null
  let len = 0
  while (text.charAt(len) === ch) len += 1
  return len >= 3 && !(ch === '`' && text.slice(len).includes('`')) ? { ch, len } : null
}

/** `closes_fence`: a run of the fence's character at least as long, alone on the line. */
export function closesFence(line: string, fence: FenceRun): boolean {
  const trimmed = trimStart(line)
  let run = 0
  while (trimmed.charAt(run) === fence.ch) run += 1
  return run >= fence.len && trim(trimmed.slice(run)) === ''
}

/** `bullet_marker`: a list marker's length and whether it is ordered. */
function bulletMarker(trimmed: string): { len: number; ordered: boolean } | null {
  const first = trimmed.charAt(0)
  let len = 1
  if (/^[0-9]$/.test(first)) {
    const digits = /^[0-9]*/.exec(trimmed)?.[0].length ?? 0
    if (digits > 9 || !['.', ')'].includes(trimmed.charAt(digits))) return null
    len = digits + 1
  } else if (first !== '-' && first !== '+' && first !== '*') {
    return null
  }
  const next = trimmed.charAt(len)
  return next === '' || next === ' ' || next === '\t' ? { len, ordered: len > 1 } : null
}

const isBulletLine = (trimmed: string): boolean => bulletMarker(trimmed) !== null

/** `heading_level`: one to six `#`, then a space, a tab or the end. */
function headingLevel(trimmed: string): number | null {
  let level = 0
  while (trimmed.charAt(level) === '#') level += 1
  const next = trimmed.charAt(level)
  return level >= 1 && level <= 6 && (next === '' || next === ' ' || next === '\t') ? level : null
}

/** `is_thematic_break`: three or more `-`, `*` or `_` and nothing else. */
function isThematicBreak(trimmed: string): boolean {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(TRAILING_WS, ''))
}

/** `split_property_line`: `key::` and a space, a tab or nothing, `key` a property key. */
function splitPropertyLine(line: string): { key: string; value: string } | null {
  const at = line.indexOf('::')
  if (at < 0) return null
  const key = line.slice(0, at)
  const rest = line.slice(at + 2)
  let value = ''
  if (trim(rest) !== '') {
    if (rest.charAt(0) !== ' ' && rest.charAt(0) !== '\t') return null
    value = rest.slice(1)
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(trim(key)) ? { key, value } : null
}

/** `opens_one_line_block`: a heading, or a break told by its opening run (G2a). */
function opensOneLineBlock(body: string): boolean {
  const first = body.charAt(0)
  let rule = 0
  if ('-*_'.includes(first) && first !== '') while (body.charAt(rule) === first) rule += 1
  const after = body.charAt(rule)
  return headingLevel(body) !== null || (rule >= 3 && (after === '' || isWhitespace(after)))
}

/** `needs_blank_line_escape`: a line of nothing but whitespace and backslashes. */
export function needsBlankLineEscape(line: string): boolean {
  return bodyOf(line) === ''
}

/** `needs_document_line_escape`: a line inside a block that would read as anything else. */
export function needsDocumentLineEscape(line: string): boolean {
  const body = bodyOf(line)
  return (
    body === '' ||
    isBulletLine(body) ||
    headingLevel(body) !== null ||
    splitPropertyLine(body) !== null ||
    fenceRun(body) !== null ||
    opensOneLineBlock(body)
  )
}

/**
 * `needs_bare_line_escape`: a block's first line, written with no marker,
 * that would not read back as that text.
 */
export function needsBareLineEscape(text: string, followed: boolean): boolean {
  const body = text.replace(/^\\+/, '')
  return (
    body === '' ||
    isWhitespace(body.charAt(0)) ||
    isBulletLine(body) ||
    splitPropertyLine(body) !== null ||
    (opensOneLineBlock(body) && (followed || body.length < text.length))
  )
}

/** `split_task_marker`: a leading `[c] `, or a bare `[c]` that is the whole text. */
function splitTaskMarker(text: string): { state: TodoState; rest: string } | null {
  if (text.charAt(0) !== '[' || text.charAt(2) !== ']') return null
  const state = taskStateFromMarker(text.charAt(1))
  if (state === null) return null
  const after = text.slice(3)
  if (after === '') return { state, rest: '' }
  return after.startsWith(' ') ? { state, rest: after.slice(1) } : null
}

/** `needs_task_marker_escape`: text after a list marker that would read as a checkbox. */
export function needsTaskMarkerEscape(text: string): boolean {
  return splitTaskMarker(text.replace(/^\\+/, '')) !== null
}

/** `split_block_task_marker`: the checkbox's state and the text, or one escape off it. */
function splitBlockTaskMarker(text: string): { state: TodoState | null; rest: string } {
  if (text.startsWith('\\') && needsTaskMarkerEscape(text.slice(1))) {
    return { state: null, rest: text.slice(1) }
  }
  return splitTaskMarker(text) ?? { state: null, rest: text }
}

/** `needs_anchor_line_escape`: a code line that would read as one ending its fence. */
export function needsAnchorLineEscape(line: string): boolean {
  const body = bodyOf(line)
  return anchorLine(body, isUlid) || (isBulletLine(body) && trailingAnchor(body, isUlid))
}

/** `bullet_text`: a bullet's text past its marker and the one blank after it. */
function bulletText(trimmed: string, len: number): string {
  const rest = trimmed.slice(len)
  return rest.startsWith(' ') || rest.startsWith('\t') ? rest.slice(1) : rest
}

/** `document_fence_opener`: the fence a written line opens, past one marker and a checkbox. */
export function documentFenceOpener(line: string): FenceRun | null {
  const trimmed = trimStart(line)
  const marker = bulletMarker(trimmed)
  if (marker === null) return fenceRun(trimmed)
  return fenceRun(splitBlockTaskMarker(bulletText(trimmed, marker.len)).rest)
}

/** A surrogate half with no partner, which `JSON.parse` keeps and `serde_json` refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** `read_source_property_value`: a double-quoted value is a JSON string, anything else trimmed. */
function readSourcePropertyValue(raw: string): string {
  const value = trim(raw)
  if (value.startsWith('"')) {
    try {
      const unquoted: unknown = JSON.parse(value)
      if (typeof unquoted === 'string' && !LONE_SURROGATE.test(unquoted)) return unquoted
    } catch {
      // Not a JSON string: the value is the text as written.
    }
  }
  return value
}

/** `write_source_property_value`: `value`, or a JSON string where the line cannot carry it bare. */
export function writeSourcePropertyValue(value: string): string {
  return /[\n\r]/.test(value) || readSourcePropertyValue(value) !== value
    ? JSON.stringify(value)
    : value
}

const UTF8 = new TextEncoder()

/** `indent_columns`: the indent's UTF-8 bytes, a tab counting twice. */
function indentColumns(line: string): number {
  const indent = line.slice(0, line.length - trimStart(line).length)
  return UTF8.encode(indent).length + indent.split('\t').length - 1
}

/** `dedent`: `line` less up to `width` columns of spaces and tabs. */
function dedent(line: string, width: number): string {
  let columns = 0
  let cut = 0
  for (const c of line) {
    if (c !== ' ' && c !== '\t') break
    columns += c === ' ' ? 1 : 2
    if (columns > width) break
    cut += 1
  }
  return line.slice(cut)
}

/** A block of a Document buffer as the Rust grammar reads it (`ParsedBlock`). */
export interface DocumentBlock {
  /** The buffer line it starts on, counted from 1. */
  line: number
  depth: number
  content: string
  /** The style its list marker gives: `-` and `*` a bullet, `N.` and `N)` numbered (D2). */
  listStyle: 'bullet' | 'ordered' | null
  /** The state its checkbox gives; a task has no list style (D3). */
  todoState: TodoState | null
  /** Its `key:: value` lines in order, the value read; an empty one clears the key. */
  properties: Array<[key: string, value: string]>
  /** The buffer line each of `properties` is on, counted from 1. */
  propertyLines: number[]
  /** The `^ID` its text ended with, read only from a buffer with no ids beside it. */
  anchor: string | null
}

export interface DocumentReading {
  blocks: DocumentBlock[]
  /** One per fence a line carrying an id ended (D5). */
  warnings: string[]
}

type Kind = 'bullet' | 'paragraph' | 'verbatim'

interface Open {
  index: number
  /** The column its line starts at. */
  marker: number
  /** The column its text starts at, which its further lines are dedented by. */
  content: number
  kind: Kind
}

/** `Open::owns_from`: the column a later block must start at to be inside this one. */
const ownsFrom = (open: Open): number => (open.kind === 'bullet' ? open.content : open.marker + 1)

/**
 * `read_page_properties`: the buffer with its front matter and the Logseq
 * `key:: value` lines after it left blank, which a block's line numbers count.
 */
function blockText(normalized: string): string {
  let at = 0
  const afterOpen = normalized.startsWith('---') ? normalized.slice(3) : null
  const close = afterOpen?.indexOf('\n---') ?? -1
  if (afterOpen !== null && close >= 0) {
    const tail = afterOpen.slice(close + 4)
    const lineEnd = tail.indexOf('\n')
    at = 3 + close + 4 + (lineEnd < 0 ? tail.length : lineEnd + 1)
  }
  for (const line of normalized.slice(at).split(/(?<=\n)/)) {
    const trimmed = trim(line)
    const property = splitPropertyLine(trimmed)
    const page = property !== null && trim(property.value) !== '' && !isBulletLine(trimmed)
    if (trimmed !== '' && !page) break
    at += line.length
  }
  const read = normalized.slice(0, at)
  return '\n'.repeat(read.split('\n').length - 1) + normalized.slice(at)
}

/**
 * The line scan of `Scan` in `ParseMode::Document`, `foreign` for text from
 * outside, as a paste reads it. Unlike Rust's, it flattens nothing past the
 * import depth limit.
 */
class Scan {
  readonly blocks: DocumentBlock[] = []
  readonly warnings: string[] = []
  private readonly endsInCode: boolean[] = []
  private readonly open: Open[] = []
  /** The open fence, the column a foreign line must reach to stay in it, and its line. */
  private fence: { run: FenceRun; column: number; line: number } | null = null
  private blankRun: string[] = []
  private afterBlank = false
  private line = 0

  private readonly idLines: ReadonlySet<number> | null
  private readonly isId: IsId
  private readonly foreign: boolean

  constructor(idLines: ReadonlySet<number> | null, isId: IsId, foreign = false) {
    this.idLines = idLines
    this.isId = isId
    this.foreign = foreign
  }

  /** `parse_block_lines`: a blank line is held until the next line, which may take it. */
  scan(lines: readonly string[]): void {
    lines.forEach((line, index) => {
      const trimmed = trimStart(line)
      if (trimmed === '') {
        this.blankRun.push(line)
        this.afterBlank = true
        return
      }
      this.read(line, trimmed, index + 1)
      this.afterBlank = false
      this.blankRun = []
    })
  }

  private read(line: string, trimmed: string, number: number): void {
    this.line = number
    const indent = indentColumns(line)
    this.endFenceBefore(trimmed, indent, number)
    const fence = this.fence
    if (fence !== null) {
      this.fence = null
      if (this.idLines === null && anchorLine(trimmed, this.isId)) {
        this.append(line, false)
      } else {
        this.append(line, true)
        if (!closesFence(trimmed, fence.run)) this.fence = fence
      }
      return
    }
    const item = bulletMarker(trimmed)
    const property = splitPropertyLine(trimmed)
    if (item !== null && this.startsItem(trimmed, indent, item.len, item.ordered)) {
      this.bullet(trimmed, indent, item.len, number)
    } else if (headingLevel(trimmed) !== null) {
      this.pushBlock(trimmed, null, null, false, indent, indent, 'verbatim')
    } else if (property !== null && this.attachProperty(property, indent)) {
      return
    } else if (this.continues(trimmed, indent)) {
      this.append(line, false)
    } else {
      this.textBlock(trimmed, indent, number)
    }
  }

  /**
   * A fence left open ends before a foreign line left of the list item holding
   * it (CommonMark), or before a line carrying an id, with a warning (D5).
   */
  private endFenceBefore(trimmed: string, indent: number, number: number): void {
    if (this.fence === null) return
    if (this.foreign && indent < this.fence.column) {
      this.fence = null
      return
    }
    const carriesId =
      this.idLines === null
        ? isBulletLine(trimmed) && trailingAnchor(trimmed, this.isId)
        : this.idLines.has(number)
    if (!carriesId) return
    const { run, line } = this.fence
    this.warnings.push(
      `the ${run.ch.repeat(run.len)} code fence opened on line ${line} is not closed; it ends ` +
        `before the block on line ${number}`,
    )
    this.fence = null
  }

  private startsItem(trimmed: string, indent: number, len: number, ordered: boolean): boolean {
    if (!this.continuesParagraph(indent)) return true
    const hasText = trim(trimmed.slice(len)) !== ''
    const inItem = this.open.some((open) => open.kind === 'bullet')
    if (ordered) return (hasText || inItem) && Number(trimmed.slice(0, len - 1)) === 1
    return hasText || inItem
  }

  private continuesParagraph(indent: number): boolean {
    const top = this.open.at(-1)
    if (top === undefined) return false
    return (
      top.kind !== 'verbatim' &&
      this.endsInCode[top.index] !== true &&
      !this.afterBlank &&
      indent >= this.itemColumn()
    )
  }

  private itemColumn(): number {
    return this.open.findLast((open) => open.kind === 'bullet')?.content ?? 0
  }

  /** `-` and `*` mark a bullet, `N.` and `N)` a numbered block, `+` none, a checkbox a task. */
  private bullet(trimmed: string, indent: number, len: number, number: number): void {
    const marker = trimmed.slice(0, len)
    const { state, rest } = splitBlockTaskMarker(bulletText(trimmed, len))
    const plain = state !== null || marker === '+'
    const style = /[.)]$/.test(marker) ? 'ordered' : 'bullet'
    const run = fenceRun(rest)
    const content = indent + len + 1
    this.pushBlock(rest, plain ? null : style, state, run !== null, indent, content, 'bullet')
    if (run !== null) this.fence = { run, column: content, line: number }
  }

  /** A paragraph, or a fence or a break, its first line's escape taken off. */
  private textBlock(trimmed: string, indent: number, number: number): void {
    const run = fenceRun(trimmed)
    const rule = isThematicBreak(trimmed)
    const text = rule ? trimmed : unescapeBareLine(trimmed)
    this.pushBlock(text, null, null, run !== null, indent, indent, rule ? 'verbatim' : 'paragraph')
    if (run !== null) this.fence = { run, column: this.itemColumn(), line: number }
  }

  private pushBlock(
    content: string,
    listStyle: DocumentBlock['listStyle'],
    todoState: TodoState | null,
    isCode: boolean,
    marker: number,
    column: number,
    kind: Kind,
  ): void {
    while (this.open.length > 0 && ownsFrom(this.open.at(-1) as Open) > marker) this.open.pop()
    this.blocks.push({
      line: this.line,
      depth: this.open.length,
      content,
      listStyle,
      todoState,
      properties: [],
      propertyLines: [],
      anchor: null,
    })
    this.endsInCode.push(isCode)
    this.open.push({ index: this.blocks.length - 1, marker, content: column, kind })
  }

  /** A fence or a break is never continued: it starts a block wherever it stands (D1). */
  private continues(trimmed: string, indent: number): boolean {
    const top = this.open.at(-1)
    if (top === undefined || top.kind === 'verbatim') return false
    const ownBlock = fenceRun(trimmed) !== null || isThematicBreak(trimmed)
    if (top.kind === 'bullet' && indent >= top.content) return !ownBlock
    return !this.afterBlank && !ownBlock
  }

  /** `append_source_line`: the line and the blank lines before it, less the text's indent. */
  private append(line: string, isCode: boolean): void {
    const top = this.open.at(-1) as Open
    const block = this.blocks[top.index] as DocumentBlock
    for (const blank of this.blankRun) block.content += `\n${dedent(blank, top.content)}`
    const text = dedent(line, top.content)
    block.content += `\n${isCode ? unescapeCodeLine(text) : unescapeContinuation(text)}`
    this.endsInCode[top.index] = isCode
  }

  /**
   * `property_line` then `attach_property`: a `key:: value` line belongs to
   * the innermost open block at or left of it, unless its key is one only the
   * app writes, or no block is. Returns whether it was one.
   */
  private attachProperty(property: { key: string; value: string }, indent: number): boolean {
    // Text from outside clears nothing: its `key::` is text.
    if (this.foreign && trim(property.value) === '') return false
    const owner = this.open.findLast((open) => open.marker <= indent)
    if (owner === undefined || FOLDED_RESERVED_KEYS.has(foldPropertyKey(trim(property.key)))) {
      return false
    }
    const block = this.blocks[owner.index] as DocumentBlock
    block.properties.push([trim(property.key), readSourcePropertyValue(property.value)])
    block.propertyLines.push(this.line)
    return true
  }

  /** `extract_block_anchors`: the `^ID` ending a block's text, unless that text ends in code. */
  extractAnchors(): void {
    this.blocks.forEach((block, i) => {
      if (this.endsInCode[i] === true) return
      const anchor = BLOCK_ANCHOR.exec(block.content)
      if (anchor === null) return
      block.content = block.content.slice(0, anchor.index)
      block.anchor = anchor[1] ?? null
    })
  }
}

/** `unescape_bare_line`: a first line written with no marker, its escape off. */
function unescapeBareLine(text: string): string {
  return text.startsWith('\\') && needsBareLineEscape(text.slice(1), true) ? text.slice(1) : text
}

/** `unescape_continuation` in a Document buffer. */
function unescapeContinuation(text: string): string {
  return text.startsWith('\\') && needsDocumentLineEscape(text.slice(1)) ? text.slice(1) : text
}

/** `unescape_code_line`. */
function unescapeCodeLine(text: string): string {
  return text.startsWith('\\') && needsAnchorLineEscape(text.slice(1)) ? text.slice(1) : text
}

/**
 * `text`, a Document buffer, read into blocks: with `lineIds` (the id each line
 * carries beside the text, one entry per line) as `import::parse_document_text`
 * reads it, and with none as `parse_document_outline` reads a buffer with each
 * block's `^ID` written in it.
 * A blank line separates blocks, but neighbouring list lines need none; a
 * paragraph's lines run to the next blank line; a heading, a fence and a
 * break start a block wherever they stand (D1 as amended), and a heading or a
 * break is a block of one line that owns nothing (D7); a line holding only
 * `\` is an empty block, or inside a block an empty line (D4). The front
 * matter and the page's `key:: value` lines after it are no block's. With no
 * ids beside the lines, `isId` tells which `^word` is one.
 */
export function parseDocument(
  text: string,
  lineIds: ReadonlyArray<string | null | undefined> | null,
  isId: IsId = isUlid,
): DocumentReading {
  const idLines = lineIds && new Set(lineIds.flatMap((id, i) => (id == null ? [] : [i + 1])))
  const scan = new Scan(idLines, isId)
  scan.scan(blockText(text.replace(/\r\n?/g, '\n')).split('\n'))
  if (idLines === null) scan.extractAnchors()
  return { blocks: scan.blocks, warnings: scan.warnings }
}

/**
 * `text` pasted from outside, read into blocks as `import::parse_pasted_text`
 * reads it (#6190): as a Document buffer, but with no page properties, a
 * `key::` with no value kept as text, a fence ended by a line left of the list
 * item holding it, and a trailing `^word` that is no block id kept in the text,
 * a space before it. So `- x` and `* x` are bulleted blocks, `1. x` a numbered
 * one, `+ x` a plain one and `- [ ] x` a task (#5691 D2, D4).
 */
export function parsePastedText(text: string): DocumentBlock[] {
  const scan = new Scan(null, isUlid, true)
  scan.scan(text.replace(/\r\n?/g, '\n').split('\n'))
  scan.extractAnchors()
  for (const block of scan.blocks) {
    const word = block.anchor
    if (word === null || BLOCK_ID.test(word)) continue
    block.content = `${block.content}${block.content === '' ? '' : ' '}^${word}`
    block.anchor = null
  }
  return scan.blocks
}

/** Where a written line puts what is under it: whether it opens with a list marker, and its text's column. */
interface LineLayout {
  marked: boolean
  /** The column its property lines and children are written at. */
  childColumn: number
}

/** `line`'s layout as the scan reads it: past a list marker, else two columns past its indent. */
export function lineLayout(line: string): LineLayout {
  const marker = bulletMarker(trimStart(line))
  return {
    marked: marker !== null,
    childColumn: indentColumns(line) + (marker === null ? 2 : marker.len + 1),
  }
}

/** The checkbox `todoState` is written as, `null` outside the alphabet (`task_marker_for`). */
function checkboxOf(todoState: string | null): string | null {
  return todoState !== null && Object.hasOwn(TASK_STATE_TO_MARKER, todoState)
    ? TASK_STATE_TO_MARKER[todoState as TodoState]
    : null
}

/** Where {@link DocumentLayout.place} puts a block, and what it opens with. */
interface DocumentPlace {
  /** Whether a blank line goes before it. */
  blank: boolean
  indent: string
  /** `- `, `N. `, `+ ` or nothing. */
  marker: string
  /** `[x] ` and the like, or nothing. */
  taskMarker: string
  /** The indent of its property lines and children. */
  childIndent: string
}

/**
 * `DocumentLayout` (`markdown.rs`): where a Document buffer's walk stands, for
 * each open depth the column its block's children are written at and whether
 * that block is written with a marker, and whether the block before was.
 */
export class DocumentLayout {
  private readonly open: Array<{ column: number; marked: boolean }>
  private previous: boolean | null

  constructor(
    open: Array<{ column: number; marked: boolean }> = [],
    previous: boolean | null = null,
  ) {
    this.open = open
    this.previous = previous
  }

  /** Whether the block placed last opens with a marker; null before any. */
  get previousMarked(): boolean | null {
    return this.previous
  }

  /**
   * `place`: a block at `depth`, its `listMarker` (`- `, `N. ` or nothing) and
   * its task state. A blank line goes before it unless it and the block before
   * both open with a marker (D1). A state in the checkbox alphabet makes it a
   * task, `- [ ] `, whatever its list marker (D3), and another state leaves it
   * none. A plain block is bare, but a `+` item under a block written with a
   * marker, whose indented lines continue it (D4), and where `opensRule`, a
   * first block opening the buffer with `---`, which would open front matter.
   */
  place(
    depth: number,
    listMarker: string,
    todoState: string | null,
    opensRule: boolean,
  ): DocumentPlace {
    if (this.open.length > depth) this.open.length = depth
    const { column, marked: underMarker } = this.open.at(-1) ?? { column: 0, marked: false }
    const checkbox = checkboxOf(todoState)
    let marker = ''
    if (checkbox !== null) marker = '- '
    else if (todoState === null && listMarker !== '') marker = listMarker
    else if (underMarker || opensRule) marker = '+ '
    const marked = marker !== ''
    const blank = this.previous !== null && !(this.previous && marked)
    this.previous = marked
    const child = column + (marked ? marker.length : 2)
    this.open.push({ column: child, marked })
    return {
      blank,
      indent: ' '.repeat(column),
      marker,
      taskMarker: checkbox === null ? '' : `[${checkbox}] `,
      childIndent: ' '.repeat(child),
    }
  }
}

/**
 * `push_block_bullet` in a Document buffer: the markers and the first line,
 * escaped when it would read as something else, then the further lines at the
 * text's column, each escaped that would read as anything but that line of
 * the block. Outside a fence an escaped line opens none, so only the first
 * line can. Returns whether the last line is code (`CodeLines::last`).
 */
export function pushDocumentLines(
  lines: string[],
  indent: string,
  listMarker: string,
  taskMarker: string,
  text: string,
): boolean {
  const [first = '', ...rest] = text.split('\n')
  const markers = listMarker + taskMarker
  let head = indent + markers
  if (first === '' && markers !== '') {
    head = indent + markers.trimEnd()
  } else {
    const escape =
      listMarker === ''
        ? needsBareLineEscape(first, rest.length > 0)
        : taskMarker === '' && needsTaskMarkerEscape(first)
    head += (escape ? '\\' : '') + first
  }
  lines.push(head)
  let fence = documentFenceOpener(head)
  let last = fence !== null
  const column = indent + ' '.repeat(listMarker.length)
  for (const line of rest) {
    const escape = fence === null ? needsDocumentLineEscape(line) : needsAnchorLineEscape(line)
    const written = column + (escape ? '\\' : '') + line
    last = fence !== null
    if (fence !== null && closesFence(written, fence)) fence = null
    lines.push(written)
  }
  return last
}
