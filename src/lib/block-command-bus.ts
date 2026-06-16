/**
 * Block command bus — focus-keyed dispatch for per-block editor commands (#1250).
 *
 * ## Why this exists
 *
 * Toolbar buttons, inline controls, and the roving editor used to drive
 * per-block commands by dispatching a `CustomEvent` on `document`
 * (`dispatchBlockEvent` in block-events.ts). EVERY mounted `BlockTree`
 * subscribed at the document level, so a journal week/month view (one tree per
 * day) installed N × ~13 document listeners, each one re-checking ownership via
 * `storeOwnsBlock(pageStore, focusedBlockId)` on every command. Only the single
 * tree whose page store owned the GLOBAL `focusedBlockId` (blocks.ts — exactly
 * one focused block app-wide) ever acted; the rest were pure overhead and the
 * source of the #713/#774/#1064 ownership-race history.
 *
 * This bus removes that listener fan-out. Each `BlockTree` registers its command
 * handlers ONCE under its own `pageStore` (the ownership key). A producer calls
 * `dispatchBlockCommand(name, detail)`; the bus resolves the SINGLE owning tree
 * — the registered store that contains the current global `focusedBlockId`, via
 * the same `storeOwnsBlock` predicate the old gate used — and invokes only that
 * tree's handler. No tree subscribes to `document`; routing is direct.
 *
 * ## Behaviour preservation
 *
 * - Same ownership gate: a command fires only for the tree whose store owns the
 *   focused block (`storeOwnsBlock(store, focusedBlockId)`), identical to the
 *   per-listener `if (!storeOwnsBlock(...)) return` guards it replaces.
 * - Same no-focus no-op: with `focusedBlockId === null`, or when no registered
 *   store owns it, the dispatch is a no-op (no handler runs).
 * - Same single-effect guarantee: exactly one handler runs per command (the old
 *   code had N listeners fire but only one act — observably identical, now by
 *   construction rather than by N-way gating).
 * - Same payload: `detail` is forwarded unchanged to the handler.
 * - At most one tree can own a given block id at a time (one focused block
 *   app-wide; a block lives in exactly one page store), so resolution is
 *   unambiguous — the same invariant `storeOwnsBlock` relied on.
 */

import type { StoreApi } from 'zustand'

import { useBlockStore } from '../stores/blocks'
import type { PageBlockState } from '../stores/page-blocks'
import { storeOwnsBlock } from '../stores/page-blocks'
import type { BLOCK_EVENTS } from './block-event-names'

/** Command name — reuses the typed `BLOCK_EVENTS` keys so producers/consumers stay in lockstep. */
export type BlockCommandName = keyof typeof BLOCK_EVENTS

/**
 * Handler for a per-block command. Receives the resolved owning block id (the
 * current global `focusedBlockId`, guaranteed to live in the registered store)
 * and the producer-supplied `detail` payload.
 */
export type BlockCommandHandler = (blockId: string, detail?: unknown) => void

/** A registry entry: one mounted BlockTree's command handlers, keyed by its page store. */
interface Registration {
  store: StoreApi<PageBlockState>
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>
}

/**
 * Registered BlockTrees, keyed by their page store (the ownership key). A
 * `Map` keyed by the store identity dedupes a tree that re-registers, and lets
 * dispatch walk the live registrations to find the one owning the focused
 * block. Trees clear their entry on unmount.
 */
const registry = new Map<StoreApi<PageBlockState>, Registration>()

/**
 * Register (or replace) a BlockTree's command handlers under its page store.
 * Returns a cleanup that removes the registration. Called once per BlockTree;
 * re-registering with the same store overwrites the handler set (latest wins),
 * matching the old per-render listener re-attach.
 */
export function registerBlockCommandTarget(
  store: StoreApi<PageBlockState>,
  handlers: Partial<Record<BlockCommandName, BlockCommandHandler>>,
): () => void {
  registry.set(store, { store, handlers })
  return () => {
    // Only delete if still ours — a later registration under the same store
    // identity must not be torn down by a stale cleanup.
    if (registry.get(store)?.handlers === handlers) registry.delete(store)
  }
}

/**
 * Resolve the registration whose store owns the current global focused block.
 * Mirrors the old `storeOwnsBlock(pageStore, focusedBlockId)` gate: returns the
 * single owning entry, or `null` when nothing is focused / no registered store
 * owns the focused block.
 */
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
 * Dispatch a per-block command to the focused block's owning BlockTree.
 *
 * No-op when no block is focused or no registered tree owns the focused block,
 * or when the owning tree did not register a handler for this command. Invokes
 * exactly the one owning handler — no document listener fan-out.
 */
export function dispatchBlockCommand(name: BlockCommandName, detail?: unknown): void {
  const owner = resolveOwner()
  if (owner == null) return
  const handler = owner.reg.handlers[name]
  if (handler == null) return
  handler(owner.blockId, detail)
}

/**
 * Test/diagnostic helper: number of BlockTrees currently registered with the
 * bus. Used to assert the listener count no longer scales with mounted trees.
 */
export function registeredBlockCommandTargetCount(): number {
  return registry.size
}

/** Test helper: clear all registrations (avoids cross-test leakage). */
export function __resetBlockCommandBus(): void {
  registry.clear()
}
