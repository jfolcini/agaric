/**
 * ViewDispatcher — extracted from App.tsx (MAINT-124 step 4 / final).
 *
 * Owns:
 * - The `currentView`-based switch over view components (was the
 *   `ViewRouter` function in App.tsx).
 * - The `lazy()` imports for each top-level view component
 *   (Settings, Trash, etc.). `KeyboardShortcuts` and
 *   `WelcomeModal` stay lazy-imported in App.tsx because they render
 *   OUTSIDE this switch (top-level overlays).
 * - The shared `<ViewFallback>` Suspense skeleton.
 * - The view-related counter hook (`useTrashCount`) — polls its IPC
 *   every 30 s with refetch on focus / visibility change, identical
 *   to the original.
 * - `useHeaderLabel` — used by the App shell header, exported so
 *   App.tsx can keep its existing import.
 *
 * MAINT-124 step 4 — last of the four originally-planned extractions
 * (after `useAppKeyboardShortcuts`, `<AppSidebar>`, `useAppDialogs`).
 * This batch is a pure code move: behaviour is preserved verbatim.
 */

import { lazy, type ReactElement, Suspense, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemCount } from '../hooks/useItemCount'
import { countTrash } from '../lib/tauri'
import { useNavigationStore, type View } from '../stores/navigation'
import { useSpaceStore } from '../stores/space'
import { type PageEntry, selectPageStack, useTabsStore } from '../stores/tabs'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'
import { JournalPage } from './JournalPage'
import { LoadingSkeleton } from './LoadingSkeleton'
import { NAV_ITEMS } from './nav-items'

// ---------------------------------------------------------------------------
// Lazy-loaded views — PERF-24
// ---------------------------------------------------------------------------
//
// Only the journal (default view) and the sidebar/header shell are in the
// entry chunk. Every other top-level view is split into its own chunk and
// loaded on demand. Keeps the initial parse budget small — especially on
// Android / low-end hardware — without touching page-editor UX (the user
// always clicks _into_ a page, giving us a natural Suspense moment).
//
// Each lazy() import automatically becomes its own Rollup chunk. The
// Suspense fallback uses `LoadingSkeleton` (the shared primitive) so the
// transient state matches the rest of the app visually.
const GraphView = lazy(() => import('./GraphView').then((m) => ({ default: m.GraphView })))
const HistoryView = lazy(() => import('./HistoryView').then((m) => ({ default: m.HistoryView })))
const PageBrowser = lazy(() => import('./PageBrowser').then((m) => ({ default: m.PageBrowser })))
const PageEditor = lazy(() => import('./PageEditor').then((m) => ({ default: m.PageEditor })))
const SearchPanel = lazy(() => import('./SearchPanel').then((m) => ({ default: m.SearchPanel })))
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })))
const StatusPanel = lazy(() => import('./StatusPanel').then((m) => ({ default: m.StatusPanel })))
const TagFilterPanel = lazy(() =>
  import('./TagFilterPanel').then((m) => ({ default: m.TagFilterPanel })),
)
const TagList = lazy(() => import('./TagList').then((m) => ({ default: m.TagList })))
const TemplatesView = lazy(() =>
  import('./TemplatesView').then((m) => ({ default: m.TemplatesView })),
)
const TrashView = lazy(() => import('./TrashView').then((m) => ({ default: m.TrashView })))

/** Resolve the header label from the current navigation state. */
export function useHeaderLabel(): string {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  const pageStack = useTabsStore(selectPageStack)
  // page-editor has its own editable title — don't duplicate it in the header
  if (currentView === 'page-editor' && pageStack.length > 0) {
    return ''
  }
  const item = NAV_ITEMS.find((item) => item.id === currentView)
  return item ? t(item.labelKey) : ''
}

/** Returns the number of trashed items. Polls every 30 s and on focus. */
export function useTrashCount(): number {
  const currentView = useNavigationStore((s) => s.currentView)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-poll when view or space changes (user may have restored items / switched spaces)
  const queryFn = useCallback(
    () =>
      // `countTrash` pushes the count into SQL so the trash badge stays
      // accurate regardless of trash size. `?? ''` is the pre-bootstrap
      // no-match fallback (see `TrashView` / the `countTrash` wrapper).
      countTrash(currentSpaceId ?? ''),
    [currentView, currentSpaceId],
  )
  return useItemCount(queryFn, 30_000)
}

/** Signature used by views that want to open another page. */
export type PageSelectHandler = (pageId: string, title?: string, blockId?: string) => void

export interface ViewDispatcherProps {
  currentView: View
  activePage: PageEntry | null
  onPageSelect: PageSelectHandler
  navigateToPage: (pageId: string, title: string, blockId?: string) => void
}

/**
 * Shared Suspense fallback for lazy-loaded views. Matches the visual
 * language of other loading states (skeleton rows). `aria-busy` tells
 * assistive tech the region is mid-load.
 */
function ViewFallback(): ReactElement {
  return (
    <div className="space-y-2" aria-busy="true" role="status" data-testid="view-fallback">
      <LoadingSkeleton count={4} height="h-6" />
    </div>
  )
}

/**
 * Renders the main view body based on `currentView`. Extracted from `App`
 * so the parent component stays well under the cognitive-complexity budget
 * (MAINT-52). Each branch is a `FeatureErrorBoundary` so a crashed view
 * never unmounts the shell. Non-journal views are lazy-loaded (PERF-24);
 * the nested `Suspense` boundary shows a skeleton until the chunk arrives.
 */
export function ViewDispatcher({
  currentView,
  activePage,
  onPageSelect,
  navigateToPage,
}: ViewDispatcherProps): ReactElement | null {
  // PERF-19 (tier-3): `goBack` is consumed only by the `page-editor`
  // branch below — subscribing here instead of forwarding from App.tsx
  // removes one `useTabsStore` selector from the App shell. The action
  // reference is stable across renders, so the cost of subscribing at
  // this level is zero re-renders.
  const goBack = useTabsStore((s) => s.goBack)
  switch (currentView) {
    case 'journal':
      return (
        <FeatureErrorBoundary name="Journal">
          <JournalPage onNavigateToPage={onPageSelect} />
        </FeatureErrorBoundary>
      )
    case 'search':
      return (
        <FeatureErrorBoundary name="Search">
          <Suspense fallback={<ViewFallback />}>
            <SearchPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'pages':
      return (
        <FeatureErrorBoundary name="Pages">
          <Suspense fallback={<ViewFallback />}>
            <PageBrowser onPageSelect={onPageSelect} />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'tags':
      return (
        <FeatureErrorBoundary name="Tags">
          <Suspense fallback={<ViewFallback />}>
            <div className="space-y-8">
              <TagList onTagClick={(tagId, tagName) => navigateToPage(tagId, tagName)} />
              <div className="flex items-center gap-4">
                <div className="flex-1 border-t border-border" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Filter
                </span>
                <div className="flex-1 border-t border-border" />
              </div>
              <TagFilterPanel />
            </div>
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'trash':
      return (
        <FeatureErrorBoundary name="Trash">
          <Suspense fallback={<ViewFallback />}>
            <TrashView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'settings':
      return (
        <FeatureErrorBoundary name="Settings">
          <Suspense fallback={<ViewFallback />}>
            <SettingsView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'status':
      return (
        <FeatureErrorBoundary name="Status">
          <Suspense fallback={<ViewFallback />}>
            <StatusPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'history':
      return (
        <FeatureErrorBoundary name="History">
          <Suspense fallback={<ViewFallback />}>
            <HistoryView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'templates':
      return (
        <FeatureErrorBoundary name="Templates">
          <Suspense fallback={<ViewFallback />}>
            <TemplatesView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'graph':
      return (
        <FeatureErrorBoundary name="Graph">
          <Suspense fallback={<ViewFallback />}>
            <GraphView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'page-editor':
      if (!activePage) return null
      return (
        <FeatureErrorBoundary name="PageEditor">
          <Suspense fallback={<ViewFallback />}>
            <PageEditor
              pageId={activePage.pageId}
              title={activePage.title}
              onBack={goBack}
              onNavigateToPage={onPageSelect}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )
    default:
      return null
  }
}
