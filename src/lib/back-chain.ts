/**
 * Android system-back priority chain (#716).
 *
 * A tiny prioritized handler registry consumed by `useAndroidBackButton`.
 * Each hardware/gesture back press walks the registered handlers from
 * highest to lowest priority; the first handler that returns `true` has
 * consumed the press. When NO handler consumes it, the caller exits the
 * app (the true-root state).
 *
 * Priority bands (higher runs first):
 *
 *   - `BACK_PRIORITY_OVERLAY` (300) — close the topmost open overlay
 *     (dialog / sheet / popover / menu / picker).
 *   - `BACK_PRIORITY_ZOOM` (200) — zoom out one level in a zoomed
 *     BlockTree (`useBlockZoom` registers this while zoomed).
 *   - `BACK_PRIORITY_NAVIGATION` (100) — pop the in-app navigation
 *     stack: page-stack `goBack()`, then non-root view → journal.
 *
 * Ties within a band resolve LIFO (most recently registered wins) so
 * that, e.g., the most recently zoomed BlockTree in a journal week view
 * handles the press.
 *
 * This module is framework-free and platform-agnostic on purpose: the
 * registry always exists, but `runBackChain()` is only ever invoked from
 * the Android-only plugin listener, so registering handlers from shared
 * hooks (like `useBlockZoom`) has zero effect on desktop behavior.
 */

import { logger } from './logger'

/** Returns `true` when the handler consumed the back press. */
export type BackHandler = () => boolean

export const BACK_PRIORITY_OVERLAY = 300
export const BACK_PRIORITY_ZOOM = 200
export const BACK_PRIORITY_NAVIGATION = 100

interface BackHandlerEntry {
  handler: BackHandler
  priority: number
  seq: number
}

let entries: BackHandlerEntry[] = []
let nextSeq = 0

/**
 * Register a back handler at the given priority. Returns an unregister
 * function (idempotent — safe to call from effect cleanups that may run
 * after a re-registration).
 */
export function registerBackHandler(handler: BackHandler, priority: number): () => void {
  const entry: BackHandlerEntry = { handler, priority, seq: nextSeq++ }
  entries.push(entry)
  return () => {
    entries = entries.filter((e) => e !== entry)
  }
}

/**
 * Run the chain: highest priority first, LIFO within a priority. Returns
 * `true` as soon as a handler consumes the press, `false` when nothing
 * handled it (caller should exit / propagate to the OS).
 *
 * A throwing handler is logged and skipped — one broken overlay must not
 * turn every back press into an app exit.
 */
export function runBackChain(): boolean {
  const sorted = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq)
  for (const entry of sorted) {
    try {
      if (entry.handler()) return true
    } catch (err) {
      logger.warn('back-chain', 'back handler threw; skipping', { priority: entry.priority }, err)
    }
  }
  return false
}

/** Test-only reset hook — clears all registered handlers between tests. */
export function __resetBackHandlersForTests(): void {
  entries = []
  nextSeq = 0
}
