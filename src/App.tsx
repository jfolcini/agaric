import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { QuickAccessBar } from '@/components/layout/QuickAccessBar'
import { QuickCaptureFab } from '@/components/layout/QuickCaptureFab'
import { SpaceTopStripe } from '@/components/layout/SpaceTopStripe'
import { TabBar } from '@/components/layout/TabBar'
import {
  ViewHeaderOutletProvider,
  ViewHeaderOutletSlot,
} from '@/components/layout/ViewHeaderOutlet'
import { BootGate } from '@/components/pages/BootGate'
import { useHeaderLabel, ViewDispatcher } from '@/components/pages/ViewDispatcher'
import { notify } from '@/lib/notify'

import { GlobalDateControls, JournalControls } from './components/JournalPage'
import { SearchSheetTrigger } from './components/SearchSheetTrigger'
import { ScrollArea } from './components/ui/scroll-area'
import { SidebarInset, SidebarProvider } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { useAndroidBackButton } from './hooks/useAndroidBackButton'
import { useAppBootRecovery } from './hooks/useAppBootRecovery'
import { useAppDialogs } from './hooks/useAppDialogs'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useAppSpaceLifecycle } from './hooks/useAppSpaceLifecycle'
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter'
import { useIsMobile } from './hooks/useIsMobile'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { usePrimaryFocusRegistry } from './hooks/usePrimaryFocus'
import { useQuickCaptureShortcut } from './hooks/useQuickCaptureShortcut'
import { useScrollRestore } from './hooks/useScrollRestore'
import { useShouldShowMobileChrome } from './hooks/useShouldShowMobileChrome'
import { useSyncEvents } from './hooks/useSyncEvents'
import { useSyncTrigger } from './hooks/useSyncTrigger'
import { useTheme } from './hooks/useTheme'
import { useUndoShortcuts } from './hooks/useUndoShortcuts'
import { useUpdateCheck } from './hooks/useUpdateCheck'
import { announce } from './lib/announcer'
import { logger } from './lib/logger'
import { isOnboardingDone } from './lib/onboarding'
import { createPageInSpace, listPeerRefs } from './lib/tauri'
import { cn } from './lib/utils'
import { useNavigationStore } from './stores/navigation'
import { useResolveStore } from './stores/resolve'
import { useSpaceStore } from './stores/space'
import { selectPageStack, useTabsStore } from './stores/tabs'
import { useSearchSheetStore } from './stores/useSearchSheetStore'

// `KeyboardShortcuts` and `WelcomeModal` are top-level overlays mounted
// outside the view dispatcher; the rest of the lazy-loaded view chunks
// (PERF-24) and the shared `<ViewFallback>` Suspense skeleton live in
// `./components/ViewDispatcher` (MAINT-124 step 4).
const KeyboardShortcuts = lazy(() =>
  import('@/components/common/KeyboardShortcuts').then((m) => ({ default: m.KeyboardShortcuts })),
)
const WelcomeModal = lazy(() =>
  import('@/components/pages/WelcomeModal').then((m) => ({ default: m.WelcomeModal })),
)
// PERF (design-system review tier-2 #12): the three shell-level dialogs
// below are mounted unconditionally near the bottom of `App` but only
// render content when their `open` boolean flips true. Code-splitting
// them keeps `BugReportDialog → bug-report-zip.ts → jszip` (≈96 KB
// `export-graph` chunk), the `QuickCaptureDialog` editor surface, and
// the `NoPeersDialog` alert-dialog tree off the critical path until the
// user actually triggers each one. Each component is a named export so
// the dynamic-import re-export shape is required for `React.lazy`.
const BugReportDialog = lazy(() =>
  import('@/components/dialogs/BugReportDialog').then((m) => ({ default: m.BugReportDialog })),
)
const QuickCaptureDialog = lazy(() =>
  import('@/components/dialogs/QuickCaptureDialog').then((m) => ({
    default: m.QuickCaptureDialog,
  })),
)
const NoPeersDialog = lazy(() =>
  import('@/components/dialogs/NoPeersDialog').then((m) => ({ default: m.NoPeersDialog })),
)
// PEND-52 — in-page find toolbar; lazy so the matcher + highlight code
// only ships when the user actually opens it (Ctrl+F). It self-renders
// nothing when the store flag is closed, so the lazy boundary is also
// the rendering gate.
const InPageFind = lazy(() =>
  import('@/components/query/InPageFind').then((m) => ({ default: m.InPageFind })),
)
// PEND-61 — Cmd/Ctrl+K command palette (successor to PEND-51's
// SearchPalette). Same lazy-render-gate pattern: the component
// self-renders nothing when its `useCommandPaletteStore.open` flag
// is `false`.
const CommandPalette = lazy(() =>
  import('@/components/common/CommandPalette').then((m) => ({ default: m.CommandPalette })),
)
// Mobile unified search sheet. Same lazy-render-gate pattern as the
// overlays above: renders nothing when its store flag is closed.
// Mounted at App level so its sheet floats above every view. The
// header trigger (`<SearchSheetTrigger />`) is the touch-only entry
// point; keyboard users still go through Ctrl+F / Cmd+K / Ctrl+Shift+F.
const SearchSheet = lazy(() =>
  import('./components/SearchSheet').then((m) => ({ default: m.SearchSheet })),
)

function App() {
  const { t } = useTranslation()
  // PERF-19 (design-system perf review tier-3 #19) — App subscribes
  // ONLY to the routing / view-shell zustand slices it actually uses:
  //   • `currentView`      — drives view routing, header switch, viewKey,
  //                           and the focus-on-view-change effect.
  //   • `setView`          — used by `handleOpenSyncSettings`; also
  //                           forwarded to AppSidebar as `onSelectView`.
  //   • `navigateToPage`   — used by `handleNewPage` / `handlePageSelect`
  //                           and forwarded to ViewDispatcher.
  //   • `pageStack`        — derives `activePage` for both `viewKey` and
  //                           the ViewDispatcher page-editor branch.
  // Everything that the sidebar alone consumed (sync state, peers,
  // last-synced timestamp, space roster, current space id, trash badge)
  // is subscribed directly inside `AppSidebar` now — the leaf owns the
  // subscription. `goBack` lives inside `ViewDispatcher`, the sole
  // consumer of the back action. `setView` and `navigateToPage` are
  // stable zustand actions, so subscribing here is a zero-rerender cost.
  const currentView = useNavigationStore((s) => s.currentView)
  const setView = useNavigationStore((s) => s.setView)
  const setPendingSettingsTab = useNavigationStore((s) => s.setPendingSettingsTab)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const pageStack = useTabsStore(selectPageStack)
  const headerLabel = useHeaderLabel()
  const { theme: currentTheme, isDark, toggleTheme } = useTheme()
  const { syncing, syncAll } = useSyncTrigger()
  // Mutual-exclusion gates for the App-level search overlays. When
  // the mobile search sheet is showing a given segment it mounts the
  // same body inside its sheet, so the App-level overlay must hide
  // to avoid running the matcher / debounced IPC twice. Reading
  // sheet state here keeps the leaves (`InPageFind`, `CommandPalette`)
  // decoupled from the sheet. Boolean-name-as-action so the use site
  // reads `{!hideFindOverlay && <InPageFind />}` (positive guard).
  const hideFindOverlay = useSearchSheetStore((s) => s.open && s.mode === 'in-page')
  const hidePaletteOverlay = useSearchSheetStore((s) => s.open && s.mode === 'all-pages')
  const isOnline = useOnlineStatus()
  const isMobile = useIsMobile()
  const shouldShowMobileChrome = useShouldShowMobileChrome()
  // MAINT-124 step 3: shell-level dialog state (4 dialogs + their
  // event listeners) lives in `useAppDialogs`. The dialog JSX stays in
  // this file — the hook only owns the open/closed booleans, the
  // bug-report prefill payload, and the `BUG_REPORT_EVENT` /
  // `CLOSE_ALL_OVERLAYS_EVENT` listeners that drive them.
  const {
    bugReportOpen,
    setBugReportOpen,
    bugReportPrefill,
    setBugReportPrefill,
    quickCaptureOpen,
    setQuickCaptureOpen,
    showNoPeersDialog,
    setShowNoPeersDialog,
    shortcutsOpen,
    setShortcutsOpen,
  } = useAppDialogs()
  // #754 — first-run gate for the lazy `WelcomeModal`. Read once per
  // session: when onboarding is already done the modal (and its chunk)
  // never mounts; when it isn't, the modal owns its own open/dismiss
  // lifecycle after mount.
  const [showWelcome] = useState(() => !isOnboardingDone())
  const mainContentRef = useRef<HTMLDivElement | null>(null)
  // #754 — the scroll viewport as STATE (alongside the ref) so effects
  // that must re-run when the viewport mounts late (it only attaches
  // after the boot gate resolves) actually re-fire. `useScrollRestore`
  // consumes this; the ref alone never re-runs an effect, which left the
  // very first view without a scroll listener until the first navigation.
  const [mainContentEl, setMainContentEl] = useState<HTMLDivElement | null>(null)

  // The main content scroller is a `ScrollArea`; `mainContentRef` points at
  // the scrollable viewport. We need `id="main-content"` and `tabIndex=-1`
  // on that viewport so the skip link (`href="#main-content"`) and the
  // drag-to-auto-scroll logic in `BlockTree` (which does
  // `document.getElementById('main-content')`) operate on the real scroll
  // container, not a non-scrolling ancestor. A callback ref runs every
  // time the DOM node is attached, which is important because the viewport
  // only mounts after the boot gate resolves.
  const setMainContentViewport = useCallback((el: HTMLDivElement | null) => {
    mainContentRef.current = el
    setMainContentEl(el)
    if (el) {
      el.id = 'main-content'
      el.tabIndex = -1
    }
  }, [])

  // ── MAINT-124 step 4 (stretch): space-driven side-effects ─────────
  // Resolve-cache preload (FEAT-3p7), cross-space link enforcement
  // (FEAT-3p7) and visual identity (FEAT-3p10) — all driven by
  // `currentSpaceId` / `availableSpaces` — live in a single hook so
  // App.tsx no longer carries the inline `useEffect` clusters.
  useAppSpaceLifecycle()

  // ── MAINT-124 step 4 (stretch): mount-only IPC hydration ──────────
  // Boot recovery (orphan-draft flush) and the UX-201b priority-levels
  // hydrate the global state from Tauri once at app start. Both are
  // empty-deps effects with no React state coupling.
  useAppBootRecovery()

  // ── Desktop auto-update check (FEAT: updater wire-up) ─────────────
  // Fires at most once per 24 h to ask the Tauri updater plugin whether
  // a new release is available. Surfaces an "update available" sonner
  // toast with Install & restart + Later actions. Mobile is a no-op —
  // the Play Store / App Store own that distribution path. Empty-deps;
  // safe to slot adjacent to the other boot hooks.
  useUpdateCheck()

  // ── Android system back button (#716) ─────────────────────────────
  // Bridges hardware/gesture back into the in-app priority chain:
  // overlay-close → zoom-out → page-stack/view back → exit at root.
  // No-op on desktop and in browser dev (guards on Android + Tauri).
  useAndroidBackButton()

  // ── Focus main content when view changes ──────────────────────────
  // Each view can register its preferred primary-focus element (search
  // input, first list item, first block, etc.) via `useRegisterPrimaryFocus`.
  // We defer one rAF so the new view has mounted and registered its ref
  // before we attempt `focus()`; if nothing registered, fall back to the
  // generic main-content container.
  const focusRegistry = usePrimaryFocusRegistry()
  useEffect(() => {
    // Small delay to let the new view render before moving focus
    const id = requestAnimationFrame(() => {
      const focusedPrimary = focusRegistry?.focus() ?? false
      if (!focusedPrimary) {
        mainContentRef.current?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(id)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- currentView IS the trigger; focusRegistry is a provider-lifetime-stable ref-registry whose focus() reads live state, so omitting it cannot stale
  }, [currentView])

  // ── Op-level undo/redo shortcuts (Ctrl+Z / Ctrl+Y) ─────────────────
  useUndoShortcuts()

  // ── Sync event listeners (Tauri → store) ───────────────────────────
  useSyncEvents()

  // ── Deep-link router (FEAT-10) ─────────────────────────────────────
  // Listens for `deeplink:navigate-to-{block,page}` / `deeplink:open-settings`
  // events emitted by the Rust router and feeds them into the
  // navigation store / settings localStorage key.  Also backfills the
  // launch URL on mount (Linux / Windows deliver the deep-link as a
  // CLI argument BEFORE the React listener registers).  No-op outside
  // Tauri.
  useDeepLinkRouter()

  // ── App-level keyboard shortcuts (MAINT-124 step 1) ────────────────
  // All five in-app keydown listeners (journal, global, space,
  // close-overlays, tab) live inside `useAppKeyboardShortcuts`. The
  // FEAT-12 OS-level chord (`registerGlobalShortcut`) below stays here
  // because it interacts with Tauri APIs and the local
  // `quickCaptureChord` state.
  useAppKeyboardShortcuts({ t, isMobile })

  // ── FEAT-12: register the quick-capture global hotkey ─────────────
  // Chord state, the storage-event re-bind listener, and the SEQUENCED
  // register/unregister IPC chain live in `useQuickCaptureShortcut`
  // (#754 — extracted so StrictMode / HMR mount cycles can't interleave
  // the async register/unregister calls and leave the chord dead).
  useQuickCaptureShortcut(setQuickCaptureOpen)

  const handleNewPage = useCallback(async () => {
    // FEAT-3 Phase 2 — route through the atomic `createPageInSpace`
    // Tauri command (CreateBlock + SetProperty('space') in one tx).
    const { currentSpaceId, isReady } = useSpaceStore.getState()
    if (!isReady || currentSpaceId == null) {
      logger.warn('App', 'handleNewPage fired before space hydrated')
      notify.error(t('space.notReady'))
      return
    }
    try {
      const newId = await createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
      useResolveStore.getState().set(newId, 'Untitled', false)
      navigateToPage(newId, 'Untitled')
      announce(t('announce.newPageCreated'))
    } catch (err) {
      logger.error('App', 'Failed to create new page', undefined, err)
      notify.error(t('error.createPageFailed'))
    }
  }, [navigateToPage, t])

  const handlePageSelect = useCallback(
    (pageId: string, title?: string, blockId?: string) => {
      navigateToPage(pageId, title ?? 'Untitled', blockId)
    },
    [navigateToPage],
  )

  // BUG-2: sidebar Sync click guard. The hook itself short-circuits on
  // `peers.length === 0` silently (see useSyncTrigger.ts:113-117) — this
  // wrapper opens a discoverable dialog instead, with a CTA that
  // navigates the user to the Settings → Sync tab where pairing lives.
  //
  // Offline state is intentionally not handled here — the existing
  // `disabled={syncing || !isOnline}` on the button + the offline
  // tooltip already cover that case. This wrapper only fires when the
  // button is enabled (online + not currently syncing), so the only
  // remaining branch is "online but no peers".
  //
  // We swallow `listPeerRefs` failures to a `syncAll()` call: the hook
  // performs the same lookup itself and will surface a proper error
  // toast via its own try/catch, so we don't double-report here.
  const handleSyncClick = useCallback(async () => {
    let peers: Awaited<ReturnType<typeof listPeerRefs>>
    try {
      peers = await listPeerRefs()
    } catch (err) {
      logger.warn(
        'App',
        'listPeerRefs failed during sidebar sync click; falling through',
        undefined,
        err,
      )
      void syncAll()
      return
    }
    if (peers.length === 0) {
      setShowNoPeersDialog(true)
      return
    }
    void syncAll()
  }, [syncAll, setShowNoPeersDialog])

  // BUG-2: CTA handler for the NoPeersDialog. Pre-selects the Sync tab so
  // the user lands directly on the pairing UI without an extra click.
  // #734 — routes through the navigation store's pending-tab handoff slot
  // (which SettingsView subscribes to while mounted) instead of the
  // `?settings=sync` URL param: the param is only read in the useState
  // initializer, so the CTA was a no-op whenever Settings was already the
  // current view. SettingsView mirrors the consumed tab back into the URL
  // + localStorage itself.
  const handleOpenSyncSettings = useCallback(() => {
    setShowNoPeersDialog(false)
    setPendingSettingsTab('sync')
    setView('settings')
  }, [setView, setShowNoPeersDialog, setPendingSettingsTab])

  const activePage = pageStack.length > 0 ? pageStack[pageStack.length - 1] : null

  // ── View key for scroll restore + transition ──────────────────────
  const viewKey =
    currentView === 'page-editor' && activePage ? `page-editor:${activePage.pageId}` : currentView

  // ── Scroll position restoration ──────────────────────────────────
  // #754 — pass the viewport ELEMENT (state) so the hook attaches as
  // soon as the boot-gated viewport mounts, not on the first navigation.
  useScrollRestore(mainContentEl, viewKey)

  // ── View transition fade ─────────────────────────────────────────
  // Uses the "set state during render" pattern to synchronously hide
  // content when the view key changes, then fades in via CSS transition.
  const [prevViewKey, setPrevViewKey] = useState(viewKey)
  const [fadeVisible, setFadeVisible] = useState(true)

  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey)
    setFadeVisible(false)
  }

  useEffect(() => {
    if (!fadeVisible) {
      // Delay fade-in by 150ms to allow page content to load from SQLite
      // before the opacity transition begins, preventing CLS from skeleton
      // placeholders being replaced by actual content mid-fade (B-76).
      const id = setTimeout(() => {
        setFadeVisible(true)
      }, 150)
      return () => clearTimeout(id)
    }
    return undefined
  }, [fadeVisible])

  return (
    <BootGate>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        {t('accessibility.skipToMain')}
      </a>
      {/*
       * PEND-11 — full-width 3px accent stripe pinned to the top of
       * the viewport. Sits above the sidebar/content so it remains
       * visible regardless of sidebar state. Decorative; identity
       * is announced by the SpaceSwitcher / OS title.
       */}
      <SpaceTopStripe />
      <SidebarProvider>
        <AppSidebar
          currentView={currentView}
          onSelectView={setView}
          syncing={syncing}
          isOnline={isOnline}
          isDark={isDark}
          currentTheme={currentTheme}
          onToggleTheme={toggleTheme}
          onNewPage={handleNewPage}
          onSyncClick={handleSyncClick}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <SidebarInset>
          <ViewHeaderOutletProvider>
            <header className="flex min-h-14 shrink-0 flex-col sm:flex-row sm:items-center gap-2 border-b bg-background px-4 py-2 sm:py-0">
              {currentView === 'journal' ? (
                <JournalControls />
              ) : (
                <>
                  <span className="font-medium" data-testid="header-label">
                    {headerLabel}
                  </span>
                  <div className="flex-1" />
                  <GlobalDateControls />
                </>
              )}
              {/* Sole touch entry point for the unified search sheet.
                  Desktop hides the trigger entirely — keyboard users
                  open the underlying surfaces via Ctrl+F / Cmd+K /
                  Ctrl+Shift+F. Gating at this JSX level keeps the
                  component from re-rendering / re-subscribing on every
                  navigation change for desktop sessions.
                  PEND-68 — `useShouldShowMobileChrome()` widens the
                  gate from `< 768 px` to "phone OR (tablet AND no
                  hardware keyboard)" so iPad-portrait touch users get
                  the trigger while iPad-with-keyboard sessions still
                  get the desktop UI + Cmd+K. */}
              {shouldShowMobileChrome && <SearchSheetTrigger />}
            </header>
            {/*
             * FEAT-7: TabBar is hoisted out of the page-editor view router
             * case and rendered at shell level so tabs stay visible across
             * every sidebar destination (journal, pages, search, …). The
             * autohide guard on `tabs.length <= 1` and the desktop-only
             * mobile gate live inside the component itself.
             *
             * #735 — boundary so a TabBar render crash degrades to an
             * inline panel instead of bubbling to the root boundary and
             * blanking the entire app (same for every shell-chrome wrap
             * below: QuickAccessBar, the overlays, the dialogs, Toaster).
             */}
            <FeatureErrorBoundary name="Tab bar">
              <TabBar />
            </FeatureErrorBoundary>
            {/*
             * PEND-68 Part B (#83 recents-only): desktop-only quick-access
             * bar — the MRU recents scroller. The former destinations cluster
             * (Pages / Tags / Graph / Search) was removed (#83) as it
             * duplicated the left sidebar. Mounted between the hoisted TabBar
             * above and the ViewHeaderOutletSlot below. #927 f6: now renders on
             * mobile too — the recents strip is the mobile page-switch
             * affordance (TabBar is desktop-only, no bottom-nav). Returns null
             * only when there are no recents.
             */}
            <FeatureErrorBoundary name="Quick access">
              <QuickAccessBar />
            </FeatureErrorBoundary>
            {/*
             * UX-198: view-level sticky headers didn't stick because the
             * nearest scroll ancestor was the <ScrollArea> viewport below,
             * not the view component. Hoisting the headers to an outlet
             * that lives _outside_ the scroll container lets them stay
             * visible as the view scrolls, without relying on sticky
             * positioning at all.
             */}
            <ViewHeaderOutletSlot className="border-b border-border/40 px-4 md:px-6 py-3 space-y-2" />
            <ScrollArea
              viewportRef={setMainContentViewport}
              className="flex-1"
              // UX-225: re-apply the bottom safe-area inset to the scroll
              // viewport so the last block of a long scroll doesn't sit
              // under the iPhone home indicator / Android gesture bar.
              // `scroll-pb-[env(…)]` extends the scroll end so keyboard
              // scroll-into-view stops short of the inset as well.
              viewportClassName="p-4 md:p-6 focus-ring-visible pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] scroll-pb-[env(safe-area-inset-bottom)]"
              data-slot="main-content"
            >
              <div
                className={cn(
                  'flex flex-1 min-h-0 flex-col',
                  fadeVisible
                    ? 'opacity-100 transition-opacity duration-normal ease-smooth'
                    : 'opacity-0',
                )}
                data-testid="view-transition-wrapper"
              >
                <ViewDispatcher
                  currentView={currentView}
                  activePage={activePage ?? null}
                  onPageSelect={handlePageSelect}
                  navigateToPage={navigateToPage}
                />
              </div>
            </ScrollArea>
          </ViewHeaderOutletProvider>
        </SidebarInset>
      </SidebarProvider>
      {/* In-page find toolbar — mounted at App level so the overlay
          floats above every view without each view having to
          participate. Self-renders nothing when its store flag is
          closed; the keyboard handler in `useAppKeyboardShortcuts`
          flips it. Yields to the mobile sheet when the sheet is
          showing its in-page segment — the sheet mounts the same
          toolbar inside its body. */}
      {!hideFindOverlay && (
        <FeatureErrorBoundary name="Find in page">
          <Suspense fallback={null}>
            <InPageFind />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/* Cmd/Ctrl+K command palette — same overlay shape, same yield
          rule for the sheet's all-pages segment. */}
      {!hidePaletteOverlay && (
        <FeatureErrorBoundary name="Command palette">
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/* Mobile unified search sheet — opened via the header trigger
          on mobile viewports. Mounts the InPageFind toolbar or
          PaletteBody inside its body depending on the active segment. */}
      <FeatureErrorBoundary name="Search sheet">
        <Suspense fallback={null}>
          <SearchSheet />
        </Suspense>
      </FeatureErrorBoundary>
      {/* #754 — both overlays are gate-mounted so their lazy chunks stay
          off the boot path. The `?` / sidebar-button open path lives in
          `useAppDialogs` (the sheet can't open itself while unmounted);
          the welcome gate reads the onboarding flag once per session. */}
      {shortcutsOpen && (
        <FeatureErrorBoundary name="Keyboard shortcuts">
          <Suspense fallback={null}>
            <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {showWelcome && (
        <FeatureErrorBoundary name="Welcome">
          <Suspense fallback={null}>
            <WelcomeModal />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/*
       * UX-279: top-level BugReportDialog driven by `BUG_REPORT_EVENT`.
       * `initialTitle` / `initialDescription` are conditionally spread so
       * the dialog only sees them once a prefill payload exists, keeping
       * `exactOptionalPropertyTypes` happy.
       *
       * PERF (design-system review tier-2 #12): gated on `bugReportOpen`
       * and wrapped in `<Suspense fallback={null}>` so the jszip-heavy
       * `export-graph` chunk only loads when the user actually opens the
       * dialog. `useAppDialogs` sets the prefill payload *before*
       * flipping `bugReportOpen=true`, so by the time the gate evaluates
       * truthy the prefill is already in place.
       */}
      {bugReportOpen && (
        <FeatureErrorBoundary name="Bug report">
          <Suspense fallback={null}>
            <BugReportDialog
              open={bugReportOpen}
              onOpenChange={(open) => {
                setBugReportOpen(open)
                if (!open) setBugReportPrefill(null)
              }}
              {...(bugReportPrefill != null
                ? {
                    initialTitle: bugReportPrefill.message,
                    initialDescription: bugReportPrefill.stack ?? '',
                  }
                : {})}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/* #920: mobile/touch entry point for quick-capture. The OS chord
          (`useQuickCaptureShortcut`) is a no-op on phones, so this FAB is
          the only reachable way to open the dialog there. Reuses the same
          `setQuickCaptureOpen` setter; self-gates on
          `useShouldShowMobileChrome()` and renders nothing on desktop. */}
      <FeatureErrorBoundary name="Quick capture button">
        <QuickCaptureFab setQuickCaptureOpen={setQuickCaptureOpen} />
      </FeatureErrorBoundary>
      {/* FEAT-12: Quick-capture dialog — driven by the global hotkey
          registered in App's startup effect. Gated on `quickCaptureOpen`
          + lazy-loaded so the editor surface stays off the critical path
          until the chord fires. */}
      {quickCaptureOpen && (
        <FeatureErrorBoundary name="Quick capture">
          <Suspense fallback={null}>
            <QuickCaptureDialog open={quickCaptureOpen} onOpenChange={setQuickCaptureOpen} />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/* BUG-2: shell-level dialog opened by the sidebar Sync button when
          there are zero paired peers. Replaces the silent
          `peers.length === 0` no-op with a discoverable affordance that
          links the user to the pairing flow. Lazy + Suspense so the
          alert-dialog tree only ships once the no-peers branch fires. */}
      {showNoPeersDialog && (
        <FeatureErrorBoundary name="Sync setup">
          <Suspense fallback={null}>
            <NoPeersDialog
              open={showNoPeersDialog}
              onOpenChange={setShowNoPeersDialog}
              onOpenSettings={handleOpenSyncSettings}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {/* #754 — sonner defaults `theme` to 'light', so without the prop
          `richColors` toasts rendered the light palette in dark themes.
          #733 — `isDark` comes from the now-module-level theme store, so
          a Settings theme change reaches the toaster without a reload. */}
      <FeatureErrorBoundary name="Notifications">
        <Toaster
          position={isMobile ? 'top-center' : 'bottom-right'}
          theme={isDark ? 'dark' : 'light'}
          richColors
          closeButton
        />
      </FeatureErrorBoundary>
    </BootGate>
  )
}

export { App }
