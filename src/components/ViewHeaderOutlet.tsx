/**
 * ViewHeaderOutlet — portal-based outlet for view-level sticky headers.
 *
 * Problem: view components render a "sticky top-0" header, but the nearest
 * scroll ancestor is App.tsx's <ScrollArea>, not the view itself. Sticky
 * positioning resolves against the nearest scrolling ancestor, so the
 * intra-view sticky never actually sticks (UX-198).
 *
 * Solution: hoist view headers to App-level, _above_ the scroll container.
 * Views opt in by wrapping their header content in <ViewHeader>, which
 * portals children into the outlet rendered by <ViewHeaderOutletSlot />.
 *
 * Lifecycle:
 *  - ViewHeaderOutletProvider owns the outlet DOM element via a ref-callback
 *    that setStates when the element attaches/detaches. Consumers re-render
 *    via context when the outlet element resolves.
 *  - ViewHeaderOutletSlot renders the host div that becomes the portal
 *    target. It sits between App.tsx's fixed <header> and the <ScrollArea>.
 *  - useViewHeaderOutlet returns the outlet DOM element (or null). When the
 *    hook is used outside a provider, it returns `undefined` so consumers can
 *    fall back to inline rendering (useful for tests and isolated renders).
 *
 * Matches the "Floating UI lifecycle logging" convention in AGENTS.md: the
 * consumer (<ViewHeader>) logs at `logger.warn` when a portal mount is
 * attempted before the outlet resolves (i.e. the provider exists but the DOM
 * ref has not attached yet — indicates a mount ordering bug).
 */

import type React from 'react'
import { createContext, useCallback, useContext, useState } from 'react'
import { cn } from '../lib/utils'

interface ViewHeaderOutletContextValue {
  readonly outlet: HTMLElement | null
  readonly setOutlet: (el: HTMLElement | null) => void
}

/**
 * The context. `undefined` when no provider is mounted — consumers can detect
 * this and fall back to inline rendering (used for tests + isolated renders).
 */
const ViewHeaderOutletContext = createContext<ViewHeaderOutletContextValue | undefined>(undefined)

interface ViewHeaderOutletProviderProps {
  readonly children: React.ReactNode
}

/**
 * Owns the outlet DOM element and exposes it via context. Wrap the subtree
 * that contains both the <ViewHeaderOutletSlot /> (target) and any
 * <ViewHeader /> consumers.
 */
export function ViewHeaderOutletProvider({
  children,
}: ViewHeaderOutletProviderProps): React.ReactElement {
  const [outlet, setOutlet] = useState<HTMLElement | null>(null)
  // Stable setter reference so the memoised context value doesn't force
  // consumer re-renders on every Provider render.
  const stableSetOutlet = useCallback((el: HTMLElement | null) => {
    setOutlet(el)
  }, [])
  const value: ViewHeaderOutletContextValue = { outlet, setOutlet: stableSetOutlet }
  return (
    <ViewHeaderOutletContext.Provider value={value}>{children}</ViewHeaderOutletContext.Provider>
  )
}

interface ViewHeaderOutletSlotProps {
  /** Extra classes merged onto the outlet host element. */
  readonly className?: string
}

/**
 * The outlet host element. Renders a div whose ref registers itself with the
 * provider so <ViewHeader> portals its children here.
 *
 * Positioned above the <ScrollArea> in App.tsx so sticky is no longer needed —
 * the outlet itself sits outside the scroll container and naturally stays
 * visible while the view scrolls.
 */
export function ViewHeaderOutletSlot({
  className,
}: ViewHeaderOutletSlotProps): React.ReactElement | null {
  const ctx = useContext(ViewHeaderOutletContext)
  // If the slot is used outside a provider we silently render an empty host —
  // the consumer warnings will surface the real problem (a <ViewHeader> with
  // no outlet).
  const setOutlet = ctx?.setOutlet
  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      setOutlet?.(el)
    },
    [setOutlet],
  )
  return (
    <div
      ref={refCallback}
      data-testid="view-header-outlet"
      className={cn('shrink-0 bg-background empty:hidden', className)}
    />
  )
}

/**
 * Returns the current outlet element (or `null` when inside a provider but
 * the DOM ref has not attached yet). Returns `undefined` when the hook is
 * used outside a provider — consumers can use this to fall back to inline
 * rendering.
 */
export function useViewHeaderOutlet(): HTMLElement | null | undefined {
  const ctx = useContext(ViewHeaderOutletContext)
  if (ctx === undefined) return undefined
  return ctx.outlet
}
