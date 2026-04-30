/**
 * useAppSpaceLifecycle — space-driven side-effects extracted from
 * App.tsx (MAINT-124 step 4 / stretch).
 *
 * Three effects, each retained as a separate `useEffect` to preserve
 * the decoupling that the original App.tsx comments call out:
 *
 * 1. Resolve cache preload (FEAT-3p7) — preload pages + tags for the
 *    current space whenever `currentSpaceId` changes. Boot races
 *    between this effect and `refreshAvailableSpaces()` are tolerated
 *    — the first pass may run with `currentSpaceId == null` and a
 *    second pass runs once the space store hydrates.
 * 2. Cross-space link enforcement (FEAT-3p7) — on space switch, flush
 *    BOTH the short-query pages list AND every cache entry keyed
 *    under the previous space, so a chip whose ULID belongs to the
 *    previous space cannot silently navigate the user across the
 *    space boundary on click.
 * 3. Visual identity (FEAT-3p10) — re-bind the `--accent-current` CSS
 *    variable on `document.documentElement` and re-stamp the OS
 *    window title as `"<SpaceName> · Agaric"`. `setWindowTitle`
 *    no-ops outside Tauri (vitest jsdom).
 *
 * The hook subscribes internally to `useSpaceStore` for the space
 * inputs (App.tsx already subscribes for AppSidebar; the redundant
 * Zustand subscription is cheap and dedups).
 */

import { useEffect, useRef } from 'react'
import { setWindowTitle } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

export function useAppSpaceLifecycle(): void {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)

  // Preload the resolve cache (pages + tags) once on app boot, and
  // again whenever the active space changes (FEAT-3p7).
  useEffect(() => {
    useResolveStore.getState().preload(currentSpaceId ?? undefined)
  }, [currentSpaceId])

  // FEAT-3p7 — Cross-space link enforcement. Order matters: read
  // `prevSpaceIdRef.current` BEFORE touching anything so we know which
  // prefix to flush, then update the ref so the next switch sees the
  // now-current space as the next "previous". Kept in its own effect
  // (separate from the visual-identity effect below) so the two
  // concerns stay decoupled.
  const prevSpaceIdRef = useRef<string | null>(currentSpaceId)
  useEffect(() => {
    const prev = prevSpaceIdRef.current
    if (prev != null && prev !== currentSpaceId) {
      useResolveStore.getState().clearAllForSpace(prev)
    }
    useResolveStore.getState().clearPagesList()
    prevSpaceIdRef.current = currentSpaceId
  }, [currentSpaceId])

  // FEAT-3p10 — visual identity. Kept in its own effect (not folded
  // into the `clearPagesList` effect above) so the two concerns stay
  // decoupled. `setWindowTitle` is a no-op in non-Tauri runtimes
  // (vitest jsdom, storybook).
  useEffect(() => {
    const accentToken = useSpaceStore.getState().getCurrentAccent()
    document.documentElement.style.setProperty('--accent-current', `var(--${accentToken})`)

    const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId) ?? null
    const titleText =
      activeSpace != null && activeSpace.name !== ''
        ? `${activeSpace.name} \u00b7 Agaric`
        : 'Agaric'
    void setWindowTitle(titleText)
  }, [currentSpaceId, availableSpaces])
}
