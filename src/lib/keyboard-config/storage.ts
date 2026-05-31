/**
 * localStorage-backed persistence for keyboard shortcut overrides (MAINT-127).
 * Reads/writes the `agaric-keyboard-shortcuts` JSON map, merges it with the
 * defaults from `./catalog`, and reports conflicts within a category.
 */

import { logger } from '../logger'
import { DEFAULT_SHORTCUTS, type ShortcutBinding } from './catalog'

const STORAGE_KEY = 'agaric-keyboard-shortcuts'

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

/**
 * Convert a human-readable display binding ("Ctrl + Shift + Arrow Up") to the
 * canonical `aria-keyshortcuts` token form ("Control+Shift+ArrowUp") so
 * assistive tech announces the binding (#216 C2 — tooltips don't fire on
 * touch). Modifier aliases are normalised to the ARIA names; non-modifier
 * keys have their internal whitespace stripped ("Arrow Up" → "ArrowUp").
 * Returns `''` for an empty/unknown binding so callers can omit the attribute.
 */
export function toAriaKeyshortcuts(displayKeys: string): string {
  if (!displayKeys) return ''
  return displayKeys
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      switch (part) {
        case 'Ctrl':
        case 'Control':
          return 'Control'
        case 'Cmd':
        case 'Command':
        case '⌘':
          return 'Meta'
        case 'Opt':
        case 'Option':
        case 'Alt':
          return 'Alt'
        default:
          return part.replace(/\s+/g, '')
      }
    })
    .join('+')
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
  // Group by exact (keys, category, condition) triple. A missing condition is
  // treated as a wildcard sentinel — wildcards fire unconditionally and so
  // conflict with every other binding on the same (keys, category) pair.
  const byTriple = new Map<string, ShortcutBinding[]>()
  // Also index by (keys, category) so we can surface wildcard cross-conflicts
  // (UX-394: shortcuts with disjoint, defined conditions never fire together
  // and must not be flagged).
  const byKeyCat = new Map<string, ShortcutBinding[]>()
  for (const s of current) {
    const condition = s.condition ?? '__wildcard__'
    const tripleKey = `${s.keys}|${s.category}|${condition}`
    const tripleArr = byTriple.get(tripleKey) ?? []
    tripleArr.push(s)
    byTriple.set(tripleKey, tripleArr)
    const kcKey = `${s.keys}|${s.category}`
    const kcArr = byKeyCat.get(kcKey) ?? []
    kcArr.push(s)
    byKeyCat.set(kcKey, kcArr)
  }
  const conflicts: Array<{ ids: string[]; keys: string; category: string }> = []
  // Pass 1: exact-triple duplicates. Two bindings sharing keys+category+condition
  // (or both lacking a condition — wildcard×wildcard) always conflict.
  for (const arr of byTriple.values()) {
    if (arr.length > 1) {
      conflicts.push({
        ids: arr.map((s) => s.id),
        keys: arr[0]?.keys ?? '',
        category: arr[0]?.category ?? '',
      })
    }
  }
  // Pass 2: wildcard×conditioned cross-conflicts. A wildcard binding fires
  // unconditionally, so it collides with every conditioned binding on the
  // same (keys, category). Pair each wildcard with each conditioned binding;
  // wildcard×wildcard pairs are already covered by Pass 1.
  for (const arr of byKeyCat.values()) {
    const wildcards = arr.filter((s) => s.condition === undefined)
    const conditioned = arr.filter((s) => s.condition !== undefined)
    if (wildcards.length > 0 && conditioned.length > 0) {
      for (const w of wildcards) {
        for (const c of conditioned) {
          conflicts.push({ ids: [w.id, c.id], keys: w.keys, category: w.category })
        }
      }
    }
  }
  return conflicts
}
