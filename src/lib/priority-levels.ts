/**
 * priority-levels — single source of truth for the active priority levels.
 *
 * UX-201b: priority levels are user-configurable via the `priority` property
 * definition's `options` JSON. This module caches the current levels in
 * module-level state and notifies subscribers when they change.
 *
 * Loading/save flow:
 *   1. App boot → `listPropertyDefs()` → parse priority def → `setPriorityLevels(parsed)`
 *   2. User edits priority options in the Properties tab →
 *      `updatePropertyDefOptions('priority', ...)` succeeds →
 *      `setPriorityLevels(parsedOptions)` → subscribers re-render.
 *
 * Pure functions (`priorityColor`, `priorityRank`) read synchronously via
 * `getPriorityLevels()`. React components that need to re-render on change
 * subscribe via the `usePriorityLevels()` hook in `src/hooks/usePriorityLevels.ts`.
 */

import { logger } from './logger'

/** Default fallback used until the DB load completes and in tests. */
export const DEFAULT_PRIORITY_LEVELS: readonly string[] = ['1', '2', '3']

/** Current active levels. Never empty. */
let currentLevels: readonly string[] = DEFAULT_PRIORITY_LEVELS

/** Subscribers notified on change. */
const listeners = new Set<() => void>()

/**
 * Normalise input: trim each entry, drop empty strings, dedupe while
 * preserving first-seen order. Does not allocate when input is already
 * well-formed.
 */
function normalise(levels: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of levels) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** True when two level arrays hold the same strings in the same order. */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Replace the current levels. Called at boot and after successful edits in
 * the Properties tab. Bad inputs (empty after normalisation) are rejected
 * without changing state — we never silently collapse back to default on
 * malformed input (that would be surprising for the user).
 */
export function setPriorityLevels(levels: readonly string[]): void {
  const normalised = normalise(levels)
  if (normalised.length === 0) {
    // Keep the existing value — a subsequent valid call can still fix it.
    return
  }
  if (arraysEqual(normalised, currentLevels)) {
    // No-op when nothing changed — don't wake subscribers needlessly.
    return
  }
  currentLevels = normalised
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      logger.warn('priority-levels', 'listener threw', undefined, err)
    }
  }
}

/** Read the currently-active priority levels. Never empty. */
export function getPriorityLevels(): readonly string[] {
  return currentLevels
}

/**
 * Full cycle used by `handleTogglePriority`:
 * `[null, ...getPriorityLevels()]` — cycling produces
 * `none → lv1 → lv2 → ... → none`.
 */
export function getPriorityCycle(): readonly (string | null)[] {
  return [null, ...currentLevels]
}

/**
 * Sort rank for a priority value. Lower = higher priority.
 * - First level → 0 (highest)
 * - Last level → N-1 (lowest)
 * - `null` or unknown level → N (sorts to bottom)
 */
export function priorityRank(priority: string | null): number {
  if (priority == null) return currentLevels.length
  const idx = currentLevels.indexOf(priority)
  return idx < 0 ? currentLevels.length : idx
}

/**
 * Subscribe to level changes. Returns an unsubscribe function. Used by the
 * `usePriorityLevels` hook via `useSyncExternalStore`.
 */
export function subscribePriorityLevels(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test-only: reset the module back to the default. Exposed so Vitest tests
 * can start from a clean slate in `beforeEach`.
 */
export function __resetPriorityLevelsForTests(): void {
  currentLevels = DEFAULT_PRIORITY_LEVELS
  listeners.clear()
}
