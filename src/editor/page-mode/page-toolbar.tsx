/**
 * Block mode's formatting toolbar (`FormattingToolbar`) above page mode's
 * document (#5691), sticky as *Edit as Markdown*'s is. Its editor commands (the
 * marks, links, refs, tags, the table, a line break, undo) act on page mode's
 * editor as they act on the roving one. Its block commands go through the
 * block command bus, which page mode answers while its editor is the one in
 * use (`registerFocusedCommandTarget`), with the commands its block menu,
 * chips and keys already run, after the save:
 *
 * - Turn into and a callout's type: on every block the selection touches, so
 *   a block's style (text, a heading, a list, code) stays one of them.
 * - The task button: TODO on every block the selection touches, none once all
 *   of them are tasks.
 * - Priority, the date pickers, properties, the query builder and the emoji
 *   picker: on the caret's block, as page mode's keys and slash menu run them.
 *
 * Discard is left off: page mode saves as it goes, with no edit to throw away.
 * The task button's tooltip says what it does here: Ctrl+Enter cycles the task.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import type React from 'react'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { type StoreApi, useStore } from 'zustand'

import { FormattingToolbar } from '@/components/FormattingToolbar'
import { getActiveEditor } from '@/editor/active-editor'
import { blockIdsBetween } from '@/editor/page-mode/page-block-actions'
import type { PageLists } from '@/editor/page-mode/page-lists'
import { caretBlockId } from '@/editor/page-mode/page-tasks'
import type { PickerItem } from '@/editor/SuggestionList'
import type { ListStyle } from '@/lib/list-style'
import { CALLOUT_COMMANDS, SLASH_COMMANDS, TURN_INTO_COMMANDS } from '@/lib/slash-commands'
import {
  type BlockCommandHandler,
  type BlockCommandName,
  registerFocusedCommandTarget,
} from '@/stores/block-command-bus'
import type { PageBlockState } from '@/stores/page-blocks'

/** The session's commands the toolbar's block commands run. */
export interface PageToolbarActions {
  setTodo: (ids: string[], state: string | null) => void
  setListStyle: (id: string, style: ListStyle) => void
  cyclePriority: (id: string) => void
  openDatePicker: (id: string, mode: 'due' | 'schedule') => void
  openDateLinkPicker: () => void
  openPropertyDrawer: (id: string) => void
  /** Run a slash item on block `id`, once it is saved. */
  turnInto: (id: string, item: PickerItem) => void
  /** Run a slash item on the caret's block. */
  command: (item: PickerItem) => void
}

const HIDDEN = new Set(['toolbar.discard'])
const TIPS = { 'toolbar.todoToggle': 'pageMode.todoToggleTip' }

const ITEMS = [...SLASH_COMMANDS, ...TURN_INTO_COMMANDS, ...CALLOUT_COMMANDS]

const selectedBlocks = (editor: Editor): string[] => {
  const { from, to } = editor.state.selection
  return blockIdsBetween(editor.state.doc, from, to)
}

/** What page mode does for each block command the toolbar sends. */
function pageToolbarCommands(
  editor: Editor,
  actions: React.RefObject<PageToolbarActions>,
  pageStore: StoreApi<PageBlockState>,
): Partial<Record<BlockCommandName, BlockCommandHandler>> {
  const onSelected = (itemId: string): void => {
    const item = ITEMS.find((candidate) => candidate.id === itemId)
    if (item === undefined) return
    for (const id of selectedBlocks(editor)) actions.current.turnInto(id, item)
  }
  const onCaret = (itemId: string) => (): void => {
    const item = ITEMS.find((candidate) => candidate.id === itemId)
    if (item !== undefined) actions.current.command(item)
  }
  const typeOf = (detail: unknown): string | undefined =>
    (detail as { type?: string } | undefined)?.type
  return {
    TURN_INTO_BLOCK: (_id, detail) => onSelected(`turn-${typeOf(detail)}`),
    INSERT_CALLOUT: (_id, detail) => onSelected(`callout-${typeOf(detail) ?? 'info'}`),
    INSERT_DIVIDER: onCaret('divider'),
    TOGGLE_TODO_STATE: () => {
      const ids = selectedBlocks(editor)
      const { blocksById } = pageStore.getState()
      const tasks = ids.every((id) => (blocksById.get(id)?.todo_state ?? null) !== null)
      actions.current.setTodo(ids, tasks ? null : 'TODO')
    },
    CYCLE_PRIORITY: (id) => actions.current.cyclePriority(id),
    OPEN_DATE_PICKER: () => actions.current.openDateLinkPicker(),
    OPEN_DUE_DATE_PICKER: (id) => actions.current.openDatePicker(id, 'due'),
    OPEN_SCHEDULED_DATE_PICKER: (id) => actions.current.openDatePicker(id, 'schedule'),
    OPEN_BLOCK_PROPERTIES: (id) => actions.current.openPropertyDrawer(id),
    OPEN_QUERY_BUILDER: onCaret('query'),
    OPEN_EMOJI_PICKER: onCaret('emoji'),
  }
}

interface PageToolbarProps {
  editor: Editor
  actions: React.RefObject<PageToolbarActions>
  lists: PageLists
  pageStore: StoreApi<PageBlockState>
}

export function PageToolbar({
  editor,
  actions,
  lists,
  pageStore,
}: PageToolbarProps): React.ReactElement {
  useEffect(
    () =>
      registerFocusedCommandTarget(
        () => (getActiveEditor() === editor ? caretBlockId(editor.state) : null),
        pageToolbarCommands(editor, actions, pageStore),
      ),
    [editor, actions, pageStore],
  )
  const caretId = useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed === null || ed.isDestroyed ? null : caretBlockId(ed.state)),
  })
  const subscribe = useCallback(
    (listener: () => void) => (caretId === null ? () => {} : lists.subscribe(caretId, listener)),
    [lists, caretId],
  )
  const listStyle = useSyncExternalStore(subscribe, () =>
    caretId === null ? 'none' : lists.styleOf(caretId),
  )
  const priority = useStore(pageStore, (s) =>
    caretId === null ? null : (s.blocksById.get(caretId)?.priority ?? null),
  )
  return (
    <FormattingToolbar
      editor={editor}
      currentPriority={priority}
      listStyle={listStyle}
      onTurnIntoCode={() => {
        for (const id of selectedBlocks(editor)) actions.current.setListStyle(id, 'none')
      }}
      tips={TIPS}
      hiddenItems={HIDDEN}
      className="sticky top-0 z-10 bg-background"
    />
  )
}
