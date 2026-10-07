/**
 * PageSourceToolbar — the block editor's toolbar on *Edit as Markdown*
 * (#5160 phase 5): the same buttons, frame and overflow, each doing what the
 * buffer does for it (`source-toolbar-actions`), plus a button opening the
 * block menu on the block the cursor is in, since a long press in a text
 * field belongs to the phone. On touch it also carries Save and Cancel, so a
 * phone with no keyboard can finish (X9).
 */

import type { Command } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { GripVertical, Minus } from 'lucide-react'
import type React from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BlockDatePicker } from '@/components/block-tree/BlockDatePicker'
import { QueryBuilderModal } from '@/components/dialogs/QueryBuilderModal'
import { BlockContextMenu } from '@/components/editor/BlockContextMenu'
import { EmojiPickerDialog } from '@/components/EmojiPicker'
import {
  buildConfigByKey,
  buildToolbarItems,
  type ToolbarItemGroups,
} from '@/components/FormattingToolbar/items'
import { renderCyclePriority } from '@/components/FormattingToolbar/MetadataGroup'
import {
  renderFormatButton,
  renderTurnIntoButton,
} from '@/components/FormattingToolbar/RefsAndBlocksGroup'
import {
  type RenderMode,
  renderConfigButton,
  Tip,
  toolbarPressHandlers,
} from '@/components/FormattingToolbar/shared'
import { ToolbarFrame } from '@/components/FormattingToolbar/ToolbarFrame'
import {
  SOURCE_MARKS,
  SOURCE_TOOLBAR_ACTIONS,
  SOURCE_TOOLBAR_MENUS,
  type SourceDialog,
  type SourceToolbarContext,
  sourceBlockActions,
  sourceMenuRows,
} from '@/components/pages/source-toolbar-actions'
import { Button } from '@/components/ui/button'
import {
  blockAtCursor,
  blockProperty,
  blockTaskState,
  blockTypeOf,
  insertText,
  type SourceBlock,
  setBlockProperty,
  setBlockText,
  toggleWrap,
  turnInto,
} from '@/editor/source-buffer-blocks'
import { useIsTouch } from '@/hooks/useIsTouch'
import type { ToolbarItem } from '@/hooks/useToolbarOverflow'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { formatDate } from '@/lib/date-utils'
import { TURN_INTO_OPTIONS, turnIntoTypeKey } from '@/lib/slash-commands'
import {
  createHistoryButtons,
  createMarkToggles,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
  toolbarActiveClass,
  toolbarMenuRowClass,
  type ToolbarButtonConfig,
} from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

const BLOCK_MENU = 'pageSource.blockMenu'
const SAVE = 'action.save'

export interface PageSourceToolbarProps {
  editor: Editor
  pageId: string
  saving: boolean
  onSave: () => void
  onCancel: () => void
}

/** The block menu, open on the block the cursor was in, below its button. */
interface OpenMenu {
  block: SourceBlock
  position: { x: number; y: number }
}

/**
 * The block editor's buttons the buffer does, in its order and priorities,
 * then the buffer's own: the block menu, and on touch Save.
 */
function sourceItems(groups: ToolbarItemGroups, isTouch: boolean): ToolbarItem[] {
  const shown = buildToolbarItems(groups).filter(
    (item) =>
      item.kind === 'separator' ||
      item.key in SOURCE_TOOLBAR_ACTIONS ||
      SOURCE_TOOLBAR_MENUS.has(item.key),
  )
  // On a phone, Cancel is the buffer's discard and stays on the bar beside Save,
  // and so does New line, the one line break a phone's keyboard cannot type.
  // `buildToolbarItems` builds the items afresh, so they are this call's to change.
  if (isTouch) {
    for (const item of shown) {
      if (item.key === 'toolbar.discard') item.group = 4
      if (item.key === 'toolbar.discard' || item.key === 'toolbar.newLine') item.priority = 100
    }
  }
  const ordered = [
    ...shown.filter((item) => item.group !== 4),
    { kind: 'separator' as const, key: 'sep-3', group: 3, priority: 0 },
    { kind: 'button' as const, key: BLOCK_MENU, group: 4, priority: 85 },
    ...shown.filter((item) => item.group === 4),
  ]
  return isTouch ? [...ordered, { kind: 'button', key: SAVE, group: 4, priority: 100 }] : ordered
}

export function PageSourceToolbar({
  editor,
  pageId,
  saving,
  onSave,
  onCancel,
}: PageSourceToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const [formatOpen, setFormatOpen] = useState(false)
  const [turnIntoOpen, setTurnIntoOpen] = useState(false)
  const [dialog, setDialog] = useState<{ kind: SourceDialog; block: SourceBlock | null } | null>(
    null,
  )
  const [menu, setMenu] = useState<OpenMenu | null>(null)

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const block = ed === null ? null : blockAtCursor(ed.state)
      return {
        canUndo: ed?.can().undo() ?? false,
        canRedo: ed?.can().redo() ?? false,
        hasBlock: block !== null,
        priority:
          ed === null || block === null ? null : blockProperty(ed.state.doc, block, 'priority'),
      }
    },
  })

  const run = (command: Command): void => {
    command(editor.state, editor.view.dispatch)
    editor.view.focus()
  }

  const context = (): SourceToolbarContext => ({
    editor,
    run,
    block: blockAtCursor(editor.state),
    openDialog: (kind) => setDialog({ kind, block: blockAtCursor(editor.state) }),
    cancel: onCancel,
  })
  // The bar's buttons are built once; each press reads the props of the render it is in.
  const latest = useRef(context)
  useLayoutEffect(() => {
    latest.current = context
  })

  // The block editor's buttons, icons, labels and priorities, doing the buffer's action.
  const groups = useMemo((): ToolbarItemGroups => {
    const swap = (configs: ToolbarButtonConfig[]) =>
      configs.map((config) => ({
        ...config,
        action: () => SOURCE_TOOLBAR_ACTIONS[config.label]?.(latest.current()),
      }))
    return {
      refsAndBlocks: swap(createRefsAndBlocks(editor)),
      structureButtons: swap(createStructureButtons(editor)),
      metadataButtons: swap(createMetadataButtons()),
      historyButtons: swap(createHistoryButtons(editor)),
    }
  }, [editor])
  const configByKey = useMemo(() => buildConfigByKey(groups), [groups])
  const items = useMemo(() => sourceItems(groups, isTouch), [groups, isTouch])

  const openBlockMenu = (anchor: HTMLElement): void => {
    const block = blockAtCursor(editor.state)
    if (block === null) return
    const rect = anchor.getBoundingClientRect()
    setMenu({ block, position: { x: rect.left, y: rect.bottom } })
  }

  const closeMenu = (): void => {
    setMenu(null)
    editor.view.focus()
  }

  const pickDate = (day: Date | undefined): void => {
    const open = dialog
    setDialog(null)
    if (day === undefined || open === null) return
    const date = formatDate(day)
    if (open.kind === 'date') run(insertText(`[[${date}]]`))
    else if (open.block !== null) {
      run(setBlockProperty(open.block, open.kind === 'due' ? 'due_date' : 'scheduled_date', date))
    }
  }

  const saveQuery = (expression: string): void => {
    const block = dialog?.block ?? null
    setDialog(null)
    if (block !== null) run(setBlockText(block, `{{query ${expression}}}`))
  }

  const renderItem = (
    item: ToolbarItem,
    mode: RenderMode,
    closeOverflow: () => void,
  ): React.ReactElement | null => {
    const after = mode === 'overflow' ? closeOverflow : undefined
    switch (item.key) {
      case 'toolbar.format': {
        return renderFormatButton({
          editor,
          mode,
          t,
          open: formatOpen,
          setOpen: setFormatOpen,
          menu: <SourceFormatMenu editor={editor} run={run} />,
        })
      }
      case 'toolbar.turnInto': {
        return renderTurnIntoButton({
          editor,
          mode,
          t,
          open: turnIntoOpen,
          setOpen: setTurnIntoOpen,
          menu: (
            <SourceTurnIntoMenu
              editor={editor}
              run={run}
              onClose={() => {
                setTurnIntoOpen(false)
                closeOverflow()
              }}
            />
          ),
        })
      }
      case 'toolbar.cyclePriority': {
        return renderCyclePriority({
          mode,
          t,
          currentPriority: state.priority,
          onAfterOverflowAction: closeOverflow,
          onCycle: () => SOURCE_TOOLBAR_ACTIONS[item.key]?.(context()),
        })
      }
      case BLOCK_MENU: {
        return (
          <BlockMenuButton
            mode={mode}
            disabled={!state.hasBlock}
            open={menu !== null}
            onOpen={(anchor) => {
              openBlockMenu(anchor)
              after?.()
            }}
          />
        )
      }
      case SAVE: {
        return (
          <Button size="sm" disabled={saving} {...toolbarPressHandlers(onSave)}>
            {t('action.save')}
          </Button>
        )
      }
      default: {
        if (isTouch && item.key === 'toolbar.discard') {
          return (
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              {...toolbarPressHandlers(onCancel)}
            >
              {t('action.cancel')}
            </Button>
          )
        }
        const config = configByKey.get(item.key)
        if (config === undefined) return null
        return renderConfigButton(config, state, mode, t, after)
      }
    }
  }

  const { doc } = editor.state
  return (
    <>
      <ToolbarFrame
        items={items}
        renderItem={renderItem}
        label={t('toolbar.formatting')}
        testId="page-source-toolbar"
        className="sticky top-0 z-10 bg-background"
      />
      {menu !== null && (
        <BlockContextMenu
          // A block the save has yet to create has no id: its actions act on its
          // line, and the rows that read the id are left out for it.
          blockId={menu.block.id ?? ''}
          position={menu.position}
          onClose={closeMenu}
          actions={sourceBlockActions(run, menu.block)}
          actionIds={sourceMenuRows(menu.block)}
          selectedBlockIds={[]}
          pageRefId={pageId}
          todoState={blockTaskState(doc, menu.block)}
          priority={blockProperty(doc, menu.block, 'priority')}
          activeBlockType={blockTypeOf(doc, menu.block)}
        />
      )}
      {(dialog?.kind === 'date' || dialog?.kind === 'due' || dialog?.kind === 'schedule') && (
        <BlockDatePicker onSelect={pickDate} onClose={() => setDialog(null)} />
      )}
      <EmojiPickerDialog
        open={dialog?.kind === 'emoji'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        onSelect={(char) => run(insertText(char))}
      />
      <QueryBuilderModal
        open={dialog?.kind === 'query'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        onSave={saveQuery}
      />
    </>
  )
}

interface BlockMenuButtonProps {
  mode: RenderMode
  disabled: boolean
  open: boolean
  onOpen: (anchor: HTMLElement) => void
}

/** Opens the block menu on the block the cursor is in, below the button. */
function BlockMenuButton({ mode, disabled, open, onOpen }: BlockMenuButtonProps) {
  const { t } = useTranslation()
  const press: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onClick'> = {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      onOpen(e.currentTarget)
    },
    onClick: (e) => {
      if (e.detail === 0) onOpen(e.currentTarget)
    },
  }
  const common = {
    'aria-label': t('contextMenu.blockActions'),
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    disabled,
    ...press,
  }
  if (mode === 'overflow') {
    return (
      <Button variant="ghost" size="sm" className={toolbarMenuRowClass} {...common}>
        <GripVertical className="h-3.5 w-3.5 mr-2" />
        <span>{t('contextMenu.blockActions')}</span>
      </Button>
    )
  }
  return (
    <Tip label={t('pageSource.blockMenuTip')}>
      <Button variant="ghost" size="icon-xs" {...common}>
        <GripVertical className="h-3.5 w-3.5" />
      </Button>
    </Tip>
  )
}

interface SourceMenuProps {
  editor: Editor
  run: (command: Command) => void
}

/** Format's marks, each wrapping the selection in its markdown. */
function SourceFormatMenu({ editor, run }: SourceMenuProps) {
  const { t } = useTranslation()
  const marks = useMemo(() => createMarkToggles(editor), [editor])
  return (
    <div role="toolbar" aria-label={t('toolbar.format')} className="flex items-center gap-0.5">
      {marks.map(({ icon, label, tip }) => {
        const wrap = SOURCE_MARKS[label]
        if (wrap === undefined) return null
        const config = { icon, label, tip, action: () => run(toggleWrap(...wrap)) }
        return <span key={label}>{renderConfigButton(config, {}, 'inline', t)}</span>
      })}
    </div>
  )
}

/** Turn into's block types and the divider, rewriting the block the cursor is in. */
function SourceTurnIntoMenu({ editor, run, onClose }: SourceMenuProps & { onClose: () => void }) {
  const { t } = useTranslation()
  const block = blockAtCursor(editor.state)
  const active = block === null ? null : blockTypeOf(editor.state.doc, block)
  const pick = (type: BlockTypeToken | 'divider'): void => {
    if (block !== null) run(type === 'divider' ? setBlockText(block, '---') : turnInto(block, type))
    onClose()
  }
  return (
    <div role="menu" aria-label={t('toolbar.turnInto')} className="flex min-w-44 flex-col gap-0.5">
      {TURN_INTO_OPTIONS.map((option) => {
        const type = option.blockType as BlockTypeToken
        return (
          <Button
            key={option.id}
            role="menuitemradio"
            aria-checked={active === type ? 'true' : 'false'}
            variant="ghost"
            size="sm"
            disabled={block === null}
            className={cn(toolbarMenuRowClass, active === type && toolbarActiveClass)}
            {...toolbarPressHandlers(() => pick(type))}
          >
            <option.icon className="h-3.5 w-3.5 mr-2" />
            <span>{t(turnIntoTypeKey(option.blockType))}</span>
          </Button>
        )
      })}
      <Button
        role="menuitem"
        variant="ghost"
        size="sm"
        disabled={block === null}
        className={toolbarMenuRowClass}
        {...toolbarPressHandlers(() => pick('divider'))}
      >
        <Minus className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.divider')}</span>
      </Button>
    </div>
  )
}
