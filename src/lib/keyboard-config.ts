/**
 * Keyboard shortcut configuration with localStorage persistence (UX-86).
 */

import { logger } from './logger'

const STORAGE_KEY = 'agaric-keyboard-shortcuts'

export interface ShortcutBinding {
  id: string
  keys: string
  category: string // i18n key
  description: string // i18n key
  condition?: string // i18n key
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  // Navigation
  {
    id: 'prevBlock',
    keys: 'Arrow Up / Left',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToPreviousBlock',
    condition: 'keyboard.condition.atStart',
  },
  {
    id: 'nextBlock',
    keys: 'Arrow Down / Right',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToNextBlock',
    condition: 'keyboard.condition.atEnd',
  },

  // Editing
  {
    id: 'saveBlock',
    keys: 'Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.saveBlockAndClose',
  },
  {
    id: 'deleteBlock',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.deleteBlock',
    condition: 'keyboard.condition.onEmptyBlock',
  },
  {
    id: 'mergeWithPrevious',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.mergeWithPrevious',
    condition: 'keyboard.condition.atStartOfBlock',
  },
  {
    id: 'indentBlock',
    keys: 'Ctrl + Shift + Arrow Right',
    category: 'keyboard.category.editing',
    description: 'keyboard.indentBlock',
  },
  {
    id: 'dedentBlock',
    keys: 'Ctrl + Shift + Arrow Left',
    category: 'keyboard.category.editing',
    description: 'keyboard.dedentBlock',
  },
  {
    id: 'cycleTaskState',
    keys: 'Ctrl + Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.cycleTaskState',
  },
  {
    id: 'collapseExpand',
    keys: 'Ctrl + .',
    category: 'keyboard.category.editing',
    description: 'keyboard.collapseExpandChildren',
  },
  {
    id: 'moveBlockUp',
    keys: 'Ctrl + Shift + Arrow Up',
    category: 'keyboard.category.editing',
    description: 'keyboard.moveBlockUp',
  },
  {
    id: 'moveBlockDown',
    keys: 'Ctrl + Shift + Arrow Down',
    category: 'keyboard.category.editing',
    description: 'keyboard.moveBlockDown',
  },
  {
    id: 'insertLineBreak',
    keys: 'Shift + Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.insertLineBreak',
    condition: 'keyboard.condition.inEditor',
  },

  // Block Tree
  {
    id: 'zoomOut',
    keys: 'Escape',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.zoomOut',
    condition: 'keyboard.condition.whenZoomed',
  },
  {
    id: 'openDatePicker',
    keys: 'Ctrl + Shift + D',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.openDatePicker',
  },
  {
    id: 'openPropertiesDrawer',
    keys: 'Ctrl + Shift + P',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.openPropertiesDrawer',
  },
  {
    id: 'heading1',
    keys: 'Ctrl + 1',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading1',
  },
  {
    id: 'heading2',
    keys: 'Ctrl + 2',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading2',
  },
  {
    id: 'heading3',
    keys: 'Ctrl + 3',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading3',
  },
  {
    id: 'heading4',
    keys: 'Ctrl + 4',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading4',
  },
  {
    id: 'heading5',
    keys: 'Ctrl + 5',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading5',
  },
  {
    id: 'heading6',
    keys: 'Ctrl + 6',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading6',
  },

  // Pickers
  {
    id: 'tagPicker',
    keys: '@',
    category: 'keyboard.category.pickers',
    description: 'keyboard.tagPicker',
    condition: 'keyboard.condition.inEditor',
  },
  {
    id: 'blockLinkPicker',
    keys: '[[',
    category: 'keyboard.category.pickers',
    description: 'keyboard.blockLinkPicker',
    condition: 'keyboard.condition.inEditor',
  },
  {
    id: 'slashCommand',
    keys: '/',
    category: 'keyboard.category.pickers',
    description: 'keyboard.slashCommandMenu',
    condition: 'keyboard.condition.inEditor',
  },

  // Journal
  {
    id: 'prevDayWeekMonth',
    keys: 'Alt + ←',
    category: 'keyboard.category.journal',
    description: 'keyboard.previousDayWeekMonth',
  },
  {
    id: 'nextDayWeekMonth',
    keys: 'Alt + →',
    category: 'keyboard.category.journal',
    description: 'keyboard.nextDayWeekMonth',
  },
  {
    id: 'goToToday',
    keys: 'Alt + T',
    category: 'keyboard.category.journal',
    description: 'keyboard.goToToday',
  },
  {
    id: 'createJournalBlock',
    keys: 'Enter / n',
    category: 'keyboard.category.journal',
    description: 'keyboard.createJournalBlock',
    condition: 'keyboard.condition.emptyDaily',
  },

  // Block Selection
  {
    id: 'toggleBlockSelection',
    keys: 'Ctrl + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.toggleBlockSelection',
  },
  {
    id: 'rangeSelectBlocks',
    keys: 'Shift + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.rangeSelectBlocks',
  },
  {
    id: 'selectAllBlocks',
    keys: 'Ctrl + A',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.selectAllBlocks',
    condition: 'keyboard.condition.notEditing',
  },
  {
    id: 'clearSelection',
    keys: 'Escape',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.clearSelection',
    condition: 'keyboard.condition.withSelection',
  },

  // Undo/Redo
  {
    id: 'undoLastPageOp',
    keys: 'Ctrl + Z',
    category: 'keyboard.category.undoRedo',
    description: 'keyboard.undoLastPageOp',
    condition: 'keyboard.condition.outsideEditor',
  },
  {
    id: 'redoLastUndoneOp',
    keys: 'Ctrl + Y',
    category: 'keyboard.category.undoRedo',
    description: 'keyboard.redoLastUndoneOp',
    condition: 'keyboard.condition.outsideEditor',
  },

  // List Selection (shared by Trash View & History View)
  {
    id: 'listToggleSelection',
    keys: 'Space',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listToggleSelection',
    condition: 'keyboard.condition.listItemFocused',
  },
  {
    id: 'listSelectAll',
    keys: 'Ctrl + A',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listSelectAll',
  },
  {
    id: 'listClearSelection',
    keys: 'Escape',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listClearSelection',
    condition: 'keyboard.condition.hasSelection',
  },

  // History View
  {
    id: 'histRangeSelect',
    keys: 'Shift + Click',
    category: 'keyboard.category.historyView',
    description: 'keyboard.rangeSelect',
  },
  {
    id: 'histRevertSelected',
    keys: 'Enter',
    category: 'keyboard.category.historyView',
    description: 'keyboard.revertSelected',
  },
  {
    id: 'histNavigateItems',
    keys: 'Arrow Up / Arrow Down',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItems',
  },
  {
    id: 'histNavigateVim',
    keys: 'j / k',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItemsVim',
  },

  // Global
  {
    id: 'focusSearch',
    keys: 'Ctrl + F',
    category: 'keyboard.category.global',
    description: 'keyboard.focusSearch',
  },
  {
    id: 'toggleSidebar',
    keys: 'Ctrl + B',
    category: 'keyboard.category.global',
    description: 'keyboard.toggleSidebar',
  },
  {
    id: 'createNewPage',
    keys: 'Ctrl + N',
    category: 'keyboard.category.global',
    description: 'keyboard.createNewPage',
  },
  {
    id: 'showShortcuts',
    keys: '?',
    category: 'keyboard.category.global',
    description: 'keyboard.showKeyboardShortcuts',
  },
  {
    id: 'gotoConflicts',
    keys: 'Alt + C',
    category: 'keyboard.category.global',
    description: 'keyboard.gotoConflicts',
  },
  {
    id: 'closeOverlays',
    keys: 'Escape',
    category: 'keyboard.category.global',
    description: 'keyboard.closeOverlays',
  },

  // Graph View (BUG-18): zoom controls previously hardcoded in GraphView.tsx
  {
    id: 'graphZoomIn',
    keys: '+ / =',
    category: 'keyboard.category.global',
    description: 'graph.zoomIn',
  },
  {
    id: 'graphZoomOut',
    keys: '-',
    category: 'keyboard.category.global',
    description: 'graph.zoomOut',
  },
  {
    id: 'graphZoomReset',
    keys: '0',
    category: 'keyboard.category.global',
    description: 'graph.zoomReset',
  },

  // Page Editor
  {
    id: 'exportPageMarkdown',
    keys: 'Ctrl + Shift + E',
    category: 'keyboard.category.pageEditor',
    description: 'keyboard.exportPageMarkdown',
    condition: 'keyboard.condition.inPageEditor',
  },

  // Tabs — after FEAT-7 the TabBar is shell-wide on desktop, so the
  // tab-management shortcuts apply everywhere, not just inside the editor.
  // The `desktopOnly` condition matches the runtime `useIsMobile() === false`
  // gate in App.tsx.
  {
    id: 'openInNewTab',
    keys: 'Ctrl + T',
    category: 'keyboard.category.tabs',
    description: 'keyboard.openInNewTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'closeActiveTab',
    keys: 'Ctrl + W',
    category: 'keyboard.category.tabs',
    description: 'keyboard.closeActiveTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'nextTab',
    keys: 'Ctrl + Tab',
    category: 'keyboard.category.tabs',
    description: 'keyboard.nextTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'previousTab',
    keys: 'Ctrl + Shift + Tab',
    category: 'keyboard.category.tabs',
    description: 'keyboard.previousTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'closeTabOnFocus',
    keys: 'Delete / Backspace',
    category: 'keyboard.category.tabs',
    description: 'keyboard.closeTabOnFocus',
    condition: 'keyboard.condition.tabFocused',
  },

  // Editor Formatting
  {
    id: 'inlineCode',
    keys: 'Ctrl + E',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.inlineCode',
  },
  {
    id: 'strikethrough',
    keys: 'Ctrl + Shift + X',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.strikethrough',
  },
  {
    id: 'highlight',
    keys: 'Ctrl + Shift + H',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.highlight',
  },
  {
    id: 'codeBlock',
    keys: 'Ctrl + Shift + C',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.codeBlock',
  },
  {
    id: 'priority1',
    keys: 'Ctrl + Shift + 1',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority1',
  },
  {
    id: 'priority2',
    keys: 'Ctrl + Shift + 2',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority2',
  },
  {
    id: 'priority3',
    keys: 'Ctrl + Shift + 3',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority3',
  },
  {
    id: 'linkPopover',
    keys: 'Ctrl + K',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.linkPopover',
  },
  {
    id: 'backspaceChip',
    keys: 'Backspace',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.backspaceChip',
    condition: 'keyboard.condition.afterChip',
  },

  // Suggestion Popup
  {
    id: 'suggestionClose',
    keys: 'Escape',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionClose',
    condition: 'keyboard.condition.popupOpen',
  },
  {
    id: 'suggestionPassSpace',
    keys: 'Space',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionPassSpace',
    condition: 'keyboard.condition.popupOpen',
  },
  {
    id: 'suggestionAutocomplete',
    keys: 'Tab',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionAutocomplete',
    condition: 'keyboard.condition.popupOpen',
  },
]

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

/**
 * Normalize a raw key token (from a binding string or `KeyboardEvent.key`)
 * to a canonical form so arrow symbols, arrow names, and Space all compare
 * equal regardless of which representation appeared on either side.
 */
function normalizeKey(raw: string): string {
  // Special-case `' '` BEFORE trimming so the literal space character from
  // `KeyboardEvent.key` (which is `' '` for the spacebar) normalises to the
  // same canonical value as the textual binding `Space`. Trimming would
  // otherwise collapse it to the empty string.
  const lower = raw.toLowerCase()
  if (lower === ' ' || lower === 'space' || lower === 'spacebar') return 'space'
  const k = lower.trim()
  if (k === '') return ''
  if (k === '←' || k === 'arrowleft' || k === 'left') return 'arrowleft'
  if (k === '→' || k === 'arrowright' || k === 'right') return 'arrowright'
  if (k === '↑' || k === 'arrowup' || k === 'up') return 'arrowup'
  if (k === '↓' || k === 'arrowdown' || k === 'down') return 'arrowdown'
  return k
}

/**
 * True when the canonical key name is a single Shift-produced punctuation
 * symbol on US-ANSI layout that this app actually binds to: `+`, `?`, `@`,
 * `=`. These are the exact glyphs that `Shift+<key>` produces (`Shift+= →
 * +`, `Shift+/ → ?`, `Shift+2 → @`). For bindings like `graphZoomIn = '+'`,
 * we want the shortcut to fire whether the user types `+` (Shift+= on US)
 * or `=` (the unshifted key) — the matcher treats Shift as don't-care when
 * the binding key is in this set.
 *
 * Deliberately narrow: we do NOT relax Shift for other symbols (`[`, `]`,
 * `;`, `'`, etc.) even though they're technically non-alphanumeric, because
 * (a) none of the app's default bindings use them, (b) a user rebinding to
 * one of those gets the expected strict Shift matching, and (c) the broader
 * `![a-z0-9]` relaxation makes the matcher unpredictable for layouts where
 * Shift+<key> produces a different glyph than the listed symbol.
 */
function isSymbolKey(canonical: string): boolean {
  if (canonical.length !== 1) return false
  return /[+?@=]/.test(canonical)
}

/**
 * Parse a shortcut binding string and check if a KeyboardEvent matches it.
 * Handles Ctrl/Cmd + Shift + single key combinations.
 *
 * Supports ` / ` separated alternatives — e.g. `+ / =` matches either `+` or `=`.
 * Arrow-key glyphs (`←`, `→`, `↑`, `↓`) in the binding match the corresponding
 * `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` `KeyboardEvent.key` values.
 * For punctuation symbols that normally require Shift on a US layout (e.g. `+`,
 * `?`, `@`) the Shift requirement is relaxed so the event matches regardless of
 * the event's shiftKey state — users can rebind without knowing the physical
 * modifier combo their layout uses.
 */
export function matchesShortcutBinding(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>,
  shortcutId: string,
): boolean {
  const binding = getShortcutKeys(shortcutId)
  if (!binding) return false
  const alternatives = binding.split(' / ')
  return alternatives.some((alt) => matchesSingleBinding(e, alt))
}

function matchesSingleBinding(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>,
  binding: string,
): boolean {
  // Split on ` + ` (space-plus-space) so bindings whose KEY is literally
  // `+` (e.g. `+` alone or `Ctrl + +`) round-trip correctly. Existing
  // bindings already use the spaced form (`Ctrl + F`, `Ctrl + Shift + D`),
  // so this is backward compatible.
  const parts = binding.split(' + ').map((p) => p.trim().toLowerCase())
  const needsCtrl = parts.includes('ctrl')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')
  const rawKey =
    parts.filter((p) => p !== 'ctrl' && p !== 'shift' && p !== 'alt' && p !== 'meta')[0] ?? ''
  const normalizedKey = normalizeKey(rawKey)
  const normalizedEventKey = normalizeKey(e.key)
  // Relax shift check for symbol punctuation keys — on many layouts
  // the same physical key produces different glyphs with/without shift
  // (US: `Shift+=` → `+`; `Shift+/` → `?`). Ignoring shift for symbols
  // makes these shortcuts work regardless of how the user types them.
  const matchShift = needsShift ? e.shiftKey : isSymbolKey(normalizedKey) ? true : !e.shiftKey
  return (
    (e.ctrlKey || e.metaKey) === needsCtrl &&
    matchShift &&
    e.altKey === needsAlt &&
    normalizedEventKey === normalizedKey
  )
}

export function getCustomOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string>
  } catch (e) {
    logger.warn('KeyboardConfig', 'failed to load custom shortcut overrides', undefined, e)
    return {}
  }
}

export function getShortcutKeys(id: string): string {
  const overrides = getCustomOverrides()
  if (overrides[id]) return overrides[id]
  const def = DEFAULT_SHORTCUTS.find((s) => s.id === id)
  return def?.keys ?? ''
}

export function getCurrentShortcuts(): (ShortcutBinding & { isCustom: boolean })[] {
  const overrides = getCustomOverrides()
  return DEFAULT_SHORTCUTS.map((s) => ({
    ...s,
    keys: overrides[s.id] ?? s.keys,
    isCustom: s.id in overrides,
  }))
}

export function setCustomShortcut(id: string, keys: string): void {
  const overrides = getCustomOverrides()
  const def = DEFAULT_SHORTCUTS.find((s) => s.id === id)
  if (def && def.keys === keys) {
    delete overrides[id]
  } else {
    overrides[id] = keys
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    logger.warn('KeyboardConfig', 'failed to save keyboard shortcut override')
  }
}

export function resetShortcut(id: string): void {
  const overrides = getCustomOverrides()
  delete overrides[id]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    logger.warn('KeyboardConfig', 'failed to reset keyboard shortcut')
  }
}

export function resetAllShortcuts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    logger.warn('KeyboardConfig', 'failed to reset all keyboard shortcuts')
  }
}

export function findConflicts(): Array<{ ids: string[]; keys: string; category: string }> {
  const current = getCurrentShortcuts()
  const byKeyCat = new Map<string, string[]>()
  for (const s of current) {
    const key = `${s.keys}|${s.category}`
    const existing = byKeyCat.get(key) ?? []
    existing.push(s.id)
    byKeyCat.set(key, existing)
  }
  const conflicts: Array<{ ids: string[]; keys: string; category: string }> = []
  for (const [keyCat, ids] of byKeyCat) {
    if (ids.length > 1) {
      const parts = keyCat.split('|')
      const keys = parts[0] ?? ''
      const category = parts[1] ?? ''
      conflicts.push({ ids, keys, category })
    }
  }
  return conflicts
}
