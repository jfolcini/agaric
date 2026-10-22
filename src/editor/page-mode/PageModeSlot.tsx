/**
 * PageModeSlot — where `PageEditor` or `DayPageEditor` shows page mode (#5691): the editor,
 * loaded on first use so TipTap stays off the startup path.
 */

import type React from 'react'
import { lazy, Suspense } from 'react'

import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import type { PageModeState } from '@/editor/page-mode/use-page-mode'
import type { NavigateToPageFn } from '@/lib/block-events'

const LazyPageModeEditor = lazy(() =>
  import('@/editor/page-mode/PageModeEditor').then((m) => ({ default: m.PageModeEditor })),
)

export interface PageModeSlotProps {
  pageId: string
  /** False until the page is known to be editable (not a tag's page). */
  ready: boolean
  onBlocked: PageModeState['onBlocked']
  editorRef: PageModeState['editorRef']
  opening: PageModeState['opening']
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function PageModeSlot({
  pageId,
  ready,
  onBlocked,
  editorRef,
  opening,
  onNavigateToPage,
}: PageModeSlotProps): React.ReactElement {
  const loading = <LoadingSkeleton count={3} />
  if (!ready) return loading
  return (
    <Suspense fallback={loading}>
      <LazyPageModeEditor
        key={pageId}
        pageId={pageId}
        onBlocked={onBlocked}
        onNavigateToPage={onNavigateToPage}
        opening={opening}
        ref={editorRef}
      />
    </Suspense>
  )
}
