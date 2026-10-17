/**
 * PageModeSlot — where `PageEditor` shows page mode (#5691): the editor,
 * loaded on first use so TipTap stays off the startup path, or the notice
 * that keeps a page over the block cap in block mode.
 */

import type React from 'react'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import type { PageModeState } from '@/editor/page-mode/use-page-mode'

const LazyPageModeEditor = lazy(() =>
  import('@/editor/page-mode/PageModeEditor').then((m) => ({ default: m.PageModeEditor })),
)

export interface PageModeSlotProps {
  pageId: string
  /** False until the page is known to be editable (not a tag's page). */
  ready: boolean
  onOverCap: PageModeState['onOverCap']
  editorRef: PageModeState['editorRef']
}

export function PageModeSlot({
  pageId,
  ready,
  onOverCap,
  editorRef,
}: PageModeSlotProps): React.ReactElement {
  const loading = <LoadingSkeleton count={3} />
  if (!ready) return loading
  return (
    <Suspense fallback={loading}>
      <LazyPageModeEditor key={pageId} pageId={pageId} onOverCap={onOverCap} ref={editorRef} />
    </Suspense>
  )
}

export function PageModeOverCapNotice({
  overCap,
}: {
  overCap: PageModeState['overCap']
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (overCap === null) return null
  return (
    <output className="text-sm text-muted-foreground">
      {t('pageMode.overCap', { cap: overCap.cap, count: overCap.count })}
    </output>
  )
}
