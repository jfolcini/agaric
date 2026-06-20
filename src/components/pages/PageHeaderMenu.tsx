import {
  BookTemplate,
  Download,
  ExternalLink,
  FolderOutput,
  LayoutTemplate,
  Link,
  MoreVertical,
  Redo2,
  Settings2,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/useIsMobile'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { cn } from '@/lib/utils'

/** A space shown in the "Move to space" sub-menu. */
export interface MoveTargetSpace {
  id: string
  name: string
}

export interface PageHeaderMenuProps {
  canRedo: boolean
  kebabOpen: boolean
  isTemplate: boolean
  isJournalTemplate: boolean
  onUndo: () => void
  onRedo: () => void
  onKebabOpenChange: (open: boolean) => void
  onAddAlias: () => void
  onAddTag: () => void
  onAddProperty: () => void
  onToggleTemplate: () => void
  onToggleJournalTemplate: () => void
  onExport: () => void
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
  onKebabOpenChange,
  onAddAlias,
  onAddTag,
  onAddProperty,
  onToggleTemplate,
  onToggleJournalTemplate,
  onExport,
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
  const orderedIds: string[] = [
    ...(onOpenInNewTab != null && !isMobile ? ['openInNewTab'] : []),
    'addAlias',
    'addTag',
    'addProperty',
    'toggleTemplate',
    'toggleJournalTemplate',
    'export',
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
        focusItem(ids[ids.length - 1] ?? null)
        break
      }
      default:
        break
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
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('pageHeader.undoAction')}
            onClick={onUndo}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        {/*  sub-fix 3: tier-aware undo tooltip. The same Ctrl+Z hits
            either the editor-undo (within current block) when an editable
            field is focused or the page-undo (last op-log entry) when not.
            We expose this so users can predict which tier will fire. */}
        <TooltipContent>
          <div>
            {t('pageHeader.undoAction')} {getShortcutKeys('undoLastPageOp')}
          </div>
          <div className="mt-1 text-xs opacity-80">{t('undo.tipPage')}</div>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('pageHeader.redoAction')}
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('pageHeader.redoAction')} {getShortcutKeys('redoLastUndoneOp')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleTemplate}
            aria-label={t('pageHeader.toggleTemplate')}
            aria-pressed={isTemplate}
          >
            <LayoutTemplate className={cn('h-3.5 w-3.5', isTemplate && 'text-primary')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isTemplate ? t('pageHeader.templateActive') : t('pageHeader.toggleTemplate')}
        </TooltipContent>
      </Tooltip>
      <Popover open={kebabOpen} onOpenChange={onKebabOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t('pageHeader.pageActions')}>
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <MenuPopoverContent
          align="end"
          className="p-1"
          role="menu"
          tabIndex={-1}
          aria-label={t('pageHeader.pageActions')}
          onKeyDown={handleMenuKeyDown}
        >
          {onOpenInNewTab != null && !isMobile && (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
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
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
            onClick={onAddAlias}
            {...menuItemProps('addAlias')}
          >
            <Link className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddAlias')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
            onClick={onAddTag}
            {...menuItemProps('addTag')}
          >
            <Tag className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddTag')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
            onClick={onAddProperty}
            {...menuItemProps('addProperty')}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddProperty')}
          </button>
          <hr className="my-1 h-px bg-border border-none" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
            onClick={onToggleTemplate}
            {...menuItemProps('toggleTemplate')}
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            {isTemplate ? t('pageHeader.removeTemplate') : t('pageHeader.saveAsTemplate')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
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
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
            onClick={onExport}
            {...menuItemProps('export')}
          >
            <Download className="h-3.5 w-3.5" />
            {t('pageHeader.exportMarkdown')}
            <span className="ml-auto text-xs text-muted-foreground">
              {getShortcutKeys('exportPageMarkdown')}
            </span>
          </button>
          {showMoveEntry && (
            <>
              <hr className="my-1 h-px bg-border border-none" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
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
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-ring-visible"
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
          <div className="rounded bg-destructive/5 p-0.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 touch-target focus-ring-visible focus-visible:ring-destructive/50"
              onClick={onDeleteRequest}
              {...menuItemProps('delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('pageHeader.deletePage')}
            </button>
          </div>
        </MenuPopoverContent>
      </Popover>
    </div>
  )
}
