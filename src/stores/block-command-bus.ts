/**
 * Block command bus: focus-keyed dispatch of per-block editor commands (#1250).
 * Each `BlockTree` registers its handlers once under its page store, and
 * `dispatchBlockCommand` runs only the handler of the one tree whose store owns
 * the global `focusedBlockId` (`storeOwnsBlock`), instead of every tree in a
 * journal week listening on `document`. A block lives in one page store and one
 * block is focused app-wide, so the owner is unambiguous; with none, nothing runs.
 */

import type { StoreApi } from 'zustand'

import type { BLOCK_EVENTS } from '@/lib/block-event-names'
import { useBlockStore } from '@/stores/blocks'
import type { PageBlockState } from '@/stores/page-blocks'
import { storeOwnsBlock } from '@/stores/page-blocks'

/** Command name: the typed `BLOCK_EVENTS` keys. */
export type BlockCommandName = keyof typeof BLOCK_EVENTS

/** Handler for a per-block command: the focused block id, which its store owns, and the producer's `detail`. */
export type BlockCommandHandler = (blockId: string, detail?: unknown) => void

/** A registry entry: one mounted BlockTree's command handlers, keyed by its page store. */
interface Registration {
  store: StoreApi<PageBlockState>
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>
}

/** Mounted BlockTrees keyed by page store, so a tree re-registering replaces its entry. */
const registry = new Map<StoreApi<PageBlockState>, Registration>()

/** Subscribers to registry membership (a BlockTree mounting or unmounting), not to block data (#4550). */
const membershipListeners = new Set<() => void>()

function notifyMembershipChanged(): void {
  for (const listener of membershipListeners) listener()
}

/** Subscribe to BlockTree mount/unmount; pairs with {@link blockIsRenderedByAMountedTree} under `useSyncExternalStore`. */
export function subscribeBlockCommandTargets(onChange: () => void): () => void {
  membershipListeners.add(onChange)
  return () => {
    membershipListeners.delete(onChange)
  }
}

/**
 * Whether some mounted `BlockTree` renders `blockId` (#4550). An unlocked embed
 * renders the host tree's editable row for its focused block, so unlocking one
 * a tree already renders would put two `EditableBlock`s, two editor surfaces,
 * on one id: invariant 4. That happens with an embed of a block on its own page
 * and across the journal's mounted days. An over-approximation (a collapsed or
 * scrolled-away row counts): the cost is an unlock withheld, the safe direction.
 */
export function blockIsRenderedByAMountedTree(blockId: string): boolean {
  for (const reg of registry.values()) {
    if (storeOwnsBlock(reg.store, blockId)) return true
  }
  return false
}

/** The page store of every mounted `BlockTree`: what in-page find searches (#6557). */
export function mountedTreeStores(): StoreApi<PageBlockState>[] {
  return [...registry.keys()]
}

/** The mounted `BlockTree` stores with a row inside `container`, in DOM order. */
export function treeStoresIn(container: Element): StoreApi<PageBlockState>[] {
  const owner = new Map<string, StoreApi<PageBlockState>>()
  for (const store of registry.keys()) {
    for (const block of store.getState().blocks) owner.set(block.id, store)
  }
  const ordered: StoreApi<PageBlockState>[] = []
  if (owner.size === 0) return ordered
  for (const row of container.querySelectorAll('li[data-block-id]')) {
    const store = owner.get(row.getAttribute('data-block-id') ?? '')
    if (store !== undefined && !ordered.includes(store)) ordered.push(store)
  }
  return ordered
}

/**
 * Register a BlockTree's handlers under its page store; re-registering with
 * the same store replaces them. Returns the cleanup.
 */
export function registerBlockCommandTarget(
  store: StoreApi<PageBlockState>,
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>,
): () => void {
  const isNew = !registry.has(store)
  registry.set(store, { store, handlers })
  // A re-register (every BlockTree render) changes no membership: do not
  // wake the membership subscribers.
  if (isNew) notifyMembershipChanged()
  return () => {
    // Only if still ours: a stale cleanup must not tear down a newer registration.
    if (registry.get(store)?.handlers === handlers) {
      registry.delete(store)
      notifyMembershipChanged()
    }
  }
}

/** A surface that edits blocks outside a `BlockTree` (page mode), naming the block a command is for. */
interface FocusedTarget {
  /** The block it edits, while it is the surface the user is in; else null. */
  focused: () => string | null
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>
}

const focusedTargets = new Set<FocusedTarget>()

/**
 * Register a surface that has no global `focusedBlockId` (#5691: page mode's
 * one editor for the whole page). While `focused` names a block, every command
 * goes to this surface, ahead of the trees; a command it has no handler for
 * does nothing. Returns the cleanup.
 */
export function registerFocusedCommandTarget(
  focused: () => string | null,
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>,
): () => void {
  const target = { focused, handlers }
  focusedTargets.add(target)
  return () => {
    focusedTargets.delete(target)
  }
}

/** The registration whose store owns the focused block, or `null`. */
function resolveOwner(): { reg: Registration; blockId: string } | null {
  const focusedBlockId = useBlockStore.getState().focusedBlockId
  if (focusedBlockId == null) return null
  for (const reg of registry.values()) {
    if (storeOwnsBlock(reg.store, focusedBlockId)) {
      return { reg, blockId: focusedBlockId }
    }
  }
  return null
}

/**
 * Dispatch a command to the focused surface: a focused target (page mode)
 * first, else the BlockTree owning the focused block. A no-op without either,
 * or without a handler for `name`.
 */
export function dispatchBlockCommand(name: BlockCommandName, detail?: unknown): void {
  for (const target of focusedTargets) {
    const blockId = target.focused()
    if (blockId === null) continue
    target.handlers[name]?.(blockId, detail)
    return
  }
  const owner = resolveOwner()
  if (owner == null) return
  const handler = owner.reg.handlers[name]
  if (handler == null) return
  handler(owner.blockId, detail)
}

/** Test helper: the number of registered BlockTrees. */
export function registeredBlockCommandTargetCount(): number {
  return registry.size
}

/** Test helper: clear all registrations (avoids cross-test leakage). */
export function __resetBlockCommandBus(): void {
  registry.clear()
  focusedTargets.clear()
  notifyMembershipChanged()
}
