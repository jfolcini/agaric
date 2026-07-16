/**
 * Keyboard shortcut configuration with localStorage persistence.
 *
 * Implementation is split across `keyboard-config/{catalog,tiptap,match,storage}.ts`
 * By concern. This barrel re-exports the public surface so
 * existing callers (`@/lib/keyboard-config` import path) keep working
 * verbatim.
 */
export type { ShortcutBinding } from '@/lib/keyboard-config/catalog'
export { DEFAULT_SHORTCUTS } from '@/lib/keyboard-config/catalog'
export { formatChordTokens } from '@/lib/keyboard-config/format-chord'
export { matchesShortcutBinding } from '@/lib/keyboard-config/match'
export type { ParsedChord } from '@/lib/keyboard-config/parse'
export {
  formatParsedChord,
  normalizeBinding,
  parseChord,
  validateBindingInput,
} from '@/lib/keyboard-config/parse'
export {
  findConflicts,
  getCurrentShortcuts,
  getCustomOverrides,
  getShortcutKeys,
  resetAllShortcuts,
  resetShortcut,
  setCustomShortcut,
  toAriaKeyshortcuts,
} from '@/lib/keyboard-config/storage'
export { configKeyToTipTap, tipTapShortcutMap } from '@/lib/keyboard-config/tiptap'
