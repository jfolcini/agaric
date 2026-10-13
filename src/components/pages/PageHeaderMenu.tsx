import {
  BookTemplate,
  Download,
  ExternalLink,
  FileCode,
  FolderOutput,
  LayoutTemplate,
  Link,
  List,
  MoreVertical,
  Network,
  Redo2,
  Settings2,
  Smile,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { shortcutHint } from '@/components/editor/block-context-menu/hints'
import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/useIsMobile'

/** A space shown in the "Move to space" sub-menu. */
export interface MoveTargetSpace {
  id: string
  name: string
}

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible disabled:pointer-events-none disabled:opacity-50'

const SHORTCUT_HINT_CLASS =
  'ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums [@media(pointer:coarse)]:hidden'

export interface PageHeaderMenuProps {
  canRedo: boolean
  kebabOpen: boolean
  isTemplate: boolean
  isJournalTemplate: boolean
  onUndo: () => void
  onRedo: () => void
  onOpenOutline: () => void
  onShowInGraph: () => void
  onInsertEmoji: () => void
  onKebabOpenChange: (open: boolean) => void
  onAddAlias: () => void
  onAddTag: () => void
  onAddProperty: () => void
  onToggleTemplate: () => void
  onToggleJournalTemplate: () => void
  onExport: () => void
  /** Opens source mode; the row is hidden without it. */
  onEditSource?: (() => void) | undefined
  /** The kebab trigger, so focus can return to it. */
  kebabRef?: React.Ref<HTMLButtonElement> | undefined
  onDeleteRequest: () => void
  onOpenInNewTab?: (() => void) | undefined
  /**
   * Phase 2 — `t('space.moveTo')` support.
   *
   * `isSpaceBlock` — hide the menu entry when the page itself is a
   *   space block (spaces cannot be moved into other spaces).
   * `moveTargets` — alphabetical list of target spaces, already
   *   filtered to exclude the current space. When the list is empty
   *   the menu entry is hidden (no valid move target).
   * `onMoveToSpace` — callback fired when the user picks a target.
   *   `null` means the feature is unavailable (tests can pass `null`).
   */
  isSpaceBlock?: boolean | undefined
  moveTargets?: MoveTargetSpace[] | undefined
  onMoveToSpace?: ((targetSpaceId: string) => void) | undefined
}

export function PageHeaderMenu({
  canRedo,
  kebabOpen,
  isTemplate,
  isJournalTemplate,
  onUndo,
  onRedo,
  onOpenOutline,
  onShowInGraph,
  onInsertEmoji,
  onKebabOpenChange,
  onAddAlias,
  onAddTag,
  onAddProperty,
  onToggleTemplate,
  onToggleJournalTemplate,
  onExport,
  onEditSource,
  kebabRef,
  onDeleteRequest,
  onOpenInNewTab,
  isSpaceBlock = false,
  moveTargets,
  onMoveToSpace,
}: PageHeaderMenuProps) {
  const { t } = useTranslation()
  // Item 7: hide the `t('tabs.openInNewTab')` affordance on mobile — the
  // hoisted TabBar is itself desktop-only, so the item would otherwise be
  // semantically misleading (the new tab is invisible on mobile).
  const isMobile = useIsMobile()

  // Phase 2 — the `t('space.moveTo')` entry expands inline (no nested
  // Radix popover) to keep focus management simple and the a11y tree
  // flat. The sub-menu is keyboard-navigable via normal Tab order.
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const showMoveEntry =
    !isSpaceBlock && onMoveToSpace != null && moveTargets != null && moveTargets.length > 0

  // CR-A11Y (#151) — roving-tabindex over the TOP-LEVEL menuitems. Items render
  // conditionally (open-in-new-tab, move-to-space) and are interleaved with
  // <hr> separators, so we build the ordered id list declaratively below in
  // render order (which is DOM order) rather than measuring the live DOM. Each
  // top-level <button> registers its node via `registerItem`, keyed by a stable
  // id. The nested "move to space" sub-menu has its own role="menu"/
  // role="menuitem" and is intentionally NOT part of this set, so its targets
  // are never counted in the top-level roving set.
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [activeId, setActiveId] = useState<string | null>(null)

  // Ordered top-level menuitem ids — mirrors the conditional render order.
  // A disabled Redo cannot take focus, so it leaves the roving set.
  const orderedIds: string[] = [
    ...(onOpenInNewTab != null && !isMobile ? ['openInNewTab'] : []),
    'undo',
    ...(canRedo ? ['redo'] : []),
    'openOutline',
    'showInGraph',
    'insertEmoji',
    'addAlias',
    'addTag',
    'addProperty',
    'toggleTemplate',
    'toggleJournalTemplate',
    'export',
    ...(onEditSource != null ? ['editSource'] : []),
    ...(showMoveEntry ? ['moveTo'] : []),
    'delete',
  ]

  const registerItem = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) itemRefs.current.set(id, node)
    else itemRefs.current.delete(id)
  }, [])

  const focusItem = useCallback((id: string | null) => {
    if (id == null) return
    setActiveId(id)
    itemRefs.current.get(id)?.focus()
  }, [])

  // On open, focus the first menuitem. We wait a frame so conditional items
  // and the Radix portal content are mounted before we focus.
  const firstId = orderedIds[0] ?? null
  useEffect(() => {
    if (!kebabOpen) {
      // oxlint-disable-next-line react/set-state-in-effect -- clears the roving focus id on close; a plain derive would discard the user's arrow-key moves; the guarded adjust is out of scope; see #4407
      setActiveId(null)
      return
    }
    const raf = requestAnimationFrame(() => focusItem(firstId))
    return () => cancelAnimationFrame(raf)
  }, [kebabOpen, firstId, focusItem])

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const ids = orderedIds
    if (ids.length === 0) return
    // Only the top-level roving set responds to arrow keys. The nested
    // "move to space" sub-menu uses normal Tab order, so when focus is inside
    // it (target is not a registered top-level item) we leave the event alone.
    const target = event.target as HTMLElement
    const onTopLevelItem = ids.some((id) => itemRefs.current.get(id) === target)
    if (!onTopLevelItem) return
    const current = activeId ?? ids[0]
    const idx = current ? ids.indexOf(current) : -1
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        focusItem(ids[(idx + 1 + ids.length) % ids.length] ?? null)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        focusItem(ids[(idx - 1 + ids.length) % ids.length] ?? null)
        break
      }
      case 'Home': {
        event.preventDefault()
        focusItem(ids[0] ?? null)
        break
      }
      case 'End': {
        event.preventDefault()
        focusItem(ids.at(-1) ?? null)
        break
      }
      default: {
        break
      }
    }
  }

  /** Shared props for every top-level menuitem button. */
  const menuItemProps = (id: string) => ({
    role: 'menuitem' as const,
    tabIndex: activeId === id ? 0 : -1,
    ref: (node: HTMLButtonElement | null) => registerItem(id, node),
    onFocus: () => setActiveId(id),
  })

  return (
    <Popover open={kebabOpen} onOpenChange={onKebabOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              ref={kebabRef}
              variant="ghost"
              size="icon-sm"
              aria-label={t('pageHeader.pageActions')}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('pageHeader.pageActions')}</TooltipContent>
      </Tooltip>
      <MenuPopoverContent
        align="end"
        className="w-80"
        role="menu"
        tabIndex={-1}
        aria-label={t('pageHeader.pageActions')}
        onKeyDown={handleMenuKeyDown}
        // Back to the kebab only when closing left focus nowhere: a row that
        // focused something (Edit as Markdown's textarea) keeps it.
        onCloseAutoFocus={(e) => {
          if (document.activeElement !== document.body) e.preventDefault()
        }}
      >
        {onOpenInNewTab != null && !isMobile && (
          <>
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={onOpenInNewTab}
              {...menuItemProps('openInNewTab')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('tabs.openInNewTab')}
            </button>
            <hr className="my-1 h-px bg-border border-none" />
          </>
        )}
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onUndo}
          {...menuItemProps('undo')}
        >
          <Undo2 className="h-3.5 w-3.5" />
          {t('pageHeader.undoAction')}
          <span className={SHORTCUT_HINT_CLASS}>{shortcutHint('undoLastPageOp')}</span>
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          disabled={!canRedo}
          onClick={onRedo}
          {...menuItemProps('redo')}
        >
          <Redo2 className="h-3.5 w-3.5" />
          {t('pageHeader.redoAction')}
          <span className={SHORTCUT_HINT_CLASS}>{shortcutHint('redoLastUndoneOp')}</span>
        </button>
        <hr className="my-1 h-px bg-border border-none" />
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onOpenOutline}
          {...menuItemProps('openOutline')}
        >
          <List className="h-3.5 w-3.5" />
          {t('pageHeader.openOutline')}
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onShowInGraph}
          {...menuItemProps('showInGraph')}
        >
          <Network className="h-3.5 w-3.5" />
          {t('pageHeader.showInGraph')}
          <span className={SHORTCUT_HINT_CLASS}>{shortcutHint('showPageInGraph')}</span>
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onInsertEmoji}
          {...menuItemProps('insertEmoji')}
        >
          <Smile className="h-3.5 w-3.5" />
          {t('pageHeader.insertEmoji')}
        </button>
        <hr className="my-1 h-px bg-border border-none" />
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onAddAlias}
          {...menuItemProps('addAlias')}
        >
          <Link className="h-3.5 w-3.5" />
          {t('pageHeader.menuAddAlias')}
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onAddTag}
          {...menuItemProps('addTag')}
        >
          <Tag className="h-3.5 w-3.5" />
          {t('pageHeader.menuAddTag')}
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onAddProperty}
          {...menuItemProps('addProperty')}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t('pageHeader.menuAddProperty')}
        </button>
        <hr className="my-1 h-px bg-border border-none" />
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onToggleTemplate}
          {...menuItemProps('toggleTemplate')}
        >
          <LayoutTemplate className="h-3.5 w-3.5" />
          {isTemplate ? t('pageHeader.removeTemplate') : t('pageHeader.saveAsTemplate')}
        </button>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onToggleJournalTemplate}
          {...menuItemProps('toggleJournalTemplate')}
        >
          <BookTemplate className="h-3.5 w-3.5" />
          {isJournalTemplate
            ? t('pageHeader.removeJournalTemplate')
            : t('pageHeader.setJournalTemplate')}
        </button>
        <hr className="my-1 h-px bg-border border-none" />
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={onExport}
          {...menuItemProps('export')}
        >
          <Download className="h-3.5 w-3.5" />
          {t('pageHeader.exportMarkdown')}
          <span className={SHORTCUT_HINT_CLASS}>{shortcutHint('exportPageMarkdown')}</span>
        </button>
        {onEditSource != null && (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={onEditSource}
            {...menuItemProps('editSource')}
          >
            <FileCode className="h-3.5 w-3.5" />
            {t('pageSource.edit')}
          </button>
        )}
        {showMoveEntry && (
          <>
            <hr className="my-1 h-px bg-border border-none" />
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              aria-haspopup="menu"
              aria-expanded={moveSubmenuOpen}
              onClick={() => setMoveSubmenuOpen((open) => !open)}
              {...menuItemProps('moveTo')}
            >
              <FolderOutput className="h-3.5 w-3.5" />
              {t('space.moveTo')}
              <span className="ml-auto text-xs text-muted-foreground" aria-hidden="true">
                {moveSubmenuOpen ? '▾' : '▸'}
              </span>
            </button>
            {moveSubmenuOpen && (
              <div
                role="menu"
                aria-label={t('space.moveTo')}
                className="pl-4 mt-0.5 flex flex-col gap-0.5"
              >
                {moveTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    role="menuitem"
                    title={target.name}
                    className={MENU_ITEM_CLASS}
                    onClick={() => {
                      setMoveSubmenuOpen(false)
                      onMoveToSpace?.(target.id)
                    }}
                  >
                    <span className="line-clamp-1">{target.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <hr className="my-1 h-px bg-border border-none" />
        <div className="rounded-md bg-destructive/5 p-0.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 touch-target focus-ring-visible focus-visible:ring-destructive/50"
            onClick={onDeleteRequest}
            {...menuItemProps('delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('pageHeader.deletePage')}
          </button>
        </div>
      </MenuPopoverContent>
    </Popover>
  )
}
