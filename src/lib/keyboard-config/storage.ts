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
