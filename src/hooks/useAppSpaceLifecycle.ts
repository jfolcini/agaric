/**
 * useAppSpaceLifecycle — space-driven side-effects extracted from
 * App.tsx (stretch).
 *
 * Four effects, each retained as a separate `useEffect` to preserve
 * the decoupling that the original App.tsx comments call out:
 *
 * 1. Resolve cache preload — preload pages + tags for the
 *    current space whenever `currentSpaceId` changes. Boot races
 *    between this effect and `refreshAvailableSpaces()` are tolerated
 *    — the first pass may run with `currentSpaceId == null` and a
 *    second pass runs once the space store hydrates.
 * 2. Cross-space link enforcement — on space switch, flush
 *    every resolve-cache entry keyed under the previous space, so a
 *    chip whose ULID belongs to the previous space cannot silently
 *    navigate the user across the space boundary on click.
 * 3. Visual identity — re-bind the `--accent-current` CSS
 *    variable on `document.documentElement` and re-stamp the OS
 *    window title. #2944 — the title now also reflects the active
 *    view (and open page name when in page-editor view), e.g.
 *    `"<Page/View> · <SpaceName> · Agaric"`, reactive to view/page
 *    changes as well as space changes. `setWindowTitle` no-ops
 *    outside Tauri (vitest jsdom).
 * 4. Once the spaces load, delete their retired text journal
 *    templates (#5373) — once per session, and done for good once
 *    the device records it.
 *
 * The hook subscribes internally to `useSpaceStore` for the space
 * inputs (App.tsx already subscribes for AppSidebar; the redundant
 * Zustand subscription is cheap and dedups), and to `useNavigationStore`
 * / `useTabsStore` for the view/page inputs.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'
import { NAV_ITEMS } from '@/lib/nav-items'
import { setWindowTitle } from '@/lib/platform/window'
import { deleteSpaceTextJournalTemplates } from '@/lib/template-utils'
import { useNavigationStore } from '@/stores/navigation'
import { retitleHeldPages } from '@/stores/page-rename'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

export function useAppSpaceLifecycle(): void {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const currentView = useNavigationStore((s) => s.currentView)
  const pageStack = useTabsStore(selectPageStack)

  // Preload the resolve cache (pages + tags) once on app boot, and
  // Again whenever the active space changes. #5277 — then retitle the
  // space's tabs and recents from it: a rename that synced in, or came from
  // an MCP agent, while another space was active never reached them.
  useEffect(() => {
    if (currentSpaceId == null) return
    // `preload` catches its scan failures internally; never rejects.
    void useResolveStore
      .getState()
      .preload(currentSpaceId)
      .then(() => {
        retitleHeldPages(null, currentSpaceId)
      })
      .catch((err: unknown) => {
        logger.warn('useAppSpaceLifecycle', 'retitling tabs and recents failed', undefined, err)
      })
  }, [currentSpaceId])

  // Cross-space link enforcement. Order matters: read
  // `prevSpaceIdRef.current` BEFORE touching anything so we know which
  // prefix to flush, then update the ref so the next switch sees the
  // now-current space as the next "previous". Kept in its own effect
  // (separate from the visual-identity effect below) so the two
  // concerns stay decoupled. (#753 — the dead `pagesList` mirror that
  // was also flushed here is gone; the picker's short-query cache is
  // the hook-local `pagesListRef` in `useBlockResolve`.)
  const prevSpaceIdRef = useRef<string | null>(currentSpaceId)
  useEffect(() => {
    const prev = prevSpaceIdRef.current
    if (prev != null && prev !== currentSpaceId) {
      useResolveStore.getState().clearAllForSpace(prev)
    }
    prevSpaceIdRef.current = currentSpaceId
  }, [currentSpaceId])

  // The space list is replaced on every refresh; a second run while the first
  // is in flight would append a duplicate delete op for each space.
  const textJournalTemplateCleanupStartedRef = useRef(false)
  useEffect(() => {
    if (availableSpaces.length === 0 || textJournalTemplateCleanupStartedRef.current) return
    textJournalTemplateCleanupStartedRef.current = true
    void deleteSpaceTextJournalTemplates(availableSpaces.map((space) => space.id))
  }, [availableSpaces])

  // Visual identity. Kept in its own effect (not folded
  // into the cache-flush effect above) so the two concerns stay
  // decoupled. `setWindowTitle` is a no-op in non-Tauri runtimes
  // (vitest jsdom, storybook).
  useEffect(() => {
    const accentToken = useSpaceStore.getState().getCurrentAccent()
    document.documentElement.style.setProperty('--accent-current', `var(--${accentToken})`)

    const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId) ?? null
    // #2944 \u2014 no active space yet (fresh boot before the space store
    // hydrates) keeps the original bare-Agaric title: there's no space to
    // qualify the view/page label against.
    if (activeSpace == null || activeSpace.name === '') {
      void setWindowTitle('Agaric')
      return
    }

    // #2944 \u2014 page-editor has its own open page instead of a static nav
    // label (mirrors `useHeaderLabel`'s branch in ViewDispatcher.tsx); every
    // other view resolves its localized nav label from the same `NAV_ITEMS`
    // manifest the sidebar renders from, so the title always agrees with
    // what's on screen.
    const activePage = pageStack.length > 0 ? pageStack.at(-1) : null
    let viewLabel: string | null = null
    if (currentView === 'page-editor' && activePage != null) {
      viewLabel = activePage.title
    } else {
      const navItem = NAV_ITEMS.find((item) => item.id === currentView)
      viewLabel = navItem ? t(navItem.labelKey) : null
    }

    const titleText =
      viewLabel != null && viewLabel !== ''
        ? `${viewLabel} \u00B7 ${activeSpace.name} \u00B7 Agaric`
        : `${activeSpace.name} \u00B7 Agaric`
    void setWindowTitle(titleText)
  }, [currentSpaceId, availableSpaces, currentView, pageStack, t])
}
