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
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { logger } from '../lib/logger'
import { useViewHeaderOutlet } from './ViewHeaderOutlet'

interface ViewHeaderProps {
  /** Inner header content — rendered via portal into the outlet. */
  readonly children: React.ReactNode
}

/**
 * Portal wrapper that renders `children` into the shared outlet element.
 * See module docstring for lifecycle / fallback semantics.
 */
export function ViewHeader({ children }: ViewHeaderProps): React.ReactElement | null {
  const outlet = useViewHeaderOutlet()
  const warnedRef = useRef(false)

  // Defer the warn via setTimeout so the common initial-mount race (slot's
  // ref callback hasn't run yet → outlet is null for the first commit)
  // doesn't produce a false positive. If the re-render from the slot's
  // `setOutlet` fires before the timer, the cleanup cancels the warn and we
  // stay quiet. If the outlet is genuinely never wired up, the timer fires
  // and we log once per mount.
  useEffect(() => {
    if (outlet) {
      // Reset so a later detach cycle can warn again.
      warnedRef.current = false
      return
    }
    if (warnedRef.current) return
    if (outlet !== null) return // undefined — no provider, inline path
    const id = setTimeout(() => {
      warnedRef.current = true
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
