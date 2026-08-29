/**
 * Global resolve cache store — Zustand state for block/tag title resolution.
 *
 * Replaces the per-component ref-based cache that was in BlockTree.
 * Single source of truth for resolving block/tag ULIDs to display titles.
 * Preloaded once on app boot; updated incrementally as pages/tags are created.
 *
 * # Cache key encoding (cross-space link enforcement)
 *
 * The cache `Map` is keyed by **flat composite strings**:
 *
 *     `${spaceId}::${ulid}`
 *
 * where `spaceId` is the active space's ULID at write time, or the
 * `__GLOBAL_SPACE_ID` sentinel (`'__global__'`) when no space is active
 * (e.g. boot before `useSpaceStore` resolves, or test fixtures that
 * don't set up the space store).
 *
 * Why composite keys (instead of nested `Map<spaceId, Map<ulid, ...>>`)?
 *
 *   - `cache.get` / `cache.set` consumer ergonomics: callers compose the
 *     key with `keyFor(spaceId, ulid)` and use a single Map lookup.
 *   - `clearAllForSpace(prevSpaceId)` is a single linear scan that
 *     deletes any key with prefix `${prevSpaceId}::` — no nested-map
 *     bookkeeping.
 *
 * The locked-in policy is **no live links between spaces,
 * ever**. With ULID-only keys, a chip resolved in space A could be
 * served from cache when the user is in space B → silent cross-space
 * leak. Composite keys make that impossible at the cache layer; the
 * `clearAllForSpace` action complements that by flushing the previous
 * space's entries on switch so foreign chips render broken instead of
 * stale-resolving.
 */

import { create } from 'zustand'

import { resolveStoreTitle, unresolvedBlockLabel } from '@/lib/block-title'
import { logger } from '@/lib/logger'
import { batchResolve, listAllTagsInSpace, listBlocks, listBlocksLimit } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

const MAX_CACHE_SIZE = 10_000

/**
 * Backend cap on the `ids` batch accepted by `batch_resolve`
 * (`MAX_BATCH_BLOCK_IDS` in `src-tauri/agaric-store/src/pagination/mod.rs`),
 * mirrored here the same way {@link listBlocks}' sibling caps are mirrored in
 * `src/lib/tauri/blocks.ts`.
 *
 * #3321 — it is also the point where a TARGETED preload rescan stops being
 * worth attempting: above the cap the IPC rejects outright, and a changed set
 * that large means the inbound sync touched most of the vault anyway, so the
 * paginated full walk is both correct and no more expensive. Falling back is
 * always safe — a full scan is a superset of any targeted one.
 */
const TARGETED_PRELOAD_MAX_IDS = 1000

/**
 * Sentinel used when no current space is active (boot, test fixtures).
 * Tags are deliberately NOT stored under this sentinel — the spec
 * treats them as space-scoped just like pages, so a switch flushes
 * tag entries too and the next `preload(spaceId)` re-fetches them.
 */
export const GLOBAL_SPACE_ID = '__global__'

/** Compose the composite cache key for `(spaceId, ulid)`. */
export function keyFor(spaceId: string | null | undefined, id: string): string {
  return `${spaceId ?? GLOBAL_SPACE_ID}::${id}`
}

/** Read `currentSpaceId` from the space store, falling back to the
 *  global sentinel when the space store hasn't hydrated yet. */
function activeSpaceId(): string {
  return useSpaceStore.getState().currentSpaceId ?? GLOBAL_SPACE_ID
}

/**
 * Evict least-recently-used entries until `cache.size <= maxSize`.
 *
 * A `Map` preserves insertion order, so the front of the iteration order
 * is the least-recently-used. Writers (`set`/`batchSet`) and reads
 * (`resolveTitle`/`resolveStatus`, via `touch`) delete+re-set an accessed
 * key to move it to the tail (most-recently-used), so the first `excess`
 * keys are the genuinely coldest entries. Mutates `cache` in place. No-op
 * when already within budget. Pure helper — only touches the passed Map.
 */
function evictLeastRecentlyUsed<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return
  let excess = cache.size - maxSize
  // Perf (#2041): the front of the Map's insertion order is the coldest entry,
  // so consume the key-iterator and delete the first `excess` keys directly —
  // no full `Array.from(cache.keys())` allocation on every at-capacity write.
  // Deleting during iteration is safe here: each deleted key is at or before the
  // iterator's current position, which the Map iterator protocol permits.
  for (const key of cache.keys()) {
    if (excess <= 0) break
    cache.delete(key)
    excess--
  }
}

/**
 * Mark `key` as most-recently-used by re-inserting it at the Map's tail
 * (delete + set preserves the value but refreshes insertion order). The
 * Map reference is unchanged and `version` is NOT bumped, so a pure read
 * does not trigger re-renders — it only updates LRU recency so a hot
 * early-inserted entry survives eviction ahead of colder recent ones.
 */
function touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key)
  cache.set(key, value)
}

/**
 * Outcome of one preload scan. `pageHalfFailed` distinguishes a page-half
 * failure (worth escalating a targeted scan to the full walk) from a tag-half
 * failure (not worth it — the walk re-runs the same failing tag IPC).
 */
interface PreloadScanResult {
  applied: boolean
  pageHalfFailed: boolean
}

interface ResolveEntry {
  /**
   * What to SHOW for this id. Purely presentational since #4238 — every seed
   * writer runs it through `resolveStoreTitle` unconditionally, blank content
   * included, so two writers reaching the same row produce the same bytes and
   * `set`/`batchSet`'s value diff sees a genuine no-op.
   */
  title: string
  deleted: boolean
  /**
   * Whether the backend actually returned a row for this id.
   *
   * #4238 — this is the cache-miss signal, moved OFF {@link ResolveEntry.title}.
   * It used to ride on the title's bytes (`useBacklinkResolution` stored the
   * `[[id…]]` broken-link shape for a resolved-but-blank row so
   * `resolveBlockDisplay` would still see a miss), which made the title mean
   * two things and forced that one writer off the shared gate. Now the flag
   * answers "is this resolved" and the title answers "what do I render",
   * independently.
   *
   * `false` is written by exactly one place: `fetchAndCacheLinks`'
   * unreturned-target branch (`@/components/block-tree/use-block-link-resolve`),
   * for an id `batch_resolve` did not hand back — foreign-space or genuinely
   * unknown.
   *
   * ## Why `set`/`batchSet` default it to `true`, and what that does NOT risk
   *
   * The field is REQUIRED here and optional at the setters, which looks like a
   * fail-open: a writer that cannot resolve a row and forgets the flag would
   * record it as resolved — the exact bug #4238 removed, relocated from a
   * string to a boolean. It is not, and the reason is structural rather than
   * convenient: **this cache is not a total map, so "I could not resolve this
   * id" already has a correct, zero-effort representation — write nothing.**
   * An absent key falls to {@link unresolvedBlockLabel} through
   * {@link ResolveStore.resolveTitle}, identically to a `resolved: false`
   * entry. (Identically for the LABEL. The two diverge at
   * {@link ResolveStore.resolveStatus}, deliberately: absent means "not asked
   * yet" and stays `'active'`, `resolved: false` means "asked, nothing came
   * back" and reads `'deleted'`. Writing nothing is still the correct
   * representation of "I could not resolve this id" — a sentinel is for
   * suppressing a re-fetch, and it buys the broken-link styling with it.
   * That is not the store guessing on the writer's behalf: a writer that DID
   * ask and wrote nothing keeps the verdict itself, which is exactly what
   * `useBacklinkResolution`'s attempted-unresolved set — named in the
   * "Residual" note below — is for. Only a caller knows whether it has asked
   * yet; the store only knows what it was told.)
   * So the default does not govern "a writer that failed to resolve";
   * it governs only "a writer that deliberately PARKS a sentinel entry to
   * suppress a re-fetch", which is a conscious, documented act with one
   * instance. Forgetting the flag is not something a writer can drift into —
   * it has to first choose to write a row it does not have.
   *
   * Residual, stated rather than hidden: a SECOND sentinel writer that copied
   * the parking pattern without the flag would be silently wrong, and no test
   * would notice — the omission has no textual footprint for the enumeration
   * guard in `resolve-store-title-seed-parity.test.ts` to find. The evidence
   * that this is remote rather than merely unlikely: the other bulk resolver
   * that faces the same "some ids did not come back" case,
   * `useBacklinkResolution`, deliberately does NOT park in the shared store
   * (#2635) — it keeps a hook-local attempted-unresolved set. If a second one
   * ever does appear, the fix is to stop making the verdict a caller's
   * parameter at all: give the sentinel its own named operation (a second
   * argument to {@link ResolveStore.batchSet} taking the unreturned ids, with
   * the store owning the label and the `deleted` flag) so `set`/`batchSet`
   * can only ever mean "here is a row I have". Making the flag REQUIRED at
   * the setters instead was considered and rejected: it costs ~100 call sites
   * writing `true`, and it converts a silent omission into an explicit wrong
   * value rather than preventing it.
   *
   * NOT foldable into `deleted`: a soft-deleted block is returned by
   * `batch_resolve` WITH its real title, so `deleted: true` is a perfectly
   * ordinary resolved state and conflating them would put every trashed
   * block's chip back on the `[[id…]]` label.
   */
  resolved: boolean
}

interface ResolveStore {
  /** Composite key (`${spaceId}::${ulid}`) → { title, deleted } */
  cache: Map<string, ResolveEntry>
  /** Bumped on cache updates to trigger re-renders */
  version: number
  /** Whether preload has been called at least once */
  _preloaded: boolean

  /**
   * Fetch all pages (in `spaceId`) + tags into the cache. Call once on
   * boot and again after sync.
   *
   * `spaceId` — narrows the page fetch to the active space
   * so only current-space pages enter the cache. FE-H-22 — passing
   * `null`/`undefined` is now a silent no-op: callers must wait for
   * the space store to hydrate before invoking preload, otherwise
   * the IPC is skipped entirely (fail closed on cross-space leaks).
   *
   * `forceRefresh` distinguishes callsite intent (post-sync vs initial
   * boot) AND drives the in-flight coalescing policy (#753): concurrent
   * preloads for the same space join the in-flight scan; a `forceRefresh`
   * call additionally schedules exactly ONE trailing re-scan after the
   * in-flight one settles (the in-flight snapshot may predate the data
   * the force caller — e.g. `sync:complete` — wants picked up). Fetched
   * data always wins over stale cache entries regardless of the flag.
   *
   * `changedPageIds` (#3321) — the owning-page id set an out-of-band write
   * touched, as already computed by `reloadChangedPageStores`. When present
   * (and within {@link TARGETED_PRELOAD_MAX_IDS}) the PAGE half of the scan
   * collapses from a paginated walk of the whole space into ONE
   * `batchResolve` of exactly those ids. The TAG half is unconditional either
   * way: tags carry no changed-id signal, so skipping them would leave a
   * remotely-renamed tag rendering its old name until the next space switch.
   * Absent / empty / oversize sets fall back to the full walk — the same
   * fallback shape the page-store reload uses, and always a superset of the
   * targeted result.
   */
  preload: (
    spaceId?: string | null | undefined,
    forceRefresh?: boolean,
    changedPageIds?: ReadonlySet<string> | undefined,
  ) => Promise<void>
  /**
   * Add/update a single entry under the active space.
   *
   * `resolved` (#4238) defaults to `true`: calling this form at all means the
   * caller HOLDS a title — an echo writer re-stating one it just persisted, or
   * a seed writer holding a row the backend returned. A writer with no row
   * does not call `set` with a placeholder, it calls nothing, and an absent
   * key already reads as unresolved. See {@link ResolveEntry.resolved} for
   * why that makes the default safe and for the residual it leaves.
   */
  set: (id: string, title: string, deleted: boolean, resolved?: boolean) => void
  /**
   * Batch-add entries under the active space. Entries already cached
   * with an identical `{ title, deleted, resolved }` are skipped; when EVERY
   * entry is unchanged the call is a no-op — no Map clone, no
   * `version` bump (#753: batchSet fires per picker keystroke with
   * mostly-cached rows, and an unconditional bump re-renders every
   * version-subscribed block row).
   *
   * `resolved` is optional and defaults to `true` — see {@link ResolveEntry}.
   */
  batchSet: (
    entries: Array<{ id: string; title: string; deleted: boolean; resolved?: boolean }>,
  ) => void
  /**
   * Resolve the display title under the active space, with fallback.
   *
   * #4238 — an entry with `resolved: false` resolves to
   * {@link unresolvedBlockLabel}, exactly as an ABSENT key does. The verdict
   * comes from the flag, never from the stored string: that is what stops a
   * title from doubling as a cache-miss signal, and it means a future writer
   * that flags a placeholder `resolved: false` cannot leak whatever it parked
   * in `title` into a chip. That covers the LABEL only; what the chip's
   * styling does with such an entry is {@link ResolveStore.resolveStatus}'
   * half of the guarantee.
   */
  resolveTitle: (id: string) => string
  /**
   * Resolve deleted status under the active space.
   *
   * `'deleted'` when the entry is soft-deleted OR carries `resolved: false`;
   * `'active'` otherwise, including for an ABSENT key.
   *
   * #4515 — the flag is consulted here too, so the "a parked placeholder
   * cannot reach a chip" guarantee covers the styling and not just the label.
   * Without it a `{ resolved: false, deleted: false }` sentinel would render
   * an ACTIVE chip carrying the unresolved label — live-looking, unclickable.
   * The two states it distinguishes are genuinely different and are rendered
   * differently on purpose: an absent key means "not asked yet" (stay
   * optimistic, the real title is about to land), while `resolved: false`
   * means "asked, and the backend returned nothing" — a broken target, which
   * is the broken-link UX. That reading was already the sole sentinel
   * writer's intent; it just had to spell it as a second field
   * (`fetchAndCacheLinks` passes `deleted: true` alongside `resolved: false`,
   * `@/components/block-tree/use-block-link-resolve`), so deriving it here is
   * inert today and only removes the duty to remember both.
   */
  resolveStatus: (id: string) => 'active' | 'deleted'
  /**
   * Whether a real entry for `id` exists under the active space. A pure
   * existence probe — no LRU touch, no `version` bump, no re-render. Lets a
   * delegating consumer (e.g. `useBacklinkResolution`, #2635) distinguish a
   * genuine cached resolution from `resolveTitle`'s `[[ULID]]` fallback so it
   * can apply its OWN fallback (broken-link placeholder / `#tag`) without
   * writing that placeholder back into the shared cache.
   */
  has: (id: string) => boolean
  /**
   * Whether a REAL resolution for `id` exists under the active space — an
   * entry that is present AND carries `resolved: true`.
   *
   * #4238 — the question {@link ResolveStore.has} cannot answer. `has` is an
   * occupancy probe used to decide whether to re-FETCH (a `resolved: false`
   * placeholder must keep suppressing the re-fetch, or a foreign-space chip
   * re-queries on every pass); this is the DISPLAY question — may a surface
   * show `title`, or must it fall back to its own broken-link label?
   */
  isResolved: (id: string) => boolean
  /**
   * Flush every cache entry whose composite key starts with
   * `${prevSpaceId}::`. Other spaces' entries (and the
   * `__global__::*` namespace, if anything ever lands there) survive.
   * Called from the App-level space-switch subscriber so foreign-space
   * chips fall through to the `[[ULID]]` fallback (which renders the
   * broken-link UX) instead of stale-resolving from the cache.
   */
  clearAllForSpace: (prevSpaceId: string) => void
}

/**
 * One in-flight preload scan, plus the ONE trailing re-scan it may owe.
 *
 * `currentFull` — whether the scan actually running is the full space walk.
 * `trailingForce` — a caller arrived mid-scan and needs a re-scan afterwards.
 * `trailingIds` — what that re-scan must cover: a page-id set for a targeted
 * re-scan, or `null` for a full one. Only meaningful while `trailingForce`.
 */
interface PreloadEntry {
  promise: Promise<void>
  currentFull: boolean
  trailingForce: boolean
  trailingIds: Set<string> | null
}

/**
 * Decide whether a caller's `changedPageIds` can drive a targeted rescan.
 * Returns the id array to `batchResolve`, or `null` meaning "full walk"
 * (absent set, empty set, or one past {@link TARGETED_PRELOAD_MAX_IDS}).
 */
function narrowToTargetedIds(changedPageIds: ReadonlySet<string> | undefined): string[] | null {
  if (changedPageIds === undefined || changedPageIds.size === 0) return null
  if (changedPageIds.size > TARGETED_PRELOAD_MAX_IDS) return null
  return [...changedPageIds]
}

/**
 * Fold a mid-scan caller's demand into the ONE trailing re-scan (#753 keeps it
 * at exactly one; #3321 makes it carry a scope).
 *
 * The union is deliberately widening: a targeted demand arriving on top of
 * another targeted demand merges the two id sets, and ANY demand for a full
 * re-scan (a plain boot/space-switch caller, or a force caller with no
 * changed-id set) collapses the trailing scan to full and stays there. A
 * targeted scan can therefore never swallow a broader caller's request — the
 * failure mode would be a page/tag rename that never reaches the cache.
 */
function foldIntoTrailing(
  entry: PreloadEntry,
  changedPageIds: ReadonlySet<string> | undefined,
): void {
  const wantsFull = changedPageIds === undefined || changedPageIds.size === 0
  if (!entry.trailingForce) {
    entry.trailingForce = true
    entry.trailingIds = wantsFull ? null : new Set(changedPageIds)
    return
  }
  if (entry.trailingIds === null) return // already full; it subsumes any set
  if (wantsFull) {
    entry.trailingIds = null
    return
  }
  for (const id of changedPageIds) entry.trailingIds.add(id)
}

export const useResolveStore = create<ResolveStore>((set, get) => {
  /**
   * #753 — in-flight preload coalescing. Boot (`useAppSpaceLifecycle`)
   * and `sync:complete` (`useSyncEvents`) can both fire `preload` for
   * the same space within the same tick window; without coalescing each
   * call runs its own full pages+tags scan. Keyed by `spaceId` so a
   * space-switch preload never joins the previous space's scan.
   * `trailingForce` records that at least one `forceRefresh` caller
   * arrived while a scan was in flight — exactly one re-scan runs after
   * the current one settles, so post-sync data is still picked up.
   */
  const inflightPreloads = new Map<string, PreloadEntry>()

  /**
   * One pages+tags scan for `spaceId`. Never rejects (logs instead); resolves
   * `false` when the scan threw and applied nothing, `true` otherwise.
   *
   * `targetedIds` — non-null to re-resolve only those page ids (one
   * `batchResolve` round-trip) instead of walking the whole space; null for
   * the full paginated walk. See {@link narrowToTargetedIds}.
   */
  async function runPreloadScan(
    spaceId: string,
    targetedIds: string[] | null,
  ): Promise<PreloadScanResult> {
    let pageHalfSucceeded = false
    try {
      const fetchedPages = new Map<string, ResolveEntry>()
      if (targetedIds) {
        // #3321 — targeted page half. `batch_resolve` is space-scoped exactly
        // like the `list_blocks` walk it replaces (foreign-space ids drop out
        // of the response, so the no-cross-space-links barrier holds) and it
        // INCLUDES soft-deleted rows with `deleted: true`, which is what keeps
        // a remotely-trashed page's chip rendering as deleted. Ids the backend
        // does not return (purged, moved to another space) simply merge
        // nothing — the same outcome as the full walk, which is merge-only and
        // never removes a stale key either.
        for (const resolved of await batchResolve(targetedIds, spaceId)) {
          fetchedPages.set(keyFor(spaceId, resolved.id), {
            // #4239 — `resolveStoreTitle('page', …)` rather than the
            // hardcoded `?? 'Untitled'` this used to carry. Two writers
            // disagreeing about a blank title is the same value-diff churn
            // as two disagreeing about a long one: the literal is
            // untranslated (the sibling seeders use the `block.untitled`
            // catalogue entry) and its test is `=== null`, so a
            // whitespace-only page title stayed raw here and became
            // "Untitled" everywhere else. Both halves now go through the one
            // gate. `changedPageIds` carries page ids, hence the `'page'`
            // literal — see the doc on `preload`.
            title: resolveStoreTitle('page', resolved.title),
            deleted: resolved.deleted,
            // #4238 — `batch_resolve` returned this row, so it IS resolved;
            // a blank `title` now means "a page with no name", not "no page".
            resolved: true,
          })
        }
      } else {
        // Fetch all pages with cursor-based pagination, scoped to the
        // Active space.
        let cursor: string | undefined
        let hasMore = true
        while (hasMore) {
          const pagesResp = await listBlocks({
            blockType: 'page',
            limit: listBlocksLimit(100),
            cursor,
            spaceId,
          })
          for (const p of pagesResp.items) {
            fetchedPages.set(keyFor(spaceId, p.id), {
              // #4239 — see the targeted half above. `blockType: 'page'`
              // scopes this walk, so the `'page'` literal is exact.
              title: resolveStoreTitle('page', p.content),
              deleted: p.deleted_at !== null,
              resolved: true,
            })
          }
          hasMore = pagesResp.has_more
          cursor = pagesResp.next_cursor ?? undefined
        }
      }

      // Fetch all tags in the active space. #1343 — `listAllTagsInSpace`
      // is the no-clamp IPC; `listTagsByPrefix({ prefix: '' })` silently
      // truncated to `MAX_TAGS_PREFIX = 200`, so chips beyond the first
      // 200 tags rendered broken in large vaults. We key the rows under
      // `spaceId` so a `clearAllForSpace` flush wipes them too — the next
      // preload re-fetches them under the new space's prefix.
      // #3321 — the page half is done; anything that throws from here on is
      // the TAG half. Recorded so the escalate-to-full-walk retry below can
      // tell the two apart: that retry exists only for pages, and escalating
      // on a tag failure re-runs the same failing tag IPC inside a
      // 30-round-trip walk — ~33 IPCs where this change exists to spend 2.
      // The abort semantics are unchanged (a tag failure still aborts the
      // scan and leaves `_preloaded` false, per the pre-existing contract);
      // only the escalation decision is now aware of which half failed.
      pageHalfSucceeded = true

      const tags = await listAllTagsInSpace(spaceId)
      const fetchedTags = new Map<string, ResolveEntry>()
      for (const t of tags) {
        fetchedTags.set(keyFor(spaceId, t.tag_id), {
          // #4239 — the tag arm of the same gate. `untitledOr` is the
          // identity for any real name, so this only bites on a blank one,
          // where it agrees with `fetchAndCacheLinks` and the `@`-picker
          // fill instead of storing whitespace.
          title: resolveStoreTitle('tag', t.name),
          deleted: false,
          resolved: true,
        })
      }

      // Merge: fetched data always wins over stale cache entries.
      // Perf (#2267) — mutate the existing cache Map in place instead of
      // spreading it into a fresh Map every sync:complete. `Map.set` on an
      // already-present key updates the value WITHOUT moving its iteration
      // position, and appends brand-new keys at the tail — byte-identical
      // ordering to `new Map([...state.cache, ...fetchedPages, ...fetchedTags])`,
      // just O(fetched) instead of O(cacheSize). All consumers re-render off
      // `version`, not the Map reference (see consumer audit in resolve.ts
      // history / #2267), so reusing the same Map object is safe.
      //
      // #3321 — diff before bumping `version`, mirroring the guards the two
      // sibling writers already have (`set`'s #1073, `batchSet`'s #753). This
      // is the ONLY writer reached on every `sync:complete` with
      // `ops_received > 0` and every MCP `blocks:changed`
      // (`reloadChangedPageStores` → `preload(spaceId, true)`), and a remote
      // edit to a block's CONTENT cannot change any page title or tag name —
      // yet every such tick used to bump `version`, which is a load-bearing
      // `useMemo` dep in `useRichContent` and `BlockListItem`. One no-op tick
      // therefore re-parsed markdown for every mounted row (up to
      // `INITIAL_MOUNT_LIMIT = 500` per tree, ×N trees in a journal
      // week/month view). Diffing turns that into zero re-renders.
      const cache = get().cache
      let mutated = false
      const mergeFetched = (key: string, value: ResolveEntry): void => {
        const cached = cache.get(key)
        if (
          cached !== undefined &&
          cached.title === value.title &&
          cached.deleted === value.deleted &&
          cached.resolved === value.resolved
        )
          return
        cache.set(key, value)
        mutated = true
      }
      for (const [k, v] of fetchedPages) mergeFetched(k, v)
      for (const [k, v] of fetchedTags) mergeFetched(k, v)
      // #3321 — only a FULL scan may claim `_preloaded`. A targeted rescan
      // re-resolves a handful of ids and says nothing about whether the rest
      // of the space was ever fetched, so flipping the flag there would let a
      // once-only caller skip the boot scan it still needs.
      const fullScan = targetedIds === null
      if (!mutated) {
        // Nothing the scan fetched differs from what is already cached. Skip
        // the `version` bump entirely; still flip `_preloaded` on the first
        // full scan so `preload`'s once-only callers see it (and an empty
        // space, whose scan legitimately fetches nothing, is not stuck
        // retrying).
        if (fullScan && !get()._preloaded) set({ _preloaded: true })
        return { applied: true, pageHalfFailed: false }
      }
      // #3321 — the bulk path enforces `MAX_CACHE_SIZE` too. `set`/`batchSet`
      // both evict after writing; preload used to be the one writer that
      // could push the Map past the cap, so the documented budget was not
      // actually a budget. Entries evicted here are the coldest ones and are
      // re-resolved on demand by the block-tree `batchResolve` path.
      evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
      set((state) => ({
        cache,
        version: state.version + 1,
        _preloaded: state._preloaded || fullScan,
      }))
      return { applied: true, pageHalfFailed: false }
    } catch (err) {
      logger.warn('ResolveStore', 'preload failed, using fallback', {}, err)
      return { applied: false, pageHalfFailed: !pageHalfSucceeded }
    }
  }

  return {
    cache: new Map(),
    version: 0,
    _preloaded: false,

    preload: (spaceId, forceRefresh = false, changedPageIds) => {
      // FE-H-22 — fail closed during pre-bootstrap. Earlier we forwarded
      // `spaceId ?? ''` to `listBlocks` and relied on the backend
      // treating `''` as a no-match SQL filter. That contract is
      // unwritten; a backend change to interpret `''` as wildcard would
      // silently leak cross-space pages through the resolve cache. The
      // cross-space barrier is the most-protected invariant — skip the
      // fetch entirely until the space store hydrates and a real
      // `spaceId` is threaded through.
      if (spaceId == null) return Promise.resolve()

      // #753 — coalesce concurrent preloads of the same space. A plain
      // call joins the in-flight scan; a forceRefresh call additionally
      // schedules ONE trailing re-scan (see `inflightPreloads` doc).
      const inflight = inflightPreloads.get(spaceId)
      if (inflight) {
        if (forceRefresh) {
          foldIntoTrailing(inflight, changedPageIds)
        } else if (!inflight.currentFull) {
          // #3321 — a PLAIN caller (boot / space switch) wants the whole space
          // warmed. The scan it would have joined is targeted and refreshes a
          // handful of ids, so schedule the full walk as the trailing scan
          // rather than resolving this caller against a partial cache.
          foldIntoTrailing(inflight, undefined)
        }
        return inflight.promise
      }

      const leadingIds = narrowToTargetedIds(changedPageIds)
      const entry: PreloadEntry = {
        promise: Promise.resolve(),
        currentFull: leadingIds === null,
        trailingForce: false,
        trailingIds: null,
      }
      entry.promise = (async () => {
        try {
          // #3321 — a scan that THREW consumed its scope without applying it.
          // A full walk self-heals (the next one re-reads the whole space), but
          // a targeted scan's ids are the ONLY thing that would ever have
          // re-resolved those pages: later ticks carry the NEXT write's ids, so
          // one transient `batch_resolve` failure would leave a peer-renamed
          // page rendering its old title until a space switch. Escalate the
          // failure to the full walk (a superset) exactly once — a failing full
          // walk does not re-escalate, so the chain is bounded at one retry.
          let scanIds = leadingIds
          let result = await runPreloadScan(spaceId, scanIds)
          // Escalate ONLY when the page half is what failed (see
          // `runPreloadScan`): a tag failure would otherwise turn a 2-IPC
          // targeted rescan into a ~33-IPC walk that re-runs the same
          // failing tag call.
          if (result.pageHalfFailed && scanIds !== null) foldIntoTrailing(entry, undefined)
          while (entry.trailingForce) {
            scanIds = narrowToTargetedIds(entry.trailingIds ?? undefined)
            entry.currentFull = scanIds === null
            entry.trailingForce = false
            entry.trailingIds = null
            result = await runPreloadScan(spaceId, scanIds)
            if (result.pageHalfFailed && scanIds !== null) foldIntoTrailing(entry, undefined)
          }
        } finally {
          // Runs synchronously with the body's completion — before any
          // joiner's `await` continuation — so a late caller can never
          // observe (and mark trailingForce on) a finished entry.
          if (inflightPreloads.get(spaceId) === entry) inflightPreloads.delete(spaceId)
        }
      })()
      inflightPreloads.set(spaceId, entry)
      return entry.promise
    },

    // FE-H-21 — `set` and `batchSet` both bump `version` inline so the
    // re-render policy is symmetric across single and batch writers.
    // (Earlier behaviour debounced `set` via a microtask + closure flag,
    // which left an asymmetric contract — `batchSet` always bumped, `set`
    // sometimes coalesced. Inline is simpler and consistent.)
    set: (id, title, deleted, resolved = true) => {
      const spaceId = activeSpaceId()
      const compositeKey = keyFor(spaceId, id)
      // #1073 — diff before cloning, mirroring batchSet's #753 guard. `set`
      // fires on tag create/delete/rename (TagList) and trash restore
      // (TrashView); idempotent restores/renames re-write the identical
      // `{ title, deleted }` for a key already in the cache. Cloning the
      // full Map and bumping `version` for a no-op change re-renders every
      // version-subscribed block row for zero gain. Skip when unchanged.
      const cached = get().cache.get(compositeKey)
      if (
        cached &&
        cached.title === title &&
        cached.deleted === deleted &&
        cached.resolved === resolved
      )
        return
      // Perf (#2267) — mutate the cache Map in place (write the one changed
      // key + evict) instead of cloning the whole (<=10k entry) Map on every
      // write. Every consumer re-renders off `version`, not the Map
      // reference, so reusing the same object is safe (see consumer audit).
      set((state) => {
        const cache = state.cache
        touch(cache, compositeKey, { title, deleted, resolved })
        evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
        return { cache, version: state.version + 1 }
      })
    },

    batchSet: (entries) => {
      if (entries.length === 0) return
      const spaceId = activeSpaceId()
      // #753 — diff before cloning. batchSet fires per picker keystroke
      // (BlockTree batchResolve) with mostly already-cached rows; when
      // nothing actually changed, cloning the full 10k-entry Map and
      // bumping `version` re-renders every version-subscribed block row
      // for zero gain. Only the changed subset is written.
      const current = get().cache
      const changed = entries.filter((e) => {
        const cached = current.get(keyFor(spaceId, e.id))
        return (
          !cached ||
          cached.title !== e.title ||
          cached.deleted !== e.deleted ||
          cached.resolved !== (e.resolved ?? true)
        )
      })
      if (changed.length === 0) return
      // Perf (#2267) — mutate the cache Map in place (write only the
      // changed subset + evict) instead of cloning the whole Map. Every
      // consumer re-renders off `version`, not the Map reference (see
      // consumer audit), so reusing the same object is safe.
      set((state) => {
        const cache = state.cache
        for (const e of changed) {
          touch(cache, keyFor(spaceId, e.id), {
            title: e.title,
            deleted: e.deleted,
            resolved: e.resolved ?? true,
          })
        }
        evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
        return { cache, version: state.version + 1 }
      })
    },

    resolveTitle: (id) => {
      const cache = get().cache
      const key = keyFor(activeSpaceId(), id)
      const cached = cache.get(key)
      if (cached) {
        // LRU: refresh recency in place (no clone, no version bump → no
        // re-render) so a frequently-read entry survives eviction.
        // Perf (#2200/#2267) — only bother once the cache is AT capacity:
        // eviction order is irrelevant while `size < MAX_CACHE_SIZE`
        // (nothing can be evicted yet), so skip the delete+re-set on every
        // hot read below that threshold. Once at capacity, every read
        // resumes touching so recency stays accurate for the next write's
        // eviction pass.
        if (cache.size >= MAX_CACHE_SIZE) touch(cache, key, cached)
        // #4238 — the FLAG decides, not the bytes. An entry the backend never
        // returned falls through to the same label an absent key produces, so
        // the two cache-miss shapes stay indistinguishable to every consumer
        // (including `resolveBlockDisplay`'s pattern) without any writer having
        // to encode "unresolved" into a title.
        if (cached.resolved) return cached.title
      }
      return unresolvedBlockLabel(id)
    },

    resolveStatus: (id) => {
      const cache = get().cache
      const key = keyFor(activeSpaceId(), id)
      const cached = cache.get(key)
      if (cached) {
        // See resolveTitle above — LRU touch only matters at capacity.
        if (cache.size >= MAX_CACHE_SIZE) touch(cache, key, cached)
        // #4515 — `!resolved` counts as deleted. An entry the backend never
        // returned is a broken target, and rendering it 'active' would put a
        // live-looking chip on the unresolved label that `resolveTitle` hands
        // back for the same entry. Inert today (the sole `resolved: false`
        // writer also sets `deleted: true`) — see the interface docblock.
        return cached.deleted || !cached.resolved ? 'deleted' : 'active'
      }
      return 'active'
    },

    has: (id) => get().cache.has(keyFor(activeSpaceId(), id)),

    isResolved: (id) => get().cache.get(keyFor(activeSpaceId(), id))?.resolved === true,

    clearAllForSpace: (prevSpaceId) =>
      set((state) => {
        const prefix = `${prevSpaceId}::`
        const cache = new Map(state.cache)
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) cache.delete(key)
        }
        return { cache, version: state.version + 1 }
      }),
  }
})
