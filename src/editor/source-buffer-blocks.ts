/**
 * The *Edit as Markdown* buffer's blocks (#5160 phase 5): the block at the
 * cursor, which the buffer's toolbar and block menu act on, and the edits they
 * make to its lines. Each edit writes what the export writes, so the save
 * reads it back as the block editor would have written it: the text through
 * the block editor's own `convertBlockContent`, the list style as the
 * export's `- 1.` / `- -` marker, and the priority and dates as its
 * `priority::`, `due_date::` and `scheduled_date::` lines.
 *
 * A block starts on a list line, or on a line carrying an id. Its own lines
 * are the lines after it indented deeper that start no block: its text's
 * further lines and its property lines. Its subtree adds its children.
 */

import type { NodeType, Node as PMNode } from '@tiptap/pm/model'
import { type Command, type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'

import { type BlockTypeToken, convertBlockContent, detectBlockType } from '@/lib/block-type-convert'
import { type ListStyle, listStyleForBlockType } from '@/lib/list-style'
import { getPriorityCycle } from '@/lib/priority-levels'
import { type TodoState, taskStateFromMarker } from '@/lib/task-states'

/** The positions where `doc`'s lines start, before each one's first character. */
export function lineStarts(doc: PMNode): number[] {
  const starts: number[] = []
  doc.forEach((_, offset) => starts.push(offset + 1))
  return starts
}

export const isBlank = (text: string): boolean => text.trim() === ''
export const depthOf = (text: string): number => /^[ \t]*/.exec(text)?.[0].length ?? 0

/** The line after the front matter (`---` … `---` at the top), 0 when there is none. */
export function frontMatterEnd(texts: readonly string[]): number {
  if (texts[0]?.trimEnd() !== '---') return 0
  const close = texts.findIndex((text, i) => i > 0 && text.trimEnd() === '---')
  return close < 0 ? 0 : close + 1
}

/** The end of line `start`'s subtree: past the lines after it indented deeper, and the blank lines between them. */
export function subtreeEnd(texts: readonly string[], start: number, level: number): number {
  let end = start + 1
  for (let i = start + 1; i < texts.length; i += 1) {
    const text = texts[i] as string
    if (isBlank(text)) continue
    if (depthOf(text) <= level) break
    end = i + 1
  }
  return end
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

/** A line's fence opener: three or more backticks or tildes where its text starts, past its list markers and checkbox. */
export const FENCE_OPENER =
  /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(?:\[[ xX/-]\][ \t]+)?(`{3,}(?!.*`)|~{3,})/

export function closesFence(text: string, run: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= run.length && trimmed === run.charAt(0).repeat(trimmed.length)
}

// A block's line: its indentation, its list marker, then the export's list
// style marker (`- 1.`, `- -`) and task checkbox when it has them.
const BLOCK_LINE =
  /^([ \t]*)((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))?(\[[ xX/-]\](?:[ \t]+|$))?/
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const CHECKBOX = /^\[[ xX/-]\](?:[ \t]|$)/
const HEADING = /^#{1,6}(?:[ \t]|$)/
/** `key:: value`, as the grammar reads a property line (`split_property_line`). */
const PROPERTY_LINE = /^[ \t]*([A-Za-z0-9_-]{1,64})[ \t]*::(?:[ \t]+(.*?))?[ \t]*$/

function startsBlock(line: PMNode): boolean {
  return line.attrs['blockId'] != null || BLOCK_LINE.test(line.textContent)
}

function lineTexts(doc: PMNode): string[] {
  const texts: string[] = []
  doc.forEach((line) => texts.push(line.textContent))
  return texts
}

/** Past `start`'s own lines: deeper lines starting no block, a fence's lines all its own. */
function ownEnd(doc: PMNode, texts: readonly string[], start: number): number {
  const level = depthOf(texts[start] as string)
  let fence = FENCE_OPENER.exec(texts[start] as string)?.[1] ?? null
  let end = start + 1
  for (let i = start + 1; i < texts.length; i += 1) {
    const text = texts[i] as string
    if (isBlank(text)) continue
    if (depthOf(text) <= level || doc.child(i).attrs['blockId'] != null) break
    if (fence !== null) {
      if (closesFence(text, fence)) fence = null
    } else if (startsBlock(doc.child(i))) {
      break
    } else {
      fence = FENCE_OPENER.exec(text)?.[1] ?? null
    }
    end = i + 1
  }
  return end
}

/**
 * The block at line `index`: the block that line starts, or the one whose
 * line starts the run of lines it is in. `null` in the front matter and above
 * the first block. Read from the top, so a list line inside a block's fence
 * is that block's code, not a block of its own.
 */
export function blockAt(doc: PMNode, index: number): SourceBlock | null {
  const texts = lineTexts(doc)
  let start: number | null = null
  let end = 0
  for (let i = frontMatterEnd(texts); i <= Math.min(index, texts.length - 1); i += 1) {
    if (i < end || !startsBlock(doc.child(i))) continue
    start = i
    end = ownEnd(doc, texts, i)
  }
  if (start === null) return null
  return {
    line: start,
    end,
    subtreeEnd: subtreeEnd(texts, start, depthOf(texts[start] as string)),
    id: (doc.child(start).attrs['blockId'] as string | null | undefined) ?? null,
  }
}

/** The block the selection's head is in. */
export function blockAtCursor(state: EditorState): SourceBlock | null {
  return blockAt(state.doc, state.selection.$head.index(0))
}

interface BlockLine {
  indent: string
  /** The list marker and the blanks after it; '' on a line that is no list item. */
  marker: string
  style: string
  box: string
  /** What follows, the export's escape taken off. */
  text: string
}

function firstLineNeedsEscape(text: string, style: string, box: string): boolean {
  return (style === '' && LIST_MARKER.test(text)) || (box === '' && CHECKBOX.test(text))
}

function readBlockLine(text: string): BlockLine {
  const match = BLOCK_LINE.exec(text)
  if (match === null) {
    const indent = /^[ \t]*/.exec(text)?.[0] ?? ''
    return { indent, marker: '', style: '', box: '', text: text.slice(indent.length) }
  }
  const [prefix, indent = '', marker = '', style = '', box = ''] = match
  const rest = text.slice(prefix.length)
  const escaped = rest.startsWith('\\') && firstLineNeedsEscape(rest.slice(1), style, box)
  return { indent, marker, style, box, text: escaped ? rest.slice(1) : rest }
}

function listStyleOf({ marker, style }: BlockLine): ListStyle {
  if (style !== '') return /^\d/.test(style) ? 'ordered' : 'bullet'
  return /^\d/.test(marker) ? 'ordered' : 'none'
}

const STYLE_MARKER: Record<ListStyle, string> = { none: '', bullet: '- ', ordered: '1. ' }

const withGap = (part: string): string => (part === '' || /[ \t]$/.test(part) ? part : `${part} `)

/** The block's line with `text` after its markers, in `style`: as it was when that is its style. */
function writeBlockLine(head: BlockLine, style: ListStyle, text: string): string {
  const kept = listStyleOf(head) === style && head.marker !== ''
  const markers = kept ? withGap(head.marker) + withGap(head.style) : `- ${STYLE_MARKER[style]}`
  const styleText = kept ? head.style : STYLE_MARKER[style]
  const prefix = head.indent + markers + withGap(head.box)
  if (text === '') return prefix.trimEnd()
  return prefix + (firstLineNeedsEscape(text, styleText, head.box) ? '\\' : '') + text
}

/** A further line of a block's text that would read as a marker, a heading or a property (`continuation_line_is_ambiguous`). */
function ambiguous(line: string): boolean {
  const body = line.replace(/^[\s\\]+/, '')
  return LIST_MARKER.test(body) || HEADING.test(body) || PROPERTY_LINE.test(body)
}

/** The width of `head`'s text column, where its further lines and property lines start. */
function contentIndent(head: BlockLine): string {
  return ' '.repeat(head.indent.length + Math.max(withGap(head.marker).length, 2))
}

function dropIndent(text: string, width: number): string {
  let cut = 0
  while (cut < width && (text[cut] === ' ' || text[cut] === '\t')) cut += 1
  return text.slice(cut)
}

interface BlockParts {
  head: BlockLine
  /** The block's text, a line each, as the block holds it. */
  text: string[]
  /** Its property lines, by line index. */
  properties: number[]
}

function readBlock(texts: readonly string[], block: SourceBlock): BlockParts {
  const head = readBlockLine(texts[block.line] as string)
  const width = contentIndent(head).length
  const text = [head.text]
  const properties: number[] = []
  let fence = FENCE_OPENER.exec(head.text)?.[1] ?? null
  for (let i = block.line + 1; i < block.end; i += 1) {
    const raw = texts[i] as string
    if (fence === null && PROPERTY_LINE.test(raw)) {
      properties.push(i)
      continue
    }
    const line = dropIndent(raw, width)
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      text.push(line)
    } else {
      const unescaped = line.startsWith('\\') && ambiguous(line.slice(1)) ? line.slice(1) : line
      fence = FENCE_OPENER.exec(unescaped)?.[1] ?? null
      text.push(unescaped)
    }
  }
  return { head, text, properties }
}

/** `text`'s lines as the block's lines: the first after its markers, the rest under them, escaped outside a fence. */
function writeBlock(texts: readonly string[], parts: BlockParts, style: ListStyle, text: string[]) {
  const [first = '', ...rest] = text
  const out = [writeBlockLine(parts.head, style, first)]
  const indent = contentIndent(readBlockLine(out[0] as string))
  let fence = FENCE_OPENER.exec(first)?.[1] ?? null
  for (const line of rest) {
    if (line === '') {
      out.push('')
    } else if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      out.push(indent + line)
    } else {
      fence = FENCE_OPENER.exec(line)?.[1] ?? null
      out.push(indent + (ambiguous(line) ? `\\${line}` : line))
    }
  }
  return [...out, ...parts.properties.map((i) => texts[i] as string)]
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
 * Lines `from` to `to - 1` replaced by `texts`, the first keeping the id the
 * first of them carries: the block keeps its id while its text changes.
 */
function replaceLines(state: EditorState, from: number, to: number, texts: string[]): Transaction {
  const id = (state.doc.child(from).attrs['blockId'] as string | null | undefined) ?? null
  const nodes = texts.map((text, i) => lineNode(state, text, i === 0 ? id : null))
  const [start, end] = lineRange(state.doc, from, to)
  const tr = state.tr.replaceWith(start, end, nodes)
  const lineEnd = tr.doc.resolve(start + 1).end()
  return tr.setSelection(TextSelection.create(tr.doc, lineEnd))
}

function rewriteBlock(
  block: SourceBlock,
  text: (parts: BlockParts) => string[],
  style?: ListStyle,
): Command {
  return (state, dispatch) => {
    const texts = lineTexts(state.doc)
    const parts = readBlock(texts, block)
    const lines = writeBlock(texts, parts, style ?? listStyleOf(parts.head), text(parts))
    dispatch?.(replaceLines(state, block.line, block.end, lines).scrollIntoView())
    return true
  }
}

/** Turn `block` into `type`, as the block editor's Turn into does: its text and its list style. */
export function turnInto(block: SourceBlock, type: BlockTypeToken): Command {
  return rewriteBlock(
    block,
    (parts) => convertBlockContent(parts.text.join('\n'), type).split('\n'),
    listStyleForBlockType(type),
  )
}

/** Replace `block`'s text with `text`, as a divider or a query from the builder does. */
export function setBlockText(block: SourceBlock, text: string): Command {
  return rewriteBlock(block, () => text.split('\n'))
}

/** The type Turn into shows as `block`'s own. */
export function blockTypeOf(doc: PMNode, block: SourceBlock): BlockTypeToken {
  const parts = readBlock(lineTexts(doc), block)
  const style = listStyleOf(parts.head)
  if (style === 'ordered') return 'numbered-list'
  if (style === 'bullet') return 'bullet-list'
  return detectBlockType(parts.text.join('\n'))
}

/** `block`'s task state, its checkbox's. */
export function blockTaskState(doc: PMNode, block: SourceBlock): TodoState | null {
  const box = readBlockLine(doc.child(block.line).textContent).box
  return box === '' ? null : taskStateFromMarker(box.charAt(1))
}

/** `key` as the grammar matches it: case and `-`/`_` aside. */
const foldKey = (key: string): string => key.toLowerCase().replaceAll('-', '_')

function propertyLine(texts: readonly string[], block: SourceBlock, key: string): number | null {
  const found = readBlock(texts, block).properties.find(
    (i) => foldKey(PROPERTY_LINE.exec(texts[i] as string)?.[1] ?? '') === foldKey(key),
  )
  return found ?? null
}

/** The value of `block`'s `key::` line, or null. */
export function blockProperty(doc: PMNode, block: SourceBlock, key: string): string | null {
  const texts = lineTexts(doc)
  const line = propertyLine(texts, block, key)
  if (line === null) return null
  const value = PROPERTY_LINE.exec(texts[line] as string)?.[2]?.trim() ?? ''
  return value === '' ? null : value
}

/**
 * Write `block`'s `key:: value` line, under its text, or take it out for
 * `null`: the export's line for the block's priority and dates.
 */
export function setBlockProperty(block: SourceBlock, key: string, value: string | null): Command {
  return (state, dispatch) => {
    const texts = lineTexts(state.doc)
    const line = propertyLine(texts, block, key)
    const tr = state.tr
    if (line !== null) {
      const [start, end] = lineRange(state.doc, line, line + 1)
      if (value === null) {
        tr.delete(start, end)
      } else {
        const text = texts[line] as string
        const indent = depthOf(text)
        const typed = PROPERTY_LINE.exec(text)?.[1] ?? key
        tr.insertText(`${typed}:: ${value}`, start + 1 + indent, end - 1)
      }
    } else if (value !== null) {
      const head = readBlockLine(texts[block.line] as string)
      const [, after] = lineRange(state.doc, block.end - 1, block.end)
      tr.insert(after, lineNode(state, `${contentIndent(head)}${key}:: ${value}`))
    }
    if (tr.docChanged) dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** Step `block`'s priority through the block editor's cycle (`getPriorityCycle`). */
export function cyclePriority(block: SourceBlock): Command {
  return (state, dispatch) => {
    const cycle = getPriorityCycle()
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

/** A copy of `block` and its children after them, new blocks all, as the block editor's Duplicate makes. */
export function duplicateBlock(block: SourceBlock): Command {
  return (state, dispatch) => {
    const texts = lineTexts(state.doc).slice(block.line, block.subtreeEnd)
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
