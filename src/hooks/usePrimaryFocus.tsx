/**
 * usePrimaryFocus — view-scoped primary focus registry.
 *
 * Each top-level view (Journal, Search, PageBrowser, HistoryView, Settings,
 * etc.) can register a ref pointing at its most meaningful focusable element
 * (a search input, the first list item, the first block, etc.). When the
 * navigation view changes, App.tsx calls `focus()` on the registry to move
 * keyboard focus there instead of the generic main-content container.
 *
 * If the registry is empty for the current view, `focus()` returns `false`
 * and the caller is expected to fall back to focusing `#main-content`.
 *
 * Design notes:
 *   - Only one primary element may be registered at a time — registering
 *     a new ref replaces any existing one. This matches the invariant that
 *     only one view is mounted at a time (via conditional rendering).
 *   - Registration is idempotent via `useEffect`; the ref is cleared on
 *     unmount so stale refs don't linger across view transitions.
 */

import type { ReactElement, ReactNode, RefObject } from 'react'
import { createContext, useContext, useEffect, useRef } from 'react'

interface FocusRegistry {
  /** Register `ref` as the primary focus target. Replaces any existing. */
  register: (ref: RefObject<HTMLElement | null>) => void
  /** Clear the currently-registered ref (called on unmount). */
  unregister: (ref: RefObject<HTMLElement | null>) => void
  /**
   * Focus the registered element, if any. Returns `true` when a ref was
   * registered AND the element is currently in the DOM. Returns `false`
   * when there is nothing registered or the element is detached.
   */
  focus: () => boolean
}

const PrimaryFocusContext = createContext<FocusRegistry | null>(null)

interface ProviderProps {
  children: ReactNode
}

export function PrimaryFocusProvider({ children }: ProviderProps): ReactElement {
  // A ref-to-a-ref: we don't want the registry itself to rebuild on every
  // render, but the *inner* ref may change as views mount.
  const currentRef = useRef<RefObject<HTMLElement | null> | null>(null)

  // The registry object is stable for the lifetime of the provider.
  const registryRef = useRef<FocusRegistry | null>(null)
  if (registryRef.current === null) {
    registryRef.current = {
      register: (ref) => {
        currentRef.current = ref
      },
      unregister: (ref) => {
        // Only clear if the ref we're unregistering is the one currently
        // registered — avoids clobbering a later view's registration when
        // an earlier view's cleanup runs after the new view mounted.
        if (currentRef.current === ref) {
          currentRef.current = null
        }
      },
      focus: () => {
        const ref = currentRef.current
        const el = ref?.current ?? null
        if (el && el.isConnected) {
          el.focus({ preventScroll: true })
          return true
        }
        return false
      },
    }
  }

  return (
    <PrimaryFocusContext.Provider value={registryRef.current}>
      {children}
    </PrimaryFocusContext.Provider>
  )
}

/**
 * Hook for a view to register its primary-focus ref.
 *
 * Registers the ref on mount and clears it on unmount. Safe to call with a
 * ref that may not yet be attached — the registry dereferences lazily when
 * `focus()` is invoked.
 *
 * Outside a `PrimaryFocusProvider` (e.g. in isolated component tests), this
 * is a no-op.
 */
export function useRegisterPrimaryFocus(ref: RefObject<HTMLElement | null>): void {
  const registry = useContext(PrimaryFocusContext)
  useEffect(() => {
    if (!registry) return undefined
    registry.register(ref)
    return () => {
      registry.unregister(ref)
    }
  }, [registry, ref])
}

/** Escape hatch for App.tsx to call `focus()` imperatively on view change. */
export function usePrimaryFocusRegistry(): FocusRegistry | null {
  return useContext(PrimaryFocusContext)
}
