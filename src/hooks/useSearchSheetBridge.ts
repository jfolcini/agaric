/**
 * useSearchSheetBridge — lifecycle bridge between the mobile search
 * sheet and the two embedded segment stores (`useInPageFindStore` /
 * `useCommandPaletteStore`).
 *
 * Each segment's store is opened on entry; only the store WE opened
 * is closed on cleanup, so a pre-existing desktop session (Cmd+K
 * opened on a keyboard-iPad before the sheet activated) survives
 * intact. The sheet store's `query` is the bridge: on entry the new
 * segment is seeded from it (but only when WE opened the store —
 * never overwrite a desktop session's query); a selector-form
 * subscription mirrors the segment's query back into the sheet on
 * every change so the next segment-switch round-trips cleanly.
 *
 * Container repopulation: `useInPageFindStore.setContainer(null)`
 * also flips its `open` to false (see `useInPageFindStore.ts`). The
 * bridge's main effect won't notice — its deps are `[open, mode]`,
 * not the find store's state — so a secondary effect re-opens the
 * find store when (sheet is open in in-page mode AND container is
 * back AND store is closed). The empty-state in `<SearchSheet>`
 * covers the gap while container is null.
 *
 * Selector-form subscriptions: zustand's `subscribe(selector, listener)`
 * only invokes the listener when the selector's return value changes.
 * The find-in-page matcher writes the store per chunk (~50 nodes), so
 * a plain `subscribe(listener)` would fire 200+ times per long-page
 * walk; the selector form gates on `state.query` and dedupes.
 */

import { useEffect, useRef } from 'react'
import { useCommandPaletteStore } from '../stores/useCommandPaletteStore'
import { useInPageFindStore } from '../stores/useInPageFindStore'
import { type SearchSheetMode, useSearchSheetStore } from '../stores/useSearchSheetStore'

interface BridgeStore {
  isOpen: () => boolean
  open: () => void
  close: () => void
  setQuery: (q: string) => void
  subscribeQuery: (listener: (q: string) => void) => () => void
}

/**
 * Hand-rolled selector-form subscribe. The underlying stores don't
 * use zustand's `subscribeWithSelector` middleware; the plain
 * `subscribe(listener)` fires on every state mutation, which for the
 * find store happens once per matcher chunk (50 nodes). Wrap it in a
 * closure that remembers the last selected value and only invokes
 * the user listener when it actually changed.
 */
function subscribeToQuery<S extends { query: string }>(
  store: { getState: () => S; subscribe: (listener: (state: S) => void) => () => void },
  listener: (q: string) => void,
): () => void {
  let last = store.getState().query
  return store.subscribe((state) => {
    if (state.query !== last) {
      last = state.query
      listener(state.query)
    }
  })
}

const findBridge: BridgeStore = {
  isOpen: () => useInPageFindStore.getState().open,
  open: () => useInPageFindStore.getState().open$(),
  close: () => useInPageFindStore.getState().close(),
  setQuery: (q) => useInPageFindStore.getState().setQuery(q),
  subscribeQuery: (listener) => subscribeToQuery(useInPageFindStore, listener),
}

const paletteBridge: BridgeStore = {
  isOpen: () => useCommandPaletteStore.getState().open,
  open: () => useCommandPaletteStore.getState().open$(),
  close: () => useCommandPaletteStore.getState().close(),
  setQuery: (q) => useCommandPaletteStore.getState().setQuery(q),
  subscribeQuery: (listener) => subscribeToQuery(useCommandPaletteStore, listener),
}

function bridgeForMode(mode: SearchSheetMode): BridgeStore {
  return mode === 'in-page' ? findBridge : paletteBridge
}

/**
 * Wire the search sheet's lifecycle to the segment-specific store.
 * Returns nothing — pure side effects.
 */
export function useSearchSheetBridge(open: boolean, mode: SearchSheetMode): void {
  // PEND-73 Phase 4.R2 — track the most recent value the bridge wrote
  // INTO the segment store. The subscription listener below mirrors
  // segment → sheet on every observed change; without this ref, our
  // own bridge.setQuery(seed) call below would echo back through the
  // subscription, hit the `q !== sheet.query` guard at the time the
  // sheet's query was still the pre-write value, and re-write the
  // sheet store with the same query. The current store shape no-ops
  // an identical write so it doesn't ping-pong today, but a future
  // store (e.g. the find-in-page matcher writing intermediate
  // post-anchor-normalised queries) could trip a real loop. The ref
  // makes the guard structural rather than incidental.
  const lastWroteRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) return
    const bridge = bridgeForMode(mode)
    const seed = useSearchSheetStore.getState().query
    const openedByUs = !bridge.isOpen()
    if (openedByUs) bridge.open()
    // Only seed from the bridge when WE opened the store. Overwriting
    // a pre-existing session's query would be a destructive
    // side-effect that originated from a totally different surface.
    if (openedByUs && seed.length > 0) {
      lastWroteRef.current = seed
      bridge.setQuery(seed)
    }
    // Mirror the segment's query → the sheet store as the user types.
    // Selector-form subscribe so the listener only fires on query
    // changes (not every matcher chunk). The `lastWroteRef` check
    // suppresses the echo of our own seed write so we don't ping-pong
    // through a future writer that observes intermediate states.
    const unsub = bridge.subscribeQuery((q) => {
      if (q === lastWroteRef.current) {
        // The next bridge update may be from a real user keystroke;
        // clear the ref so we stop suppressing.
        lastWroteRef.current = null
        return
      }
      if (q !== useSearchSheetStore.getState().query) {
        useSearchSheetStore.setState({ query: q })
      }
    })
    return () => {
      unsub()
      lastWroteRef.current = null
      if (openedByUs) bridge.close()
    }
  }, [open, mode])

  // Container repopulation: when the in-page-find store's `container`
  // returns to non-null while the sheet is open in in-page mode and
  // the find store auto-closed itself, reopen it so the embedded
  // toolbar's matcher restarts. Same selector-form pattern as the
  // query subscriptions above.
  useEffect(() => {
    if (!open || mode !== 'in-page') return
    let lastContainer = useInPageFindStore.getState().container
    return useInPageFindStore.subscribe((state) => {
      if (state.container === lastContainer) return
      lastContainer = state.container
      if (state.container != null && !state.open) {
        useInPageFindStore.getState().open$()
      }
    })
  }, [open, mode])
}
