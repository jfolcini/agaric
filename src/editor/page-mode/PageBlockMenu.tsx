/**
 * PageBlockMenu — block mode's block menu (`BlockContextMenu`) on the block
 * under a right click in page mode, on a block's grip clicked (or Enter on it,
 * `page-gutter.ts`), or on the caret's block on the menu key or Shift+F10
 * (#5972). The rows that change structure edit the document
 * (`page-block-actions.ts`) and the save writes them; Collapse is the block's
 * chevron (`page-collapse.ts`); the rest go through the commands block mode's
 * menu runs, after the save (`PageTaskActions`).
 *
 * A right click inside text selected within one block keeps the webview's own
 * menu, so Copy and Paste stay one click away. On a selection across blocks the
 * block menu takes over, in its bulk form, with Copy selection as Markdown.
 * Turn into is the slash menu's (`page-slash-commands.tsx`), run on the menu's
 * block. Left out: Zoom in (page mode has none), and the touch gesture, which
 * keeps the pinned toolbar.
 */

import type { Editor } from '@tiptap/core'
import type { Command } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'

import type { BlockActions } from '@/components/block-tree/use-block-actions'
import { linkUrlAt, pageLinkIdAt } from '@/components/block-tree/use-block-touch-long-press'
import {
  BLOCK_MENU_ACTION_IDS,
  type BlockMenuActionId,
} from '@/components/editor/block-context-menu/types'
import { BlockContextMenu } from '@/components/editor/BlockContextMenu'
import {
  blockIdsBetween,
  canMerge,
  deleteBlocks,
  duplicateBlock,
  mergeBlock,
  moveBlocks,
} from '@/editor/page-mode/page-block-actions'
import { type Fold, foldOf, toggleFold } from '@/editor/page-mode/page-collapse'
import { GRIP } from '@/editor/page-mode/page-gutter'
import { indentIds, outdentIds, treeRows } from '@/editor/page-mode/page-keys'
import { blockText } from '@/editor/page-mode/page-slash-commands'
import type { PickerItem } from '@/editor/SuggestionList'
import { blockIdOf } from '@/editor/token-ids'
import { type BlockTypeToken, detectBlockType } from '@/lib/block-type-convert'
import { CALLOUT_COMMANDS, TURN_INTO_COMMANDS } from '@/lib/slash-commands'
import { computeSelectionRoots, type FlatBlock } from '@/lib/tree-utils'
import type { PageBlockState } from '@/stores/page-blocks'

/** What the menu asks of the session: block mode's commands, run after the save. */
export interface PageBlockMenuActions {
  cycle: (id: string) => void
  cyclePriority: (id: string) => void
  openPropertyDrawer: (id: string) => void
  openHistory: (id: string) => void
  /** Run slash item `turn-*` or `callout-*` on a block, once it is saved. */
  turnInto: (id: string, item: PickerItem) => void
}

export interface PageBlockMenuProps {
  editor: Editor | null
  pageId: string
  pageStore: StoreApi<PageBlockState>
  actions: React.RefObject<PageBlockMenuActions>
  /** Absent on mobile, which has no tab bar to open a tab on. */
  onOpenLinkInNewTab: ((id: string) => void) | undefined
}

/** The menu's block, where it opens, and the blocks it acts on: the selection when the block is in it. */
interface OpenMenu {
  blockId: string
  position: { x: number; y: number }
  linkUrl?: string
  pageLinkId?: string
  selectedIds: string[]
  /** The block's row as the store held it once saved; none while it is not saved yet. */
  row: FlatBlock | undefined
  /** The block's type as the document holds it, which the store lags while it is typed in. */
  blockType: BlockTypeToken
  fold: Fold | null
  /** The gutter control it opened from with the keyboard, which takes the focus back; else the editor. */
  trigger: HTMLElement | null
}

/** The block at document position `pos`. */
function blockAt(view: EditorView, pos: number): string | null {
  const { doc } = view.state
  const index = doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0)
  return blockIdOf(doc.child(Math.min(index, doc.childCount - 1)))
}

/** The block under a point outside any block's own element: the margin around the document. */
function blockAtCoords(view: EditorView, coords: { left: number; top: number }): string | null {
  const at = view.posAtCoords(coords)
  return at === null ? null : blockAt(view, at.pos)
}

/** The blocks the menu acts on: the selection's, if it spans several and holds `blockId`. */
function selectedBlocks(view: EditorView, blockId: string): string[] {
  const { from, to } = view.state.selection
  const ids = blockIdsBetween(view.state.doc, from, to)
  return ids.length > 1 && ids.includes(blockId) ? ids : [blockId]
}

/** Whether a right click at `pos` is on text selected within one block, where the webview's menu stays. */
function onSelectedText(view: EditorView, coords: { left: number; top: number }): boolean {
  const { empty, from, to, $from, $to } = view.state.selection
  if (empty || $from.index(0) !== $to.index(0)) return false
  const at = view.posAtCoords(coords)
  return at !== null && at.pos >= from && at.pos <= to
}

export function PageBlockMenu({
  editor,
  pageId,
  pageStore,
  actions,
  onOpenLinkInNewTab,
}: PageBlockMenuProps): React.ReactElement | null {
  const [open, setOpen] = useState<OpenMenu | null>(null)

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return
    const { view } = editor
    const show = (
      menu: Omit<OpenMenu, 'row' | 'blockType' | 'fold' | 'trigger'>,
      trigger?: Element,
    ): void => {
      setOpen({
        ...menu,
        row: pageStore.getState().blocksById.get(menu.blockId),
        blockType: detectBlockType(blockText(editor, menu.blockId).read()),
        fold: foldOf(view.state, menu.blockId),
        trigger:
          trigger instanceof HTMLElement && trigger === document.activeElement ? trigger : null,
      })
    }
    /** The block of the gutter control `target` is in, as `selector` finds the control; none for the text. */
    const gutterBlock = (target: EventTarget | null, selector: string): Element | null =>
      target instanceof Element && target.closest(selector) !== null
        ? target.closest('[data-page-block-id]')
        : null
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target
      if (e.defaultPrevented || !(target instanceof Element)) return
      if (target.closest('input, textarea') !== null) return
      const coords = { left: e.clientX, top: e.clientY }
      const blockId =
        target.closest('[data-page-block-id]')?.getAttribute('data-page-block-id') ??
        blockAtCoords(view, coords)
      if (blockId === null) return
      if (onSelectedText(view, coords)) return
      e.preventDefault()
      const linkUrl = linkUrlAt(target)
      const pageLinkId = pageLinkIdAt(target)
      show({
        blockId,
        position: { x: e.clientX, y: e.clientY },
        ...(linkUrl === undefined ? {} : { linkUrl }),
        ...(pageLinkId === undefined ? {} : { pageLinkId }),
        selectedIds: selectedBlocks(view, blockId),
      })
    }
    /** Open on the block of `control`, its grip or chevron, below it. */
    const showAtGrip = (control: Element, block: Element): void => {
      const blockId = block.getAttribute('data-page-block-id')
      if (blockId === null) return
      const box = control.getBoundingClientRect()
      show(
        {
          blockId,
          position: { x: box.left, y: box.bottom },
          selectedIds: selectedBlocks(view, blockId),
        },
        control,
      )
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
      const block = gutterBlock(e.target, '.page-block-gutter')
      if (block !== null) {
        e.preventDefault()
        showAtGrip(e.target as Element, block)
        return
      }
      const { head } = view.state.selection
      const blockId = blockAt(view, head)
      if (blockId === null) return
      e.preventDefault()
      const caret = view.coordsAtPos(head)
      show({
        blockId,
        position: { x: caret.left, y: caret.bottom },
        selectedIds: selectedBlocks(view, blockId),
      })
    }
    // A drag's release is not a click: the drag swallows it (`page-drag.ts`).
    const onClick = (e: MouseEvent): void => {
      const block = gutterBlock(e.target, `[${GRIP}]`)
      if (block === null) return
      showAtGrip((e.target as Element).closest(`[${GRIP}]`) as Element, block)
    }
    view.dom.addEventListener('contextmenu', onContextMenu)
    view.dom.addEventListener('keydown', onKeyDown)
    view.dom.addEventListener('click', onClick)
    return () => {
      view.dom.removeEventListener('contextmenu', onContextMenu)
      view.dom.removeEventListener('keydown', onKeyDown)
      view.dom.removeEventListener('click', onClick)
    }
  }, [editor, pageStore])

  // The menu's close drops focus with its rows; a dialog an action opens takes it later.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open !== null) wasOpen.current = true
    else if (wasOpen.current && editor !== null && !editor.isDestroyed) {
      wasOpen.current = false
      const focused = document.activeElement
      if (focused === null || focused === document.body) editor.view.focus()
    }
  }, [open, editor])

  const bag = useMemo(
    () =>
      open === null || editor === null
        ? null
        : menuActions(editor, open, actions, onOpenLinkInNewTab),
    [open, editor, actions, onOpenLinkInNewTab],
  )
  if (open === null || editor === null || bag === null) return null
  // A block the store does not hold is not saved yet: a reference to it would point at nothing.
  const rows: ReadonlySet<BlockMenuActionId> = new Set(
    BLOCK_MENU_ACTION_IDS.filter((id) => open.row !== undefined || id !== 'copyBlockRef'),
  )
  return (
    <BlockContextMenu
      blockId={open.blockId}
      position={open.position}
      onClose={() => setOpen(null)}
      triggerRef={{ current: open.trigger ?? editor.view.dom }}
      actions={bag}
      actionIds={rows}
      selectedBlockIds={open.selectedIds}
      hasChildren={open.fold !== null}
      isCollapsed={open.fold === 'collapsed'}
      activeBlockType={open.blockType}
      todoState={open.row?.todo_state}
      priority={open.row?.priority}
      linkUrl={open.linkUrl}
      pageLinkId={open.pageLinkId}
      pageRefId={pageId}
    />
  )
}

/**
 * The menu's actions on `menu`'s blocks. Over a selection a row runs once, on
 * the selection's top blocks, whichever block the menu loops over: the
 * blocks under a selected block move with it.
 */
function menuActions(
  editor: Editor,
  menu: OpenMenu,
  actions: React.RefObject<PageBlockMenuActions>,
  onOpenLinkInNewTab: ((id: string) => void) | undefined,
): BlockActions {
  const { view } = editor
  const roots = computeSelectionRoots(treeRows(view.state.doc), menu.selectedIds)
  const done = new Set<string>()
  const once = (row: string, run: () => void) => () => {
    if (done.has(row)) return
    done.add(row)
    run()
  }
  const run = (command: Command) => command(view.state, view.dispatch, view)
  const mergeable = menu.selectedIds.length === 1 && canMerge(view.state, menu.blockId)
  const bag: BlockActions = {
    onToggleTodo: (id) => actions.current.cycle(id),
    onTogglePriority: (id) => actions.current.cyclePriority(id),
    onShowProperties: (id) => actions.current.openPropertyDrawer(id),
    onShowHistory: (id) => actions.current.openHistory(id),
    onIndent: once('indent', () => run(indentIds(() => roots))),
    onDedent: once('dedent', () => run(outdentIds(() => roots))),
    onMoveUp: once('moveUp', () => run(moveBlocks(roots, -1))),
    onMoveDown: once('moveDown', () => run(moveBlocks(roots, 1))),
    onDelete: once('delete', () => run(deleteBlocks(roots))),
    onDuplicate: (id) => run(duplicateBlock(id)),
    onToggleCollapse: (id) => run(toggleFold(id)),
    onTurnInto: (id, blockType, calloutType) => {
      const itemId = calloutType === undefined ? `turn-${blockType}` : `callout-${calloutType}`
      const item = [...TURN_INTO_COMMANDS, ...CALLOUT_COMMANDS].find((c) => c.id === itemId)
      if (item !== undefined) actions.current.turnInto(id, item)
    },
    ...(mergeable ? { onMerge: (id: string) => run(mergeBlock(id)) } : {}),
    ...(onOpenLinkInNewTab === undefined ? {} : { onOpenLinkInNewTab }),
  }
  return bag
}
