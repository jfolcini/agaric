/**
 * Per-page block store — Zustand store instances scoped to individual pages.
 *
 * Each mounted BlockTree gets its own store via React context. This fixes
 * the multi-BlockTree conflict in weekly/monthly journal views where a
 * single global store caused the last load() to win for all instances.
 *
 * Pattern: createStore() factory + React context + module-level registry.
 *
 * ## Usage
 *
 * ```tsx
 * // Provider at BlockTree call site (PageEditor, DaySection)
 * <PageBlockStoreProvider pageId={pageId}>
 *   <BlockTree ... />
 * </PageBlockStoreProvider>
 *
 * // Consumer inside the provider tree
 * const blocks = usePageBlockStore((s) => s.blocks)
 * const store = usePageBlockStoreApi()
 * store.getState().load()
 * ```
 */

import { createContext, createElement, useContext, useEffect, useRef } from 'react'
import { createStore, type StoreApi, useStore } from 'zustand'

import { validationCode } from '@/lib/app-error'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { INTERACTIONS, traceInteraction } from '@/lib/observability'
import { consumePrefetchedPageSubtree } from '@/lib/prefetch-page-subtree'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { loadPageSubtree } from '@/lib/tauri'
import { buildFlatTree } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { buildBlocksById } from '@/stores/page-blocks-map'
import { createReducers } from '@/stores/page-blocks-reducers'
import type { PageBlockState } from '@/stores/page-blocks-types'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

// #2254 — `PageBlockState` and `FlatBlock` now live in `page-blocks-types.ts`;
// re-export them so every existing consumer keeps importing from `page-blocks`.
export type { FlatBlock, PageBlockState } from '@/stores/page-blocks-types'

/**
 * Augment an external `setState` partial so that callers passing only
 * `{ blocks: [...] }` get `blocksById` derived automatically. If the caller
 * supplies an explicit `blocksById` (e.g. fine-grained tests of the invariant),
 * it is honoured as-is.
 */
function augmentBlocksUpdate<T extends Partial<PageBlockState> | PageBlockState | null | undefined>(
  update: T,
): T {
  if (update == null) return update
  const obj = update as Partial<PageBlockState>
  const touchesBlocks = Object.hasOwn(obj, 'blocks')
  const hasMap = Object.hasOwn(obj, 'blocksById')
  if (!touchesBlocks || hasMap) return update
  const blocks = obj.blocks ?? []
  return { ...update, blocksById: buildBlocksById(blocks) } as T
}

/**
 * #713 — ownership gate for document-level BlockTree listeners.
 *
 * Journal week/month views mount one BlockTree (and one copy of every
 * document-level listener) per day, all sharing the GLOBAL `focusedBlockId`
 * from `useBlockStore`. A tree's listener may only act when its OWN page
 * store actually contains the focused block; otherwise N trees race
 * conflicting IPCs (e.g. todo cycling computed from a store where the block
 * doesn't exist → `current = null` → wrong next state). Non-owning trees
 * must return WITHOUT side effects and WITHOUT `preventDefault()`.
 */
export function storeOwnsBlock(
  store: StoreApi<PageBlockState>,
  blockId: string | null,
): blockId is string {
  return blockId != null && store.getState().blocksById.has(blockId)
}

// ── Store factory ────────────────────────────────────────────────────────

export function createPageBlockStore(pageId: string): StoreApi<PageBlockState> {
  /** Guard: block IDs currently being split. Prevents re-entrant splitBlock calls. */
  const splitInProgress = new Set<string>()

  /**
   * #774 — per-block mover serialization queue. The sibling-slot movers
   * (`moveUp`/`moveDown`/`indent`/`dedent`/`reorder`) capture their target
   * indices from `get()` state at the START of the action body, BEFORE the
   * `move_block` IPC awaits. A rapid double moveUp/moveDown fired before the
   * first resolved therefore computed BOTH requests from the same pre-move
   * snapshot: the second re-stated the first move's slot, so the two presses
   * collapsed into one backend move (lost intent — FE/BE stayed consistent,
   * but the block only moved one slot). Chaining each block's movers so the
   * next one runs only after the previous settles makes the second request
   * read the post-first-move state and target the correct next slot.
   *
   * Keyed by block id — moves of DIFFERENT blocks stay concurrent. The chain
   * swallows the predecessor's rejection (each mover owns its own try/catch
   * and never throws) before running the next link, so one failed move does
   * not strand the queue.
   */
  const moverQueue = new Map<string, Promise<unknown>>()
  function enqueueMove<T>(blockId: string, run: () => Promise<T>): Promise<T> {
    const prev = moverQueue.get(blockId)
    // When NO move for this block is in flight, run SYNCHRONOUSLY (up to the
    // first await inside `run`). This preserves the existing contract that a
    // mover captures its pre-await `get()` snapshot and dispatches its
    // `move_block` IPC synchronously with the call — the #714 stale-capture
    // races depend on it, and a lone move must not eat an extra microtask.
    // Only when a predecessor is still settling do we chain, so the queued
    // second press reads the post-first-move state (the #774 fix).
    const next: Promise<T> = prev ? prev.then(run, run) : run()
    // Keep the queue map from growing unbounded: once THIS link is the tail,
    // drop it so an idle block leaves no retained promise.
    moverQueue.set(blockId, next)
    void next.finally(() => {
      if (moverQueue.get(blockId) === next) moverQueue.delete(blockId)
    })
    return next
  }

  /**
   * #753 — load generation counter. `rootParentId` is immutable for the
   * lifetime of a per-page store, so the old "discard if rootParentId
   * changed" guard never fired for the real race: two overlapping
   * `load()` calls for the SAME page (sync:complete reload racing a
   * mount load) resolved last-write-wins, letting the staler snapshot
   * clobber the fresher one. Each `load()` claims a generation at start;
   * after every await it checks it is still the newest claimant and
   * discards its result otherwise (latest-started load wins).
   */
  let loadGeneration = 0

  const store = createStore<PageBlockState>((set, get) => ({
    blocks: [],
    blocksById: new Map(),
    rootParentId: pageId,
    loading: true,
    truncatedTotal: null,

    getBlockById: (id: string) => get().blocksById.get(id),

    load: async () => {
      // FE-H-22 — fail closed during pre-bootstrap. Earlier we forwarded
      // `useSpaceStore.getState().currentSpaceId ?? ''` to `listBlocks`
      // and relied on the backend treating `''` as a no-match SQL
      // filter. That contract is unwritten; a backend change to
      // interpret `''` as wildcard would silently leak cross-space
      // blocks into the page tree. Skip the fetch and leave state
      // (including the initial `loading: true`) untouched — the boot
      // sequence hydrates the space store before any BlockTree mounts,
      // so this branch is a defensive no-op rather than a hot path.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) return
      const rootParentId = get().rootParentId
      if (rootParentId == null) return
      // #753 — claim a generation (see `loadGeneration` doc above).
      const generation = ++loadGeneration
      set({ loading: true })
      try {
        const start = performance.now()
        // #773 — capture the index as of load START. The backend snapshot
        // below can only know about blocks that existed when its query ran,
        // so "absent from the snapshot" is evidence of remote deletion ONLY
        // for blocks that were already here before the await. A block
        // optimistically spliced in mid-flight (createBelow committing while
        // this SELECT is in flight, then focused via Enter) lands in the
        // commit-time map but never in the snapshot — it must NOT trip the
        // focus-clear branch.
        const preLoadBlocksById = get().blocksById
        // Single-SELECT descendant load via the materializer-maintained
        // `page_id` index — replaces the recursive per-parent
        // `listBlocks` walk that silently clamped each level to 100.
        // #2850 — the ONLY seam a speculative hover/focus prefetch gets:
        // if a live one-shot prefetch promise was parked for this exact
        // `(spaceId, rootParentId)`, consume (and thereby delete) it instead
        // of firing a fresh IPC.
        //
        // CRITICAL — consume ONLY on the initial navigation load
        // (`generation === 1`). `load()` is ALSO the reload path driven by
        // sync/remote `blocks:changed` (`useSyncEvents`), undo/redo
        // (`useUndoShortcuts`), header ops, and post-move. A prefetch can be
        // parked for the CURRENTLY-OPEN page (palette-highlight its recents
        // row then Escape — which cancels only the dwell timer, not an
        // already-fired prefetch; a viewport/hover auto-prefetch of the open
        // row; a self-link), and it lives up to `PREFETCH_TTL_MS`. Serving
        // that pre-mutation snapshot to a reload fired precisely to show the
        // NEW state (e.g. Ctrl+Z, or a just-synced remote edit) would render
        // stale content for one cycle. Gating on `generation === 1` (the
        // store's first-ever real load, i.e. genuine navigation — reloads
        // reuse the store at generation >= 2) confines the handoff to the
        // first-open latency it was designed for; a prefetch left parked for
        // the open page simply expires unconsumed. EVERYTHING below this line
        // is unchanged and runs identically regardless of which source
        // produced `subtree`: the `#753` generation guard, focused-block
        // preservation, the #798 selection prune, and the `PageNotInSpace`
        // rejection/heal in the catch block.
        // #2110 (M4) — trace the page-open data load. `loadPageSubtree`
        // dispatches its IPC synchronously inside the callback, so the backend
        // command + SQLite/materializer spans parent under this interaction.
        const subtree = await traceInteraction(
          INTERACTIONS.PAGE_OPEN,
          () =>
            (generation === 1 ? consumePrefetchedPageSubtree(spaceId, rootParentId) : null) ??
            loadPageSubtree(rootParentId, spaceId),
        )
        const allBlocks = subtree.blocks
        // Defensive: discard if rootParentId changed (shouldn't happen with per-page stores)
        if (get().rootParentId !== rootParentId) return
        // #753 — a newer load() started while this snapshot was in
        // flight; discard the stale result and let the newer load own
        // the store (including its `loading` flag).
        if (generation !== loadGeneration) return
        let newBlocks = buildFlatTree(allBlocks, rootParentId)

        // Preserve focused block's content during sync reload to prevent
        // visual flash and store/editor divergence
        const focusedBlockId = useBlockStore.getState().focusedBlockId
        if (focusedBlockId) {
          const currentBlock = get().blocksById.get(focusedBlockId)
          if (currentBlock) {
            if (newBlocks.some((b) => b.id === focusedBlockId)) {
              newBlocks = newBlocks.map((b) =>
                b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
              )
            } else if (preLoadBlocksById.has(focusedBlockId)) {
              // #773 — sync-delete focus reconciliation. The focused block
              // lived in THIS store both when the load STARTED and now (so
              // this store owns the focus, mirroring the storeOwnsBlock gate
              // from #713) but is gone from the fresh backend snapshot — a
              // remote sync deleted it. Clear the global focus, otherwise
              // every tree fail-closes on the phantom id and block chords go
              // dead until the user clicks. Stores that never held the block
              // (other pages, fresh mounts where blocksById is still empty)
              // skip this branch, so ordinary navigation loads cannot
              // spuriously clear focus that is managed elsewhere. The
              // load-START check (`preLoadBlocksById`) keeps blocks created
              // and focused while this load was in flight — invisible to the
              // backend snapshot, so their absence proves nothing — from
              // being mistaken for remote deletions. `setFocused(null)` also
              // clears the coupled selection state, matching every other
              // focus-clear path in the app.
              useBlockStore.getState().setFocused(null)
            }
          }
        }

        // #798 — prune remotely-deleted ids from the global multi-selection.
        // Mirrors the #773 focus reconciliation above but for the coupled
        // selection set: a NON-focused block that lived in THIS store when
        // the load STARTED (`preLoadBlocksById`) but is gone from the fresh
        // backend snapshot was remotely deleted. Left in `selectedBlockIds`,
        // batch ops would target a dead block (a silent backend no-op via
        // idempotency, but selection-count badges would lie). Surviving ids
        // and ids this store never owned (managed by another tree, or
        // optimistically created mid-load and absent from the snapshot — same
        // load-START guard as #773) are preserved untouched, and the update
        // only fires when something actually changed.
        const survivingIds = new Set(newBlocks.map((b) => b.id))
        const { selectedBlockIds, setSelected } = useBlockStore.getState()
        if (selectedBlockIds.length > 0) {
          const pruned = selectedBlockIds.filter(
            (id) => survivingIds.has(id) || !preLoadBlocksById.has(id),
          )
          if (pruned.length !== selectedBlockIds.length) setSelected(pruned)
        }

        // #1258 — surface the backend truncation signal. `truncated` means
        // the page exceeded PAGE_SUBTREE_MAX_BLOCKS and `subtree.total` is the
        // true descendant count; store it so BlockTree can render a
        // non-blocking notice. `null` clears any prior page's signal.
        const truncatedTotal = subtree.truncated ? subtree.total : null
        set({
          blocks: newBlocks,
          blocksById: buildBlocksById(newBlocks),
          loading: false,
          truncatedTotal,
        })
        logger.debug('page-blocks', 'page loaded', {
          pageId: rootParentId ?? '',
          blockCount: newBlocks.length,
          durationMs: Math.round(performance.now() - start),
        })
      } catch (err) {
        if (get().rootParentId !== rootParentId) return
        // #753 — a stale failed load must not stomp the newer load's
        // `loading: true` (or double-toast for a snapshot nobody wants).
        if (generation !== loadGeneration) return
        set({ loading: false })
        // #2802 / #2810 — space-membership rejection. `load_page_subtree`
        // scopes the fetch to the ACTIVE space and rejects with a
        // `ValidationCode.PageNotInSpace`-coded AppError ("block '…' not in
        // current space '…'", `load_page_subtree_inner` in
        // src-tauri/src/commands/pages/listing.rs; the tauri-mock mirrors the
        // shape) when the page no longer belongs to it — i.e. the page was
        // moved to another space and a stale old-space reference (a surviving
        // tab-stack entry or recent-pages item) was just followed. That is
        // expected staleness, not a load failure: show a soft notice instead
        // of the raw error toast, and self-heal the stale state the same way
        // the delete flow handles "this page is no longer valid in the
        // current view" (`usePageDeleteAction` → `onBack`, and #2803's move
        // handler): drop the page from the active space's recent-pages MRU
        // (the click itself just re-recorded it via `recordVisit`) and, when
        // this page sits on top of the active tab's stack, pop it via the
        // existing `goBack()` — which also closes the tab / falls back to the
        // pages view when the stack empties, exactly like delete. There is
        // deliberately NO eager purge sweep across the old space's tab stacks
        // at move time: page deletion doesn't purge tabs/recent-pages either,
        // so stale refs heal lazily here at the rejection point. The active
        // space is NOT switched to follow the page (see #2785's note in
        // PageHeader.handleMoveToSpace). #2810 — key the heal on the
        // structured `PageNotInSpace` code rather than the generic
        // `kind: 'validation'` (message-regexing was retired in #2251): a
        // malformed id is `kind: 'ulid'` (`BlockId::from_string`), the
        // `require_active` Global-scope rejection can't fire because
        // `requireActiveScope` always dispatches an active scope, and any
        // future uncoded/differently-coded validation on this command path
        // must NOT silently reroute into this heal. A well-formed id that
        // matches NO row (page hard-purged) surfaces the same
        // `PageNotInSpace` rejection — an equally dead reference for which
        // this cleanup is the sane outcome.
        if (validationCode(err) === ValidationCode.PageNotInSpace) {
          // Heal only when the space this load was SCOPED to is still the
          // active space. The rejection can land after the user already
          // switched spaces (e.g. followed the page into its new home) —
          // `removeRecentPage` keys on the CURRENT active space and
          // `goBack()` pops the CURRENT active slice, so healing then would
          // purge a legitimate recents entry / pop a legitimate tab in the
          // wrong space. Skipping is safe: the heal is lazy by design and
          // re-fires the next time the stale reference is followed.
          if (useSpaceStore.getState().currentSpaceId !== spaceId) return
          logger.warn('page-blocks', 'page not in current space — healing stale reference', {
            rootParentId: rootParentId ?? '',
          })
          notify.info(i18n.t('error.pageNotInCurrentSpace'), { id: 'page-not-in-space' })
          useRecentPagesStore.getState().removeRecentPage(rootParentId)
          const tabsState = useTabsStore.getState()
          if (selectPageStack(tabsState).at(-1)?.pageId === rootParentId) {
            tabsState.goBack()
          }
          return
        }
        logger.error(
          'page-blocks',
          'Failed to load blocks',
          {
            rootParentId: rootParentId ?? '',
          },
          err,
        )
        notify.error(i18n.t('error.loadBlocksFailed'), { id: 'load-blocks-failed' })
      }
    },

    // #2254 — the ~13 mutation reducers moved verbatim to
    // `page-blocks-reducers.ts` (behavior-preserving). They close over this
    // store's `set`/`get` plus the per-store `splitInProgress` guard and
    // `enqueueMove` serializer created above.
    ...createReducers({ set, get, splitInProgress, enqueueMove }),
  }))

  // G — escape hatch for external callers (tests, ad-hoc setState).
  // Wrap `store.setState` so callers passing only `{ blocks: [...] }` get
  // `blocksById` derived automatically. Internal `set(...)` calls inside the
  // factory already maintain the Map atomically and bypass this wrap.
  const origSetState = store.setState
  store.setState = ((partial: unknown, replace?: unknown) => {
    if (typeof partial === 'function') {
      const updater = partial as (state: PageBlockState) => Partial<PageBlockState> | PageBlockState
      return (origSetState as (p: unknown, r?: unknown) => void)(
        (state: PageBlockState) => augmentBlocksUpdate(updater(state)),
        replace,
      )
    }
    return (origSetState as (p: unknown, r?: unknown) => void)(
      augmentBlocksUpdate(partial as Partial<PageBlockState>),
      replace,
    )
  }) as typeof store.setState

  return store
}

// ── Store registry ───────────────────────────────────────────────────────

/**
 * #1075 — single source of truth for per-page stores.
 *
 * The store a `PageBlockStoreProvider` hands to its React context (created
 * once in `useRef`) is the SAME instance this registry exposes via
 * {@link getPageStore}. Global hooks (useSyncEvents, useUndoShortcuts,
 * useJournalBlockCreation) that must reload a specific page from OUTSIDE a
 * provider tree resolve that exact instance — so `getPageStore(pageId)
 * .getState().load()` reloads the very store the editor is rendering from,
 * preserving the in-place reload the undo path (`refreshAfterUndoRedo`)
 * depends on.
 *
 * **Ref-counting (the same-pageId race).** Each pageId owns ONE slot tagged
 * with a reference count. A provider's mount EFFECT either creates the slot
 * (count 1) or, when one already exists, adopts its own store into the slot
 * and bumps the count; its cleanup decrements and deletes the slot only when
 * the count returns to zero. This is purely a reference-count over the
 * existing `useEffect`-timed registration — NOT a timing change — so a
 * transient remount for the same pageId (old provider unmounting while the new
 * one mounts, in either order) can never drop a slot a still-mounted provider
 * needs. The monthly view mounts up to 30 PageBlockStoreProviders for
 * DISTINCT pageIds (one slot each, count 1); only a genuine same-pageId
 * overlap shares a slot.
 *
 * External consumers MUST go through {@link getPageStore} /
 * {@link forEachPageStore} rather than reading the map directly.
 */
interface PageBlockRegistrySlot {
  /**
   * Canonical store consumers see — the most-recently-mounted live provider's
   * store. Always references an entry in {@link liveStores} (never an
   * unmounted store while any provider for the pageId remains).
   */
  store: StoreApi<PageBlockState>
  refCount: number
  /**
   * #1560 — every still-mounted provider's store for this pageId, in mount
   * order (newest last). Lets `unregisterPageStore` re-point `store` to a
   * surviving provider when the slot owner unmounts out of order, instead of
   * stranding the slot on an unmounted store. Length stays in lockstep with
   * `refCount`.
   */
  liveStores: StoreApi<PageBlockState>[]
}

const pageBlockSlots = new Map<string, PageBlockRegistrySlot>()

/**
 * Register a provider's store under `pageId`, returning the canonical store
 * for that page. Called from the provider's mount `useEffect`.
 *
 * If no slot exists, this provider's store becomes the canonical one
 * (refCount 1). If a slot already exists (a concurrent same-pageId provider),
 * the slot ADOPTS this newest provider's store and bumps the count — so
 * `getPageStore` tracks the most-recently-mounted (active) provider while the
 * count keeps the slot alive for any older provider still mounted.
 */
function registerPageStore(pageId: string, store: StoreApi<PageBlockState>): void {
  const slot = pageBlockSlots.get(pageId)
  if (slot) {
    slot.store = store
    slot.refCount += 1
    slot.liveStores.push(store)
  } else {
    pageBlockSlots.set(pageId, { store, refCount: 1, liveStores: [store] })
  }
}

/**
 * Release one reference to `pageId`'s slot (from the provider's cleanup).
 * Deletes the slot — and clears the page's session undo state (#753) — only
 * when the LAST reference drops, so a stale unmount cannot clobber a slot a
 * newer mount still holds.
 *
 * #1560 — providers for the same pageId can unmount out of order (the
 * slot-owning newest provider first). The caller passes the unmounting
 * provider's `store` so we can drop exactly that entry and, when it was the
 * canonical `slot.store`, re-point the slot at a still-live provider instead
 * of leaving `slot.store` dangling at an unmounted store.
 */
function unregisterPageStore(pageId: string, store: StoreApi<PageBlockState>): void {
  const slot = pageBlockSlots.get(pageId)
  if (!slot) return
  const idx = slot.liveStores.lastIndexOf(store)
  if (idx !== -1) slot.liveStores.splice(idx, 1)
  slot.refCount -= 1
  if (slot.refCount > 0) {
    // If the slot owner just unmounted out of order, adopt the newest
    // surviving provider so the slot never references an unmounted store.
    const newest = slot.liveStores.at(-1)
    if (slot.store === store && newest !== undefined) {
      slot.store = newest
    }
    return
  }
  pageBlockSlots.delete(pageId)
  // #753 — drop the page's session undo state alongside the registry slot.
  // PageEditor already clears on navigation away, but journal day pages
  // (DaySection mounts one provider per day) had NO clear path — every
  // visited day accumulated up to MAX_REDO_STACK OpRefs in the undo store for
  // the whole session.
  useUndoStore.getState().clearPage(pageId)
}

/**
 * Resolve the live store for `pageId` from outside a provider tree. Returns
 * the EXACT instance the active provider hands to its React context, or
 * `undefined` when no provider for that page is mounted.
 */
export function getPageStore(pageId: string): StoreApi<PageBlockState> | undefined {
  return pageBlockSlots.get(pageId)?.store
}

/**
 * Iterate every currently-mounted page store (one per pageId). Replaces the
 * old `pageBlockRegistry.entries()` fan-out in useSyncEvents.
 */
export function forEachPageStore(
  fn: (pageId: string, store: StoreApi<PageBlockState>) => void,
): void {
  for (const [pageId, slot] of pageBlockSlots) fn(pageId, slot.store)
}

// ── React context ────────────────────────────────────────────────────────

export const PageBlockContext = createContext<StoreApi<PageBlockState> | null>(null)

/**
 * Provider that creates a per-page store instance and registers it.
 *
 * Wrap each BlockTree call site in this provider:
 * - PageEditor: `<PageBlockStoreProvider pageId={pageId}>`
 * - DaySection: `<PageBlockStoreProvider pageId={entry.pageId}>`
 */
export function PageBlockStoreProvider({
  pageId,
  children,
}: {
  pageId: string
  children: React.ReactNode
}): React.ReactElement {
  const storeRef = useRef<{ store: StoreApi<PageBlockState>; pageId: string } | null>(null)
  if (!storeRef.current || storeRef.current.pageId !== pageId) {
    storeRef.current = { store: createPageBlockStore(pageId), pageId }
  }

  const store = storeRef.current.store

  // #1075 — register THIS provider's context store in the ref-counted slot
  // registry, on the SAME `useEffect` timing as before (no useLayoutEffect).
  // `store` is the very instance the context provides below (created once in
  // `useRef`), so `getPageStore(pageId)` returns exactly what consumers inside
  // the tree see — one source of truth. Ref-counting (register/unregister)
  // handles ONLY the same-pageId mount/unmount race: a transient remount can
  // never drop a slot a still-mounted provider needs. `store` is stable for a
  // given pageId (storeRef swaps it only when pageId changes), so including it
  // in the deps adds no extra runs.
  useEffect(() => {
    registerPageStore(pageId, store)
    return () => unregisterPageStore(pageId, store)
  }, [pageId, store])

  return createElement(PageBlockContext.Provider, { value: store }, children)
}

/**
 * Hook to subscribe to per-page block state with a selector.
 *
 * Must be called inside a PageBlockStoreProvider.
 */
export function usePageBlockStore<T>(selector: (state: PageBlockState) => T): T {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStore must be used within a PageBlockStoreProvider')
  return useStore(store, selector)
}

/**
 * #1445 — a no-provider fallback store. Some components that host per-page UI
 * (e.g. `SortableBlock`) are also rendered in isolation by tests WITHOUT a
 * `PageBlockStoreProvider`. `usePageBlockStoreOptional` subscribes to this
 * empty store in that case so the hook stays unconditional (rules of hooks)
 * and never throws — selectors simply see an empty page (no blocks, null root).
 */
const emptyPageBlockStore = createPageBlockStore('')

/**
 * Like {@link usePageBlockStore}, but tolerant of being called OUTSIDE a
 * `PageBlockStoreProvider`: instead of throwing it falls back to a shared empty
 * store. Use this for optional, non-critical reads (e.g. resolving the
 * containing page id for a context-menu affordance) where the absence of a
 * provider should degrade gracefully rather than crash.
 */
export function usePageBlockStoreOptional<T>(selector: (state: PageBlockState) => T): T {
  const store = useContext(PageBlockContext)
  return useStore(store ?? emptyPageBlockStore, selector)
}

/**
 * Hook to get the raw StoreApi for imperative access (getState/setState).
 *
 * Must be called inside a PageBlockStoreProvider.
 */
export function usePageBlockStoreApi(): StoreApi<PageBlockState> {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStoreApi must be used within a PageBlockStoreProvider')
  return store
}
