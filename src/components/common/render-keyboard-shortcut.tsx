/**
 * renderKeys — render a keyboard shortcut string as styled `<kbd>` elements.
 *
 * Shared between `KeyboardSettingsTab`, `KeyboardShortcuts` and the palette
 * `HelpModeBody`. Handles `+` combos and `/` alternatives, and substitutes
 * the platform mod key (Cmd / Ctrl) for the literal `Ctrl` token.
 *
 * #1005 — the chip look now lives in the canonical `<KbdChord>` primitive
 * (`@/components/ui/kbd`); this is a thin compatibility wrapper so there is
 * a single implementation of the keyboard-chip style across the app. These
 * are prominent settings/help chips, so they use the `md` size variant.
 *
 * #4006 — moved down from lib/'s former render-keyboard-shortcut module
 * (deleted outright, no re-export left behind, so the old location stays
 * prose rather than a citation — there is no live path to point at): it
 * renders JSX (a `<KbdChord>` wrapper), so it is a component, not a
 * `lib/`-tier utility.
 */

import React from 'react'

import { KbdChord } from '@/components/ui/kbd'

/** Render a keys string as styled <kbd> elements. Handles `+` combos and `/` alternatives. */
export function renderKeys(keys: string): React.ReactNode {
  return <KbdChord keys={keys} size="md" />
}
