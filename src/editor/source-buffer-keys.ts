/**
 * The *Edit as Markdown* buffer's outline keys (#5160 phase 5): the keyboard
 * catalog's indent, dedent, task-cycle and move bindings by id, user overrides
 * included, acting on lines of markdown as the block editor acts on blocks.
 * Tab and Shift+Tab indent and dedent too while *Tab indents blocks* is on
 * (Settings → Editor), the opt-out that gives Tab back to focus navigation;
 * Escape leaves the buffer either way.
 *
 * No key changes which line carries which id. Indent, dedent and the cycle
 * edit text past a line's start, which stays where it was, and a move puts the
 * same line nodes back in a new order: a replaced line's start is gone, so it
 * keeps the id it carries (`lineIdsAfter`).
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type Command, type EditorState, Plugin, TextSelection } from '@tiptap/pm/state'

import { isTabIndentEnabled } from '@/lib/editor-preferences'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { nextTaskState, TASK_STATE_TO_MARKER, taskStateFromMarker } from '@/lib/task-states'

/** A child is indented two spaces under its parent (the export's indent). */
const INDENT = '  '

/** The positions where `doc`'s lines start, before each one's first character. */
export function lineStarts(doc: PMNode): number[] {
  const starts: number[] = []
  doc.forEach((_, offset) => starts.push(offset + 1))
  return starts
}

/**
 * The first and last line the selection touches. A selection that ends where
 * a line starts leaves that line out, as text editors do.
 */
function touchedLines({ doc, selection }: EditorState): [number, number] {
  const { $from, $to, empty } = selection
  const first = Math.min($from.index(0), doc.childCount - 1)
  let last = Math.min($to.index(0), doc.childCount - 1)
  if (!empty && last > first && $to.depth === 1 && $to.parentOffset === 0) last -= 1
  return [first, last]
}

/** Indent lines `first` to `last` two spaces. */
export function indentRange(first: number, last: number): Command {
  return (state, dispatch) => {
    const starts = lineStarts(state.doc)
    const tr = state.tr
    for (let i = last; i >= first; i -= 1) tr.insertText(INDENT, starts[i])
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

const indentLines: Command = (state, dispatch) =>
  indentRange(...touchedLines(state))(state, dispatch)

/** Up to two leading spaces, or a tab. */
const LEADING_INDENT = /^(?:\t| {1,2})/

/** Take up to two leading spaces, or a tab, off lines `first` to `last`. */
export function dedentRange(first: number, last: number): Command {
  return (state, dispatch) => {
    const starts = lineStarts(state.doc)
    const tr = state.tr
    for (let i = last; i >= first; i -= 1) {
      const width = LEADING_INDENT.exec(state.doc.child(i).textContent)?.[0].length ?? 0
      const start = starts[i] as number
      if (width > 0) tr.delete(start, start + width)
    }
    if (tr.docChanged) dispatch?.(tr.scrollIntoView())
    return true
  }
}

const dedentLines: Command = (state, dispatch) =>
  dedentRange(...touchedLines(state))(state, dispatch)

// A list line: its indentation and list markers (`- 1.` is a bullet holding an
// ordered list style), then the task checkbox it holds, if any.
const TASK_LINE = /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))+)(\[([ xX/-])\](?:[ \t]|$))?/

/**
 * Step list line `index` to the block editor's next task state
 * (`nextTaskState`), written as the checkbox after its marker: `- foo`,
 * `- [ ] foo`, `- [/] foo`, `- [x] foo`, `- [-] foo`, and `- foo` again.
 */
export function cycleTaskAt(index: number): Command {
  return (state, dispatch) => {
    const match = TASK_LINE.exec(state.doc.child(index).textContent)
    if (match === null) return true
    const [, prefix = '', box, marker] = match
    const at = (lineStarts(state.doc)[index] as number) + prefix.length
    const next = nextTaskState(marker === undefined ? null : taskStateFromMarker(marker))
    const tr = state.tr
    if (next === null) tr.delete(at, at + (box?.length ?? 0))
    else if (box !== undefined) tr.insertText(TASK_STATE_TO_MARKER[next], at + 1, at + 2)
    else tr.insertText(`${/[ \t]$/.test(prefix) ? '' : ' '}[${TASK_STATE_TO_MARKER[next]}] `, at)
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

const cycleTask: Command = (state, dispatch) => cycleTaskAt(touchedLines(state)[0])(state, dispatch)

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

interface LineMove {
  /** The lines `[from, to)` the move rewrites. */
  from: number
  to: number
  /** Those lines' indexes in their new order. */
  order: number[]
  /** Where the moved lines' first line was, and where it goes. */
  movedFrom: number
  movedTo: number
}

const span = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i)

/**
 * Lines `first` to `last` with the subtree of the last, moved past the sibling
 * subtree before them (`-1`) or after them (`1`): the nearest line at their
 * indentation with no shallower line between. The blank lines between the two
 * stay between them. `null` when there is no such sibling, when the lines are
 * not siblings (one is shallower than the first), when the first is blank,
 * and in the front matter, which no move enters or leaves.
 */
function lineMove(
  texts: readonly string[],
  first: number,
  last: number,
  direction: -1 | 1,
): LineMove | null {
  const top = frontMatterEnd(texts)
  const firstText = texts[first] as string
  if (first < top || isBlank(firstText)) return null
  const level = depthOf(firstText)
  let end = first + 1
  for (let i = first + 1; i < texts.length; i += 1) {
    const text = texts[i] as string
    if (isBlank(text)) continue
    const depth = depthOf(text)
    if (depth < level && i <= last) return null
    if (depth < level || (depth === level && i > last)) break
    end = i + 1
  }
  if (direction < 0) {
    let prev = first - 1
    const inside = (i: number): boolean =>
      isBlank(texts[i] as string) || depthOf(texts[i] as string) > level
    while (prev >= top && inside(prev)) prev -= 1
    if (prev < top || depthOf(texts[prev] as string) < level) return null
    let prevEnd = first
    while (isBlank(texts[prevEnd - 1] as string)) prevEnd -= 1
    return {
      from: prev,
      to: end,
      order: [...span(first, end), ...span(prevEnd, first), ...span(prev, prevEnd)],
      movedFrom: first,
      movedTo: prev,
    }
  }
  let next = end
  while (next < texts.length && isBlank(texts[next] as string)) next += 1
  if (next >= texts.length || depthOf(texts[next] as string) !== level) return null
  const nextEnd = subtreeEnd(texts, next, level)
  return {
    from: first,
    to: nextEnd,
    order: [...span(next, nextEnd), ...span(end, next), ...span(first, end)],
    movedFrom: first,
    movedTo: first + (nextEnd - end),
  }
}

/**
 * Move lines `first` to `last`, with their subtrees, past their sibling, in
 * one step: the same line nodes, ids and all, replace the lines they were, and
 * a selection in the lines that move goes with them.
 */
export function moveRange(first: number, last: number, direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { doc, selection } = state
    const texts: string[] = []
    doc.forEach((line) => texts.push(line.textContent))
    const move = lineMove(texts, first, last, direction)
    if (move === null) return true
    const starts = lineStarts(doc)
    const before = (index: number): number => (starts[index] ?? doc.content.size + 1) - 1
    const lines = move.order.map((i) => doc.child(i))
    const tr = state.tr.replaceWith(before(move.from), before(move.to), lines)
    const offset = tr.doc.resolve(0).posAtIndex(move.movedTo) - before(move.movedFrom)
    const moved = (pos: number) => tr.doc.resolve(Math.min(pos + offset, tr.doc.content.size))
    tr.setSelection(TextSelection.between(moved(selection.anchor), moved(selection.head)))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** Move the lines the selection touches past their sibling. */
function moveLines(direction: -1 | 1): Command {
  return (state, dispatch) => moveRange(...touchedLines(state), direction)(state, dispatch)
}

/** The command a key runs in the buffer, or `null` for a key it leaves alone. */
function commandFor(event: KeyboardEvent): Command | null {
  if (matchesShortcutBinding(event, 'indentBlock')) return indentLines
  if (matchesShortcutBinding(event, 'dedentBlock')) return dedentLines
  if (matchesShortcutBinding(event, 'moveBlockUp')) return moveLines(-1)
  if (matchesShortcutBinding(event, 'moveBlockDown')) return moveLines(1)
  if (matchesShortcutBinding(event, 'cycleTaskState')) return cycleTask
  const plainTab = event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
  if (plainTab && isTabIndentEnabled()) return event.shiftKey ? dedentLines : indentLines
  return null
}

export const SourceBufferKeys = Extension.create({
  name: 'sourceBufferKeys',
  // Ahead of TipTap's own keymaps; the pickers, higher still, take their keys first.
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // A bound key is the buffer's even where it changes nothing, as at
          // the top of a move, so the browser does not act on it either.
          handleKeyDown(view, event) {
            const command = commandFor(event)
            if (command === null) return false
            command(view.state, view.dispatch)
            return true
          },
        },
      }),
    ]
  },
})
