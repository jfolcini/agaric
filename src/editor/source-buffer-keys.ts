/**
 * The *Edit as Markdown* buffer's outline keys (#5160 phase 5): the keyboard
 * catalog's indent, dedent, task-cycle, move and heading bindings by id, user overrides
 * included, acting on the blocks the selection touches as the block editor acts on
 * blocks (`source-buffer-blocks`). Tab and Shift+Tab indent and dedent too while
 * *Tab indents blocks* is on (Settings → Editor), the opt-out that gives Tab back to
 * focus navigation; Escape leaves the buffer either way.
 *
 * No key changes which block carries which id: each block a key writes again keeps
 * the id its first line carries.
 */

import { Extension } from '@tiptap/core'
import { type Command, type EditorState, Plugin } from '@tiptap/pm/state'

import {
  blockAtCursor,
  cycleTaskAt,
  dedentRange,
  indentRange,
  moveRange,
  turnInto,
} from '@/editor/source-buffer-blocks'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { isTabIndentEnabled } from '@/lib/editor-preferences'
import { headingChordLevel, matchesShortcutBinding } from '@/lib/keyboard-config'
import { isTabKey } from '@/lib/keyboard-config/keys'

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

/** `range` run over the lines the selection touches. */
function onTouched(range: (first: number, last: number) => Command): Command {
  return (state, dispatch) => range(...touchedLines(state))(state, dispatch)
}

const indentBlocks = onTouched(indentRange)
const dedentBlocks = onTouched(dedentRange)

/** Cycle the task of the block the caret is in, as the toolbar's button does. */
const cycleTask: Command = (state, dispatch) =>
  cycleTaskAt(state.selection.$head.index(0))(state, dispatch)

/** Move the blocks the selection touches past their sibling. */
function moveLines(direction: -1 | 1): Command {
  return onTouched((first, last) => moveRange(first, last, direction))
}

/** Turn the block the caret is in into a heading of `level`, as Turn into's row does. */
function turnIntoHeading(level: number): Command {
  return (state, dispatch) => {
    const block = blockAtCursor(state)
    return block === null || turnInto(block, `h${level}` as BlockTypeToken)(state, dispatch)
  }
}

/** The command a key runs in the buffer, or `null` for a key it leaves alone. */
function commandFor(event: KeyboardEvent): Command | null {
  if (matchesShortcutBinding(event, 'indentBlock')) return indentBlocks
  if (matchesShortcutBinding(event, 'dedentBlock')) return dedentBlocks
  if (matchesShortcutBinding(event, 'moveBlockUp')) return moveLines(-1)
  if (matchesShortcutBinding(event, 'moveBlockDown')) return moveLines(1)
  if (matchesShortcutBinding(event, 'cycleTaskState')) return cycleTask
  const level = headingChordLevel(event)
  if (level !== null) return turnIntoHeading(level)
  const plainTab = isTabKey(event) && !event.ctrlKey && !event.metaKey && !event.altKey
  if (plainTab && isTabIndentEnabled()) return event.shiftKey ? dedentBlocks : indentBlocks
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
