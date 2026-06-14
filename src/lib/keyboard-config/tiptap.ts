/**
 * TipTap key-format conversion (MAINT-127). Translates a human-readable
 * keyboard-config key string (e.g. `Ctrl + Shift + S`) into the dash-joined
 * `Mod-Shift-s` form that TipTap's `addKeyboardShortcuts` extension expects.
 */

import type { KeyboardShortcutCommand } from '@tiptap/core'

import { getShortcutKeys } from './storage'

/**
 * Convert a SINGLE keyboard-config chord (no ` / ` alternatives) to TipTap
 * key format. e.g., 'Ctrl + E' → 'Mod-e', 'Ctrl + Shift + S' → 'Mod-Shift-s'.
 *
 * A binding string containing ` / ` alternatives (e.g. `Ctrl + E / Ctrl +
 * Shift + E`) is NOT a single chord — passing it here yields a malformed
 * key. Use {@link tipTapShortcutMap} for bindings that may carry alternatives.
 */
export function configKeyToTipTap(configKey: string): string {
  const parts = configKey.split('+').map((p) => p.trim())
  return parts
    .map((p) => {
      const lower = p.toLowerCase()
      if (lower === 'ctrl') return 'Mod'
      if (lower === 'shift') return 'Shift'
      if (lower === 'alt') return 'Alt'
      return lower
    })
    .join('-')
}

/**
 * #789 — Build a TipTap `addKeyboardShortcuts` entry map for a shortcut id,
 * expanding ` / ` alternatives into one keymap entry PER alternative so a
 * rebinding like `Ctrl + E / Ctrl + Shift + E` fires on either chord.
 *
 * Before this helper, call sites passed `getShortcutKeys(id)` straight into
 * {@link configKeyToTipTap} as a computed object key — an alternatives
 * binding produced a single malformed key (the ` / ` separator and both
 * chords mangled into one token) that TipTap could never trigger. Spreading
 * this map into the returned shortcuts object preserves the existing
 * single-binding behaviour (one entry) while making alternatives real.
 *
 * Empty/blank alternatives (a malformed override) are skipped so they can't
 * shadow the handler under a `''` key.
 */
export function tipTapShortcutMap(
  shortcutId: string,
  handler: KeyboardShortcutCommand,
): Record<string, KeyboardShortcutCommand> {
  const binding = getShortcutKeys(shortcutId)
  const map: Record<string, KeyboardShortcutCommand> = {}
  for (const alt of binding.split(' / ')) {
    const trimmed = alt.trim()
    if (!trimmed) continue
    map[configKeyToTipTap(trimmed)] = handler
  }
  return map
}
