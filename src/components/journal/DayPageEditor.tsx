/**
 * DayPageEditor — the daily view's day page, inside its `PageBlockStoreProvider`
 * (#5691). It opens in page mode where a page view would (`usePageMode`: the
 * *Edit pages as* setting or the Blocks | Page switch, a desktop pointer, a page
 * within the cap), the switch ending the day's row of actions; otherwise in
 * block mode's tree with its Add block button. The week and stream views mount
 * a tree per day and stay in block mode.
 */

import type React from 'react'

import { AddBlockButton } from '@/components/editor/AddBlockButton'
import { BlockTree } from '@/components/editor/BlockTree'
import { EditModeSwitch } from '@/components/pages/EditModeSwitch'
import { PageModeSlot } from '@/editor/page-mode/PageModeSlot'
import { usePageMode } from '@/editor/page-mode/use-page-mode'
import { useScrollToFocus } from '@/hooks/useScrollToFocus'
import type { NavigateToPageFn } from '@/lib/block-events'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'

interface DayPageEditorProps {
  pageId: string
  /** The day's own actions, on the row the switch ends. */
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
  const pageMode = usePageMode(pageId)

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
      {(actions != null || pageMode.available) && (
        <div className="flex items-center gap-2 mb-2">
          {actions}
          {pageMode.available && (
            <div className="ml-auto">
              <EditModeSwitch
                mode={pageMode.mode}
                onChange={pageMode.changeMode}
                blocked={pageMode.blocked}
              />
            </div>
          )}
        </div>
      )}
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
