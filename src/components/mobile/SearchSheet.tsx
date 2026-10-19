/**
 * SearchSheet — unified mobile search sheet.
 *
 * Single touch entry point that collapses three desktop search
 * surfaces (Ctrl+F in-page find, Cmd+K palette, Ctrl+Shift+F
 * find-in-files) into one Sheet with two segments. The `'in-page'`
 * segment embeds `<InPageFind variant="embedded" />`; `'all-pages'`
 * embeds `<PaletteBody>`. Mutual exclusion with the desktop overlays
 * is enforced by App.tsx — the leaves themselves stay decoupled.
 *
 * Lifecycle (seed-on-entry, mirror-on-keystroke, close-only-what-we-
 * opened, container-repop reopen) lives in `useSearchSheetBridge`,
 * unit-testable in isolation.
 */

import { FileSearch, Pin } from 'lucide-react'
import { Suspense, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLongPress } from '@/hooks/useLongPress'
import { usePullToDismiss } from '@/hooks/usePullToDismiss'
import { useSearchSheetBridge } from '@/hooks/useSearchSheetBridge'
import { haptic } from '@/lib/haptics'
import { lazyWithPreload } from '@/lib/lazy-with-preload'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  clearPinnedSearchScope,
  getPinnedSearchScope,
  setPinnedSearchScope,
} from '@/lib/pinned-search-scope'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useInPageFindStore } from '@/stores/useInPageFindStore'
import { type SearchSheetMode, useSearchSheetStore } from '@/stores/useSearchSheetStore'

// The in-page-find toolbar and the palette body are both lazy-imported
// at the App level for their overlay surfaces. Importing them here
// reuses the same chunks — the module loader memoises by module identifier.
const InPageFind = lazyWithPreload(() =>
  import('@/components/query/InPageFind').then((m) => ({ default: m.InPageFind })),
)
const PaletteBody = lazyWithPreload(() =>
  import('@/components/common/CommandPalette').then((m) => ({ default: m.PaletteBody })),
)
// This module loads at idle with the App-level overlays, so the sheet's first
// open finds its segment loaded and does not suspend on it.
for (const segment of [InPageFind, PaletteBody]) {
  segment.preload().catch((err: unknown) => {
    logger.warn('SearchSheet', 'search segment preload failed', undefined, err)
  })
}

export function SearchSheet(): React.ReactElement | null {
  const { t } = useTranslation()
  const { open, mode, close, setMode } = useSearchSheetStore(
    useShallow((s) => ({
      open: s.open,
      mode: s.mode,
      close: s.close,
      setMode: s.setMode,
    })),
  )
  // `useInPageFindStore.container` is `null` whenever no page surface
  // is registered (Pages list, Trash, Settings, etc.). The body
  // branches on it: empty-state when null, embedded toolbar otherwise.
  const inPageContainer = useInPageFindStore((s) => s.container)
  // The embedded palette's action menu owns Escape — its keydown
  // handler closes the menu, not the whole sheet. Bridge the ref
  // through `<SheetContent onEscapeKeyDown>` (same pattern the
  // overlay `CommandPalette` uses for its Dialog wrapper).
  const actionMenuOpenRef = useRef(false)

  // #135 — the currently-pinned default scope (localStorage), used to
  // badge the matching segment and to toggle on long-press. Tracked in
  // component state so the badge updates immediately after a pin without
  // a remount. Seeded from storage on first render.
  const [pinnedScope, setPinnedScope] = useState<SearchSheetMode | null>(() =>
    getPinnedSearchScope(),
  )

  useSearchSheetBridge(open, mode)

  // #133 — pull-to-dismiss wired to the grab handle only (declared
  // before the early return so hook order stays stable; harmless when
  // the sheet is closed).
  const { dragY, dragging, handlers: dragHandlers } = usePullToDismiss({ onDismiss: () => close() })

  // #135 — long-press a scope segment to pin/unpin it as the default.
  // Toggling: long-pressing the already-pinned scope clears the pin.
  const pinScope = (scope: SearchSheetMode) => {
    haptic('tick')
    if (pinnedScope === scope) {
      clearPinnedSearchScope()
      setPinnedScope(null)
      notify.success(t('searchSheet.scopeUnpinned'))
      return
    }
    setPinnedSearchScope(scope)
    setPinnedScope(scope)
    const label =
      scope === 'in-page' ? t('searchSheet.segmentInPage') : t('searchSheet.segmentAllPages')
    notify.success(t('searchSheet.scopePinned', { scope: label }))
  }

  const inPagePinHandlers = useLongPress({ onLongPress: () => pinScope('in-page') })
  const allPagesPinHandlers = useLongPress({ onLongPress: () => pinScope('all-pages') })

  if (!open) return null

  const handleOpenChange = (next: boolean) => {
    if (!next) close()
  }

  // ToggleGroup's `onValueChange` may fire with `''` when the user
  // taps the active item — single-select toggle groups can de-select.
  // Ignore that case so the sheet always has an active segment.
  const handleSegmentChange = (next: string) => {
    if (next === 'in-page' || next === 'all-pages') {
      setMode(next satisfies SearchSheetMode)
    }
  }

  // `onClose` for the embedded palette — closes both stores so the
  // existing `escalate()` flow (setPendingViewQuery → onClose →
  // setView('search')) tears down the sheet en route to the search
  // view.
  const handlePaletteClose = () => {
    useCommandPaletteStore.getState().close()
    close()
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        // Deliberately lower than SheetContent's shared viewport-minus-2rem
        // cap: 90dvh keeps the page partially visible for the in-page
        // highlight pipeline, including while the iOS keyboard is open.
        className="max-h-[90dvh]"
        // Suppress Radix's default first-focus — both embedded
        // surfaces auto-focus their own inputs.
        onOpenAutoFocus={(e: Event) => e.preventDefault()}
        // Preserve action-menu Escape semantics for the embedded
        // palette: when the menu is open, Escape goes to the menu,
        // not the sheet.
        onEscapeKeyDown={(e: KeyboardEvent) => {
          if (actionMenuOpenRef.current) e.preventDefault()
        }}
        data-testid="search-sheet"
        // #133 — translate the sheet under the finger during a
        // pull-to-dismiss drag (rubber-band feel); spring back via a
        // transition when the gesture ends below threshold.
        style={
          dragY > 0
            ? { transform: `translateY(${dragY}px)`, transition: dragging ? 'none' : undefined }
            : undefined
        }
      >
        {/* #133 — grab handle. The ONLY pull-to-dismiss initiator: a
            downward drag here closes the sheet, while the scrollable
            body below keeps its native scroll. `touch-none` stops the
            browser claiming the gesture for scroll/zoom so the pointer
            stream reaches our handlers. 44 px tall for the thumb, with
            negative margins so the visible bar keeps its place. */}
        <button
          type="button"
          {...dragHandlers}
          tabIndex={-1}
          aria-label={t('searchSheet.dragHandleLabel')}
          data-testid="search-sheet-drag-handle"
          className="mx-auto -mt-5 -mb-2 flex h-11 w-full max-w-[8rem] cursor-grab touch-none items-center justify-center"
        >
          <span aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
        </button>
        <SheetHeader>
          {/* The segment control directly below is the visible title;
              keeping a separate Sheet title would chew vertical space
              on a phone. Reserved for screen readers only. The Radix
              Sheet primitive requires a Description for axe-clean
              dialog semantics — point it at the segment-group's
              aria-label by reusing the same key. */}
          <SheetTitle className="sr-only">{t('searchSheet.title')}</SheetTitle>
          <SheetDescription className="sr-only">
            {t('searchSheet.dialogDescription')}
          </SheetDescription>
        </SheetHeader>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={handleSegmentChange}
          aria-label={t('searchSheet.title')}
          // Stretch the two segments edge-to-edge for thumb-friendly
          // touch targets; ToggleGroup defaults to inline-flex with
          // content-sized children.
          className="w-full"
        >
          <ToggleGroupItem
            value="in-page"
            aria-label={t('searchSheet.segmentInPage')}
            className="flex-1 gap-1.5"
            data-testid="search-sheet-segment-in-page"
            data-pinned={pinnedScope === 'in-page' ? 'true' : undefined}
            {...inPagePinHandlers}
          >
            {pinnedScope === 'in-page' && (
              <Pin
                aria-label={t('searchSheet.scopePinnedBadge')}
                className="size-3 shrink-0"
                fill="currentColor"
                data-testid="search-sheet-segment-in-page-pin"
              />
            )}
            {t('searchSheet.segmentInPage')}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="all-pages"
            aria-label={t('searchSheet.segmentAllPages')}
            className="flex-1 gap-1.5"
            data-testid="search-sheet-segment-all-pages"
            data-pinned={pinnedScope === 'all-pages' ? 'true' : undefined}
            {...allPagesPinHandlers}
          >
            {pinnedScope === 'all-pages' && (
              <Pin
                aria-label={t('searchSheet.scopePinnedBadge')}
                className="size-3 shrink-0"
                fill="currentColor"
                data-testid="search-sheet-segment-all-pages-pin"
              />
            )}
            {t('searchSheet.segmentAllPages')}
          </ToggleGroupItem>
        </ToggleGroup>
        <SheetBody>
          {mode === 'in-page' ? (
            inPageContainer == null ? (
              <div
                className="flex flex-col items-center gap-3 py-8 text-center"
                data-testid="search-sheet-in-page-empty"
              >
                <FileSearch aria-hidden className="size-8 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">{t('searchSheet.emptyInPage')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMode('all-pages')}
                  data-testid="search-sheet-in-page-empty-switch"
                >
                  {t('searchSheet.emptyInPageSwitchCta')}
                </Button>
              </div>
            ) : (
              <Suspense fallback={null}>
                {/* `onCloseRequest` routes the toolbar's Escape to the
                    SHEET (not the find store). The
                    bridge's cleanup closes the find store as part of
                    the sheet-close transition. */}
                <InPageFind variant="embedded" onCloseRequest={close} />
              </Suspense>
            )
          ) : (
            // PaletteBody is the inner cmdk surface. The escalation
            // footer it renders runs `setPendingViewQuery → onClose →
            // setView('search')`; our `handlePaletteClose` closes the
            // sheet too.
            <Suspense fallback={null}>
              <PaletteBody onClose={handlePaletteClose} actionMenuOpenRef={actionMenuOpenRef} />
            </Suspense>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
