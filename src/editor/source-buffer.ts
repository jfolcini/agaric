/**
 * The *Edit as Markdown* buffer's document (#5160 phase 5): the page's markdown
 * as plain-text lines, each carrying the id of the block that starts on it. A
 * line is text alone, with no marks, input rules or node conversions, so it
 * shows its markdown as typed, and the ids travel beside the text, never in it.
 *
 * An id belongs to the start of its line and follows it through every edit, as
 * the save reads it (`read_by_line`): a block is the one whose id the line it
 * starts on carries. So Enter keeps the id on the line where the text it splits
 * starts, joining two lines keeps the first line's (D-e) and drops the second's,
 * and a cut takes the id of each line whose start it removes with its line
 * break or the rest of its text, so pasting that text where a line starts
 * moves the block, while a cut of only a line's start leaves the line its id.
 * Dragging lines within the buffer moves them as a cut and a paste do. A line
 * whose start no edit moved keeps the id it has; a new line has none. A paste
 * or a drop brings in only the page's own ids, so lines from another page's
 * buffer are new blocks.
 */

import { Extension, type JSONContent, Node } from '@tiptap/core'
import History from '@tiptap/extension-history'
import Text from '@tiptap/extension-text'
import type { NodeType, Node as PMNode, Schema } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { type Command, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { type Mappable, Mapping } from '@tiptap/pm/transform'

export interface SourceLines {
  text: string
  /** One entry per line of `text`: the id of the block that starts on it. */
  lineIds: Array<string | null>
}

/** Marks the lines a copy from a buffer puts on the clipboard, so a paste knows them. */
const SOURCE_LINE_ATTR = 'data-source-line'

const SourceDocument = Node.create({ name: 'doc', topNode: true, content: 'line+' })

const SourceLine = Node.create({
  name: 'line',
  content: 'text*',
  marks: '',
  // Indentation is markdown here: a pasted line keeps its leading spaces.
  whitespace: 'pre',
  addAttributes() {
    return {
      blockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-block-id'),
        renderHTML: (attributes) =>
          attributes['blockId'] == null ? {} : { 'data-block-id': attributes['blockId'] },
      },
    }
  },
  parseHTML() {
    return [{ tag: `div[${SOURCE_LINE_ATTR}]` }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { [SOURCE_LINE_ATTR]: '', ...HTMLAttributes }, 0]
  },
})

function blockIdOf(line: PMNode): string | null {
  return (line.attrs['blockId'] as string | null | undefined) ?? null
}

/** `lines` as the buffer's document: a line node per line of the text, under its id. */
export function linesContent({ text, lineIds }: SourceLines): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line, i) => {
      const node: JSONContent = { type: 'line', attrs: { blockId: lineIds[i] ?? null } }
      if (line !== '') node.content = [{ type: 'text', text: line }]
      return node
    }),
  }
}

/** The buffer's lines: their text joined with `\n`, and each line's id in order. */
export function readLines(doc: PMNode): SourceLines {
  const lines: string[] = []
  const lineIds: Array<string | null> = []
  doc.forEach((line) => {
    lines.push(line.textContent)
    lineIds.push(blockIdOf(line))
  })
  return { text: lines.join('\n'), lineIds }
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
// Indentation, then one or more list markers (`- 1.` is a bullet holding an
// ordered list style), then a task checkbox, each followed by blanks or the end.
const LIST_PREFIX = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))+(?:\[[ xX/-]\](?:[ \t]+|$))?/

/**
 * The list prefix `line` starts with: its length, and the prefix Enter starts
 * the next line with, `null` when the line holds nothing else and Enter ends
 * the list. `null` for a line that is no list item.
 */
function listContinuation(line: string): { length: number; next: string | null } | null {
  if (THEMATIC_BREAK.test(line)) return null
  const prefix = LIST_PREFIX.exec(line)?.[0]
  if (prefix === undefined) return null
  if (line.slice(prefix.length).trim() === '') return { length: prefix.length, next: null }
  const next = prefix
    .replace(/\d+(?=[.)])/g, (n) => String(Number(n) + 1))
    .replace(/\[[^\]]\]/, '[ ]')
  return { length: prefix.length, next }
}

/**
 * Enter: split the line at the cursor. With `continueList`, a list line goes on
 * with its marker on the new line, and a line holding only its marker loses it,
 * ending the list, as GitHub and Obsidian do (#5160 X6).
 */
function splitLine(continueList: boolean): Command {
  return (state, dispatch) => {
    const tr = state.tr.deleteSelection()
    const { $from } = tr.selection
    if (!$from.parent.isTextblock) return false
    const list = continueList ? listContinuation($from.parent.textContent) : null
    if (list === null || $from.parentOffset < list.length) tr.split($from.pos)
    else if (list.next === null) tr.delete($from.start(), $from.end())
    else tr.split($from.pos).insertText(list.next)
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

function lineType(schema: Schema): NodeType {
  return schema.topNodeType.contentMatch.defaultType as NodeType
}

/** `text` as pasted lines: one per line of it, none with an id. */
function textLines(schema: Schema, text: string): Slice {
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => lineType(schema).create(null, line === '' ? null : schema.text(line)))
  return new Slice(Fragment.from(lines), 1, 1)
}

function holdsId(doc: PMNode, id: string): boolean {
  let held = false
  doc.forEach((line) => {
    held ||= blockIdOf(line) === id
  })
  return held
}

/**
 * `slice` with no id but `pageIds`: a line carrying another page's block is a
 * new block, as a copy is (#5160 D15).
 */
function withPageIds(slice: Slice, pageIds: ReadonlySet<string | null>): Slice {
  const nodes: PMNode[] = []
  slice.content.forEach((node) => {
    const id = blockIdOf(node)
    nodes.push(
      id === null || pageIds.has(id)
        ? node
        : node.type.create({ ...node.attrs, blockId: null }, node.content),
    )
  })
  return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd)
}

/** What a paste or a drop brings in: a buffer's lines, or anything else as its text (D-a). */
function incoming(
  schema: Schema,
  data: DataTransfer | null,
  slice: Slice,
  pageIds: ReadonlySet<string | null>,
): Slice {
  const html = data?.getData('text/html') ?? ''
  return html === '' || html.includes(SOURCE_LINE_ATTR)
    ? withPageIds(slice, pageIds)
    : textLines(schema, data?.getData('text/plain') ?? '')
}

/**
 * Paste `slice` over `tr`'s selection as a text editor pastes lines: its first
 * line joins the text before the cursor, its last the text after. Pasted where
 * a line starts, the first line starts that line, under its id when no other
 * line holds it: a cut line pasted there is a move.
 */
function pasteLines(tr: Transaction, slice: Slice): Transaction {
  const lines =
    slice.content.firstChild?.isTextblock === true ? new Slice(slice.content, 1, 1) : slice
  const { $from } = tr.selection
  const before = tr.doc
  const steps = tr.steps.length
  tr.replaceSelection(lines)
  const first = lines.openStart > 0 ? lines.content.firstChild : null
  const id = first === null ? null : blockIdOf(first)
  if (id !== null && $from.parent.isTextblock && $from.parentOffset === 0 && !holdsId(before, id)) {
    const start = tr.mapping.slice(steps).map($from.pos, -1)
    tr.setNodeAttribute(tr.doc.resolve(start).before(), 'blockId', id)
  }
  return tr.scrollIntoView()
}

/**
 * Whether the token at `pos`, a character or a line's end, is gone after the
 * change `mapping` maps over: the positions either side of it no longer one apart.
 */
function goneAt(mapping: Mappable, pos: number): boolean {
  return mapping.map(pos + 1, -1) - mapping.map(pos, 1) !== 1
}

/**
 * The ids a cut over `mapping` takes from the lines of `before`: each line's
 * whose start it removed with its line break or the rest of its text, so its
 * first token and its last, a character or, empty, its end, are both gone. A
 * cut that leaves part of a line leaves the line its id, as deleting it does.
 */
function cutIds(before: PMNode, mapping: Mappable): Set<string> {
  const taken = new Set<string>()
  before.forEach((line, offset) => {
    const id = blockIdOf(line)
    const last = offset + Math.max(line.content.size, 1)
    if (id !== null && goneAt(mapping, offset + 1) && goneAt(mapping, last)) taken.add(id)
  })
  return taken
}

/**
 * Delete `tr`'s selection as a cut does: a line whose id the cut takes gives it
 * up to the line dragged away, so a line left where it was has none.
 */
function dragAway(tr: Transaction): void {
  const before = tr.doc
  const steps = tr.steps.length
  tr.deleteSelection()
  const taken = cutIds(before, tr.mapping.slice(steps))
  tr.doc.forEach((line, offset) => {
    const id = blockIdOf(line)
    if (id !== null && taken.has(id)) tr.setNodeAttribute(offset, 'blockId', null)
  })
}

/**
 * Each line's id after `transactions` turned `before` into `after`: the id of
 * the line whose start it now begins with, else the id it holds, unless another
 * line holds that id or a cut took it (`cutIds`).
 */
function lineIdsAfter(
  transactions: readonly Transaction[],
  before: PMNode,
  after: PMNode,
): Array<string | null> {
  const mapping = new Mapping()
  for (const tr of transactions) mapping.appendMapping(tr.mapping)
  const cut = transactions.some((tr) => tr.getMeta('uiEvent') === 'cut')
  const taken = cut ? cutIds(before, mapping) : new Set<string>()
  const moved = new Map<number, string>()
  before.forEach((line, offset) => {
    const id = blockIdOf(line)
    // A line whose first token is gone has no start left to follow.
    if (id === null || goneAt(mapping, offset + 1)) return
    const start = mapping.map(offset + 1, 1)
    const $start = after.resolve(start)
    if ($start.depth === 1 && $start.parentOffset === 0 && !moved.has(start)) {
      moved.set(start, id)
    }
  })
  const held = new Set([...moved.values(), ...taken])
  const ids: Array<string | null> = []
  after.forEach((line, offset) => {
    const own = moved.get(offset + 1)
    const kept = blockIdOf(line)
    if (own !== undefined) {
      ids.push(own)
    } else if (kept !== null && !held.has(kept)) {
      held.add(kept)
      ids.push(kept)
    } else {
      ids.push(null)
    }
  })
  return ids
}

interface SourceBufferOptions {
  /** The page's line ids as the buffer loaded them: the only ids a paste or a drop brings in. */
  pageIds: ReadonlySet<string | null>
}

const SourceBufferBehaviour = Extension.create<SourceBufferOptions>({
  name: 'sourceBuffer',
  // Ahead of TipTap's own Enter, clipboard and drop handling.
  priority: 1000,
  addOptions() {
    return { pageIds: new Set() }
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => splitLine(true)(editor.state, editor.view.dispatch),
      'Shift-Enter': ({ editor }) => splitLine(false)(editor.state, editor.view.dispatch),
    }
  },
  addProseMirrorPlugins() {
    const { pageIds } = this.options
    return [
      new Plugin({
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const ids = lineIdsAfter(transactions, oldState.doc, newState.doc)
          const tr = newState.tr
          newState.doc.forEach((line, offset, i) => {
            if (blockIdOf(line) !== ids[i]) tr.setNodeAttribute(offset, 'blockId', ids[i])
          })
          return tr.docChanged ? tr : null
        },
        props: {
          // The lines as typed, one per line: no id leaves the buffer as text (D-a).
          clipboardTextSerializer: (slice) =>
            slice.content.textBetween(0, slice.content.size, '\n'),
          clipboardTextParser: (text, $context) => textLines($context.doc.type.schema, text),
          handlePaste(view, event, slice) {
            const pasted = incoming(view.state.schema, event.clipboardData, slice, pageIds)
            view.dispatch(pasteLines(view.state.tr, pasted))
            return true
          },
          handleDrop(view, event, slice, moved) {
            const dropped = incoming(view.state.schema, event.dataTransfer, slice, pageIds)
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (at === null || dropped.size === 0) return false
            const tr = view.state.tr
            if (moved) dragAway(tr)
            tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(at.pos))))
            view.focus()
            view.dispatch(pasteLines(tr, dropped).setMeta('uiEvent', 'drop'))
            return true
          },
        },
      }),
    ]
  },
})

/** The buffer's extensions, for a page whose lines carried `pageIds` as loaded. */
export function sourceBufferExtensions(pageIds: ReadonlyArray<string | null>) {
  return [
    SourceDocument,
    SourceLine,
    Text,
    History,
    SourceBufferBehaviour.configure({ pageIds: new Set(pageIds) }),
  ]
}
