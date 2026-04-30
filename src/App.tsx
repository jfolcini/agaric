import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AppSidebar } from './components/AppSidebar'
import { BootGate } from './components/BootGate'
import { BugReportDialog } from './components/BugReportDialog'
import { GlobalDateControls, JournalControls } from './components/JournalPage'
import { NoPeersDialog } from './components/NoPeersDialog'
import { QuickCaptureDialog } from './components/QuickCaptureDialog'
import { RecentPagesStrip } from './components/RecentPagesStrip'
import { TabBar } from './components/TabBar'
import { ScrollArea } from './components/ui/scroll-area'
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import {
  useConflictCount,
  useHeaderLabel,
  useTrashCount,
  ViewDispatcher,
} from './components/ViewDispatcher'
import { ViewHeaderOutletProvider, ViewHeaderOutletSlot } from './components/ViewHeaderOutlet'
import { useAppBootRecovery } from './hooks/useAppBootRecovery'
import { useAppDialogs } from './hooks/useAppDialogs'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useAppSpaceLifecycle } from './hooks/useAppSpaceLifecycle'
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter'
import { useIsMobile } from './hooks/useIsMobile'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { usePrimaryFocusRegistry } from './hooks/usePrimaryFocus'
import { useScrollRestore } from './hooks/useScrollRestore'
import { useSyncEvents } from './hooks/useSyncEvents'
import { useSyncTrigger } from './hooks/useSyncTrigger'
import { useTheme } from './hooks/useTheme'
import { useUndoShortcuts } from './hooks/useUndoShortcuts'
import { announce } from './lib/announcer'
import { logger } from './lib/logger'
import {
  loadQuickCaptureShortcut,
  QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
} from './lib/quick-capture-shortcut'
import {
  createPageInSpace,
  listPeerRefs,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
} from './lib/tauri'
import { setSettingsTabInUrl } from './lib/url-state'
import { cn } from './lib/utils'
import { selectPageStack, useNavigationStore } from './stores/navigation'
import { useResolveStore } from './stores/resolve'
import { useSpaceStore } from './stores/space'
import { useSyncStore } from './stores/sync'

// `KeyboardShortcuts` and `WelcomeModal` are top-level overlays mounted
// outside the view dispatcher; the rest of the lazy-loaded view chunks
// (PERF-24) and the shared `<ViewFallback>` Suspense skeleton live in
// `./components/ViewDispatcher` (MAINT-124 step 4).
const KeyboardShortcuts = lazy(() =>
  import('./components/KeyboardShortcuts').then((m) => ({ default: m.KeyboardShortcuts })),
)
const WelcomeModal = lazy(() =>
  import('./components/WelcomeModal').then((m) => ({ default: m.WelcomeModal })),
)

function App() {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  const setView = useNavigationStore((s) => s.setView)
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const goBack = useNavigationStore((s) => s.goBack)
  const pageStack = useNavigationStore(selectPageStack)
  const headerLabel = useHeaderLabel()
  const conflictCount = useConflictCount()
  const trashCount = useTrashCount()
  const { isDark, toggleTheme } = useTheme()
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  // FEAT-3 Phase 2 — subscribe to `currentSpaceId` so the
  // `clearPagesList` effect below re-runs whenever the active space
  // changes (e.g. the user picks a different space in `SpaceSwitcher`).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // FEAT-3p10 — subscribe to `availableSpaces` so the visual-identity
  // effect re-runs after `refreshAvailableSpaces()` finishes (boot
  // path: the persisted `currentSpaceId` is set BEFORE the IPC
  // resolves, so without this dep the title / accent stay stale until
  // the next user-driven space switch).
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const { syncing, syncAll } = useSyncTrigger()
  const isOnline = useOnlineStatus()
  const isMobile = useIsMobile()
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
  // FEAT-12: lift the chord into state so the registration effect
  // re-runs when SettingsView changes it. Lazy-init from localStorage
  // so we don't read on every render. The storage-event listener
  // below feeds new chords into this state.
  const [quickCaptureChord, setQuickCaptureChord] = useState<string>(loadQuickCaptureShortcut)
  const mainContentRef = useRef<HTMLDivElement | null>(null)

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

  // ── Focus main content when view changes ──────────────────────────
  // Each view can register its preferred primary-focus element (search
  // input, first list item, first block, etc.) via `useRegisterPrimaryFocus`.
  // We defer one rAF so the new view has mounted and registered its ref
  // before we attempt `focus()`; if nothing registered, fall back to the
  // generic main-content container.
  const focusRegistry = usePrimaryFocusRegistry()
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentView IS the trigger — we focus when the view changes
  useEffect(() => {
    // Small delay to let the new view render before moving focus
    const id = requestAnimationFrame(() => {
      const focusedPrimary = focusRegistry?.focus() ?? false
      if (!focusedPrimary) {
        mainContentRef.current?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(id)
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
  // Registers the user-configured chord (default Ctrl+Alt+N on Linux /
  // Windows, Cmd+Option+N on macOS) via `tauri-plugin-global-shortcut`.
  // When the chord fires the handler:
  //   1. Brings the window forward (unminimize + show + setFocus) so
  //      the dialog is visible even if the app was hidden / minimized.
  //   2. Opens `QuickCaptureDialog` via `setQuickCaptureOpen(true)`.
  //
  // The effect re-runs whenever the localStorage key changes (Settings
  // panel triggers a `storage`-event-style rerender by writing the new
  // chord). On unmount or re-bind, we unregister the previous chord so
  // we don't leak OS-level bindings across hot reloads.
  //
  // Desktop-only: `registerGlobalShortcut` itself short-circuits on
  // mobile, so there is no platform gate here.
  // Storage-event listener that updates the chord state, kept in its
  // own effect so it never tears down between chord-driven re-binds.
  // SettingsView writes the new chord to localStorage and dispatches
  // a synthetic storage event; we re-read and feed it into state.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== QUICK_CAPTURE_SHORTCUT_STORAGE_KEY) return
      const next = loadQuickCaptureShortcut()
      setQuickCaptureChord((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Register / re-register the global chord whenever it changes.
  // Cleanup unregisters the previous chord before the new one is
  // registered, so the OS only ever has one binding at a time.
  // Desktop-only: `registerGlobalShortcut` short-circuits on mobile.
  useEffect(() => {
    let active = true
    const accelerator = quickCaptureChord

    const handler = () => {
      // Best-effort window focus. The IPC failures here are non-fatal —
      // the dialog still opens; only the visibility / focus state may
      // be wrong if the user already closed the window manually.
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          const w = getCurrentWindow()
          // Order matters: unminimize before show before setFocus.
          if (await w.isMinimized().catch(() => false)) {
            await w
              .unminimize()
              .catch((err) =>
                logger.warn('App', 'window operation failed', { op: 'unminimize' }, err),
              )
          }
          await w
            .show()
            .catch((err) => logger.warn('App', 'window operation failed', { op: 'show' }, err))
          await w
            .setFocus()
            .catch((err) => logger.warn('App', 'window operation failed', { op: 'setFocus' }, err))
        } catch (err) {
          logger.warn('App', 'quick-capture window focus failed', undefined, err)
        }
      })()
      if (active) setQuickCaptureOpen(true)
    }

    registerGlobalShortcut(accelerator, handler).catch((err: unknown) => {
      logger.warn('App', 'failed to register quick-capture global shortcut', { accelerator }, err)
    })

    return () => {
      active = false
      unregisterGlobalShortcut(accelerator).catch((err: unknown) => {
        logger.warn(
          'App',
          'failed to unregister quick-capture global shortcut',
          { accelerator },
          err,
        )
      })
    }
  }, [quickCaptureChord, setQuickCaptureOpen])

  const handleNewPage = useCallback(async () => {
    // FEAT-3 Phase 2 — route through the atomic `createPageInSpace`
    // Tauri command (CreateBlock + SetProperty('space') in one tx).
    const { currentSpaceId, isReady } = useSpaceStore.getState()
    if (!isReady || currentSpaceId == null) {
      logger.warn('App', 'handleNewPage fired before space hydrated')
      toast.error(t('space.notReady'))
      return
    }
    try {
      const newId = await createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
      useResolveStore.getState().set(newId, 'Untitled', false)
      navigateToPage(newId, 'Untitled')
      announce(t('announce.newPageCreated'))
    } catch (err) {
      logger.error('App', 'Failed to create new page', undefined, err)
      toast.error(t('error.createPageFailed'))
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

  // BUG-2: CTA handler for the NoPeersDialog. Pre-selects the Sync tab
  // via the `?settings=sync` URL param mechanism (UX-276) — SettingsView
  // reads the param on mount in `readActiveTab()` so the user lands
  // directly on the pairing UI without an extra click.
  const handleOpenSyncSettings = useCallback(() => {
    setShowNoPeersDialog(false)
    setSettingsTabInUrl('sync')
    setView('settings')
  }, [setView, setShowNoPeersDialog])

  const activePage = pageStack.length > 0 ? pageStack[pageStack.length - 1] : null

  // ── View key for scroll restore + transition ──────────────────────
  const viewKey =
    currentView === 'page-editor' && activePage ? `page-editor:${activePage.pageId}` : currentView

  // ── Scroll position restoration ──────────────────────────────────
  useScrollRestore(mainContentRef, viewKey)

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
      <SidebarProvider>
        <AppSidebar
          currentView={currentView}
          onSelectView={setView}
          conflictCount={conflictCount}
          trashCount={trashCount}
          syncState={syncState}
          syncPeers={syncPeers}
          syncing={syncing}
          isOnline={isOnline}
          lastSyncedAt={lastSyncedAt}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onNewPage={handleNewPage}
          onSyncClick={handleSyncClick}
          onShowShortcuts={() => setShortcutsOpen(true)}
          availableSpaces={availableSpaces}
          currentSpaceId={currentSpaceId}
        />
        <SidebarInset>
          <ViewHeaderOutletProvider>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
              <SidebarTrigger className="md:hidden" />
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
            </header>
            {/*
             * FEAT-7: TabBar is hoisted out of the page-editor view router
             * case and rendered at shell level so tabs stay visible across
             * every sidebar destination (journal, pages, search, …). The
             * autohide guard on `tabs.length <= 1` and the desktop-only
             * mobile gate live inside the component itself.
             */}
            <TabBar />
            {/*
             * FEAT-9: desktop-only "Recently visited" chip strip, mounted
             * between the hoisted TabBar above and the ViewHeaderOutletSlot
             * below. Responsive grid auto-fits chips; auto-hides on mobile
             * and when the visible list is empty.
             */}
            <RecentPagesStrip />
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
              viewportClassName="p-4 md:p-6 outline-none pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] scroll-pb-[env(safe-area-inset-bottom)]"
              data-slot="main-content"
            >
              <div
                className={cn(
                  'flex flex-1 min-h-0 flex-col',
                  fadeVisible
                    ? 'opacity-100 transition-opacity duration-150 ease-out'
                    : 'opacity-0',
                )}
                data-testid="view-transition-wrapper"
              >
                <ViewDispatcher
                  currentView={currentView}
                  activePage={activePage ?? null}
                  onPageSelect={handlePageSelect}
                  onBack={goBack}
                  navigateToPage={navigateToPage}
                />
              </div>
            </ScrollArea>
          </ViewHeaderOutletProvider>
        </SidebarInset>
      </SidebarProvider>
      <Suspense fallback={null}>
        <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <WelcomeModal />
      </Suspense>
      {/*
       * UX-279: top-level BugReportDialog driven by `BUG_REPORT_EVENT`.
       * `initialTitle` / `initialDescription` are conditionally spread so
       * the dialog only sees them once a prefill payload exists, keeping
       * `exactOptionalPropertyTypes` happy.
       */}
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
      {/* FEAT-12: Quick-capture dialog — driven by the global hotkey
          registered in App's startup effect. Mounted unconditionally so
          the global shortcut handler can flip `open` instantly. */}
      <QuickCaptureDialog open={quickCaptureOpen} onOpenChange={setQuickCaptureOpen} />
      {/* BUG-2: shell-level dialog opened by the sidebar Sync button when
          there are zero paired peers. Replaces the silent
          `peers.length === 0` no-op with a discoverable affordance that
          links the user to the pairing flow. */}
      <NoPeersDialog
        open={showNoPeersDialog}
        onOpenChange={setShowNoPeersDialog}
        onOpenSettings={handleOpenSyncSettings}
      />
      <Toaster position="bottom-right" richColors closeButton />
    </BootGate>
  )
}

export { App }
