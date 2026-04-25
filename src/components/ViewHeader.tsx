/**
 * ViewHeader — declarative consumer for the view-level header outlet.
 *
 * Wrap the portion of a view component that should render _above_ App.tsx's
 * <ScrollArea> (so it naturally stays visible while the view scrolls). Under
 * the hood, `children` are rendered via `createPortal` into the DOM element
 * owned by the nearest <ViewHeaderOutletProvider> / <ViewHeaderOutletSlot>
 * pair.
 *
 * Fallback behaviour:
 *  - Outside a <ViewHeaderOutletProvider> (e.g., isolated component tests) the
 *    children render inline. This keeps existing tests behaviour-preserving
 *    and makes the component safe to use in Storybook-like environments.
 *  - Inside a provider whose outlet is still unresolved, the component
 *    returns `null` for the current commit and waits for the ref callback to
 *    trigger a re-render. If the outlet is still `null` one task later (i.e.
 *    the Provider is mounted but nobody ever rendered a <ViewHeaderOutletSlot>)
 *    we log once via `logger.warn`. Matches the "Floating UI lifecycle
 *    logging" convention in AGENTS.md.
 */

import type React from 'react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { logger } from '../lib/logger'
import { useViewHeaderOutlet } from './ViewHeaderOutlet'

interface ViewHeaderProps {
  /** Inner header content — rendered via portal into the outlet. */
  readonly children: React.ReactNode
}

/**
 * Module-scoped Set that dedupes the "outlet not resolved" warning across
 * all <ViewHeader> instances. The outlet is a singleton owned by the
 * provider, so a view that renders N <ViewHeader>s before the slot mounts
 * would otherwise log N times in one paint. The Set is keyed by warning
 * kind (currently a single key) to keep the structure flexible if more
 * lifecycle warnings are added later. Entries are cleared when an outlet
 * eventually resolves so a subsequent detach/reattach cycle can warn again.
 */
const warnedOutletKeys = new Set<string>()
const WARN_OUTLET_NOT_RESOLVED = 'outlet-not-resolved'

/**
 * Test-only helper — clears the module-scoped warned-keys Set so each test
 * starts from a clean state. Not part of the public API; do not call from
 * production code.
 *
 * @internal
 */
export function __resetViewHeaderWarningsForTest(): void {
  warnedOutletKeys.clear()
}

/**
 * Portal wrapper that renders `children` into the shared outlet element.
 * See module docstring for lifecycle / fallback semantics.
 */
export function ViewHeader({ children }: ViewHeaderProps): React.ReactElement | null {
  const outlet = useViewHeaderOutlet()

  // Defer the warn via setTimeout so the common initial-mount race (slot's
  // ref callback hasn't run yet → outlet is null for the first commit)
  // doesn't produce a false positive. If the re-render from the slot's
  // `setOutlet` fires before the timer, the cleanup cancels the warn and we
  // stay quiet. If the outlet is genuinely never wired up, the timer fires
  // and we log once total (across all ViewHeader instances).
  useEffect(() => {
    if (outlet) {
      // Outlet wired up — clear so a later detach cycle can warn again.
      warnedOutletKeys.delete(WARN_OUTLET_NOT_RESOLVED)
      return
    }
    if (outlet !== null) return // undefined — no provider, inline path
    if (warnedOutletKeys.has(WARN_OUTLET_NOT_RESOLVED)) return
    // Claim the warning slot synchronously so concurrently-mounting
    // siblings don't each schedule their own timer.
    warnedOutletKeys.add(WARN_OUTLET_NOT_RESOLVED)
    const id = setTimeout(() => {
      logger.warn(
        'ViewHeader',
        'Portal mount attempted before outlet resolved; header will render on next commit',
      )
    }, 0)
    return () => clearTimeout(id)
  }, [outlet])

  if (outlet === undefined) {
    // No provider — render inline. Intentional graceful degradation for
    // isolated tests / embeddings without the outlet.
    return <>{children}</>
  }

  if (outlet === null) {
    // Provider present but outlet element not attached yet. Skip this commit;
    // the ref callback will trigger a re-render.
    return null
  }

  return createPortal(children, outlet)
}
