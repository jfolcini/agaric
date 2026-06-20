/**
 * useAppSpaceLifecycle — space-driven side-effects extracted from
 * App.tsx (stretch).
 *
 * Three effects, each retained as a separate `useEffect` to preserve
 * the decoupling that the original App.tsx comments call out:
 *
 * 1. Resolve cache preload — preload pages + tags for the
 *    current space whenever `currentSpaceId` changes. Boot races
 *    between this effect and `refreshAvailableSpaces()` are tolerated
 *    — the first pass may run with `currentSpaceId == null` and a
 *    second pass runs once the space store hydrates.
 * 2. Cross-space link enforcement — on space switch, flush
 *    every resolve-cache entry keyed under the previous space, so a
 *    chip whose ULID belongs to the previous space cannot silently
 *    navigate the user across the space boundary on click.
 * 3. Visual identity — re-bind the `--accent-current` CSS
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
  // Again whenever the active space changes.
  useEffect(() => {
    useResolveStore.getState().preload(currentSpaceId ?? undefined)
  }, [currentSpaceId])

  // Cross-space link enforcement. Order matters: read
  // `prevSpaceIdRef.current` BEFORE touching anything so we know which
  // prefix to flush, then update the ref so the next switch sees the
  // now-current space as the next "previous". Kept in its own effect
  // (separate from the visual-identity effect below) so the two
  // concerns stay decoupled. (#753 — the dead `pagesList` mirror that
  // was also flushed here is gone; the picker's short-query cache is
  // the hook-local `pagesListRef` in `useBlockResolve`.)
  const prevSpaceIdRef = useRef<string | null>(currentSpaceId)
  useEffect(() => {
    const prev = prevSpaceIdRef.current
    if (prev != null && prev !== currentSpaceId) {
      useResolveStore.getState().clearAllForSpace(prev)
    }
    prevSpaceIdRef.current = currentSpaceId
  }, [currentSpaceId])

  // Visual identity. Kept in its own effect (not folded
  // into the cache-flush effect above) so the two concerns stay
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
