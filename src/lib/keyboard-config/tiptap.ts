/**
 * TipTap key-format conversion (MAINT-127). Translates a human-readable
 * keyboard-config key string (e.g. `Ctrl + Shift + S`) into the dash-joined
 * `Mod-Shift-s` form that TipTap's `addKeyboardShortcuts` extension expects.
 */

/**
 * Convert a keyboard-config key string to TipTap key format.
 * e.g., 'Ctrl + E' → 'Mod-e', 'Ctrl + Shift + S' → 'Mod-Shift-s'
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
