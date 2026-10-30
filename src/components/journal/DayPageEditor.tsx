/**
 * DayPageEditor — the daily view's day page, inside its `PageBlockStoreProvider`
 * (#5691). It opens in page mode where a page view would (`usePageMode`: the
 * *Edit pages as* setting or the Blocks | Page switch, a page within the cap),
 * the switch ending the day's row of actions (on a phone, a *Page actions* menu
 * holding the switch's row instead, so the row fits one line); otherwise in
 * block mode's tree with its Add block button. The week and stream views mount
 * a tree per day and stay in block mode.
 */

import { MoreVertical } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AddBlockButton } from '@/components/editor/AddBlockButton'
import { BlockTree } from '@/components/editor/BlockTree'
import { EditModeItem } from '@/components/pages/EditModeItem'
import { EditModeSwitch } from '@/components/pages/EditModeSwitch'
import { MENU_ITEM_CLASS } from '@/components/pages/PageHeaderMenu'
import { Button } from '@/components/ui/button'
import { MenuSheet } from '@/components/ui/menu-sheet'
import { SheetTrigger } from '@/components/ui/sheet'
import { PageModeSlot } from '@/editor/page-mode/PageModeSlot'
import { useEditModeShortcut, usePageMode } from '@/editor/page-mode/use-page-mode'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useScrollToFocus } from '@/hooks/useScrollToFocus'
import type { NavigateToPageFn } from '@/lib/block-events'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'

interface DayPageEditorProps {
  pageId: string
  /** The day's own actions, on the row the switch (on a phone, the menu) ends. */
  actions?: React.ReactNode
  onNavigateToPage?: NavigateToPageFn | undefined
  onAddBlock: () => void
}

export function DayPageEditor({
  pageId,
  actions,
  onNavigateToPage,
  onAddBlock,
}: DayPageEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const isMobile = useIsMobile()
  const onPhone = isTouch && isMobile
  const [menuOpen, setMenuOpen] = useState(false)
  const pageMode = usePageMode(pageId)
  useEditModeShortcut(pageMode.mode, pageMode.changeMode)

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
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {actions}
        <div className="ml-auto">
          {onPhone ? (
            <MenuSheet
              open={menuOpen}
              onOpenChange={setMenuOpen}
              title={t('pageHeader.pageActions')}
              trigger={
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('pageHeader.pageActions')}>
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </SheetTrigger>
              }
            >
              <div role="menu" aria-label={t('pageHeader.pageActions')}>
                <EditModeItem
                  role="menuitem"
                  className={MENU_ITEM_CLASS}
                  mode={pageMode.mode}
                  blocked={pageMode.blocked}
                  onModeChange={(mode) => {
                    setMenuOpen(false)
                    pageMode.changeMode(mode)
                  }}
                />
              </div>
            </MenuSheet>
          ) : (
            <EditModeSwitch
              mode={pageMode.mode}
              onChange={pageMode.changeMode}
              blocked={pageMode.blocked}
            />
          )}
        </div>
      </div>
      {pageMode.wanted ? (
        <PageModeSlot
          pageId={pageId}
          ready
          onBlocked={pageMode.onBlocked}
          editorRef={pageMode.editorRef}
          opening={pageMode.opening}
          onNavigateToPage={onNavigateToPage}
        />
      ) : (
        <>
          <BlockTree parentId={pageId} onNavigateToPage={onNavigateToPage} autoCreateFirstBlock />
          <div className="mt-1">
            <AddBlockButton onClick={onAddBlock} />
          </div>
        </>
      )}
    </div>
  )
}
