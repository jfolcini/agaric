/**
 * localStorage-backed persistence for keyboard shortcut overrides (MAINT-127).
 * Reads/writes the `agaric-keyboard-shortcuts` JSON map, merges it with the
 * defaults from `./catalog`, and reports conflicts within a category.
 */

import { logger } from '../logger'
import { DEFAULT_SHORTCUTS, type ShortcutBinding } from './catalog'
import { normalizeBinding } from './parse'

const STORAGE_KEY = 'agaric-keyboard-shortcuts'

// #754 / #789 — module-level overrides cache. `getCustomOverrides` sits on
// the hot path of `matchesShortcutBinding`, which the always-on keydown
// listeners call ~10-20× per keystroke; without caching every keydown
// re-runs `JSON.parse` on the same blob that many times (the cost #754/#789
// removes).
//
// #754 caches the PARSED object keyed on the raw string, so repeated calls
// against an unchanged blob skip the parse. #789 adds explicit invalidation
// on the settings-changed signals so the cache is dropped the instant a
// rebinding is saved, rather than relying solely on the raw string differing:
//
//   - Same-tab writes go through this module (`setCustomShortcut` /
//     `resetShortcut` / `resetAllShortcuts`), which call `invalidateCache`.
//   - Cross-tab writes — and the synthetic same-tab `storage` events the
//     Settings/quick-capture hooks already dispatch — hit the `storage`
//     listener below.
//
// We keep reading the (cheap) raw string and comparing it as the correctness
// backstop: a direct `localStorage.setItem`/`clear()` that bypasses the
// module (out-of-band writes, and the storage-spy idiom used throughout the
// test suite) is still honoured even without an explicit invalidation. The
// per-call `JSON.parse` — the cost the issue flags — happens only when the
// blob actually changes.
let cachedRaw: string | null = null
let cachedOverrides: Record<string, string> = {}

function invalidateCache(): void {
  // Force the next `getCustomOverrides` to re-parse even if the raw string
  // happens to compare equal (it won't, for a real write — but an explicit
  // drop keeps the contract obvious and survives any future caller that
  // mutates in place).
  cachedRaw = null
}

// Cross-tab + synthetic same-tab writes. Other surfaces in the app
// (`useQuickCaptureShortcut`, `useWeekStart`, the Settings tabs) already
// dispatch `storage` events for same-tab listeners, so this single listener
// covers both real cross-tab writes and any synthetic same-tab signal. Only
// invalidate when our key (or a full clear, `e.key === null`) changed.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) invalidateCache()
  })
}

export function getCustomOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      cachedRaw = null
      cachedOverrides = {}
      return cachedOverrides
    }
    if (raw === cachedRaw) return cachedOverrides
    const parsed = JSON.parse(raw) as Record<string, string>
    cachedRaw = raw
    cachedOverrides = parsed
    return parsed
  } catch (e) {
    logger.warn('KeyboardConfig', 'failed to load custom shortcut overrides', undefined, e)
    cachedRaw = null
    cachedOverrides = {}
    return cachedOverrides
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
  // Clone — `getCustomOverrides` may return the shared cache object (#754).
  const overrides = { ...getCustomOverrides() }
  // #723 — normalise user-typed formats (`Ctrl+E`, `Cmd + K`, `Mod-K`…)
  // to the canonical `'Ctrl + Shift + E'` form before persisting, so the
  // saved binding is always something the matcher honours.
  const normalized = normalizeBinding(keys)
  const def = DEFAULT_SHORTCUTS.find((s) => s.id === id)
  if (def && normalizeBinding(def.keys) === normalized) {
    delete overrides[id]
  } else {
    overrides[id] = normalized
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    // #789 — same-tab writes no longer self-invalidate via a raw re-read,
    // so the writer must drop the cache itself. Only invalidate after the
    // write actually landed; a throwing `setItem` leaves storage (and thus
    // the cache) unchanged.
    invalidateCache()
  } catch {
    logger.warn('KeyboardConfig', 'failed to save keyboard shortcut override')
  }
}

export function resetShortcut(id: string): void {
  // Clone — `getCustomOverrides` may return the shared cache object (#754).
  const overrides = { ...getCustomOverrides() }
  delete overrides[id]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    invalidateCache()
  } catch {
    logger.warn('KeyboardConfig', 'failed to reset keyboard shortcut')
  }
}

export function resetAllShortcuts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
    invalidateCache()
  } catch {
    logger.warn('KeyboardConfig', 'failed to reset all keyboard shortcuts')
  }
}

/**
 * Categories whose bindings are dispatched by document/window-level
 * keydown listeners that coexist on ordinary views
 * (`useAppKeyboardShortcuts`'s listeners, `useUndoShortcuts`, and
 * `PageHeader`'s document-level `exportPageMarkdown` listener — mounted
 * whenever a page is open, regardless of focus). Two bindings in
 * DIFFERENT categories of this set still race for the same keystroke, so
 * `findConflicts` must compare them cross-category (#754) — the
 * per-category grouping below only covers surfaces whose listeners are
 * scoped to a focused element (editor, lists, graph) and therefore can't
 * co-fire across categories.
 */
const GLOBAL_LISTENER_CATEGORIES: ReadonlySet<string> = new Set([
  'keyboard.category.global',
  'keyboard.category.journal',
  'keyboard.category.pageEditor',
  'keyboard.category.spaces',
  'keyboard.category.tabs',
  'keyboard.category.undoRedo',
])

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
  // Pass 3 (#754): cross-category collisions between always-on listeners.
  conflicts.push(...findAlwaysOnCrossCategoryConflicts(current))
  return conflicts
}

/**
 * Pass 3 (#754): the `GLOBAL_LISTENER_CATEGORIES` listeners (global /
 * journal / page-editor / spaces / tabs / undo-redo) all see the same
 * document/window keystrokes, so two bindings on the same chord in two
 * DIFFERENT categories of that set race each other — the per-category
 * grouping in passes 1/2 never compares them. Alternatives
 * (`'Ctrl + Y / Ctrl + Shift + Z'`) are split so a single shared chord
 * counts. The UX-394 condition rule carries over: two bindings whose
 * conditions are BOTH defined and differ are assumed disjoint and not
 * flagged.
 */
function findAlwaysOnCrossCategoryConflicts(
  current: ShortcutBinding[],
): Array<{ ids: string[]; keys: string; category: string }> {
  const byChord = new Map<string, ShortcutBinding[]>()
  for (const s of current) {
    // #1592 — a binding races the always-on listeners when its category is in
    // the global set OR when it is an individually-flagged document-level
    // listener (e.g. Escape `zoomOut`/`clearSelection`/`listClearSelection`)
    // sitting inside an otherwise focus-scoped category. Focus-scoped entries
    // (suggestion-popup keymap, editor chords) lack the flag and stay out, so
    // they aren't over-reported.
    if (!GLOBAL_LISTENER_CATEGORIES.has(s.category) && !s.documentLevel) continue
    for (const chord of s.keys.split(' / ')) {
      const arr = byChord.get(chord) ?? []
      arr.push(s)
      byChord.set(chord, arr)
    }
  }
  const conflicts: Array<{ ids: string[]; keys: string; category: string }> = []
  const seenPairs = new Set<string>()
  for (const [chord, arr] of byChord.entries()) {
    for (const [i, a] of arr.entries()) {
      for (const b of arr.slice(i + 1)) {
        if (a.category === b.category) continue // passes 1/2 own same-category
        const conditionsDisjoint =
          a.condition !== undefined && b.condition !== undefined && a.condition !== b.condition
        if (conditionsDisjoint) continue
        const pairKey = [a.id, b.id].sort().join('|')
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)
        conflicts.push({ ids: [a.id, b.id], keys: chord, category: a.category })
      }
    }
  }
  return conflicts
}
