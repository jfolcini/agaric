/**
 * What *Edit as Markdown*'s toolbar and block menu do (#5160 phase 5): the
 * block editor's toolbar buttons and block-menu rows, by id, each with the
 * text edit the buffer makes for it, or left out with the reason (D-c). The
 * parity test holds every id of the two to one or the other, so an action
 * added to the block editor fails it until the buffer answers for it.
 *
 * A toolbar action acts at the cursor, a block action on the block the cursor
 * is in, as the block editor's act on the focused block; the block menu's
 * rows act on the block the cursor was in when it opened.
 */

import type { Editor } from '@tiptap/core'
import type { Command } from '@tiptap/pm/state'

import type { BlockActions } from '@/components/block-tree/use-block-actions'
import type { BlockMenuActionId } from '@/components/editor/block-context-menu/types'
import { breakLine } from '@/editor/source-buffer'
import {
  cyclePriority,
  deleteBlock,
  depthOf,
  duplicateBlock,
  insertTagTrigger,
  insertTrigger,
  type SourceBlock,
  turnInto,
} from '@/editor/source-buffer-blocks'
import { cycleTaskAt, dedentRange, indentRange, moveRange } from '@/editor/source-buffer-keys'

/** A dialog a toolbar action opens, which writes what is picked in it. */
export type SourceDialog = 'date' | 'due' | 'schedule' | 'emoji' | 'query'

export interface SourceToolbarContext {
  editor: Editor
  /** Runs `command` on the buffer, which keeps the focus. */
  run: (command: Command) => void
  /** The block the cursor is in. */
  block: SourceBlock | null
  openDialog: (dialog: SourceDialog) => void
  /** Cancel: the buffer's discard, asking first when it changed. */
  cancel: () => void
}

type SourceToolbarAction = (context: SourceToolbarContext) => void

/** The toolbar buttons the buffer shows, by id: what each does there. */
export const SOURCE_TOOLBAR_ACTIONS: Readonly<Record<string, SourceToolbarAction>> = {
  'toolbar.internalLink': ({ run }) => run(insertTrigger('[[', ']]')),
  'toolbar.insertBlockRef': ({ run }) => run(insertTrigger('((')),
  'toolbar.insertTag': ({ run }) => run(insertTagTrigger),
  'toolbar.insertQuery': ({ block, openDialog }) => {
    if (block !== null) openDialog('query')
  },
  'toolbar.emoji': ({ openDialog }) => openDialog('emoji'),
  'toolbar.newLine': ({ run }) => run(breakLine),
  'toolbar.cyclePriority': ({ block, run }) => {
    if (block !== null) run(cyclePriority(block))
  },
  'toolbar.insertDate': ({ openDialog }) => openDialog('date'),
  'toolbar.setDueDate': ({ block, openDialog }) => {
    if (block !== null) openDialog('due')
  },
  'toolbar.setScheduledDate': ({ block, openDialog }) => {
    if (block !== null) openDialog('schedule')
  },
  'toolbar.todoToggle': ({ block, run }) => {
    if (block !== null) run(cycleTaskAt(block.line))
  },
  'toolbar.undo': ({ editor }) => editor.chain().focus().undo().run(),
  'toolbar.redo': ({ editor }) => editor.chain().focus().redo().run(),
  'toolbar.discard': ({ cancel }) => cancel(),
}

/** The toolbar's popovers the buffer shows, with its own content: Format's marks, Turn into's block types. */
export const SOURCE_TOOLBAR_MENUS: ReadonlySet<string> = new Set([
  'toolbar.format',
  'toolbar.turnInto',
])

/** Each of Format's marks as the markdown that wraps the selection. */
export const SOURCE_MARKS: Readonly<Record<string, readonly [open: string, close: string]>> = {
  'toolbar.bold': ['**', '**'],
  'toolbar.italic': ['*', '*'],
  'toolbar.code': ['`', '`'],
  'toolbar.strikethrough': ['~~', '~~'],
  'toolbar.highlight': ['==', '=='],
  'toolbar.underline': ['<u>', '</u>'],
}

/** The toolbar buttons the buffer leaves out, each with why. */
export const SOURCE_TOOLBAR_EXCLUDED: Readonly<Record<string, string>> = {
  'toolbar.insertTable':
    'The grid inserts a table node; in the buffer a table is the `|` rows it reads as, typed as text.',
  'toolbar.tableOps': 'It acts on the table node the caret is in, and the buffer has none.',
  'toolbar.properties':
    'The drawer writes the saved block behind the buffer; there a property is its `key:: value` line.',
}

/** The block menu's rows the buffer shows. */
export const SOURCE_MENU_ROWS: ReadonlySet<BlockMenuActionId> = new Set<BlockMenuActionId>([
  'copyBlockRef',
  'copyPageRef',
  'cycleTodo',
  'cyclePriority',
  'turnInto',
  'moveArrange',
  'indent',
  'dedent',
  'moveUp',
  'moveDown',
  'duplicate',
  'delete',
])

/** The block menu's rows the buffer leaves out, each with why. */
export const SOURCE_MENU_EXCLUDED: Readonly<Partial<Record<BlockMenuActionId, string>>> = {
  openLink:
    'It opens the link the menu was opened on; the buffer’s links are text and its menu opens from the toolbar.',
  copyUrl: 'It copies the link the menu was opened on, which the buffer’s menu never is.',
  copyBlockContent: 'The buffer is the block’s markdown: select its lines and copy them.',
  copySubtreeContent: 'The buffer is the subtree’s markdown: select its lines and copy them.',
  copySelectionContent: 'It copies selected blocks; the buffer selects text, which copies as text.',
  merge:
    'Backspace at the start of a line is the buffer’s merge: it joins the line to the one above, keeping that block.',
  collapse: 'Folding hides a block’s children in the tree; the buffer shows every line.',
  zoomIn: 'Zoom shows one block’s subtree in the tree; the buffer is the whole page.',
  history: 'It lists the saved block’s versions, and restoring one would write behind the buffer.',
  properties:
    'The drawer writes the saved block behind the buffer; there a property is its `key:: value` line.',
}

/** The rows the menu shows for `block`: a block the save has yet to create has no reference to copy. */
export function sourceMenuRows(block: SourceBlock): ReadonlySet<BlockMenuActionId> {
  if (block.id !== null) return SOURCE_MENU_ROWS
  return new Set([...SOURCE_MENU_ROWS].filter((id) => id !== 'copyBlockRef'))
}

/**
 * The block menu's actions on `block`, as the block editor's act on theirs:
 * indent and dedent take its children with it, as the move keys do, and a
 * top-level block has nowhere to dedent to.
 */
export function sourceBlockActions(
  run: (command: Command) => void,
  block: SourceBlock,
): BlockActions {
  const last = block.subtreeEnd - 1
  return {
    onToggleTodo: () => run(cycleTaskAt(block.line)),
    onTogglePriority: () => run(cyclePriority(block)),
    onTurnInto: (_id, type) => run(turnInto(block, type)),
    onIndent: () => run(indentRange(block.line, last)),
    onDedent: () =>
      run(
        (state, dispatch) =>
          depthOf(state.doc.child(block.line).textContent) === 0 ||
          dedentRange(block.line, last)(state, dispatch),
      ),
    onMoveUp: () => run(moveRange(block.line, block.line, -1)),
    onMoveDown: () => run(moveRange(block.line, block.line, 1)),
    onDuplicate: () => run(duplicateBlock(block)),
    onDelete: () => run(deleteBlock(block)),
  }
}
