/**
 * useTauriEventListener — shared Tauri `listen()` wrapper.
 *
 * UseSyncEvents (3 listeners), useDeepLinkRouter (3
 * listeners), and useBlockPropertyEvents (1 listener) all carry the
 * same `listen() → unlisten()` lifecycle with slightly different
 * error-handling shapes. This hook centralizes the pattern, including
 * the unmount-before-listen-resolves race (the `cancelled` flag).
 *
 * Each call site keeps its own log shape via the optional `onError`
 * callback so the existing `logger.warn` / `logger.error` lines (with
 * their per-module names and context payloads) are preserved verbatim.
 *
 * Use `enabled = false` to gate registration on runtime conditions
 * (e.g. browser mode, when `__TAURI_INTERNALS__` is absent). Hooks
 * must be called unconditionally, so callers that need a "no-op in
 * browser" guard pass `enabled` rather than wrapping in an `if`.
 */

import type { Event } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef } from 'react'

import { logger } from '@/lib/logger'

export interface UseTauriEventListenerOptions {
  /**
   * When `false`, the hook is a no-op: no `listen()` call is issued
   * and no cleanup is registered. Default: `true`.
   */
  enabled?: boolean
  /**
   * Invoked when `listen()` rejects. When omitted, the hook falls
   * back to `logger.warn('useTauriEventListener', …)`. Pass a custom
   * handler to preserve per-module log shapes.
   */
  onError?: (err: unknown) => void
  /**
   * Invoked once `listen()` has resolved and the subscription is live, and
   * only if the component is still mounted.
   *
   * `listen()` does not buffer: anything the backend emits between this hook's
   * effect running and the promise resolving is delivered to nobody. A caller
   * that compensates for that window by reading current state over IPC has to
   * issue that read *here* rather than in its own mount effect — otherwise the
   * read can be answered before the subscription exists, and an event that
   * lands in between is lost by both paths at once. `useOsNetworkBlock` is the
   * worked example.
   */
  onSubscribed?: () => void
}

/**
 * Register a Tauri event listener for the lifetime of the component.
 *
 * Handles:
 *   - the `listen()` → `unlisten()` lifecycle,
 *   - the unmount-before-`listen()`-resolves race (via the `cancelled`
 *     flag — if the component unmounts before the promise settles, the
 *     resolved unlisten function is invoked immediately),
 *   - the `listen()` rejection path (via `onError` or the default
 *     `logger.warn` fallback),
 *   - the "subscription is now live" moment (via `onSubscribed`), which is
 *     the only safe point at which a caller can reconcile against the
 *     unbuffered gap before it.
 *
 * `handler` and `onError` are read through refs so the listener is
 * never re-registered on each render even when callers pass inline
 * closures. Re-registration only happens when `eventName` or
 * `enabled` change.
 */
export function useTauriEventListener<T = unknown>(
  eventName: string,
  handler: (event: Event<T>) => void,
  options: UseTauriEventListenerOptions = {},
): void {
  const { enabled = true, onError, onSubscribed } = options
  const handlerRef = useRef(handler)
  const onErrorRef = useRef(onError)
  const onSubscribedRef = useRef(onSubscribed)

  // Keep the refs current on every render so the registered listener
  // always calls the latest handler / onError without re-subscribing.
  handlerRef.current = handler
  onErrorRef.current = onError
  onSubscribedRef.current = onSubscribed

  useEffect(() => {
    if (!enabled) return

    let unlisten: (() => void) | null = null
    let cancelled = false

    listen<T>(eventName, (event) => {
      handlerRef.current(event)
    })
      .then((fn) => {
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
          // Only now is the subscription live. Deliberately after `unlisten`
          // is stored, so a callback that throws cannot strand the listener.
          onSubscribedRef.current?.()
        }
      })
      .catch((err: unknown) => {
        const errorHandler = onErrorRef.current
        if (errorHandler) {
          errorHandler(err)
        } else {
          logger.warn('useTauriEventListener', `Failed to listen to ${eventName}`, undefined, err)
        }
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [eventName, enabled])
}
