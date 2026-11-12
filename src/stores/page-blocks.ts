/**
 * Per-page block store: one Zustand store per mounted `BlockTree`, handed down
 * by `PageBlockStoreProvider`, so the journal week and month views, which mount
 * one tree per day, do not share one store where the last `load()` wins.
 *
 * ```tsx
 * <PageBlockStoreProvider pageId={pageId}>
 *   <BlockTree ... />
 * </PageBlockStoreProvider>
 *
 * const blocks = usePageBlockStore((s) => s.blocks)
 * usePageBlockStoreApi().getState().load()
 * ```
 */

import { createContext, createElement, useContext, useEffect, useRef } from 'react'
import { createStore, type StoreApi, useStore } from 'zustand'

import { reloadBaseline, takeReloadedText } from '@/editor/active-editor'
import { isNotFound, unwrap, validationCode } from '@/lib/app-error'
import { commands, type TodoStateBatch, type WithOps } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { INTERACTIONS, traceInteraction } from '@/lib/observability'
import { consumePrefetchedPageSubtree } from '@/lib/prefetch-page-subtree'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { stopReading } from '@/lib/speech/read-aloud'
import { buildFlatTree } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { buildBlocksById, reuseUnchangedBlocks } from '@/stores/page-blocks-map'
import { createReducers } from '@/stores/page-blocks-reducers'
import type { PageBlockState } from '@/stores/page-blocks-types'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

export type { FlatBlock, PageBlockState } from '@/stores/page-blocks-types'

/**
 * Derive `blocksById` for an external `setState` partial that sets only
 * `blocks`; an explicit `blocksById` is honoured as-is.
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
 * Whether this tree's store holds `blockId` (#713). The journal views mount
 * one tree, and one copy of each document listener, per day, all sharing the
 * global `focusedBlockId`; a non-owning tree must act on nothing and call no
 * `preventDefault()`, or the trees race conflicting IPCs.
 */
export function storeOwnsBlock(
  store: StoreApi<PageBlockState>,
  blockId: string | null,
): blockId is string {
  return blockId != null && store.getState().blocksById.has(blockId)
}

/**
 * Register a `document` listener whose handler runs only when `store` owns
 * `blockId` ({@link storeOwnsBlock}), so the #713 gate cannot be forgotten at
 * a call site. `blockId` is captured at registration and reaches `handler`
 * narrowed to `string`. Returns the cleanup; return it from a `useEffect`.
 */
export function addOwnedBlockListener<K extends keyof DocumentEventMap>(
  store: StoreApi<PageBlockState>,
  blockId: string | null,
  type: K,
  handler: (event: DocumentEventMap[K], ownedBlockId: string) => void,
  options?: boolean | AddEventListenerOptions,
): () => void {
  const listener = (event: DocumentEventMap[K]): void => {
    if (!storeOwnsBlock(store, blockId)) return
    handler(event, blockId)
  }
  document.addEventListener(type, listener, options)
  return () => document.removeEventListener(type, listener, options)
}

/**
 * Clear the task state of those of `ids` that hold one, as making them
 * bulleted or numbered does: a task is a third list kind, exclusive with
 * both (#5691). Call it once the list style is written, so a refused write
 * clears nothing. Resolves whether it cleared them all; a failure is logged
 * and told.
 *
 * The clear joins the list style's undo entry by the op refs the batch
 * returns, so one Ctrl+Z gives back the task with the style (#6156).
 */
export async function clearTaskStates(
  pageStore: StoreApi<PageBlockState>,
  ids: readonly string[],
): Promise<boolean> {
  const { blocksById, rootParentId } = pageStore.getState()
  const tasks = ids.filter((id) => (blocksById.get(id)?.todo_state ?? null) !== null)
  if (tasks.length === 0) return true
  let cleared: WithOps<TodoStateBatch>
  try {
    cleared = unwrap(await commands.setTodoStateBatch(tasks, null))
  } catch (err) {
    logger.error('BlockTree', 'Failed to clear the task states of new list blocks', { ids }, err)
    notify.error(i18n.t('blockTree.setTaskStateFailed'))
    return false
  }
  if (rootParentId !== null) useUndoStore.getState().onNewAction(rootParentId, cleared.op_refs)
  const taskSet = new Set(tasks)
  pageStore.setState((s) => ({
    blocks: s.blocks.map((b) => (taskSet.has(b.id) ? { ...b, todo_state: null } : b)),
  }))
  return cleared.updated === tasks.length
}

export function createPageBlockStore(pageId: string): StoreApi<PageBlockState> {
  /** Guard: block IDs currently being split. Prevents re-entrant splitBlock calls. */
  const splitInProgress = new Set<string>()

  /**
   * Blocks whose `create_block` has not answered, each with a promise that
   * settles when it does (#6559). Enter focuses the new block at once and IPC
   * answers arrive out of order, so a write naming such a block, and a load
   * whose snapshot would leave it out, wait for it.
   */
  const createsInFlight = new Map<string, Promise<void>>()

  /**
   * Per-block mover queue (#774). Movers read their target slot from `get()`
   * before the `move_block` await, so two quick presses would compute both
   * requests from one snapshot and move one slot. Chaining each block's movers
   * makes the second read the state after the first. Moves of different
   * blocks stay concurrent; movers never throw, so a failed move does not
   * strand the queue.
   */
  const moverQueue = new Map<string, Promise<unknown>>()
  function enqueueMove<T>(blockId: string, run: () => Promise<T>): Promise<T> {
    const prev = moverQueue.get(blockId)
    // With nothing in flight, run synchronously: a mover dispatches its IPC
    // and applies its provisional splice before its first await, and a lone
    // move must not wait a microtask. Chain only behind a settling predecessor,
    // so the queued press computes against the predecessor's applied move.
    const next: Promise<T> = prev ? prev.then(run, run) : run()
    // Drop the tail once it settles, so an idle block retains no promise.
    moverQueue.set(blockId, next)
    void next.finally(() => {
      if (moverQueue.get(blockId) === next) moverQueue.delete(blockId)
    })
    return next
  }

  /**
   * Load generation (#753): two overlapping `load()`s for the same page (a
   * sync reload racing the mount load) must not let the staler snapshot win.
   * Each load claims a generation and discards its result if a newer one began.
   */
  let loadGeneration = 0

  const store = createStore<PageBlockState>((set, get) => ({
    blocks: [],
    blocksById: new Map(),
    rootParentId: pageId,
    loading: true,
    completedLoads: 0,
    truncatedTotal: null,
    staleFocusedBlock: null,

    getBlockById: (id: string) => get().blocksById.get(id),

    load: async () => {
      // No active space yet: fail closed rather than send an empty space id,
      // which the backend might one day read as a wildcard. Clear `loading`
      // (#2921): with zero spaces nothing else would call `load()` again, and
      // the tree would sit on its skeleton forever.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) {
        set({ loading: false })
        return
      }
      const rootParentId = get().rootParentId
      if (rootParentId == null) return
      // A block created but not yet in the backend would be missing from the
      // snapshot, and read as deleted: its row dropped, the focus on it cleared.
      // A second Enter can start another create while this waits.
      while (createsInFlight.size > 0) await Promise.all(createsInFlight.values())
      const generation = ++loadGeneration
      // What the focused editor was based on as this load started (#6533).
      const startFocusedId = useBlockStore.getState().focusedBlockId
      const startBaseline = startFocusedId ? reloadBaseline(startFocusedId) : null
      set({ loading: true })
      try {
        const start = performance.now()
        // Index as of load start (#773): the snapshot can only miss blocks that
        // existed before the await, so absence proves remote deletion only for
        // those. A block created and focused mid-flight is in neither.
        const preLoadBlocksById = get().blocksById
        // Serve a parked hover/focus prefetch only on the first load
        // (`generation === 1`, #2850). Every later `load()` is a reload fired
        // to show new state (sync, undo, a move), and a prefetch parked for the
        // open page would hand it the pre-mutation snapshot.
        const subtree = await traceInteraction(
          INTERACTIONS.PAGE_OPEN,
          () =>
            (generation === 1 ? consumePrefetchedPageSubtree(spaceId, rootParentId) : null) ??
            commands
              .loadPageSubtree(rootParentId, { kind: 'active', space_id: spaceId })
              .then(unwrap),
        )
        const allBlocks = subtree.blocks
        if (get().rootParentId !== rootParentId) return
        // A newer load started; it owns the store, `loading` included (#753).
        if (generation !== loadGeneration) return
        // Reuse the held object for every unchanged row, so a reload that
        // changed one block does not memo-miss every mounted row (#3321).
        let newBlocks = reuseUnchangedBlocks(
          buildFlatTree(allBlocks, rootParentId),
          get().blocksById,
        )

        // The focused block takes the reloaded text when its editor holds
        // nothing uncommitted, the editor with it; otherwise it keeps the text
        // the editor started from, so store and editor stay one text (#6533).
        const focusedBlockId = useBlockStore.getState().focusedBlockId
        let staleFocusedBlock: PageBlockState['staleFocusedBlock'] = null
        if (focusedBlockId) {
          const currentBlock = get().blocksById.get(focusedBlockId)
          if (currentBlock) {
            const fresh = newBlocks.find((b) => b.id === focusedBlockId)
            if (fresh) {
              if (
                fresh.content !== currentBlock.content &&
                !takeReloadedText(
                  focusedBlockId,
                  fresh.content ?? '',
                  focusedBlockId === startFocusedId ? startBaseline : null,
                )
              ) {
                staleFocusedBlock = { id: focusedBlockId, content: currentBlock.content }
                newBlocks = newBlocks.map((b) =>
                  b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
                )
              }
            } else if (preLoadBlocksById.has(focusedBlockId)) {
              // Here at load start, gone from the snapshot: a remote delete
              // (#773). Clear focus, or every tree fail-closes on the phantom
              // id and block chords go dead. Blocks created mid-load, or
              // removed optimistically before it, never reach this branch.
              useBlockStore.getState().setFocused(null)
            }
          }
        }

        // Prune remotely deleted ids from the selection by the same load-start
        // rule (#798): ids this store never held, or created mid-load, stay.
        const survivingIds = new Set(newBlocks.map((b) => b.id))
        const { selectedBlockIds, setSelected } = useBlockStore.getState()
        if (selectedBlockIds.length > 0) {
          const pruned = selectedBlockIds.filter(
            (id) => survivingIds.has(id) || !preLoadBlocksById.has(id),
          )
          if (pruned.length !== selectedBlockIds.length) setSelected(pruned)
        }

        // The page exceeded `PAGE_SUBTREE_MAX_BLOCKS`; `total` is the true
        // count for BlockTree's notice (#1258). `null` clears a prior signal.
        const truncatedTotal = subtree.truncated ? subtree.total : null
        set({
          blocks: newBlocks,
          blocksById: buildBlocksById(newBlocks),
          loading: false,
          completedLoads: get().completedLoads + 1,
          truncatedTotal,
          staleFocusedBlock,
        })
        logger.debug('page-blocks', 'page loaded', {
          pageId: rootParentId ?? '',
          blockCount: newBlocks.length,
          durationMs: Math.round(performance.now() - start),
        })
      } catch (err) {
        if (get().rootParentId !== rootParentId) return
        // A stale failed load must not stomp the newer load's `loading` (#753).
        if (generation !== loadGeneration) return
        set({ loading: false })
        // The page left the active space (`PageNotInSpace`), or is trashed
        // (`not_found`): a stale tab or recents reference was followed. Show a
        // soft notice and heal: drop it from recents and from every tab
        // (`removePages`; popping only the active tab would land on another
        // tab holding the same page, #5753). Keyed on the structured code, so
        // another validation error never reroutes here (#2810).
        const trashed = isNotFound(err)
        if (trashed || validationCode(err) === ValidationCode.PageNotInSpace) {
          // Heal only if the space this load was scoped to is still active:
          // both removals act on the current space, and the heal re-fires the
          // next time the stale reference is followed.
          if (useSpaceStore.getState().currentSpaceId !== spaceId) return
          logger.warn('page-blocks', 'stale page reference — healing', {
            rootParentId: rootParentId ?? '',
            trashed,
          })
          if (trashed) notify.info(i18n.t('error.pageInTrash'), { id: 'page-in-trash' })
          else notify.info(i18n.t('error.pageNotInCurrentSpace'), { id: 'page-not-in-space' })
          useRecentPagesStore.getState().removeRecentPage(rootParentId)
          useTabsStore.getState().removePages([rootParentId])
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
        notify.retry(i18n.t('error.loadBlocksFailed'), () => void get().load(), {
          id: 'load-blocks-failed',
        })
      }
    },

    // Mutation reducers close over this store's `set`/`get`, the split guard,
    // `createsInFlight` and the mover queue.
    ...createReducers({ set, get, splitInProgress, createsInFlight, enqueueMove }),
  }))

  // External `setState` (tests, ad-hoc callers) derives `blocksById` from
  // `blocks`; the factory's own `set` keeps the map itself.
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

/**
 * Registry of per-page stores (#1075). `getPageStore(pageId)` returns the very
 * instance the provider gives its context, so a reload from outside the tree
 * (sync, undo) reloads what the editor renders.
 *
 * Each pageId has one ref-counted slot: a provider's mount effect creates it
 * or adopts its store into it, and the cleanup deletes it at zero, so a
 * same-page remount (old and new provider, either order) cannot drop a slot a
 * mounted provider needs. Read it through {@link getPageStore} /
 * {@link forEachPageStore}.
 */
interface PageBlockRegistrySlot {
  /** The newest live provider's store; always one of {@link liveStores}. */
  store: StoreApi<PageBlockState>
  refCount: number
  /**
   * Every mounted provider's store for this pageId, oldest first, so an
   * out-of-order unmount can re-point `store` at a survivor (#1560).
   */
  liveStores: StoreApi<PageBlockState>[]
  /**
   * The fan-out unsubscribe per live store. Keyed by store, not index-aligned:
   * `liveStores` is spliced by `lastIndexOf`, and a parallel array would drift.
   */
  mirrorUnsubscribes: Map<StoreApi<PageBlockState>, () => void>
}

const pageBlockSlots = new Map<string, PageBlockRegistrySlot>()

/**
 * Per-page re-entrancy guard for {@link mirrorToSiblings}: each mirrored write
 * fires the sibling's own subscription, and this stops it after one hop.
 */
const mirroringPages = new Set<string>()

/**
 * Fan a store's block state out to the other providers mounted for the same
 * pageId (#4550). Each provider builds its own store, so without this an
 * `{{embed}}` of a page open in a tab kept rendering pre-edit content. Slots
 * with one store (the journal views' day pages) bail at once. `loading` is
 * never mirrored, so a mounting embed cannot flash a skeleton over the source.
 */
function mirrorToSiblings(
  pageId: string,
  source: StoreApi<PageBlockState>,
  state: PageBlockState,
  prev: PageBlockState,
): void {
  if (state.blocks === prev.blocks && state.truncatedTotal === prev.truncatedTotal) return
  const slot = pageBlockSlots.get(pageId)
  if (!slot || slot.liveStores.length < 2) return
  if (mirroringPages.has(pageId)) return
  mirroringPages.add(pageId)
  try {
    for (const target of slot.liveStores) {
      if (target === source) continue
      const targetState = target.getState()
      if (
        targetState.blocks === state.blocks &&
        targetState.truncatedTotal === state.truncatedTotal
      ) {
        continue
      }
      // Share the source's map, or `augmentBlocksUpdate` builds a fresh one and
      // memo-misses unchanged rows.
      target.setState({
        blocks: state.blocks,
        blocksById: state.blocksById,
        truncatedTotal: state.truncatedTotal,
      })
    }
  } finally {
    mirroringPages.delete(pageId)
  }
}

/**
 * Register a provider's store under `pageId` from its mount effect. A new slot
 * starts at 1; an existing one adopts this newest store and bumps the count,
 * so `getPageStore` tracks the active provider. Every store also subscribes
 * {@link mirrorToSiblings}.
 */
function registerPageStore(pageId: string, store: StoreApi<PageBlockState>): void {
  const slot = pageBlockSlots.get(pageId)
  if (slot) {
    slot.store = store
    slot.refCount += 1
    slot.liveStores.push(store)
    slot.mirrorUnsubscribes.set(
      store,
      store.subscribe((state, prev) => mirrorToSiblings(pageId, store, state, prev)),
    )
  } else {
    pageBlockSlots.set(pageId, {
      store,
      refCount: 1,
      liveStores: [store],
      mirrorUnsubscribes: new Map([
        [store, store.subscribe((state, prev) => mirrorToSiblings(pageId, store, state, prev))],
      ]),
    })
  }
}

/**
 * Release one reference from the provider's cleanup. Out-of-order unmounts
 * drop exactly `store` and re-point the slot at a live one (#1560); the last
 * reference deletes the slot and the page's session undo state.
 */
function unregisterPageStore(pageId: string, store: StoreApi<PageBlockState>): void {
  const slot = pageBlockSlots.get(pageId)
  if (!slot) return
  const idx = slot.liveStores.lastIndexOf(store)
  if (idx !== -1) slot.liveStores.splice(idx, 1)
  // An unmounted store must neither mirror nor be mirrored.
  slot.mirrorUnsubscribes.get(store)?.()
  slot.mirrorUnsubscribes.delete(store)
  slot.refCount -= 1
  if (slot.refCount > 0) {
    const newest = slot.liveStores.at(-1)
    if (slot.store === store && newest !== undefined) {
      slot.store = newest
    }
    return
  }
  pageBlockSlots.delete(pageId)
  // Journal day pages have no navigation-away clear, so without this every
  // visited day kept its undo state for the session (#753).
  useUndoStore.getState().clearPage(pageId)
}

/**
 * The live store for `pageId` from outside a provider tree, the very instance
 * the active provider gives its context; `undefined` when none is mounted.
 */
export function getPageStore(pageId: string): StoreApi<PageBlockState> | undefined {
  return pageBlockSlots.get(pageId)?.store
}

/** Every mounted page store, one per pageId. */
export function forEachPageStore(
  fn: (pageId: string, store: StoreApi<PageBlockState>) => void,
): void {
  for (const [pageId, slot] of pageBlockSlots) fn(pageId, slot.store)
}

/**
 * Every mounted pageId with all its live stores (#4550). An out-of-band reload
 * must reach each one, or a page open in a tab and embedded elsewhere keeps a
 * stale copy; the per-page shape lets a caller run a page-scoped side effect
 * (`reanchorAfterRemoteOps`) once.
 */
export function forEachLivePageStoreGroup(
  fn: (pageId: string, stores: readonly StoreApi<PageBlockState>[]) => void,
): void {
  for (const [pageId, slot] of pageBlockSlots) fn(pageId, slot.liveStores)
}

export const PageBlockContext = createContext<StoreApi<PageBlockState> | null>(null)

/** Creates and registers the per-page store; wrap each `BlockTree` call site in it. */
export function PageBlockStoreProvider({
  pageId,
  children,
}: {
  pageId: string
  children: React.ReactNode
}): React.ReactElement {
  // React's lazy-ref-init idiom, re-initialised when `pageId` changes; the
  // state-adjustment-during-render alternative adds a discarded render to
  // every page mount. oxlint's react(refs) rule has no case for it, so each
  // read carries its own disable (#4406).
  const storeRef = useRef<{ store: StoreApi<PageBlockState>; pageId: string } | null>(null)
  // oxlint-disable-next-line react/refs -- React's documented lazy-ref-init idiom (`if (!ref.current) ref.current = new Thing()`), widened to re-init when `pageId` changes; see the note above and #4406
  if (!storeRef.current || storeRef.current.pageId !== pageId) {
    storeRef.current = { store: createPageBlockStore(pageId), pageId }
  }

  const store = storeRef.current.store

  // Register on effect timing (#1075); `store` changes only with `pageId`, so
  // the dep adds no runs.
  useEffect(() => {
    registerPageStore(pageId, store)
    return () => {
      unregisterPageStore(pageId, store)
      // A reading of this page ends with it, as on leaving it: views mount one at a time (#5745).
      stopReading(store)
    }
    // oxlint-disable-next-line react/refs -- `store` is the lazily-initialised `storeRef.current.store` above, so the dep array inherits that render read; the value is stable for a given `pageId`; see #4406
  }, [pageId, store])

  // oxlint-disable-next-line react/refs -- the context value IS the lazily-initialised `storeRef.current.store`; there is no non-render read that could publish it; see #4406
  return createElement(PageBlockContext.Provider, { value: store }, children)
}

/** Subscribe to per-page block state; throws outside a `PageBlockStoreProvider`. */
export function usePageBlockStore<T>(selector: (state: PageBlockState) => T): T {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStore must be used within a PageBlockStoreProvider')
  return useStore(store, selector)
}

/**
 * Fallback for `usePageBlockStoreOptional` outside a provider (#1445): the hook
 * stays unconditional and selectors see an empty page.
 */
const emptyPageBlockStore = createPageBlockStore('')

/**
 * Like {@link usePageBlockStore}, but outside a provider it reads an empty
 * store instead of throwing; for optional reads that should degrade gracefully.
 */
export function usePageBlockStoreOptional<T>(selector: (state: PageBlockState) => T): T {
  const store = useContext(PageBlockContext)
  return useStore(store ?? emptyPageBlockStore, selector)
}

/** The raw `StoreApi` for imperative access; throws outside a `PageBlockStoreProvider`. */
export function usePageBlockStoreApi(): StoreApi<PageBlockState> {
  const store = useContext(PageBlockContext)
  if (!store) throw new Error('usePageBlockStoreApi must be used within a PageBlockStoreProvider')
  return store
}
