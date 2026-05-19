/**
 * Palette command registry (PEND-67 Phase 8).
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
  Clock,
  FileSearch,
  FileText,
  type LucideIcon,
  Settings as SettingsIcon,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react'
import { useNavigationStore } from '@/stores/navigation'

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

export const PALETTE_COMMANDS: readonly PaletteCommandSpec[] = [
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
    // PEND-67 Phase 1 — `focusSearch` is the find-in-files chord
    // (Ctrl+Shift+F by default). This command produces the same
    // outcome from the palette.
    shortcutId: 'focusSearch',
    run: ({ onEscalate }) => {
      // Escalate with an empty seed — SearchPanel mounts with its
      // input ready for the user to type, same as Ctrl+Shift+F.
      onEscalate('')
    },
  },
]

/** Lookup a command by id. Returns undefined for ids that are no longer in the registry. */
export function getPaletteCommand(id: string): PaletteCommandSpec | undefined {
  return PALETTE_COMMANDS.find((c) => c.id === id)
}
