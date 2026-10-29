/**
 * The *Edit as Markdown* buffer's blocks (#5160 phase 5, #5691): the block at
 * the cursor, which the buffer's toolbar, block menu and outline keys act on,
 * and the edits they make to its lines. The buffer is in the Document dialect
 * and is read as the Rust grammar reads it (`parseDocument`). A block an edit
 * changes is written again as the backend writes it (`DocumentLayout`,
 * `pushDocumentLines`): its list marker or task checkbox, its text with the
 * escapes it needs, its property lines as typed and its children at its text's
 * column, a blank line between it and a neighbour unless both are list lines.
 * So the save reads it back as the block editor would have written it: the
 * text through the block editor's own `convertBlockContent`, the list style
 * as its marker, and the priority and dates as `priority::`, `due_date::` and
 * `scheduled_date::` lines.
 */

import type { NodeType, Node as PMNode } from '@tiptap/pm/model'
import { type Command, type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'

import {
  closesFence,
  type DocumentBlock,
  DocumentLayout,
  documentFenceOpener,
  type FenceRun,
  lineLayout,
  parseDocument,
  pushDocumentLines,
} from '@/editor/source-buffer-document'
import { type BlockTypeToken, convertBlockContent, detectBlockType } from '@/lib/block-type-convert'
import { foldPropertyKey } from '@/lib/inline-property-parse'
import { type ListStyle, listStyleForBlockType } from '@/lib/list-style'
import { PRIORITY_CYCLE } from '@/lib/priority-levels'
import { nextTaskState, type TodoState } from '@/lib/task-states'

/** The positions where `doc`'s lines start, before each one's first character. */
function lineStarts(doc: PMNode): number[] {
  const starts: number[] = []
  doc.forEach((_, offset) => starts.push(offset + 1))
  return starts
}

export const isBlank = (text: string): boolean => text.trim() === ''

/** The line after the front matter (`---` … `---` at the top), 0 when there is none. */
export function frontMatterEnd(texts: readonly string[]): number {
  if (texts[0]?.trimEnd() !== '---') return 0
  const close = texts.findIndex((text, i) => i > 0 && text.trimEnd() === '---')
  return close < 0 ? 0 : close + 1
}

export interface SourceBlock {
  /** The line the block starts on, counted from 0. */
  line: number
  /** Past the block's own lines: its text's further lines and its property lines. */
  end: number
  /** Past its children too. */
  subtreeEnd: number
  /** The id its line carries; null for a block the save will create. */
  id: string | null
}

function lineTexts(doc: PMNode): string[] {
  const texts: string[] = []
  doc.forEach((line) => texts.push(line.textContent))
  return texts
}

function lineIds(doc: PMNode): Array<string | null> {
  const ids: Array<string | null> = []
  doc.forEach((line) => ids.push((line.attrs['blockId'] as string | null | undefined) ?? null))
  return ids
}

/** Past the last line before `end` that is not blank, but never before `start + 1`. */
function pastText(texts: readonly string[], start: number, end: number): number {
  let past = end
  while (past > start + 1 && isBlank(texts[past - 1] as string)) past -= 1
  return past
}

/** The buffer read once: its lines, the grammar's blocks, and where each block's lines are. */
interface Parsed {
  texts: string[]
  ids: Array<string | null>
  blocks: DocumentBlock[]
  spans: SourceBlock[]
  /** Past each block's subtree, as an index into `blocks`. */
  subtreeEnds: number[]
}

function readBuffer(doc: PMNode): Parsed {
  const texts = lineTexts(doc)
  const ids = lineIds(doc)
  const { blocks } = parseDocument(texts.join('\n'), ids)
  const depth = (i: number): number => (blocks[i] as DocumentBlock).depth
  const subtreeEnds = blocks.map(() => blocks.length)
  const open: number[] = []
  blocks.forEach((block, i) => {
    while (open.length > 0 && depth(open.at(-1) as number) >= block.depth) {
      subtreeEnds[open.pop() as number] = i
    }
    open.push(i)
  })
  const startOf = (i: number): number => (blocks[i]?.line ?? texts.length + 1) - 1
  const spans = blocks.map((block, i) => {
    const start = block.line - 1
    return {
      line: start,
      end: pastText(texts, start, startOf(i + 1)),
      subtreeEnd: pastText(texts, start, startOf(subtreeEnds[i] as number)),
      id: ids[start] ?? null,
    }
  })
  return { texts, ids, blocks, spans, subtreeEnds }
}

/** The index of the block at line `index`: the last starting at or above it; -1 above the first. */
function indexAt(buffer: Parsed, index: number): number {
  return buffer.spans.findLastIndex((span) => span.line <= index)
}

/** The index of the block `block` names, by the line it starts on. */
function indexOf(buffer: Parsed, block: SourceBlock): number {
  return buffer.spans.findIndex((span) => span.line === block.line)
}

/**
 * The block at line `index`: the block that line starts, or the one whose
 * line starts the run of lines it is in, as the grammar reads the buffer.
 * `null` in the front matter and above the first block.
 */
export function blockAt(doc: PMNode, index: number): SourceBlock | null {
  const buffer = readBuffer(doc)
  return buffer.spans[indexAt(buffer, index)] ?? null
}

/** The block the selection's head is in. */
export function blockAtCursor(state: EditorState): SourceBlock | null {
  return blockAt(state.doc, state.selection.$head.index(0))
}

/** A block of the buffer as it is written again. */
interface Written {
  /** The block it was read as, by index: its id and the cursor go with it. */
  from: number
  depth: number
  content: string
  listStyle: DocumentBlock['listStyle']
  todoState: TodoState | null
  /** Its property lines as typed. */
  properties: string[]
}

function written(buffer: Parsed, i: number): Written {
  const block = buffer.blocks[i] as DocumentBlock
  return {
    from: i,
    depth: block.depth,
    content: block.content,
    listStyle: block.listStyle,
    todoState: block.todoState,
    properties: block.propertyLines.map((line) => buffer.texts[line - 1] as string),
  }
}

function headOf(buffer: Parsed, i: number): string {
  return buffer.texts[(buffer.spans[i] as SourceBlock).line] as string
}

/** The columns and markers of the blocks a block at `depth` written in place of block `at` is under. */
function ancestors(buffer: Parsed, at: number, depth: number) {
  const open: Array<{ column: number; marked: boolean }> = []
  let want = depth - 1
  for (let i = at - 1; i >= 0 && want >= 0; i -= 1) {
    if ((buffer.blocks[i] as DocumentBlock).depth !== want) continue
    const layout = lineLayout(headOf(buffer, i))
    open[want] = { column: layout.childColumn, marked: layout.marked }
    want -= 1
  }
  return open
}

/** How many numbered blocks with no task run just before block `at` among the blocks at `depth`. */
function runBefore(buffer: Parsed, at: number, depth: number): number {
  let run = 0
  for (let i = at - 1; i >= 0; i -= 1) {
    const block = buffer.blocks[i] as DocumentBlock
    if (block.depth > depth) continue
    if (block.depth < depth || block.listStyle !== 'ordered' || block.todoState !== null) break
    run += 1
  }
  return run
}

/** A place in a block's lines: `line` lines into block `from`, `fromEnd` characters before that line's end. */
interface Spot {
  from: number
  line: number
  fromEnd: number
}

function spotOf(buffer: Parsed, doc: PMNode, pos: number): Spot | null {
  const $pos = doc.resolve(pos)
  const index = $pos.index(0)
  const from = indexAt(buffer, index)
  const span = buffer.spans[from]
  if (span === undefined) return null
  const text = buffer.texts[index] as string
  return { from, line: index - span.line, fromEnd: text.length - $pos.parentOffset }
}

/** Blocks written as lines: each block's first line and how many lines it has, by the block it was read as. */
interface Lines {
  lines: string[]
  ids: Array<string | null>
  heads: Map<number, { line: number; count: number }>
}

/**
 * `blocks` written as a Document buffer writes them in place of block `from`
 * and those after it, with `layout` standing where the block before them
 * left it: list markers numbered on from the run before them, and a `+` item
 * where a first block at the buffer's top (`atTop`) opens with `---`.
 */
function writeBlocks(
  buffer: Parsed,
  from: number,
  blocks: Written[],
  layout: DocumentLayout,
  atTop: boolean,
): Lines {
  const out: Lines = { lines: [], ids: [], heads: new Map() }
  const { lines, ids } = out
  const runs: number[] = []
  let shallowest = Number.POSITIVE_INFINITY
  for (const block of blocks) {
    if (runs.length > block.depth + 1) runs.length = block.depth + 1
    const prior =
      runs[block.depth] ?? (shallowest > block.depth ? runBefore(buffer, from, block.depth) : 0)
    const run = block.listStyle === 'ordered' && block.todoState === null ? prior + 1 : 0
    runs[block.depth] = run
    shallowest = Math.min(shallowest, block.depth)
    const listMarker =
      block.listStyle === null ? '' : block.listStyle === 'bullet' ? '- ' : `${run}. `
    const opensRule = atTop && lines.length === 0 && block.content.startsWith('---')
    const place = layout.place(block.depth, listMarker, block.todoState, opensRule)
    if (place.blank) lines.push('')
    const head = lines.length
    pushDocumentLines(lines, place.indent, place.marker, place.taskMarker, block.content)
    for (const property of block.properties) lines.push(place.childIndent + property.trimStart())
    out.heads.set(block.from, { line: head, count: lines.length - head })
    while (ids.length < lines.length) ids.push(null)
    ids[head] = buffer.ids[(buffer.spans[block.from] as SourceBlock).line] ?? null
  }
  return out
}

/**
 * Blocks `from` to `to - 1` written again as `blocks`, each naming the block
 * it was read as, in one step, the blank lines either side by the writer's
 * rule. The lines after the buffer's last block stay. With `caret` the cursor
 * goes to the end of that block's first line; else the selection stays on the
 * line of its block it was on, as far from that line's end.
 */
function rewrite(
  state: EditorState,
  buffer: Parsed,
  [from, to]: [number, number],
  blocks: Written[],
  caret?: number,
): Transaction {
  const { spans } = buffer
  const before = spans[from - 1]
  const replaceFrom = before === undefined ? (spans[from] as SourceBlock).line : before.end
  const replaceTo = spans[to]?.line ?? (spans[to - 1] as SourceBlock).end
  const layout = new DocumentLayout(
    ancestors(buffer, from, blocks[0]?.depth ?? 0),
    before === undefined ? null : lineLayout(headOf(buffer, from - 1)).marked,
  )
  const { lines, ids, heads } = writeBlocks(buffer, from, blocks, layout, replaceFrom === 0)
  const nextMarked = to < spans.length ? lineLayout(headOf(buffer, to)).marked : null
  if (nextMarked !== null && !(layout.previousMarked === true && nextMarked)) lines.push('')

  const spots = [state.selection.anchor, state.selection.head].map((pos) =>
    spotOf(buffer, state.doc, pos),
  )
  const [start, end] = lineRange(state.doc, replaceFrom, replaceTo)
  const tr = state.tr.replaceWith(
    start,
    end,
    lines.map((text, i) => lineNode(state, text, ids[i] ?? null)),
  )
  const at = (line: number, offset: number): number => {
    const node = tr.doc.child(replaceFrom + line)
    return (
      tr.doc.resolve(0).posAtIndex(replaceFrom + line) +
      1 +
      Math.max(0, Math.min(offset, node.content.size))
    )
  }
  const placed = (spot: Spot | null): number | null => {
    const head = spot === null ? undefined : heads.get(spot.from)
    if (spot === null || head === undefined) return null
    const line = head.line + Math.min(spot.line, head.count - 1)
    return at(line, (lines[line] as string).length - spot.fromEnd)
  }
  const [anchor, cursor] =
    caret === undefined
      ? spots.map(placed)
      : [heads.get(caret)].map((head) => (head === undefined ? null : at(head.line, Infinity)))
  if (anchor != null) tr.setSelection(TextSelection.create(tr.doc, anchor, cursor ?? anchor))
  return tr.scrollIntoView()
}

/**
 * Write the block at index `at` again with `change` made to it, and its
 * children with it, at the column its marker puts them, `+` items under a
 * list block (D4). With `caret`, the cursor goes to the end of its first line.
 */
function rewriteAt(
  state: EditorState,
  buffer: Parsed,
  at: number,
  change: (block: Written) => Written,
  caret: boolean,
): Transaction {
  const end = buffer.subtreeEnds[at] as number
  const blocks = [change(written(buffer, at))]
  for (let i = at + 1; i < end; i += 1) blocks.push(written(buffer, i))
  return rewrite(state, buffer, [at, end], blocks, caret ? at : undefined)
}

function rewriteBlock(block: SourceBlock, change: (block: Written) => Written): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const at = indexOf(buffer, block)
    if (at >= 0) dispatch?.(rewriteAt(state, buffer, at, change, true))
    return true
  }
}

function lineType(state: EditorState): NodeType {
  return state.schema.topNodeType.contentMatch.defaultType as NodeType
}

function lineNode(state: EditorState, text: string, blockId: string | null = null): PMNode {
  return lineType(state).create({ blockId }, text === '' ? null : state.schema.text(text))
}

/** The positions before line `from` and after line `to - 1`. */
function lineRange(doc: PMNode, from: number, to: number): [number, number] {
  const starts = lineStarts(doc)
  const after = (starts[to] ?? doc.content.size + 1) - 1
  return [(starts[from] as number) - 1, after]
}

/**
 * Turn `block` into `type`, as the block editor's Turn into does: its text
 * and its list style. A list kind takes a task's checkbox off, as a task has
 * no list style (D3).
 */
export function turnInto(block: SourceBlock, type: BlockTypeToken, calloutType?: string): Command {
  const style = listStyleForBlockType(type)
  const listStyle = style === 'none' ? null : style
  return rewriteBlock(block, (read) => ({
    ...read,
    content: convertBlockContent(read.content, type, calloutType),
    listStyle,
    todoState: listStyle === null ? read.todoState : null,
  }))
}

/** Replace `block`'s text with `text`, as a divider or a query from the builder does. */
export function setBlockText(block: SourceBlock, text: string): Command {
  return rewriteBlock(block, (read) => ({ ...read, content: text }))
}

/**
 * Step the block at line `index` to the block editor's next task state
 * (`nextTaskState`), written as its checkbox: `foo`, `- [ ] foo`, `- [/] foo`,
 * `- [x] foo`, `- [-] foo`, and `foo` again: a task is written `- [ ]` whatever
 * its list style, and reads back with none (D3).
 */
export function cycleTaskAt(index: number): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const at = indexAt(buffer, index)
    if (at < 0) return true
    const change = (read: Written): Written => ({
      ...read,
      todoState: nextTaskState(read.todoState),
    })
    dispatch?.(rewriteAt(state, buffer, at, change, false))
    return true
  }
}

function readingOf(doc: PMNode, block: SourceBlock): DocumentBlock | null {
  const buffer = readBuffer(doc)
  return buffer.blocks[indexOf(buffer, block)] ?? null
}

/** The type Turn into shows as `block`'s own. */
export function blockTypeOf(doc: PMNode, block: SourceBlock): BlockTypeToken {
  const read = readingOf(doc, block)
  if (read?.listStyle === 'ordered') return 'numbered-list'
  if (read?.listStyle === 'bullet') return 'bullet-list'
  return detectBlockType(read?.content ?? '')
}

/** `block`'s task state, its checkbox's. */
export function blockTaskState(doc: PMNode, block: SourceBlock): TodoState | null {
  return readingOf(doc, block)?.todoState ?? null
}

/** Which of `read`'s property lines is its last `key::` line, as the grammar matches the key; -1 for none. */
function propertyIndex(read: DocumentBlock, key: string): number {
  return read.properties.findLastIndex(([typed]) => foldPropertyKey(typed) === foldPropertyKey(key))
}

/** The value of `block`'s `key::` line, or null. */
export function blockProperty(doc: PMNode, block: SourceBlock, key: string): string | null {
  const read = readingOf(doc, block)
  const value = read === null ? '' : (read.properties[propertyIndex(read, key)]?.[1] ?? '')
  return value === '' ? null : value
}

/** A block of the buffer as the toolbar reads it, for the Preview. */
export interface BlockReading {
  /** How many blocks it is nested under. */
  depth: number
  listStyle: ListStyle
  taskState: TodoState | null
  /** Its text as the block holds it, markers and escapes off. */
  text: string
  properties: Array<[key: string, value: string]>
}

/** Every block below the front matter, in order, as the Rust grammar reads the buffer ({@link parseDocument}). */
export function readBlocks(
  texts: readonly string[],
  ids: ReadonlyArray<string | null>,
): BlockReading[] {
  return parseDocument(texts.join('\n'), ids).blocks.map((block) => ({
    depth: block.depth,
    listStyle: block.listStyle ?? 'none',
    taskState: block.todoState,
    text: block.content,
    properties: block.properties,
  }))
}

/** The front matter's `key: value` lines; the lines under a `key: |` (or any) line continue its value. */
export function frontMatterProperties(
  texts: readonly string[],
): Array<[key: string, value: string]> {
  const properties: Array<[string, string]> = []
  for (const text of texts.slice(1, Math.max(frontMatterEnd(texts) - 1, 1))) {
    const last = properties.at(-1)
    const match = /^([^\s:][^:]*):[ \t]*(.*)$/.exec(text)
    if (match !== null)
      properties.push([match[1] as string, (match[2] as string).trim().replace(/^\|$/, '')])
    else if (last !== undefined && !isBlank(text)) last[1] = `${last[1]} ${text.trim()}`.trim()
  }
  return properties
}

/**
 * Write `block`'s `key:: value` line, under its text at its text's column, or
 * take it out for `null`: the export's line for the block's priority and dates.
 */
export function setBlockProperty(block: SourceBlock, key: string, value: string | null): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const at = indexOf(buffer, block)
    const read = buffer.blocks[at]
    const span = buffer.spans[at]
    if (read === undefined || span === undefined) return true
    const found = propertyIndex(read, key)
    const tr = state.tr
    if (found >= 0) {
      const line = (read.propertyLines[found] as number) - 1
      const [start, end] = lineRange(state.doc, line, line + 1)
      if (value === null) {
        tr.delete(start, end)
      } else {
        const indent = /^[ \t]*/.exec(buffer.texts[line] as string)?.[0].length ?? 0
        const typed = read.properties[found]?.[0] ?? key
        tr.insertText(`${typed}:: ${value}`, start + 1 + indent, end - 1)
      }
    } else if (value !== null) {
      const column = lineLayout(headOf(buffer, at)).childColumn
      const [, after] = lineRange(state.doc, span.end - 1, span.end)
      tr.insert(after, lineNode(state, `${' '.repeat(column)}${key}:: ${value}`))
    }
    if (tr.docChanged) dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** Step `block`'s priority through the block editor's cycle (`PRIORITY_CYCLE`). */
export function cyclePriority(block: SourceBlock): Command {
  return (state, dispatch) => {
    const cycle = PRIORITY_CYCLE
    const current = blockProperty(state.doc, block, 'priority')
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? null
    return setBlockProperty(block, 'priority', next)(state, dispatch)
  }
}

/** Delete `block` and its children, as the block editor's Delete does. */
export function deleteBlock(block: SourceBlock): Command {
  return (state, dispatch) => {
    const [start, end] = lineRange(state.doc, block.line, block.subtreeEnd)
    const tr = state.tr
    if (start === 0 && end === state.doc.content.size)
      tr.replaceWith(start, end, lineNode(state, ''))
    else tr.delete(start, end)
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/**
 * A copy of `block` and its children after them, new blocks all, as the block
 * editor's Duplicate makes, a blank line before it unless it and the last
 * block of what it copies are both list lines (D1).
 */
export function duplicateBlock(block: SourceBlock): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const at = indexOf(buffer, block)
    if (at < 0) return true
    const last = (buffer.subtreeEnds[at] as number) - 1
    const texts = buffer.texts.slice(block.line, block.subtreeEnd)
    if (!(lineLayout(headOf(buffer, at)).marked && lineLayout(headOf(buffer, last)).marked)) {
      texts.unshift('')
    }
    const [, after] = lineRange(state.doc, block.subtreeEnd - 1, block.subtreeEnd)
    const tr = state.tr.insert(
      after,
      texts.map((text) => lineNode(state, text)),
    )
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/**
 * The blocks lines `first` to `last` touch, each with its further lines and
 * children, as indexes into the buffer's blocks: `[from, to)`. `null` where
 * they touch none, as in the front matter.
 */
function touched(buffer: Parsed, first: number, last: number): [number, number] | null {
  const from = Math.max(indexAt(buffer, first), 0)
  const until = indexAt(buffer, last) + 1
  if (until <= from) return null
  let to = until
  for (let i = from; i < until; i += 1) to = Math.max(to, buffer.subtreeEnds[i] as number)
  return [from, to]
}

/** The block before block `at` that has its parent, or -1. */
function siblingBefore(buffer: Parsed, at: number): number {
  const depth = (buffer.blocks[at] as DocumentBlock).depth
  for (let i = at - 1; i >= 0; i -= 1) {
    const before = (buffer.blocks[i] as DocumentBlock).depth
    if (before === depth) return i
    if (before < depth) return -1
  }
  return -1
}

/**
 * Indent the blocks lines `first` to `last` touch, each with its further lines
 * and children, a level, under the sibling before the first of them, as the
 * block editor's Indent does; with no sibling before it, nothing moves.
 */
export function indentRange(first: number, last: number): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const range = touched(buffer, first, last)
    if (range === null || siblingBefore(buffer, range[0]) < 0) return true
    const blocks: Written[] = []
    for (let i = range[0]; i < range[1]; i += 1) {
      const block = written(buffer, i)
      blocks.push({ ...block, depth: block.depth + 1 })
    }
    dispatch?.(rewrite(state, buffer, range, blocks))
    return true
  }
}

/**
 * Dedent the blocks lines `first` to `last` touch a level, as the block
 * menu's Dedent: a top-level block has nowhere to go, and the blocks selected
 * with it stay where they are too. The blocks after them under the same
 * parent go under them, as the text then reads, and are written again there.
 */
export function dedentRange(first: number, last: number): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const range = touched(buffer, first, last)
    if (range === null) return true
    const blocks: Written[] = []
    let shallowest = Number.POSITIVE_INFINITY
    for (let i = range[0]; i < range[1]; i += 1) {
      const block = written(buffer, i)
      if (block.depth === 0) return true
      shallowest = Math.min(shallowest, block.depth)
      blocks.push({ ...block, depth: block.depth - 1 })
    }
    let to = range[1]
    while (to < buffer.blocks.length && (buffer.blocks[to] as DocumentBlock).depth >= shallowest) {
      blocks.push(written(buffer, to))
      to += 1
    }
    dispatch?.(rewrite(state, buffer, [range[0], to], blocks))
    return true
  }
}

/**
 * The blocks lines `first` to `last` start in, with the children of the last,
 * moved past their sibling before them (`-1`) or after them (`1`), in one
 * step: each keeps its id, and a selection in them goes with them. Nothing
 * moves when there is no such sibling, when one of them is shallower than the
 * first, or in the front matter, which no move enters or leaves.
 */
export function moveRange(first: number, last: number, direction: -1 | 1): Command {
  return (state, dispatch) => {
    const buffer = readBuffer(state.doc)
    const from = indexAt(buffer, first)
    const until = indexAt(buffer, last)
    if (from < 0) return true
    const depthOf = (i: number): number | undefined => buffer.blocks[i]?.depth
    const depth = depthOf(from) as number
    let end = from + 1
    for (; end < buffer.blocks.length; end += 1) {
      const next = depthOf(end) as number
      if (next < depth && end <= until) return true
      if (next < depth || (next === depth && end > until)) break
    }
    const run = (a: number, b: number): Written[] =>
      Array.from({ length: b - a }, (_, i) => written(buffer, a + i))
    if (direction < 0) {
      const before = siblingBefore(buffer, from)
      if (before >= 0) {
        dispatch?.(rewrite(state, buffer, [before, end], [...run(from, end), ...run(before, from)]))
      }
    } else if (depthOf(end) === depth) {
      const after = buffer.subtreeEnds[end] as number
      dispatch?.(rewrite(state, buffer, [from, after], [...run(end, after), ...run(from, end)]))
    }
    return true
  }
}

/** The fence open after `text`, a line read with `fence` open before it. */
export function fenceAfter(fence: FenceRun | null, text: string): FenceRun | null {
  if (fence === null) return documentFenceOpener(text)
  return closesFence(text, fence) ? null : fence
}

/**
 * The fence open where line `index` of `doc` starts, read from the top as the
 * grammar reads fences: one a line opens, closed by a run at least as long,
 * and ended before a line carrying an id (D5).
 */
export function fenceBefore(doc: PMNode, index: number): FenceRun | null {
  let fence: FenceRun | null = null
  for (let i = 0; i <= index && i < doc.childCount; i += 1) {
    const line = doc.child(i)
    if (line.attrs['blockId'] != null) fence = null
    if (i === index) break
    fence = fenceAfter(fence, line.textContent)
  }
  return fence
}

/**
 * Wrap the selection in `open` and `close`, as a mark's markdown, or take
 * them off when they already wrap it; at a caret, put them either side of it.
 */
export function toggleWrap(open: string, close: string): Command {
  return (state, dispatch) => {
    const { $from, $to, from, to, empty } = state.selection
    const before = $from.parent.textContent.slice(0, $from.parentOffset)
    const after = $to.parent.textContent.slice($to.parentOffset)
    const tr = state.tr
    if (!empty && before.endsWith(open) && after.startsWith(close)) {
      tr.delete(to, to + close.length).delete(from - open.length, from)
    } else {
      tr.insertText(close, to).insertText(open, from)
      tr.setSelection(TextSelection.create(tr.doc, from + open.length, to + open.length))
    }
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/**
 * Type `trigger` at the cursor, which opens its picker. A selection stays
 * after it, so the picker searches it; with `close`, the selection is closed
 * in instead, `[[selected text]]`, which the save resolves as typed.
 */
export function insertTrigger(trigger: string, close?: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const closed = !empty && close !== undefined
    const tr = state.tr
    if (closed) tr.insertText(close, to)
    tr.insertText(trigger, from)
    const end = to + trigger.length + (closed ? close.length : 0)
    tr.setSelection(TextSelection.create(tr.doc, end))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** `#` at the cursor, after a space unless one is there: the tag picker opens only there. */
export const insertTagTrigger: Command = (state, dispatch) => {
  const { $from } = state.selection
  const previous = $from.parent.textContent.slice(0, $from.parentOffset).at(-1)
  const spaced = previous === undefined || /\s/.test(previous)
  return insertTrigger(spaced ? '#' : ' #')(state, dispatch)
}

/** `text` in place of the selection, the cursor after it. */
export function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text).scrollIntoView())
    return true
  }
}
