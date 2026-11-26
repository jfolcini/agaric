/**
 * DayPageEditor — the daily view's day page, inside its `PageBlockStoreProvider`
 * (#5691). It opens in page mode where a page view would (`usePageMode`: the
 * *Edit pages as* setting or the Blocks | Page switch, a page within the cap);
 * otherwise in block mode's tree with its Add block button. The week and stream
 * views mount a tree per day and stay in block mode.
 *
 * The day's title row works like a page's (#7155 R6): on desktop it heads the
 * view, above the formatting toolbar, with the Blocks | Page switch, the
 * bookmark and the *Page actions* menu (Properties…, Delete). On a phone the
 * top bar shows the date, and a row of the bookmark and that menu, which also
 * holds the switch's row, sits above the blocks.
 */

import { MoreVertical, Settings2, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AddBlockButton } from '@/components/editor/AddBlockButton'
import { BlockTree } from '@/components/editor/BlockTree'
import { ViewHeader } from '@/components/layout/ViewHeader'
import { EditModeItem } from '@/components/pages/EditModeItem'
import { EditModeSwitch } from '@/components/pages/EditModeSwitch'
import { PagePropertyTable } from '@/components/pages/PagePropertyTable'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { menuRowVariants } from '@/components/ui/menu-row'
import { MenuSheet } from '@/components/ui/menu-sheet'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { ModeSwap } from '@/editor/page-mode/ModeSwap'
import { PageModeSlot } from '@/editor/page-mode/PageModeSlot'
import { useEditModeShortcut, usePageMode } from '@/editor/page-mode/use-page-mode'
import { useIsTouch } from '@/hooks/useIsTouch'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { useScrollToFocus } from '@/hooks/useScrollToFocus'
import type { NavigateToPageFn } from '@/lib/block-events'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'

const DESTRUCTIVE_ROW =
  'text-destructive hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10 active:text-destructive'

/**
 * The day's title, the view's one `<h1>`. On desktop the row heads the view
 * (the header outlet, above the formatting toolbar) with `actions` and `kebab`;
 * on a phone the top bar names the day and the title is for assistive tech.
 */
export function DayHeader({
  displayDate,
  actions,
  kebab,
}: {
  displayDate: string
  actions?: React.ReactNode
  kebab?: React.ReactNode
}): React.ReactElement {
  const isTouch = useIsTouch()
  const phoneLayout = usePhoneLayout()
  if (isTouch && phoneLayout) {
    return <FeaturePageHeader title={displayDate} className="journal-page-header" />
  }
  return (
    <ViewHeader>
      {/* Capped and centred like the day's column below the outlet. */}
      <div className="outline-column max-w-reading mx-auto">
        <FeaturePageHeader
          title={displayDate}
          className="journal-page-header"
          actions={actions}
          kebab={kebab}
        />
      </div>
    </ViewHeader>
  )
}

/** The day page's properties, in a dialog (a sheet on a phone). */
function DayPropertiesDialog({
  pageId,
  displayDate,
  open,
  onOpenChange,
}: {
  pageId: string
  displayDate: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description } = parts
  const table = <PagePropertyTable pageId={pageId} forceExpanded={open} />
  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content data-testid="day-properties-dialog">
        <Header>
          <Title>{t('pageProperty.propertiesButton')}</Title>
          <Description>{displayDate}</Description>
        </Header>
        {parts.isMobile ? table : <DialogBody>{table}</DialogBody>}
      </Content>
    </Root>
  )
}

/** Desktop's *Page actions* menu for the day. */
function DayActionsMenu({
  onOpenProperties,
  onDeleteRequest,
}: {
  onOpenProperties: () => void
  onDeleteRequest?: (() => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const label = t('pageHeader.pageActions')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={label}>
              <MoreVertical />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <MenuPopoverContent align="end" className="w-56" aria-label={label}>
        <div role="menu" aria-label={label} className="flex flex-col gap-0.5">
          <PopoverMenuItem
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenProperties()
            }}
          >
            <Settings2 aria-hidden="true" />
            {t('journal.dayProperties')}
          </PopoverMenuItem>
          {onDeleteRequest && (
            <PopoverMenuItem
              role="menuitem"
              className={DESTRUCTIVE_ROW}
              onClick={() => {
                setOpen(false)
                onDeleteRequest()
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('pageHeader.deletePage')}
            </PopoverMenuItem>
          )}
        </div>
      </MenuPopoverContent>
    </Popover>
  )
}

interface DayPageEditorProps {
  pageId: string
  /** The day's title, its view's heading. */
  displayDate: string
  /** The day's own actions (the bookmark), on the title row. */
  actions?: React.ReactNode
  /** The menu's Delete page row; the host confirms. */
  onDeleteRequest?: (() => void) | undefined
  onNavigateToPage?: NavigateToPageFn | undefined
  onAddBlock: () => void
  /** Block mode's zoom root, or `null` at the day's root, for the day's linked references. */
  onZoomChange?: ((blockId: string | null) => void) | undefined
}

export function DayPageEditor({
  pageId,
  displayDate,
  actions,
  onDeleteRequest,
  onNavigateToPage,
  onAddBlock,
  onZoomChange,
}: DayPageEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const phoneLayout = usePhoneLayout()
  const onPhone = isTouch && phoneLayout
  const [menuOpen, setMenuOpen] = useState(false)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  // A phone menu row's action waits for the menu to close, when Radix hands
  // focus back to its trigger: a dialog returns focus to what held it as it
  // opened, and until then the menu's focus trap holds it on the row.
  const afterMenuClose = useRef<(() => void) | null>(null)
  const closeMenuThen = (action: () => void) => {
    afterMenuClose.current = action
    setMenuOpen(false)
  }
  const pageMode = usePageMode(pageId)
  useEditModeShortcut(pageMode.mode, pageMode.changeMode)
  // #6746 — page mode's reference count opens block mode zoomed on its block.
  const [zoomOnMount, setZoomOnMount] = useState<string | null>(null)
  const handleZoomChange = useCallback(
    (blockId: string | null) => {
      setZoomOnMount(null)
      onZoomChange?.(blockId)
    },
    [onZoomChange],
  )

  // A link into the day (search, a backlink, a breadcrumb): block mode focuses
  // its block once it has scrolled to it; page mode puts its cursor there itself.
  const selectedBlockId = useNavigationStore((s) => s.selectedBlockId)
  useScrollToFocus(pageMode.wanted ? null : selectedBlockId, {
    block: 'nearest',
    resolveElement: (id) => document.querySelector(`[data-block-id="${id}"]`),
    // After the scroll, inside the hook's rAF: only an unmount cancels it.
    onComplete: (id) => {
      useBlockStore.getState().setFocused(id)
      useNavigationStore.getState().clearSelection()
    },
  })

  return (
    <div className="journal-day-page">
      <DayHeader
        displayDate={displayDate}
        actions={
          onPhone ? undefined : (
            <>
              <EditModeSwitch
                mode={pageMode.mode}
                onChange={pageMode.changeMode}
                blocked={pageMode.blocked}
              />
              {actions}
            </>
          )
        }
        kebab={
          onPhone ? undefined : (
            <DayActionsMenu
              onOpenProperties={() => setPropertiesOpen(true)}
              onDeleteRequest={onDeleteRequest}
            />
          )
        }
      />
      {onPhone && (
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {actions}
          <div className="ml-auto">
            <MenuSheet
              open={menuOpen}
              onOpenChange={setMenuOpen}
              title={t('pageHeader.pageActions')}
              onCloseAutoFocus={() => {
                const action = afterMenuClose.current
                afterMenuClose.current = null
                action?.()
              }}
              trigger={
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('pageHeader.pageActions')}>
                    <MoreVertical />
                  </Button>
                </SheetTrigger>
              }
            >
              <div role="menu" aria-label={t('pageHeader.pageActions')}>
                <EditModeItem
                  role="menuitem"
                  className={menuRowVariants()}
                  mode={pageMode.mode}
                  blocked={pageMode.blocked}
                  onModeChange={(mode) => {
                    setMenuOpen(false)
                    pageMode.changeMode(mode)
                  }}
                />
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowVariants()}
                  onClick={() => closeMenuThen(() => setPropertiesOpen(true))}
                >
                  <Settings2 aria-hidden="true" />
                  {t('journal.dayProperties')}
                </button>
                {onDeleteRequest && (
                  <button
                    type="button"
                    role="menuitem"
                    className={cn(menuRowVariants(), DESTRUCTIVE_ROW)}
                    onClick={() => closeMenuThen(onDeleteRequest)}
                  >
                    <Trash2 aria-hidden="true" />
                    {t('pageHeader.deletePage')}
                  </button>
                )}
              </div>
            </MenuSheet>
          </div>
        </div>
      )}
      <DayPropertiesDialog
        pageId={pageId}
        displayDate={displayDate}
        open={propertiesOpen}
        onOpenChange={setPropertiesOpen}
      />
      <ModeSwap
        pageId={pageId}
        pageMode={pageMode.wanted}
        page={
          <PageModeSlot
            pageId={pageId}
            ready
            onBlocked={pageMode.onBlocked}
            editorRef={pageMode.editorRef}
            opening={pageMode.opening}
            onNavigateToPage={onNavigateToPage}
            onOpenReferences={(blockId) => {
              setZoomOnMount(blockId)
              pageMode.changeMode('blocks')
            }}
          />
        }
        blocks={
          <>
            <BlockTree
              parentId={pageId}
              onNavigateToPage={onNavigateToPage}
              autoCreateFirstBlock
              zoomOnMount={zoomOnMount}
              onZoomChange={handleZoomChange}
            />
            <div className="mt-1">
              <AddBlockButton onClick={onAddBlock} />
            </div>
          </>
        }
      />
    </div>
  )
}
