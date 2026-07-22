/**
 * Palette command registry (Phase 8).
 *
 * Extracted from `CommandPalette.tsx`'s in-component `useMemo` so the
 * registry is reachable from outside the palette body. Phase 8's
 * "run last command" global shortcut (`runLastCommand`, `Cmd+.`)
 * needs to execute a command by id without first mounting the
 * palette dialog; this module is that bridge.
 *
 * Each command keeps a single `run(ctx)` closure rather than a flat
 * action so the same spec works from both surfaces:
 *
 *   - From inside the palette: `onClose` closes the open dialog;
 *     `onEscalate` seeds `pendingViewQuery` and flips to the
 *     find-in-files view.
 *   - From outside the palette (global shortcut): `onClose` is a
 *     no-op; `onEscalate` does the same nav-store handoff (`open$`
 *     was never called, so there's nothing to close).
 *
 * Future phases (Phase 4 pinned recents, Phase 5 action menu) will
 * also read from `PALETTE_COMMANDS` rather than maintaining their
 * own copies.
 */

import {
  Activity,
  Calendar,
  CalendarCheck,
  Clock,
  Download,
  FilePlus2,
  FileSearch,
  FileText,
  Keyboard,
  LayoutTemplate,
  type LucideIcon,
  Network,
  PanelLeftIcon,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react'

import { announce } from '@/lib/announcer'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { SHOW_SHORTCUTS_EVENT, TOGGLE_SIDEBAR_EVENT } from '@/lib/overlay-events'
import { createPageInSpace, exportPageMarkdown } from '@/lib/tauri'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

export type PaletteCommandCategory = 'navigate' | 'action'

export interface PaletteCommandContext {
  /** Close the open palette. Pass a no-op when running from outside the palette. */
  onClose: () => void
  /** Escalate to the find-in-files view seeded with the given query. */
  onEscalate: (q: string) => void
}

export interface PaletteCommandSpec {
  /** Stable id used as cmdk `value`, recent-commands key, and lookup key. */
  id: string
  /** i18n key — the palette resolves this via `t()` before rendering. */
  labelKey: string
  category: PaletteCommandCategory
  /** Lucide glyph rendered as the leading row icon. */
  icon: LucideIcon
  /** Optional `keyboard-config/catalog.ts` id surfaced as an inline chord chip. */
  shortcutId?: string
  /** Side-effect for the command. Receives a context so the same spec works in/outside the palette. */
  run: (ctx: PaletteCommandContext) => void
}

// #2942 — the registry used to expose only 5 of the 11 `NAV_ITEMS`
// destinations (`nav-items.ts`). The `go-<view>` entries below now mirror
// every destination there EXCEPT `search`: `search-everywhere` below already
// routes to the search view (with the added value of seeding the escalation
// query), so a second plain `go-search` would just be a same-destination
// duplicate with a different label.
export const PALETTE_COMMANDS: readonly PaletteCommandSpec[] = [
  {
    id: 'go-journal',
    labelKey: 'palette.cmdGoJournal',
    category: 'navigate',
    icon: Calendar,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('journal')
      onClose()
    },
  },
  {
    id: 'go-pages',
    labelKey: 'palette.cmdGoPages',
    category: 'navigate',
    icon: FileText,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('pages')
      onClose()
    },
  },
  {
    id: 'go-tags',
    labelKey: 'palette.cmdGoTags',
    category: 'navigate',
    icon: TagIcon,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('tags')
      onClose()
    },
  },
  {
    id: 'go-graph',
    labelKey: 'palette.cmdGoGraph',
    category: 'navigate',
    icon: Network,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('graph')
      onClose()
    },
  },
  {
    id: 'go-templates',
    labelKey: 'palette.cmdGoTemplates',
    category: 'navigate',
    icon: LayoutTemplate,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('templates')
      onClose()
    },
  },
  {
    id: 'go-query',
    labelKey: 'palette.cmdGoQuery',
    category: 'navigate',
    icon: SlidersHorizontal,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('query')
      onClose()
    },
  },
  {
    id: 'go-status',
    labelKey: 'palette.cmdGoStatus',
    category: 'navigate',
    icon: Activity,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('status')
      onClose()
    },
  },
  {
    id: 'go-history',
    labelKey: 'palette.cmdGoHistory',
    category: 'navigate',
    icon: Clock,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('history')
      onClose()
    },
  },
  {
    id: 'go-trash',
    labelKey: 'palette.cmdGoTrash',
    category: 'navigate',
    icon: Trash2,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('trash')
      onClose()
    },
  },
  {
    id: 'go-settings',
    labelKey: 'palette.cmdGoSettings',
    category: 'navigate',
    icon: SettingsIcon,
    run: ({ onClose }) => {
      useNavigationStore.getState().setView('settings')
      onClose()
    },
  },
  {
    id: 'search-everywhere',
    labelKey: 'palette.cmdSearchEverywhere',
    category: 'action',
    icon: FileSearch,
    // Phase 1 — `focusSearch` is the find-in-files chord
    // (Ctrl+Shift+F by default). This command produces the same
    // outcome from the palette.
    shortcutId: 'focusSearch',
    run: ({ onEscalate }) => {
      // Escalate with an empty seed — SearchPanel mounts with its
      // input ready for the user to type, same as Ctrl+Shift+F.
      onEscalate('')
    },
  },
  {
    id: 'create-new-page',
    labelKey: 'palette.cmdCreateNewPage',
    category: 'action',
    icon: FilePlus2,
    // Mirrors `tryCreateNewPage` in `useAppKeyboardShortcuts.ts` (the
    // `createNewPage` chord, Ctrl+Alt+N by default) — same guard, same
    // resolve-cache seeding, same error handling, reachable from the
    // palette without an editor/shortcut route.
    shortcutId: 'createNewPage',
    run: ({ onClose }) => {
      onClose()
      const { currentSpaceId, isReady } = useSpaceStore.getState()
      if (!isReady || currentSpaceId == null) {
        notify.error(t('space.notReady'))
        return
      }
      createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
        .then((newId) => {
          useResolveStore.getState().set(newId, 'Untitled', false)
          useTabsStore.getState().navigateToPage(newId, 'Untitled')
          announce(t('announce.newPageCreated'))
        })
        .catch((err: unknown) => {
          logger.error('palette-commands', 'Failed to create page via palette', undefined, err)
          notify.error(t('error.createPageFailed'))
        })
    },
  },
  {
    id: 'go-to-today',
    labelKey: 'palette.cmdGoToToday',
    category: 'action',
    icon: CalendarCheck,
    // Mirrors the `goToToday` journal shortcut (Alt+T by default), plus
    // switching to the journal view first so the command works from any
    // view (the keyboard chord only fires while already in journal).
    //
    // Announce guard (#2944): only announce `jumpedToToday` ourselves when
    // we're already on the journal view, i.e. `setView` is a same-value
    // no-op that `useViewChangeAnnouncer`'s effect won't react to. When
    // invoked from another view, `setView('journal')` DOES change
    // `currentView`, so the central announcer already announces "Navigated
    // to Journal" — skipping our own announce here avoids a double
    // announcement for that path.
    shortcutId: 'goToToday',
    run: ({ onClose }) => {
      onClose()
      const wasAlreadyOnJournal = useNavigationStore.getState().currentView === 'journal'
      useNavigationStore.getState().setView('journal')
      useJournalStore.getState().setCurrentDate(new Date())
      if (wasAlreadyOnJournal) {
        announce(t('announce.jumpedToToday'))
      }
    },
  },
  {
    id: 'toggle-sidebar',
    labelKey: 'palette.cmdToggleSidebar',
    category: 'action',
    icon: PanelLeftIcon,
    // Sidebar open/closed state lives in `SidebarProvider`'s local React
    // context (`use-sidebar-state.ts`), not a store this plain module can
    // reach — `TOGGLE_SIDEBAR_EVENT` is the editor-agnostic bridge
    // `use-sidebar-keyboard.ts` listens for (mirrors the `showShortcuts`
    // event bridge above).
    shortcutId: 'toggleSidebar',
    run: ({ onClose }) => {
      window.dispatchEvent(new CustomEvent(TOGGLE_SIDEBAR_EVENT))
      onClose()
    },
  },
  {
    id: 'export-page-markdown',
    labelKey: 'palette.cmdExportPageMarkdown',
    category: 'action',
    icon: Download,
    // Mirrors `PageHeader.tsx`'s `exportPageMarkdown` shortcut
    // (Ctrl+Shift+E by default), reading the active page off the tab's
    // page stack instead of a component-scoped `pageId` prop. No-ops with
    // a toast when no page is open (e.g. journal/pages/settings views).
    shortcutId: 'exportPageMarkdown',
    run: ({ onClose }) => {
      onClose()
      const activePage = selectPageStack(useTabsStore.getState()).at(-1)
      if (!activePage) {
        notify.error(t('palette.noActivePage'))
        return
      }
      exportPageMarkdown(activePage.pageId)
        .then(async (markdown) => {
          await writeText(markdown)
          notify.success(t('pageHeader.exportCopied'))
          announce(t('announce.exported'))
        })
        .catch((err: unknown) => {
          logger.error(
            'palette-commands',
            'Failed to export page markdown via palette',
            { pageId: activePage.pageId },
            err,
          )
          notify.error(t('pageHeader.exportFailed'))
        })
    },
  },
  {
    id: 'keyboard-shortcuts',
    labelKey: 'palette.cmdKeyboardShortcuts',
    category: 'action',
    icon: Keyboard,
    // #922 — the `?` chord is suppressed while an editor is focused (so a
    // literal `?` types during outlining), leaving the cheatsheet unreachable
    // mid-outline. This command opens it via the editor-agnostic
    // `SHOW_SHORTCUTS_EVENT`, so it works whether or not an editor is focused.
    // The chip still advertises the `?` chord for the non-editing case.
    shortcutId: 'showShortcuts',
    run: ({ onClose }) => {
      window.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT))
      onClose()
    },
  },
]

/** Lookup a command by id. Returns undefined for ids that are no longer in the registry. */
export function getPaletteCommand(id: string): PaletteCommandSpec | undefined {
  return PALETTE_COMMANDS.find((c) => c.id === id)
}
