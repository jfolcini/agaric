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

import { useEffect } from 'react'
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
  useEffect(() => {
    if (!open) return
    const bridge = bridgeForMode(mode)
    const seed = useSearchSheetStore.getState().query
    const openedByUs = !bridge.isOpen()
    if (openedByUs) bridge.open()
    // Only seed from the bridge when WE opened the store. Overwriting
    // a pre-existing session's query would be a destructive
    // side-effect that originated from a totally different surface.
    if (openedByUs && seed.length > 0) bridge.setQuery(seed)
    // Mirror the segment's query → the sheet store as the user types.
    // Selector-form subscribe so the listener only fires on query
    // changes (not every matcher chunk).
    const unsub = bridge.subscribeQuery((q) => {
      if (q !== useSearchSheetStore.getState().query) {
        useSearchSheetStore.setState({ query: q })
      }
    })
    return () => {
      unsub()
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
