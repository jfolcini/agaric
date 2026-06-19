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

import { EmptyState } from '@/components/common/EmptyState'
import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { NAV_ITEMS } from '@/components/common/nav-items'
import { JournalPage } from '@/components/JournalPage'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { useItemCount } from '@/hooks/useItemCount'
import { countTrash } from '@/lib/tauri'
import { useNavigationStore, type View } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { type PageEntry, selectPageStack, useTabsStore } from '@/stores/tabs'

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
const AdvancedQueryView = lazy(() =>
  import('@/components/AdvancedQuery/AdvancedQueryView').then((m) => ({
    default: m.AdvancedQueryView,
  })),
)
const GraphView = lazy(() =>
  import('@/components/graph/GraphView').then((m) => ({ default: m.GraphView })),
)
const HistoryView = lazy(() =>
  import('@/components/history/HistoryView').then((m) => ({ default: m.HistoryView })),
)
const PageBrowser = lazy(() =>
  import('@/components/PageBrowser').then((m) => ({ default: m.PageBrowser })),
)
const PageEditor = lazy(() => import('./PageEditor').then((m) => ({ default: m.PageEditor })))
const SearchPanel = lazy(() =>
  import('@/components/SearchPanel').then((m) => ({ default: m.SearchPanel })),
)
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })))
const StatusPanel = lazy(() =>
  import('@/components/agenda/StatusPanel').then((m) => ({ default: m.StatusPanel })),
)
const TagsView = lazy(() => import('@/components/TagsView').then((m) => ({ default: m.TagsView })))
const TemplatesView = lazy(() =>
  import('@/components/templates/TemplatesView').then((m) => ({ default: m.TemplatesView })),
)
const TrashView = lazy(() =>
  import('@/components/TrashView').then((m) => ({ default: m.TrashView })),
)

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
  const queryFn = useCallback(
    () =>
      // `countTrash` pushes the count into SQL so the trash badge stays
      // accurate regardless of trash size. `?? ''` is the pre-bootstrap
      // no-match fallback (see `TrashView` / the `countTrash` wrapper).
      countTrash(currentSpaceId ?? ''),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-poll when view or space changes (user may have restored items / switched spaces)
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
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level skeleton fallback; native <output> is display:inline and would collapse the space-y-2 vertical layout
    <div className="space-y-2" aria-busy="true" role="status" data-testid="view-fallback">
      <LoadingSkeleton count={4} height="h-6" />
    </div>
  )
}

/**
 * Recoverable fallback rendered when a routed view has nothing valid to
 * paint: the `page-editor` branch with a null `activePage` (#1723), and the
 * exhaustive `default` branch (#1577 — an unknown/unhandled `View`). Both
 * formerly `return null`, which silently painted a blank content region.
 *
 * Renders the shared `EmptyState` with a CTA that navigates back to the
 * Journal (which always has a today/daily fallback), reusing the existing
 * `pageEditor.empty.*` copy so no new pattern is introduced.
 */
function JournalFallback(): ReactElement {
  const { t } = useTranslation()
  const setView = useNavigationStore((s) => s.setView)
  return (
    <FeatureErrorBoundary name="PageEditor" nameKey="errorBoundary.section.pageEditor">
      <EmptyState
        message={t('pageEditor.empty.message')}
        description={t('pageEditor.empty.description')}
        action={
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 mx-auto flex items-center gap-1"
            onClick={() => setView('journal')}
          >
            {t('pageEditor.empty.goToJournal')}
          </Button>
        }
      />
    </FeatureErrorBoundary>
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
}: ViewDispatcherProps): ReactElement {
  // PERF-19 (tier-3): `goBack` is consumed only by the `page-editor`
  // branch below — subscribing here instead of forwarding from App.tsx
  // removes one `useTabsStore` selector from the App shell. The action
  // reference is stable across renders, so the cost of subscribing at
  // this level is zero re-renders.
  const goBack = useTabsStore((s) => s.goBack)
  switch (currentView) {
    case 'journal':
      return (
        <FeatureErrorBoundary name="Journal" nameKey="sidebar.journal">
          <JournalPage onNavigateToPage={onPageSelect} />
        </FeatureErrorBoundary>
      )
    case 'search':
      return (
        <FeatureErrorBoundary name="Search" nameKey="sidebar.search">
          <Suspense fallback={<ViewFallback />}>
            <SearchPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'pages':
      return (
        <FeatureErrorBoundary name="Pages" nameKey="sidebar.pages">
          <Suspense fallback={<ViewFallback />}>
            <PageBrowser onPageSelect={onPageSelect} />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'tags':
      return (
        <FeatureErrorBoundary name="Tags" nameKey="sidebar.tags">
          <Suspense fallback={<ViewFallback />}>
            <TagsView onTagClick={(tagId, tagName) => navigateToPage(tagId, tagName)} />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'trash':
      return (
        <FeatureErrorBoundary name="Trash" nameKey="sidebar.trash">
          <Suspense fallback={<ViewFallback />}>
            <TrashView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'settings':
      return (
        <FeatureErrorBoundary name="Settings" nameKey="sidebar.settings">
          <Suspense fallback={<ViewFallback />}>
            <SettingsView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'status':
      return (
        <FeatureErrorBoundary name="Status" nameKey="sidebar.status">
          <Suspense fallback={<ViewFallback />}>
            <StatusPanel />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'history':
      return (
        <FeatureErrorBoundary name="History" nameKey="sidebar.history">
          <Suspense fallback={<ViewFallback />}>
            <HistoryView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'templates':
      return (
        <FeatureErrorBoundary name="Templates" nameKey="sidebar.templates">
          <Suspense fallback={<ViewFallback />}>
            <TemplatesView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'graph':
      return (
        <FeatureErrorBoundary name="Graph" nameKey="sidebar.graph">
          <Suspense fallback={<ViewFallback />}>
            <GraphView />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'query':
      return (
        <FeatureErrorBoundary name="AdvancedQuery" nameKey="sidebar.query">
          <Suspense fallback={<ViewFallback />}>
            <AdvancedQueryView onNavigate={onPageSelect} />
          </Suspense>
        </FeatureErrorBoundary>
      )
    case 'page-editor':
      // #1723: a fresh-space switch can force currentView='page-editor'
      // while the empty tab list leaves activePage null. Returning null
      // here paints a blank content region (a routed view returning null
      // is a bug). Render an EmptyState with a CTA back to the Journal
      // (which always has a today/daily fallback) instead.
      if (!activePage) {
        return <JournalFallback />
      }
      return (
        <FeatureErrorBoundary name="PageEditor" nameKey="errorBoundary.section.pageEditor">
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
    default: {
      // #1577: make the switch exhaustive over the `View` union. If a new
      // `View` member is added without a dispatcher case, this assignment
      // becomes a COMPILE error (the value is no longer `never`), forcing a
      // case to be wired up. At runtime we still render a recoverable
      // fallback instead of `return null` (which painted a blank region).
      const _exhaustive: never = currentView
      void _exhaustive
      return <JournalFallback />
    }
  }
}
