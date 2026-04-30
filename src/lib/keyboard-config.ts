/**
 * Keyboard shortcut configuration with localStorage persistence (UX-86).
 *
 * Implementation is split across `keyboard-config/{catalog,tiptap,match,storage}.ts`
 * by concern (MAINT-127). This barrel re-exports the public surface so
 * existing callers (`@/lib/keyboard-config` import path) keep working
 * verbatim.
 */
export type { ShortcutBinding } from './keyboard-config/catalog'
export { DEFAULT_SHORTCUTS } from './keyboard-config/catalog'
export { matchesShortcutBinding } from './keyboard-config/match'
export {
  findConflicts,
  getCurrentShortcuts,
  getCustomOverrides,
  getShortcutKeys,
  resetAllShortcuts,
  resetShortcut,
  setCustomShortcut,
} from './keyboard-config/storage'
export { configKeyToTipTap } from './keyboard-config/tiptap'
