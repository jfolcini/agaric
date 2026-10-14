/**
 * Display titles for a batch of block ids, read from the resolve store first.
 *
 * The store is preloaded with every page and tag title in the active space, so
 * the journal's side panels find their breadcrumb titles there and skip the
 * `batchResolve` round each used to send at boot (#5439). Only ids the store
 * has not resolved in `spaceId` go to the backend, and those rows are written
 * back so the next caller hits.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { resolveStoreTitle } from '@/lib/block-title'
import { requireActiveScope } from '@/lib/space-scope'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

/** Composite cache key → the request already fetching it, so callers in one tick share it. */
const pending = new Map<string, Promise<Map<string, string>>>()

async function fetchTitles(spaceId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = unwrap(await commands.batchResolve(ids, requireActiveScope(spaceId)))
  const entries = rows.map((r) => ({
    id: r.id,
    title: resolveStoreTitle(r.block_type, r.title),
    deleted: r.deleted,
  }))
  // `batchSet` writes under the active space; a switch mid-IPC flushed this one.
  if (useSpaceStore.getState().currentSpaceId === spaceId) {
    useResolveStore.getState().batchSet(entries)
  }
  return new Map(entries.map((e) => [e.id, e.title]))
}

/**
 * Titles for `ids` in `spaceId`, keyed by id. An id `batchResolve` does not
 * return (another space, purged) is absent, as it was from the raw IPC.
 * Rejects when the backend call does.
 */
export async function resolveTitles(
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids)]
  const { cache } = useResolveStore.getState()
  const cached = new Map<string, string>()
  const waits = new Set<Promise<Map<string, string>>>()
  const misses: string[] = []
  for (const id of uniqueIds) {
    const key = keyFor(spaceId, id)
    const entry = cache.get(key)
    const inFlight = pending.get(key)
    if (entry?.resolved === true) cached.set(id, entry.title)
    else if (inFlight) waits.add(inFlight)
    else misses.push(id)
  }
  if (misses.length > 0) {
    const request = fetchTitles(spaceId, misses)
    const keys = misses.map((id) => keyFor(spaceId, id))
    for (const key of keys) pending.set(key, request)
    const settle = (): void => {
      for (const key of keys) if (pending.get(key) === request) pending.delete(key)
    }
    void request.then(settle, settle)
    waits.add(request)
  }
  const fetched = await Promise.all(waits)
  const titles = new Map<string, string>()
  for (const id of uniqueIds) {
    const title = cached.get(id) ?? fetched.find((m) => m.has(id))?.get(id)
    if (title !== undefined) titles.set(id, title)
  }
  return titles
}
