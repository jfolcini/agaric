import {
  BookTemplate,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileOutput,
  FolderOutput,
  LayoutTemplate,
  Link,
  List,
  MoreVertical,
  Network,
  Printer,
  Redo2,
  Settings2,
  Smile,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { shortcutHint } from '@/components/editor/block-context-menu/hints'
import { EditModeItem } from '@/components/pages/EditModeItem'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { MenuRowChevron, menuRowVariants } from '@/components/ui/menu-row'
import { MenuSheet } from '@/components/ui/menu-sheet'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useKeyboardHints } from '@/hooks/useKeyboardHints'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import type { EditMode } from '@/lib/preferences'
import { cn } from '@/lib/utils'

/** A space shown in the "Move to space" sub-menu. */
export interface MoveTargetSpace {
  id: string
  name: string
}

const SHORTCUT_HINT_CLASS = 'ml-auto shrink-0'

export interface PageHeaderMenuProps {
  canRedo: boolean
  kebabOpen: boolean
  isTemplate: boolean
  isJournalTemplate: boolean
  onUndo: () => void
  onRedo: () => void
  /** Opens the History view scoped to this page; the row is hidden without it. */
  onOpenHistory?: (() => void) | undefined
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
  /** Saves the page as a `.md` file; the row is hidden without it. */
  onSaveMarkdownFile?: (() => void) | undefined
  /** Opens the webview's print dialog; the row is hidden without it. */
  onPrint?: (() => void) | undefined
  /** Copies the page's `agaric://` link. */
  onCopyAppLink: () => void
  /** Opens source mode; the row is hidden without it. */
  onEditSource?: (() => void) | undefined
  /** Switches the page's editing mode; the row, which names the other mode, is hidden without it. */
  editMode?: EditMode | undefined
  onEditModeChange?: ((mode: EditMode) => void) | undefined
  /** Why page mode is not offered for this page: the row says so and does nothing. */
  editModeBlocked?: string | null | undefined
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

interface MenuFlags {
  offersNewTab: boolean
  canRedo: boolean
  hasHistory: boolean
  hasSaveMarkdownFile: boolean
  hasPrint: boolean
  hasEditMode: boolean
  hasEditSource: boolean
  showMoveEntry: boolean
  exportOpen: boolean
  phoneLayout: boolean
}

function exportMenuIds(f: MenuFlags): string[] {
  return [
    'copyAppLink',
    'export',
    ...(f.hasSaveMarkdownFile ? ['saveMarkdownFile'] : []),
    ...(f.hasPrint ? ['print'] : []),
  ]
}

/**
 * Ordered menuitem ids — mirrors the conditional render order: the Add, View,
 * Template and Edit sections, Export and its open rows, Delete. On a phone an
 * open Export is all the sheet shows. A disabled Redo cannot take focus, so it
 * leaves the roving set.
 */
function menuIds(f: MenuFlags): string[] {
  if (f.exportOpen && f.phoneLayout) return ['exportBack', ...exportMenuIds(f)]
  return [
    'addAlias',
    'addTag',
    'addProperty',
    'insertEmoji',
    'openOutline',
    ...(f.hasHistory ? ['pageHistory'] : []),
    'showInGraph',
    ...(f.offersNewTab ? ['openInNewTab'] : []),
    'toggleTemplate',
    'toggleJournalTemplate',
    'undo',
    ...(f.canRedo ? ['redo'] : []),
    ...(f.hasEditMode ? ['editMode'] : []),
    ...(f.hasEditSource ? ['editSource'] : []),
    ...(f.showMoveEntry ? ['moveTo'] : []),
    'exportMenu',
    ...(f.exportOpen ? exportMenuIds(f) : []),
    'delete',
  ]
}

interface ExportRowsProps extends Pick<
  PageHeaderMenuProps,
  'onCopyAppLink' | 'onExport' | 'onSaveMarkdownFile' | 'onPrint'
> {
  id: string
  /** Indented under the Export row on a desktop; alone in the sheet on a phone. */
  indent: 0 | 1
  keyboardHints: boolean
  itemProps: (id: string) => React.ComponentProps<'button'>
}

/** The Export submenu's rows. */
function ExportRows({
  id,
  indent,
  keyboardHints,
  itemProps,
  onCopyAppLink,
  onExport,
  onSaveMarkdownFile,
  onPrint,
}: ExportRowsProps): React.ReactElement {
  const { t } = useTranslation()
  const row = menuRowVariants({ indent })
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of items inside a menu; <fieldset> would bring form semantics into it
    <div id={id} role="group" aria-label={t('pageHeader.exportMenu')}>
      <button type="button" className={row} onClick={onCopyAppLink} {...itemProps('copyAppLink')}>
        <Link />
        {t('pageHeader.copyAppLink')}
      </button>
      <button type="button" className={row} onClick={onExport} {...itemProps('export')}>
        <Copy />
        {t('pageHeader.exportMarkdown')}
        {keyboardHints && (
          <Kbd
            keys={shortcutHint('exportPageMarkdown')}
            tone="muted"
            className={SHORTCUT_HINT_CLASS}
          />
        )}
      </button>
      {onSaveMarkdownFile != null && (
        <button
          type="button"
          className={row}
          onClick={onSaveMarkdownFile}
          {...itemProps('saveMarkdownFile')}
        >
          <Download />
          {t('pageHeader.saveMarkdownFile')}
        </button>
      )}
      {onPrint != null && (
        <button type="button" className={row} onClick={onPrint} {...itemProps('print')}>
          <Printer />
          {t('pageHeader.print')}
        </button>
      )}
    </div>
  )
}

export function PageHeaderMenu({
  canRedo,
  kebabOpen,
  isTemplate,
  isJournalTemplate,
  onUndo,
  onRedo,
  onOpenHistory,
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
  onSaveMarkdownFile,
  onPrint,
  onCopyAppLink,
  onEditSource,
  editMode,
  onEditModeChange,
  editModeBlocked,
  kebabRef,
  onDeleteRequest,
  onOpenInNewTab,
  isSpaceBlock,
  moveTargets,
  onMoveToSpace,
}: PageHeaderMenuProps) {
  const { t } = useTranslation()
  const phoneLayout = usePhoneLayout()
  const isTouch = useIsTouch()
  const keyboardHints = useKeyboardHints()
  // A touch phone has no tab bar (`TabBar`), so a new tab there could never be seen.
  const offersNewTab = onOpenInNewTab != null && !(isTouch && phoneLayout)

  // Phase 2 — the `t('space.moveTo')` entry expands inline (no nested
  // Radix popover) to keep focus management simple and the a11y tree
  // flat. The sub-menu is keyboard-navigable via normal Tab order.
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const showMoveEntry =
    !isSpaceBlock && onMoveToSpace != null && moveTargets != null && moveTargets.length > 0

  // Export opens in place on a desktop, as the block menu's disclosures do, and
  // drills in on a phone, where the sheet shows its rows alone. The menu
  // reopens with it closed.
  const [exportOpen, setExportOpen] = useState(false)
  const [wasOpen, setWasOpen] = useState(kebabOpen)
  if (kebabOpen !== wasOpen) {
    setWasOpen(kebabOpen)
    if (kebabOpen) setExportOpen(false)
  }
  const exportGroupId = useId()

  // CR-A11Y (#151) — roving-tabindex over the menuitems. Items render
  // conditionally (open-in-new-tab, move-to-space, the Export rows) and are
  // interleaved with <hr> separators, so we build the ordered id list
  // declaratively below in render order (which is DOM order) rather than
  // measuring the live DOM. Each <button> registers its node via
  // `registerItem`, keyed by a stable id. The nested "move to space" sub-menu
  // has its own role="menu"/role="menuitem" and is intentionally NOT part of
  // this set, so its targets are never counted in the roving set.
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [activeId, setActiveId] = useState<string | null>(null)

  const orderedIds = menuIds({
    offersNewTab,
    canRedo,
    hasHistory: onOpenHistory != null,
    hasSaveMarkdownFile: onSaveMarkdownFile != null,
    hasPrint: onPrint != null,
    hasEditMode: onEditModeChange != null,
    hasEditSource: onEditSource != null,
    showMoveEntry,
    exportOpen,
    phoneLayout,
  })

  const registerItem = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) itemRefs.current.set(id, node)
    else itemRefs.current.delete(id)
  }, [])

  const focusItem = useCallback((id: string | null) => {
    if (id == null) return
    setActiveId(id)
    itemRefs.current.get(id)?.focus()
  }, [])

  // On open, focus the first menuitem, Add alias. We wait a frame so the Radix
  // portal content is mounted before we focus.
  useEffect(() => {
    if (!kebabOpen) {
      // oxlint-disable-next-line react/set-state-in-effect -- clears the roving focus id on close; a plain derive would discard the user's arrow-key moves; the guarded adjust is out of scope; see #4407
      setActiveId(null)
      return
    }
    const raf = requestAnimationFrame(() => focusItem('addAlias'))
    return () => cancelAnimationFrame(raf)
  }, [kebabOpen, focusItem])

  // A phone's drill unmounts the row that had focus, so focus follows the
  // drill: into the Export rows, or back onto the Export row.
  const drillFocus = useRef<string | null>(null)
  useEffect(() => {
    const id = drillFocus.current
    drillFocus.current = null
    focusItem(id)
  }, [exportOpen, focusItem])
  const toggleExport = () => {
    if (phoneLayout) drillFocus.current = exportOpen ? 'exportMenu' : 'copyAppLink'
    setExportOpen((open) => !open)
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const ids = orderedIds
    if (ids.length === 0) return
    // Only the roving set responds to arrow keys. The nested "move to space"
    // sub-menu uses normal Tab order, so when focus is inside it (target is
    // not a registered item) we leave the event alone.
    const target = event.target as HTMLElement
    const onRovingItem = ids.some((id) => itemRefs.current.get(id) === target)
    if (!onRovingItem) return
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

  /** Shared props for every roving menuitem button. */
  const menuItemProps = (id: string) => ({
    role: 'menuitem' as const,
    tabIndex: activeId === id ? 0 : -1,
    ref: (node: HTMLButtonElement | null) => registerItem(id, node),
    onFocus: () => setActiveId(id),
  })

  const triggerButton = (
    <Button ref={kebabRef} variant="ghost" size="icon-sm" aria-label={t('pageHeader.pageActions')}>
      <MoreVertical />
    </Button>
  )
  const trigger = (
    <Tooltip>
      <TooltipTrigger asChild>
        {phoneLayout ? (
          <SheetTrigger asChild>{triggerButton}</SheetTrigger>
        ) : (
          <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        )}
      </TooltipTrigger>
      <TooltipContent>{t('pageHeader.pageActions')}</TooltipContent>
    </Tooltip>
  )
  const menuProps = {
    role: 'menu',
    tabIndex: -1,
    'aria-label': t('pageHeader.pageActions'),
    onKeyDown: handleMenuKeyDown,
  } as const
  // Back to the kebab only when closing left focus nowhere: a row that
  // focused something (Edit as Markdown's textarea) keeps it.
  const onCloseAutoFocus = (e: Event) => {
    if (document.activeElement !== document.body) e.preventDefault()
  }

  const row = menuRowVariants()
  const separator = <hr className="my-1 h-px bg-border border-none" />

  const exportRows = (
    <ExportRows
      id={exportGroupId}
      indent={phoneLayout ? 0 : 1}
      keyboardHints={keyboardHints}
      itemProps={menuItemProps}
      onCopyAppLink={onCopyAppLink}
      onExport={onExport}
      onSaveMarkdownFile={onSaveMarkdownFile}
      onPrint={onPrint}
    />
  )

  const drilledIntoExport = (
    <>
      <button type="button" className={row} onClick={toggleExport} {...menuItemProps('exportBack')}>
        <ChevronLeft />
        {t('pageHeader.exportBack')}
      </button>
      {separator}
      {exportRows}
    </>
  )

  const sections = (
    <>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of items inside a menu; see exportRows */}
      <div role="group" aria-label={t('pageHeader.sectionAdd')}>
        <button type="button" className={row} onClick={onAddAlias} {...menuItemProps('addAlias')}>
          <Link />
          {t('pageHeader.menuAddAlias')}
        </button>
        <button type="button" className={row} onClick={onAddTag} {...menuItemProps('addTag')}>
          <Tag />
          {t('pageHeader.menuAddTag')}
        </button>
        <button
          type="button"
          className={row}
          onClick={onAddProperty}
          {...menuItemProps('addProperty')}
        >
          <Settings2 />
          {t('pageHeader.menuAddProperty')}
        </button>
        <button
          type="button"
          className={row}
          onClick={onInsertEmoji}
          {...menuItemProps('insertEmoji')}
        >
          <Smile />
          {t('pageHeader.insertEmoji')}
        </button>
      </div>
      {separator}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of items inside a menu; see exportRows */}
      <div role="group" aria-label={t('pageHeader.sectionView')}>
        <button
          type="button"
          className={row}
          onClick={onOpenOutline}
          {...menuItemProps('openOutline')}
        >
          <List />
          {t('pageHeader.openOutline')}
        </button>
        {onOpenHistory != null && (
          <button
            type="button"
            className={row}
            onClick={onOpenHistory}
            {...menuItemProps('pageHistory')}
          >
            <Clock />
            {t('pageHeader.pageHistory')}
          </button>
        )}
        <button
          type="button"
          className={row}
          onClick={onShowInGraph}
          {...menuItemProps('showInGraph')}
        >
          <Network />
          {t('pageHeader.showInGraph')}
          {keyboardHints && (
            <Kbd
              keys={shortcutHint('showPageInGraph')}
              tone="muted"
              className={SHORTCUT_HINT_CLASS}
            />
          )}
        </button>
        {offersNewTab && (
          <button
            type="button"
            className={row}
            onClick={onOpenInNewTab}
            {...menuItemProps('openInNewTab')}
          >
            <ExternalLink />
            {t('tabs.openInNewTab')}
          </button>
        )}
      </div>
      {separator}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of items inside a menu; see exportRows */}
      <div role="group" aria-label={t('pageHeader.sectionTemplate')}>
        <button
          type="button"
          className={row}
          onClick={onToggleTemplate}
          {...menuItemProps('toggleTemplate')}
        >
          <LayoutTemplate />
          {isTemplate ? t('pageHeader.removeTemplate') : t('pageHeader.saveAsTemplate')}
        </button>
        <button
          type="button"
          className={row}
          onClick={onToggleJournalTemplate}
          {...menuItemProps('toggleJournalTemplate')}
        >
          <BookTemplate />
          {isJournalTemplate
            ? t('pageHeader.removeJournalTemplate')
            : t('pageHeader.setJournalTemplate')}
        </button>
      </div>
      {separator}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of items inside a menu; see exportRows */}
      <div role="group" aria-label={t('pageHeader.sectionEdit')}>
        <button type="button" className={row} onClick={onUndo} {...menuItemProps('undo')}>
          <Undo2 />
          {t('pageHeader.undoAction')}
          {keyboardHints && (
            <Kbd
              keys={shortcutHint('undoLastPageOp')}
              tone="muted"
              className={SHORTCUT_HINT_CLASS}
            />
          )}
        </button>
        <button
          type="button"
          className={row}
          disabled={!canRedo}
          onClick={onRedo}
          {...menuItemProps('redo')}
        >
          <Redo2 />
          {t('pageHeader.redoAction')}
          {keyboardHints && (
            <Kbd
              keys={shortcutHint('redoLastUndoneOp')}
              tone="muted"
              className={SHORTCUT_HINT_CLASS}
            />
          )}
        </button>
        {onEditModeChange != null && (
          <EditModeItem
            className={row}
            mode={editMode}
            blocked={editModeBlocked}
            onModeChange={onEditModeChange}
            {...menuItemProps('editMode')}
          />
        )}
        {onEditSource != null && (
          <button
            type="button"
            className={row}
            onClick={onEditSource}
            {...menuItemProps('editSource')}
          >
            <FileCode />
            {t('pageSource.edit')}
          </button>
        )}
        {showMoveEntry && (
          <>
            <button
              type="button"
              className={row}
              aria-haspopup="menu"
              aria-expanded={moveSubmenuOpen}
              onClick={() => setMoveSubmenuOpen((open) => !open)}
              {...menuItemProps('moveTo')}
            >
              <FolderOutput />
              {t('space.moveTo')}
              <MenuRowChevron expanded={moveSubmenuOpen} />
            </button>
            {moveSubmenuOpen && (
              <div role="menu" aria-label={t('space.moveTo')}>
                {moveTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    role="menuitem"
                    className={menuRowVariants({ indent: 1 })}
                    onClick={() => {
                      setMoveSubmenuOpen(false)
                      onMoveToSpace?.(target.id)
                    }}
                  >
                    <TruncatedText>{target.name}</TruncatedText>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {separator}
      <button
        type="button"
        className={row}
        aria-expanded={exportOpen}
        aria-controls={exportOpen ? exportGroupId : undefined}
        onClick={toggleExport}
        {...menuItemProps('exportMenu')}
      >
        <FileOutput />
        {t('pageHeader.exportMenu')}
        <MenuRowChevron expanded={exportOpen} />
      </button>
      {exportOpen && exportRows}
      {separator}
      <div className="rounded-md bg-destructive/5 p-0.5">
        <button
          type="button"
          className={cn(
            row,
            'text-destructive hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10 active:text-destructive',
          )}
          onClick={onDeleteRequest}
          {...menuItemProps('delete')}
        >
          <Trash2 />
          {t('pageHeader.deletePage')}
        </button>
      </div>
    </>
  )

  // A phone gets the rows as a bottom sheet: the dropdown covered most of
  // the screen (#5931).
  if (phoneLayout) {
    return (
      <MenuSheet
        open={kebabOpen}
        onOpenChange={onKebabOpenChange}
        title={t('pageHeader.pageActions')}
        trigger={trigger}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div {...menuProps}>{exportOpen ? drilledIntoExport : sections}</div>
      </MenuSheet>
    )
  }

  return (
    <Popover open={kebabOpen} onOpenChange={onKebabOpenChange}>
      {trigger}
      <MenuPopoverContent
        align="end"
        className="w-80"
        {...menuProps}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {sections}
      </MenuPopoverContent>
    </Popover>
  )
}
