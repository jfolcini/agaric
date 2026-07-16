/**
 * useLocalStoragePreference — THE localStorage-preference primitive: a typed,
 * defensive `useSyncExternalStore` over a single localStorage key with
 * cross-instance synchronization (#2666).
 *
 * ## Cross-instance sync
 *
 * Every mounted hook instance for a key — in this window or another — sees a
 * write immediately:
 *   - `setPreference` persists, then broadcasts via
 *     {@link broadcastPreferenceChange}: a synthetic `StorageEvent`, the
 *     app-wide same-tab convention established by `useWeekStart` /
 *     `useExternalImagePolicy` / `keyboard-config` (other windows receive
 *     the browser's native event for the same key).
 *   - One module-level `storage` listener (installed while any instance is
 *     subscribed) fans events out to the instances registered for that
 *     exact key; `localStorage.clear()` (`e.key === null`) notifies all.
 *
 * Non-hook writers that go through `writePreference` /
 * `removePreference` (`src/lib/preferences.ts`) broadcast the same way, so
 * lib-level writes (e.g. `starred-pages.ts`) also update mounted hooks.
 *
 * ## Failure discipline
 *
 * Defensive against the three failure modes localStorage exhibits:
 *   1. Read throws (e.g. SecurityError in private mode) → fall back to
 *      `defaultValue`, log once per instance via the structured logger.
 *   2. Stored value can't be parsed (`parse` throws / invalid JSON) →
 *      fall back to `defaultValue`. No log — invalid stored data is
 *      common after schema migrations and not actionable.
 *   3. Write throws (quota exceeded, private mode) → swallow + log. The
 *      calling instance keeps the new value in memory for the session
 *      (preserving the legacy useState-based behavior, so e.g. a settings
 *      toggle still responds in private mode), but NO broadcast is sent —
 *      nothing was persisted for other instances to read.
 *
 * ## Contract details
 *
 * The default `parse`/`serialize` use JSON. Pass custom transformers when
 * the existing on-disk format is a bare string that JSON can't handle —
 * e.g. `'date'` (not `'"date"'`) for legacy preferences.
 *
 * `defaultValue` and the `options` transformers are captured on first
 * render (they are contractually stable once provided — callers may
 * inline-construct the options object without re-render churn). The parsed
 * snapshot is cached against the raw stored string, so object/array values
 * keep a stable reference between writes — a `useSyncExternalStore`
 * requirement (a fresh reference per `getSnapshot` call would loop forever).
 *
 * On mount the current value is re-persisted once (a no-op overwrite for a
 * valid stored value). This is the write-back that re-persists a `migrate`d
 * or normalized legacy value in the current format — the preferences
 * registry's migrate-on-read contract relies on it. It does not broadcast:
 * by construction every instance parses the pre-write raw string to the
 * same value, so there is nothing new to tell them.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { logger } from '@/lib/logger'

export interface LocalStoragePreferenceOptions<T> {
  /** Convert the raw stored string into a value. May throw on invalid input. */
  parse?: (raw: string) => T
  /** Convert the value back to a string for storage. */
  serialize?: (value: T) => string
  /**
   * Source label for `logger.warn` calls. Defaults to
   * `'useLocalStoragePreference'`.
   */
  source?: string
}

const DEFAULT_PARSE = <T>(raw: string): T => JSON.parse(raw) as T
const DEFAULT_SERIALIZE = <T>(value: T): string => JSON.stringify(value)

// ── Shared same-tab broadcast: one module-level emitter ────────────────────

type Listener = () => void

/** Per-key subscriber registry behind the single module-level listener. */
const keyListeners = new Map<string, Set<Listener>>()

function notifyKey(key: string): void {
  const listeners = keyListeners.get(key)
  if (listeners === undefined) return
  // Live iteration is safe: Set/Map tolerate deletion during for…of, and a
  // notified listener may at most unsubscribe (unmount) — never subscribe.
  for (const listener of listeners) listener()
}

function handleStorageEvent(e: StorageEvent): void {
  if (e.key === null) {
    // `localStorage.clear()` — every key may have changed.
    for (const key of keyListeners.keys()) notifyKey(key)
    return
  }
  notifyKey(e.key)
}

function subscribeKey(key: string, listener: Listener): () => void {
  if (keyListeners.size === 0) window.addEventListener('storage', handleStorageEvent)
  let listeners = keyListeners.get(key)
  if (listeners === undefined) {
    listeners = new Set()
    keyListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = keyListeners.get(key)
    if (current !== undefined) {
      current.delete(listener)
      if (current.size === 0) keyListeners.delete(key)
    }
    if (keyListeners.size === 0) window.removeEventListener('storage', handleStorageEvent)
  }
}

/**
 * Broadcast that `key`'s stored value changed so every subscribed hook
 * instance re-reads. Implemented as a synthetic `StorageEvent` — the
 * app-wide same-tab convention (other windows get the browser's native
 * event, and pre-existing raw `storage` listeners such as
 * `keyboard-config/storage.ts` keep working unchanged). MUST be dispatched
 * AFTER the write, so listeners always read fresh data.
 */
export function broadcastPreferenceChange(
  key: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      url: window.location.href,
      storageArea: window.localStorage,
    }),
  )
}

// ── The hook ────────────────────────────────────────────────────────────────

export function useLocalStoragePreference<T>(
  key: string,
  defaultValue: T,
  options: LocalStoragePreferenceOptions<T> = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  // Captured on first render (see header, "Contract details"): the options
  // fields are contractually stable once provided, and `defaultValue` must
  // keep one identity so the "key absent" snapshot stays referentially
  // stable across renders.
  const optsRef = useRef({
    parse: options.parse ?? DEFAULT_PARSE<T>,
    serialize: options.serialize ?? DEFAULT_SERIALIZE<T>,
    source: options.source ?? 'useLocalStoragePreference',
    defaultValue,
  })

  // Snapshot cache: re-parse only when the raw stored string changes, so the
  // returned value is referentially stable between writes (required by
  // `useSyncExternalStore` — see header).
  const cacheRef = useRef<{ key: string; raw: string | null; value: T } | null>(null)
  // A persistently-throwing read (private mode) would otherwise log on every
  // snapshot; warn once per instance, matching the legacy mount-only log.
  const warnedReadRef = useRef(false)
  // Last failed write (header §3): kept so the calling instance still
  // reflects the user's choice for the session when storage is unavailable.
  // Ref + tick so `setPreference` reads it synchronously without a stale
  // closure; cleared by the next successful write.
  const failedWriteRef = useRef<{ key: string; value: T } | null>(null)
  const [, bumpFailedWrite] = useState(0)

  const getSnapshot = useCallback((): T => {
    let raw: string | null
    try {
      raw = localStorage.getItem(key)
    } catch (err) {
      if (!warnedReadRef.current) {
        warnedReadRef.current = true
        logger.warn(optsRef.current.source, 'Failed to read localStorage preference', { key }, err)
      }
      raw = null // fall through to defaultValue
    }
    const cached = cacheRef.current
    if (cached !== null && cached.key === key && cached.raw === raw) return cached.value
    let value: T
    if (raw === null) {
      value = optsRef.current.defaultValue
    } else {
      try {
        value = optsRef.current.parse(raw)
      } catch {
        // Invalid stored data — fall back silently. Not log-worthy: a
        // schema/format migration will hit this on first read.
        value = optsRef.current.defaultValue
      }
    }
    cacheRef.current = { key, raw, value }
    return value
  }, [key])

  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeKey(key, onStoreChange),
    [key],
  )

  const getServerSnapshot = useCallback((): T => optsRef.current.defaultValue, [])

  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Mount / key-change write-back (see header: re-persists migrated /
  // normalized values; a no-op overwrite otherwise). Silent — no broadcast.
  useEffect(() => {
    const value = getSnapshot()
    try {
      const raw = optsRef.current.serialize(value)
      localStorage.setItem(key, raw)
      // Prime the cache so the write-back never invalidates the snapshot
      // reference (serialize(parse(raw)) may differ from raw byte-wise).
      cacheRef.current = { key, raw, value }
    } catch (err) {
      logger.warn(optsRef.current.source, 'Failed to write localStorage preference', { key }, err)
    }
  }, [key, getSnapshot])

  const setPreference = useCallback(
    (next: T | ((prev: T) => T)) => {
      const failed = failedWriteRef.current
      const prev = failed !== null && failed.key === key ? failed.value : getSnapshot()
      const value = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
      const opts = optsRef.current
      let raw: string
      try {
        raw = opts.serialize(value)
      } catch (err) {
        logger.warn(opts.source, 'Failed to write localStorage preference', { key }, err)
        return
      }
      let oldRaw: string | null = null
      try {
        try {
          oldRaw = localStorage.getItem(key)
        } catch {
          // Reading the previous value is best-effort broadcast metadata.
        }
        localStorage.setItem(key, raw)
      } catch (err) {
        // Degrade to in-memory (header §3): this instance keeps the value
        // for the session; no broadcast — nothing persisted for others.
        logger.warn(opts.source, 'Failed to write localStorage preference', { key }, err)
        failedWriteRef.current = { key, value }
        bumpFailedWrite((n) => n + 1)
        return
      }
      failedWriteRef.current = null
      // Prime the cache with the exact value the caller set, so this
      // instance's snapshot keeps the caller's reference (not a re-parsed
      // copy), then tell everyone else.
      cacheRef.current = { key, raw, value }
      broadcastPreferenceChange(key, oldRaw, raw)
    },
    [key, getSnapshot],
  )

  const failed = failedWriteRef.current
  const value = failed !== null && failed.key === key ? failed.value : stored
  return [value, setPreference]
}
