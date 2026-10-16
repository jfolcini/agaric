/**
 * useBlockResolve — hook for resolving block/tag ULIDs to display titles.
 *
 * Wraps the global resolve store and provides:
 * - Resolve callbacks (resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus)
 * - Picker search callbacks (searchTags, searchPages, onCreatePage)
 *
 * NOTE: The preload effect that fetches pages/tags and scans for uncached
 * ULIDs is intentionally kept in BlockTree (not in this hook) to preserve
 * the original effect ordering: load() must fire before preload.
 */

import { Hash, Tag } from 'lucide-react'
import { matchSorter } from 'match-sorter'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { type GenerationRef, matchPages } from '@/components/block-tree/page-matcher'
import type { PickerItem } from '@/editor/SuggestionList'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { TagCacheRow } from '@/lib/bindings'
import {
  blockFirstLineOr,
  resolveStoreTitle,
  unresolvedBlockLabel,
  unresolvedTagLabel,
} from '@/lib/block-title'
import { foldForSearch } from '@/lib/fold-for-search'
import { t as translate } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { searchBlocksLimit } from '@/lib/safe-limit'
import { requireActiveScope, requireActiveSearchScope } from '@/lib/space-scope'
import { compareUtf8Bytes, foldAsciiUppercase } from '@/lib/sqlite-collation'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

function logSlowQuery(fn: string, query: string, t0: number, count: number): void {
  const durationMs = Math.round(performance.now() - t0)
  if (durationMs > 200) {
    logger.warn('useBlockResolve', `${fn} slow`, { query, durationMs, count })
  }
}

export interface UseBlockResolveReturn {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  resolveTagStatus: (id: string) => 'active' | 'deleted'
  searchTags: (query: string) => Promise<PickerItem[]>
  searchPages: (query: string) => Promise<PickerItem[]>
  searchBlockRefs: (query: string) => Promise<PickerItem[]>
  onCreatePage: (label: string) => Promise<string>
  onCreateTag: (name: string) => Promise<string>
  /**
   * #4319 — the ONLY sanctioned way for a page-creation site OUTSIDE this
   * hook (today: the date picker's `handleDateMode`) to tell the picker
   * cache about a page it just created. Wraps `recordCreatedRow`, so the
   * append and the generation bump cannot be taken apart: a caller cannot
   * do one without the other.
   *
   * The date picker used to be handed `pagesListRef` itself and appended to
   * it directly — which is how it ended up the one creation site carrying
   * NEITHER invariant. It receives this instead.
   *
   * How strong the guarantee is, precisely: for a site handed ONLY this
   * callback — which is what `UseBlockDatePickerParams` now passes — it is
   * a compile-time one, because that site has no reference to
   * `pagesListRef` to append to. It is NOT compile-time for a component
   * that calls `useBlockResolve()` itself: `pagesListRef` / `tagsListRef`
   * are on this interface (for tests, see their own notes) and
   * `React.RefObject.current` is mutable, so `resolve.pagesListRef.current`
   * can still be reassigned or `.push`ed by hand. Nothing does today
   * (`BlockTree` reads neither ref), and nothing should — but that is
   * convention, the same convention that holds inside this hook, not a
   * barrier. Narrow it by moving the two refs behind a test-only accessor
   * if a production consumer ever appears.
   *
   * #4358 asked whether the OTHER `createPageInSpace` call sites should
   * register too. Answer: NO code change is needed. The finding worth
   * keeping is the enumeration behind that answer, so it is recorded here
   * rather than re-derived:
   *
   *  1. ONE ENTRY POINT (as of #4411). `createPageInSpace` used to exist
   *     both as a typed wrapper in the (now-deleted) `system` module of the
   *     hand-written IPC layer AND as the raw binding, so a reference
   *     query on either alone undercounted — asymmetrically: the wrapper
   *     reached some of the sites below and the binding the others.
   *     That wrapper is gone; every site now calls
   *     `commands.createPageInSpace` directly, so a single reference query
   *     on the binding is complete. Of the creation sites outside
   *     `onCreatePage`, one registers
   *     (`src/components/block-tree/use-block-date-picker.ts`, the #4319 site above).
   *  2. THE REST CANNOT REGISTER — they did not forget to.
   *     `useBlockResolve()` has exactly one caller (`BlockTree`), and every
   *     other site sits above or beside it: `useJournalBlockCreation` (via
   *     `JournalPage`/`StreamView`), `JournalTemplateButton`, the App-level
   *     New page dialog (`usePageCreation`), `TemplatesView`, and
   *     `WelcomeModal`'s `ensureSamplePage`. A paste's `[[Name]]` now creates
   *     its page in the backend's `paste_blocks` (#5140), which the paste
   *     reducer announces on the name-change bus. The journal also mounts one
   *     BlockTree PER DAY PANEL, so several `pagesListRef` caches coexist:
   *     there is no single cache to register into.
   *  3. THE IMPACT CEILING, which is NOT uniform across the two readers.
   *     `searchPages` routes `q.length <= 2` through the cache and
   *     everything longer through FTS, so a missing cache row hides a page
   *     from SEARCH RESULTS only for empty and <=2-char queries, and only
   *     against an already-warm cache. But `appendCreatePageOptionIfNeeded`
   *     reads `pagesListRef` at ANY query length, so CREATE-SUPPRESSION is
   *     affected more broadly than search is — the easy half to miss.
   *  4. THE #4319 OVERWRITE SHAPE REQUIRES REACHING `pagesListRef`. A site
   *     that never touches the ref cannot reproduce it, however the page is
   *     registered later: a refill is a guarded DB replace, and a
   *     name-change event bumps the generation BEFORE it applies, so a
   *     bump-without-append can only cost an extra refetch, never a lost
   *     row.
   *  5. A SITE THAT DOES NEED TO REGISTER USES THE BUS, NOT THIS RETURN
   *     VALUE. #4338 implemented that route: `notifyPageAdded` /
   *     `notifyTagAdded` on the name-change bus, applied through the same
   *     append-only-into-a-non-empty-cache guard as `recordCreatedRow`, so
   *     it reaches EVERY mounted instance rather than just this one. That
   *     is why it beats both alternatives: this return value is unreachable
   *     for all eight sites above, and a React context cannot be consumed by
   *     the module-level ones. `name-change-bus.ts` used to state there was
   *     deliberately no "added" event; #4338 amended that paragraph rather
   *     than silently contradicting it, and it now carries the enumeration
   *     of which sites publish and why — so a reader landing here while
   *     adding a TENTH creation site should start there.
   *
   *     The residual #4338 left open, recorded so it is not rediscovered:
   *     the three IN-HOOK paths still update only their own instance, so a
   *     page created via Monday's `[[`-picker is invisible to Tuesday's
   *     cache in the journal's per-day-panel mounts.
   */
  registerCreatedPage: (row: { id: string; title: string }) => void
  /** Ref to the pages list cache for search. Lazily filled by
   *  `searchPagesViaCache`, written by `onCreatePage` /
   *  `registerCreatedPage` through `recordCreatedRow` (never appended to
   *  directly), cleared on space switch (#732), and kept current across
   *  renames and deletes by the name-change bus (#4007). */
  pagesListRef: React.RefObject<Array<{ id: string; title: string }>>
  /**
   * Ref to the tags list cache for search — `pagesListRef`'s sibling, with
   * the same lifecycle (lazy fill in `searchTags`, `onCreateTag` write via
   * `recordCreatedRow`, space-switch clear, name-change-bus patching).
   *
   * #4337 item 4 — exposed for the same reason `pagesListRef` is. Without
   * it the tags-side cache tests could only assert through `searchTags`'s
   * IPC call counts, so they failed for reasons other than the guard they
   * pinned. Read/seed access only BY CONVENTION: creations go through
   * `onCreateTag`. Exposing it does widen what production code *could*
   * reach — see `registerCreatedPage` for exactly how far the #4319
   * guarantee extends, and what to do if a production consumer appears.
   */
  tagsListRef: React.RefObject<TagCacheRow[]>
}

/**
 * #853 — `batchSet` keys rows by the active space at WRITE time. A stale
 * in-flight response from the OLD space can resolve after a space switch
 * and seed old-space rows under the NEW space's keys (silent cross-space
 * data). Every resolve-cache writeback in this file captures the active
 * space at request time (`requestSpaceId`) and must gate its `batchSet`
 * behind this equality check before writing — mirrors the #732
 * captured-space guard (`pagesListRef`'s own invalidation).
 */
function isRequestSpaceStillActive(requestSpaceId: string | null): boolean {
  return (useSpaceStore.getState().currentSpaceId ?? null) === requestSpaceId
}

/**
 * Populates the resolve cache so page links show titles instead of raw ULIDs.
 *
 * #853 — see `isRequestSpaceStillActive` above.
 *
 * #4239 — takes page ROWS, not the rendered `PickerItem`s. It used to seed
 * `m.label`, and `makePagePickerItem` builds that label through
 * `formatNamespacedLabel`, which SPLITS a namespaced title into
 * `{ label: leaf, breadcrumb: 'parent / child' }`. So the picker stored
 * `Observability` for a page whose title is
 * `Engineering/Platform/Observability`, while `preload` and the three
 * id-fetching seeders store the full path under that same key — a permanent
 * value-diff that re-bumped `version` every time the user typed `[[` on a
 * page with a namespace, and left `renderBlockLink`'s `title=` tooltip (and
 * `getPageDisplayName`'s own leaf/breadcrumb split) working off a path that
 * had already been truncated once. Seeding from the row keeps the stored
 * title un-split and un-capped, which is the page/tag arm of the invariant
 * in `@/lib/block-title`.
 */
function populatePageResolveCache(
  rows: ReadonlyArray<{ id: string; title: string }>,
  requestSpaceId: string | null,
): void {
  if (rows.length === 0) return
  if (!isRequestSpaceStillActive(requestSpaceId)) return
  useResolveStore
    .getState()
    .batchSet(
      rows.map((r) => ({ id: r.id, title: resolveStoreTitle('page', r.title), deleted: false })),
    )
}

// ── Name-cache invalidation (#4007) ─────────────────────────────────────
//
// Both picker caches are filled once per space, so a rename or delete
// performed on any other surface used to keep being offered under the old
// name until the next space switch. `@/lib/name-change-bus` carries those
// mutations; the two appliers below fold one event into one cached list.
//
// A `removed` entry is dropped rather than blanked so the picker stops
// offering it at all. Dropping the LAST entry leaves the list empty, which
// both call sites read as "not fetched for this space yet" and re-fetch —
// correct, if slightly eager: the backend has already committed the delete.

/**
 * A patched-in-place rename must also re-establish the ORDER the fetch
 * returned, because both caches are served in list order: `searchPages`'s
 * empty/short query slices the FIRST 20 rows off `pagesListRef`, and
 * `searchTags` maps `tagsListRef` straight through. Patching a title without
 * re-sorting leaves the renamed row parked in its OLD alphabetical slot — so
 * a page renamed from `Zebra` to `Apple` stays invisible past row 20 in a
 * space with more than 20 pages, which is the same "picker doesn't show the
 * truth" symptom #4007 exists to remove.
 *
 * The comparators mirror the backend's `ORDER BY`:
 *   - pages: `ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC`
 *     (`src-tauri/src/commands/pages/listing.rs`) — case-insensitive, id
 *     tie-break.
 *   - tags: `ORDER BY tc.name` (`agaric-store/src/tag_query/query.rs`) —
 *     SQLite's default BINARY collation, i.e. case-SENSITIVE UTF-8 BYTE order.
 *
 * `compareTagRows` compares raw UTF-8 bytes (`compareUtf8Bytes`), so it is an
 * exact match for BINARY — not an approximation. `comparePageRows` USED TO be
 * only an approximation of `NOCASE`, diverging for TWO independent reasons:
 *   1. `NOCASE` folds ASCII only; `toLowerCase()` folded Unicode too, so a
 *      page whose title differed only in non-ASCII casing (Turkish İ/i, and
 *      similar) could land in the wrong slot. Fixed by `foldAsciiUppercase`,
 *      an ASCII-only fold matching what `NOCASE` actually does.
 *   2. After the fold it still compared with `<`, i.e. UTF-16 code units —
 *      the exact byte-order divergence #4057 fixed for tags, also live for
 *      pages: `NOCASE` case-folds and then memcmps bytes, so page titles
 *      whose UTF-16 and UTF-8 orders disagree (a supplementary-plane
 *      character vs. one in U+E000–U+FFFF) sorted in opposite orders
 *      backend-vs-frontend. Fixed by reusing `compareUtf8Bytes` here too.
 * Both fixed together (#4131) — fixing one and not the other would have left
 * this docblock wrong again in a new way.
 *
 * The exactness claim is about the COMPARATOR. #4138 closed three residual
 * gaps that sat outside it, split from the #4134 review so they'd be tracked
 * rather than lost:
 *   1. The cache seed used to write `title: p.content ?? 'Untitled'`, so a
 *      NULL-content page sorted as `'Untitled'` here vs. `''` (first) in
 *      SQLite. Fixed by seeding the raw `''` and moving the placeholder to
 *      `makePagePickerItem`, the render site (see its docblock).
 *   2. Both comparators tiebroke on `a.id < b.id` / `a.tag_id < b.tag_id`,
 *      UTF-16 order, where the backend's `id ASC` is BINARY. Inert while ids
 *      are ULIDs (ASCII-only), but nothing enforces that alphabet, so fixed
 *      by reusing `compareUtf8Bytes` for the id tiebreak too.
 *   3. The equality gate compared JS-string `!==` while the comparison
 *      compared UTF-8 bytes. `TextEncoder` maps every unpaired surrogate to
 *      U+FFFD, so two titles differing ONLY in lone surrogates were `!==`
 *      (gate passed) yet encoded to identical bytes — `compareUtf8Bytes`
 *      returned 0 and was returned directly, silently skipping the id
 *      tiebreak below it. Fixed by dropping the `!==` gate entirely and
 *      falling through to the id tiebreak whenever the title/name byte
 *      comparison itself returns 0.
 *
 * Either comparator only runs on a rename, so the worst case for either
 * comparator is a locally-renamed row landing one slot away from where a
 * refetch would put it. Note the cache is not perfectly ordered to begin
 * with — `onCreatePage` has always APPENDED a newly created page — so this
 * restores the invariant for renames, it does not establish one that never
 * existed.
 */
function comparePageRows(
  a: { id: string; title: string },
  b: { id: string; title: string },
): number {
  const at = foldAsciiUppercase(a.title)
  const bt = foldAsciiUppercase(b.title)
  const titleCmp = compareUtf8Bytes(at, bt)
  if (titleCmp !== 0) return titleCmp
  return compareUtf8Bytes(a.id, b.id)
}

// #4057's `compareUtf8Bytes` and `NOCASE`'s ASCII-only fold now live in
// `@/lib/sqlite-collation`.

function compareTagRows(a: TagCacheRow, b: TagCacheRow): number {
  const nameCmp = compareUtf8Bytes(a.name, b.name)
  if (nameCmp !== 0) return nameCmp
  return compareUtf8Bytes(a.tag_id, b.tag_id)
}

/**
 * The 'added' arm shared by both apply functions below (#4338) — the decision
 * `recordCreatedRow` makes for an in-hook create, restated for a create
 * announced on the bus.
 *
 * Both dedupe. A bus event can race a fill that already delivered the same row;
 * an in-hook create can BE that row, because `create_page_in_space` resolves an
 * existing title to that page rather than creating a second one (#4723).
 *
 *  - `'skip'` when the list is EMPTY. An empty cache is not "a space with no
 *    rows", it is "not fetched for this space yet", and appending the one row
 *    the event describes would latch it as the whole space (#4008 review
 *    notes 1 / 6). This is the objection the bus docblock used to raise
 *    against having an 'added' event at all; it is answered by honouring it
 *    here, not by refusing the event. The subscriber's unconditional
 *    generation bump has already fired by this point, so the skipped row is
 *    not lost — the next picker read re-fetches and sees it.
 *
 *    #4391 note: this guard is about cache FRESHNESS ("have we ever fetched
 *    for this space") and is orthogonal to the space-id check the subscriber
 *    runs before calling in here at all ("is this event even ABOUT the space
 *    we're showing"). Scoping the event does not make this one redundant —
 *    even a same-space 'added' event can still land on a cache that has
 *    never been fetched, and must still be skipped for exactly this reason.
 *    They compose: the space check answers "is this event relevant", this
 *    one answers "is our cache warm enough to accept a single-row patch".
 *  - `'skip'` when the row is ALREADY present. Reachable without any double
 *    emit: a fill dispatched before the create can resolve AFTER the backend
 *    commit and BEFORE the emit (the create's `await` and the emit are the
 *    same microtask continuation, but the fill's resolution is not ordered
 *    against the backend write), so its response already contains the new
 *    row. Without this, that interleaving leaves a duplicate id in the cache.
 *  - `'append'` otherwise, at the END and unsorted. The 'renamed' arms
 *    re-sort because a row already in position had its SORT KEY changed
 *    under it; a create has no position to preserve, and matching the
 *    in-hook create path matters more than matching the backend's ORDER BY.
 */
function addedRowDisposition(isEmpty: boolean, alreadyPresent: boolean): 'skip' | 'append' {
  return isEmpty || alreadyPresent ? 'skip' : 'append'
}

/** Applies one page-scoped change to the `pagesListRef` list. */
function applyPageNameChange(
  list: Array<{ id: string; title: string }>,
  change: NameChange,
): Array<{ id: string; title: string }> {
  if (change.kind === 'invalidated') return []
  if (change.kind === 'removed') return list.filter((p) => p.id !== change.id)
  // Bind before the closure: TypeScript's narrowing of `change` does not
  // survive into the callback below.
  const { id, name } = change
  const present = list.some((p) => p.id === id)
  if (change.kind === 'added') {
    if (addedRowDisposition(list.length === 0, present) === 'skip') return list
    return [...list, { id, title: name }]
  }
  if (!present) return list
  return list.map((p) => (p.id === id ? { ...p, title: name } : p)).toSorted(comparePageRows)
}

/** Applies one tag-scoped change to the `tagsListRef` list. */
function applyTagNameChange(list: TagCacheRow[], change: NameChange): TagCacheRow[] {
  if (change.kind === 'invalidated') return []
  if (change.kind === 'removed') return list.filter((t) => t.tag_id !== change.id)
  const { id, name } = change
  const present = list.some((t) => t.tag_id === id)
  if (change.kind === 'added') {
    if (addedRowDisposition(list.length === 0, present) === 'skip') return list
    // `usage_count: 0` is correct — a just-created tag is not yet applied to
    // any block. Mirrors the row `onCreateTag` appends for its own create.
    // `updated_at` reads the clock inside what is otherwise a pure reducer.
    // Inert today: `compareTagRows` sorts on name then `tag_id`, and nothing in
    // the picker reads `updated_at` — but it does make this function
    // non-deterministic under fake timers or a future snapshot test. If one is
    // ever added, hoist the clock read to the subscriber and pass it in rather
    // than dropping the field.
    return [...list, { tag_id: id, name, usage_count: 0, updated_at: new Date().toISOString() }]
  }
  if (!present) return list
  return list.map((t) => (t.tag_id === id ? { ...t, name } : t)).toSorted(compareTagRows)
}

/**
 * The append+bump pair EVERY creation site owes the picker caches, in one
 * place so that no call site can perform half of it.
 *
 * Two independent invariants, learned separately and each easy to miss:
 *
 *  1. Bump the generation (#4275 item 1). A create is a name change. A fill
 *     issued BEFORE the create resolves after it holding a pre-create
 *     snapshot that passes the space, generation and #4270 sequence guards
 *     — all three were captured after that fill was issued, and none of
 *     them knows a row appeared — and overwrites the cache, so the
 *     just-created row vanishes from the picker until something else
 *     invalidates.
 *
 *  2. Append ONLY into an already-filled cache (#4008 review notes 1 / 6).
 *     An EMPTY list is not "a space with no pages/tags", it is the "not
 *     fetched for this space yet" state that makes the lazy fill re-fetch.
 *     Appending there flips it to "filled" with a single row and latches
 *     that one row as the whole space for the rest of the session. #4007
 *     widened the window: the caches now also empty on every sync / MCP
 *     invalidation, every restore, and any delete that drops the last row,
 *     so "invalidate, type a long name, Create" is an ordinary sequence
 *     that reaches an empty cache at create time.
 *
 * They compose, which is why they belong together and why the bump is
 * unconditional and comes FIRST: skipping the append is only safe BECAUSE
 * the bump forces the next read to re-fetch, and the empty-cache case is
 * precisely the one where a racing fill is the only thing that could still
 * hide the new row. A site that appends without bumping is the #4319 bug; a
 * site that bumps without the guard is the #4008 latch.
 *
 * #4319 — this lived as two copy-pasted lines in `onCreatePage` and
 * `onCreateTag`, and a third creation site (the date picker's
 * `handleDateMode`, added later) carried NEITHER: it appended
 * unconditionally and never bumped. That is the recurring shape — "a new
 * creation site does not inherit the invariants the existing ones learned"
 * — so the pair is one function now, and the out-of-hook site reaches it
 * only through `registerCreatedPage`, never through a raw ref.
 *
 * #4338 — the SAME pair, for a creation site that cannot reach this hook at
 * all, is `notifyPageAdded` / `notifyTagAdded`: the subscriber below bumps
 * the generation unconditionally before applying, and `applyPageNameChange`
 * / `applyTagNameChange`'s 'added' arms share this function's decision
 * through `addedRowDisposition`. Nine of the ten page creation sites in the
 * app are outside this hook; `notifyPageAdded`'s docblock carries the
 * per-site enumeration and the reason the three in-hook paths stay on
 * `recordCreatedRow`.
 */
function recordCreatedRow<Row, IdKey extends keyof Row>(
  listRef: React.RefObject<Row[]>,
  generationRef: GenerationRef,
  row: Row,
  idKey: IdKey,
): void {
  generationRef.current += 1
  const list = listRef.current
  // #4723 — `create_page_in_space` RESOLVES an existing title to that page
  // instead of creating one, so a "created" row can be a row the filled list
  // already holds, and the `[[` picker would offer that page twice.
  const alreadyPresent = list.some((existing) => existing[idKey] === row[idKey])
  if (addedRowDisposition(list.length === 0, alreadyPresent) === 'skip') return
  listRef.current = [...list, row]
}

export function useBlockResolve(): UseBlockResolveReturn {
  // Subscribe to version so the component re-renders when the cache updates,
  // keeping cacheRef.current fresh for the stable callbacks below.
  useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)

  const cacheRef = useRef(cache)
  useLayoutEffect(() => {
    cacheRef.current = cache
  })

  // Local ref for pagesListRef used in searchPages caching. Lazily
  // filled by `searchPagesViaCache` (scoped to the space active at
  // call-time) and written by `onCreatePage` and the date picker's
  // `registerCreatedPage`, both through `recordCreatedRow`.
  const pagesListRef = useRef<Array<{ id: string; title: string }>>([])

  // #3277 — mirrors `pagesListRef`: `searchTags` used to call
  // `listAllTagsInSpace` on EVERY keystroke with no client cache, unlike
  // this sibling. Lazily filled by `searchTags` on the FIRST call, filtered
  // client-side (via `matchSorter`) on every subsequent keystroke, and
  // invalidated by the same space-switch subscriber below (#732 pattern).
  const tagsListRef = useRef<TagCacheRow[]>([])

  // #4055 — bumped by the name-change-bus subscriber below on EVERY event
  // (any kind, any entity). Both lazy-fill sites (`searchPagesViaCache` and
  // `searchTags`'s inline fill) capture this before their IPC and refuse to
  // persist a stale response once it no longer matches — closing the
  // in-flight window the #732 space-only guard couldn't see: a bus event
  // landing between the IPC dispatch and its resolution. Also bumped by
  // `onCreatePage` / `onCreateTag` (#4275 item 1 — see their comments): a
  // create is a name-change too, and without this an in-flight fill's
  // pre-create snapshot could win and silently hide the just-created page/tag.
  //
  // #4275 item 2 — deliberately ONE counter shared across both entities
  // (page/tag) and every event kind, not split per-entity. A tag rename
  // therefore also rejects an in-flight PAGE fill, and vice versa: safe
  // (it over-rejects, never under-rejects — the fill just re-fetches), but
  // it costs an avoidable `listAllPagesInSpace`/`listAllTagsInSpace` round
  // trip and a transiently empty picker for an event that could not have
  // affected that particular fetch. Recorded decision: left as one counter.
  // Over-rejection is the correct bias for a correctness guard, and two
  // counters are two things that can drift out of sync (miss bumping one on
  // a new event kind) for a cost that is small and self-healing on the very
  // next keystroke. Split them only if the extra round trips are ever
  // measured to matter.
  //
  // #4337 item 5 — stating the cost the recorded decision above leaves
  // implicit: the create sites bump this too (via `recordCreatedRow`), and
  // a user creates pages and tags far more often than they rename or delete
  // them. So the over-rejection is not a rare bus-event nuisance — every
  // page created aborts an in-flight `tagsListRef` fill, and every tag
  // created aborts an in-flight `pagesListRef` fill, leaving THAT call's
  // picker rendering empty for one keystroke before it re-fetches. Still
  // accepted (the alternative is two counters that can drift apart, for a
  // cost that self-heals on the very next keystroke), but it is a
  // user-visible flicker rather than a round trip, and it is the reason to
  // revisit if pickers are ever observed to flicker.
  const nameChangeGenerationRef = useRef(0)

  // #4270 — per-list monotonic sequence counters gating a fill's write on
  // being the latest ISSUED request for that list, not merely the latest
  // RESOLVED one. See `RequestSeqRef`'s comment for the mechanism and why
  // these stay split per-list rather than sharing one counter (contrast
  // `nameChangeGenerationRef` just above, which is deliberately shared).
  const pagesRequestSeqRef = useRef(0)
  const tagsRequestSeqRef = useRef(0)

  // #732 — the cache holds space-scoped data in a space-agnostic
  // container, and the hook instance SURVIVES page-editor→page-editor
  // space switches (ViewDispatcher renders PageEditor without a key and
  // PageEditor renders BlockTree without a key). Without invalidation, a
  // list lazily filled in space A keeps serving ≤2-char `[[` picker
  // queries after the user switches to space B — cross-space results in
  // the picker. Clear the ref the moment the active space changes; the
  // next short query refetches for the new space via the lazy fallback
  // in `searchPagesViaCache`. The space store carries
  // `subscribeWithSelector`, so the listener only wakes on real
  // `currentSpaceId` changes (not `availableSpaces` / `isReady` writes).
  useEffect(
    () =>
      useSpaceStore.subscribe(
        (s) => s.currentSpaceId,
        () => {
          pagesListRef.current = []
          tagsListRef.current = []
        },
      ),
    [],
  )

  // #4007 — the space-switch subscriber above was the ONLY invalidation
  // either cache had. A page or tag renamed or deleted from another surface
  // (PageHeader, undo/redo, the shared page-delete flow, the Tags view) stayed
  // in the cache under its old name for the rest of the session, so the `[[`
  // and `#` pickers kept offering a name that no longer exists — and, after a
  // delete, an id that resolves to nothing. Subscribe both refs to the
  // name-change bus so the very next picker read reflects the mutation,
  // without dropping the cache the whole strategy exists to keep warm.
  useEffect(
    () =>
      subscribeToNameChanges((change) => {
        // #4055 — bump on every event, unconditionally, BEFORE applying it
        // AND BEFORE the #4391 space drop below.
        // An in-flight fill's `requestGeneration` capture and this bump can
        // never interleave any other way: JS is single-threaded and nothing
        // awaits between them, so a fill either captured the generation
        // before this listener runs (and must now lose the race) or after
        // (and reads the bumped value already).
        //
        // #4391 review — the bump must come FIRST, ahead of the space check,
        // and the check may only suppress the CACHE MUTATION below. The two
        // guards measure different spaces: this listener compares the event
        // against the space that is LIVE right now, while an in-flight fill
        // is pinned to the space it CAPTURED at dispatch
        // (`searchPagesViaCache` in `page-matcher.ts`).
        // Those diverge across an A→B→A round trip. Dropping the bump on a
        // mismatch reopens #4007 exactly: a fill issued for A captures
        // generation G; the user switches to B (both caches clear); a genuine
        // A-side rename captured in A emits with `spaceId: 'A'` while B is
        // live, mismatches, and is dropped; the user switches back to A; the
        // fill resolves with the PRE-rename snapshot and every guard passes
        // (space is A again, generation never moved, no newer fill issued),
        // so the stale title is persisted and the `[[` picker serves it for
        // the rest of the session. The invariant the fill guards are written
        // against — stated in the note above 'a fetch survives a space switch
        // that returns to the original space' in
        // `src/components/block-tree/__tests__/use-block-resolve.test.ts`, and
        // pinned by 'a rename landing while parked on another space still
        // rejects the survivor fetch' right below it — is that ANY genuine
        // mutation bumps the generation regardless of which space was active
        // when it fired. The bump is a correctness
        // mechanism about STALENESS, not about relevance; only the apply is
        // about relevance. Cost of bumping on a foreign event is one refetch,
        // which is precisely the pre-#4391 behaviour.
        nameChangeGenerationRef.current += 1
        // #4391 — every kind but 'invalidated' carries the space the
        // publisher had in hand when it decided to act. Drop the event
        // OUTRIGHT when that does not match the space we are live-showing —
        // before the #4008 latch guard (which is about cache freshness, not
        // relevance) — so no foreign-space row is ever appended and no
        // foreign-space 'removed' deletes one. A create whose captured-space
        // read and emit straddled a space switch is exactly the case this
        // closes: without this check the event would reach an already-
        // re-warmed cache for the NEW space and append a foreign-space row
        // (the #4391 report).
        //
        // 'invalidated' carries no `spaceId` and is intentionally exempt —
        // see the name-change-bus module docblock for why a full clear does
        // not need a space to compare against.
        //
        // #4558 — so is a 'removed' event carrying `spaceId: null`. Honour it
        // whatever space is live; `notifyPageRemoved`'s `spaceId: null`
        // section is where that is argued, including why it is safe for THIS
        // subscriber.
        if (change.kind !== 'invalidated' && change.spaceId !== null) {
          const activeSpaceId = useSpaceStore.getState().currentSpaceId
          if (change.spaceId !== activeSpaceId) {
            // Log the event's SHAPE, not the event: `change.name` is a
            // user-authored page title or tag name, and this path fires
            // without any user action (a background sync write is enough).
            // Kind + id + space carry the whole diagnostic value — which
            // event was dropped, for which row, and which way the space
            // comparison went — with none of the content.
            logger.debug('useBlockResolve', 'dropped name-change event for inactive space', {
              kind: change.kind,
              entity: change.entity,
              id: change.id,
              spaceId: change.spaceId,
              activeSpaceId,
            })
            return
          }
        }
        if (change.kind === 'invalidated' || change.entity === 'page') {
          pagesListRef.current = applyPageNameChange(pagesListRef.current, change)
        }
        if (change.kind === 'invalidated' || change.entity === 'tag') {
          tagsListRef.current = applyTagNameChange(tagsListRef.current, change)
        }
      }),
    [],
  )

  // Every cache lookup is composed against the active
  // space's id so a chip resolved in space A is invisible from space B.
  // `useSpaceStore.getState()` is read at call-time (not hook-mount-time)
  // because the active space can change while the user is typing — the
  // App-level subscriber flushes the previous space's cache, so a stale
  // `spaceId` captured at mount would re-key against an empty bucket
  // and surface only the fallback string.
  const resolveBlockTitle = useCallback((id: string): string => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    // #4238 — `cached.resolved`, not merely `cached`: an entry can be present
    // and stand for "the backend returned nothing" (`fetchAndCacheLinks`'
    // unreturned-target placeholder). Mirrors `useResolveStore.resolveTitle`,
    // which reads the same entries.
    if (cached?.resolved) return cached.title
    return unresolvedBlockLabel(id)
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    // #4515 — `!resolved` counts as deleted, mirroring
    // `useResolveStore.resolveStatus` (these read the same entries), so a
    // parked placeholder cannot render an ACTIVE chip carrying the unresolved
    // label `resolveBlockTitle` returns for it. Inert today: the sole
    // `resolved: false` writer also sets `deleted: true`.
    if (cached) return cached.deleted || !cached.resolved ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    // See `resolveBlockTitle` above — same verdict, tag-shaped label.
    if (cached?.resolved) return cached.title
    return unresolvedTagLabel(id)
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    // See `resolveBlockStatus` above — same verdict.
    if (cached) return cached.deleted || !cached.resolved ? 'deleted' : 'active'
    return 'active'
  }, [])

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // Strip trailing ] so @tag] resolves to "tag", not "tag]"
      const q = query.replace(/\]+$/, '').toLowerCase().trim()

      // `listAllTagsInSpace` lists the space's tags (bounded by the space's
      // intrinsic tag count); filtering down to the query happens
      // client-side via the existing `matchSorter` call below, same as
      // `searchPagesViaCache`'s cache-fallback strategy.
      //
      // #3277 — mirrors `searchPagesViaCache`: fill `tagsListRef` once (on
      // the first call, or after a space switch clears it) and filter every
      // subsequent keystroke against the cached list, instead of issuing a
      // fresh `listAllTagsInSpace` IPC (and re-running `batchSet`'s diff
      // over the whole tag list) per character typed.
      const requestSpaceId = useSpaceStore.getState().currentSpaceId
      if (requestSpaceId == null) return []
      let tags = tagsListRef.current
      if (tags.length === 0) {
        // #4055 — capture the generation BEFORE the IPC, same guard as
        // `searchPagesViaCache`'s `requestGeneration` (see its comment): the
        // #853 space check alone doesn't notice a rename/removal/invalidation
        // landing on THIS space while the fetch is in flight.
        const requestGeneration = nameChangeGenerationRef.current
        // #4270 — capture this fill's own sequence number BEFORE the IPC,
        // same guard as `searchPagesViaCache`'s `requestSeq` (see
        // `RequestSeqRef`'s comment).
        const requestSeq = tagsRequestSeqRef.current + 1
        tagsRequestSeqRef.current = requestSeq
        const fetched = unwrap(
          await commands.listAllTagsInSpace(requireActiveScope(requestSpaceId)),
        )
        tags = fetched
        // #853 — gate behind the captured-space guard: a stale response
        // from a since-abandoned space must not seed the new space's
        // cache (neither the resolve store nor `tagsListRef`).
        // #4055 — AND behind the captured-generation guard above.
        // #4270 — AND behind the captured-sequence guard (latest ISSUED,
        // not merely latest RESOLVED, request for `tagsListRef`).
        // #4344 part 2 — the three conditions are evaluated SEPARATELY
        // rather than as one `&&`, for the same reason as
        // `searchPagesViaCache` above: space + generation say whether
        // `fetched` is still SERVABLE at all (and therefore whether it may
        // be returned AND seeded), while the sequence says only whether it
        // is the FRESHEST fill (and therefore whether it may own the cache).
        // Hence the nesting rather than a flat three-way split: two of the
        // three outcomes share the servable half.
        const spaceStillActive = isRequestSpaceStillActive(requestSpaceId)
        const generationUnchanged = nameChangeGenerationRef.current === requestGeneration
        const isLatestFill = tagsRequestSeqRef.current === requestSeq
        if (spaceStillActive && generationUnchanged) {
          // SERVABLE: right space, no name-change-bus event since this fill
          // was issued. `fetched` is a valid snapshot of THIS space at THIS
          // generation, so it is both returned (by leaving `tags` as
          // `fetched`) and seeded — see below. Whether it also OWNS the
          // cache is a separate, freshness-only question.
          if (isLatestFill) {
            tagsListRef.current = fetched
          } else {
            // LOST THE #4270 TIE-BREAK, but still SERVABLE: return the
            // freshest rows in hand, without persisting. "Freshest in hand"
            // is `tagsListRef.current` when the #4270 winner has already
            // filled it, and this fill's own `fetched` otherwise — see the
            // assignment at the end of this branch. Full rationale follows.
            //
            // #4344 part 2 — a newer fill has been ISSUED that should own
            // the cache. So do not PERSIST (that is #4270's whole point —
            // the earlier-issued fill must not overwrite the later-issued
            // one), but DO RETURN something usable.
            //
            // Same defect, same fix, as `searchPagesViaCache` above: this
            // used to fall through to `tags = tagsListRef.current` together
            // with the genuinely-unsafe cases, and on the common cold-cache
            // path that read ZERO tags. In-order IPC means the
            // earlier-issued fill resolves FIRST, so the winning fill has
            // only been issued, not resolved, and nothing has written the
            // ref yet — the `#` picker rendered EMPTY for one round trip on
            // exactly the fast-typing-into-a-cold-cache path, discarding a
            // snapshot whose only flaw was being one keystroke old.
            //
            // #4344 part 2 review — plain `fetched` was still wrong in the
            // OTHER resolution order, which no test asserted: when the
            // later-issued fill (the #4270 winner) resolves FIRST and
            // persists, THIS fill — the earlier-issued loser, resolving
            // second — used to hand back its own older `fetched` even
            // though `tagsListRef.current` had just been overwritten with
            // the winner's fresher rows sitting right there. Prefer the ref
            // whenever the winner has already filled it; fall back to
            // `fetched` only when it hasn't (the in-order case above).
            //
            // The `batchSet` seed just below stays keyed on this fill's own
            // `fetched`, not this freshened `tags` — deliberately: `batchSet`
            // is a per-id upsert (never a wholesale replace, confirmed
            // against `@/stores/resolve.ts`), so seeding from a stale
            // snapshot cannot un-seed an id the winner already wrote, and
            // for any id BOTH snapshots share the value is identical anyway
            // (the generation guard above rules out a rename between the
            // two dispatches). Rekeying it to `tags` would add a second
            // meaning of "freshest" to track for zero behavioural gain.
            tags = tagsListRef.current.length > 0 ? tagsListRef.current : fetched
          }
          // Populate the resolve cache so tag_ref nodes can resolve the
          // name after the block is saved (serialized as #[ULID]) and
          // reloaded. Only on a SERVABLE fill, not merely "the fill" — see
          // #4344 part 2 just below: a servable-but-losing fill also seeds.
          // Either way a cache-served keystroke re-seeds nothing new, so
          // re-running the diff every keystroke bought nothing (#3277).
          //
          // #4344 part 2 — the seed is gated on SERVABLE, not on PERSISTING.
          // It has to be: `searchTags` now returns the tie-break loser's
          // rows, and a returned-but-unseeded tag is a state that could not
          // exist before — every tag this function could return used to come
          // from a fill that had persisted AND seeded. A `tag_ref` chip
          // resolves its name ONLY through the resolve store
          // (`useRichContentCallbacks.resolveTagName`; `#[ULID]` has no lazy
          // per-id fallback the way `[[ULID]]` has `fetchAndCacheLinks`), so
          // a tag picked out of the loser's list would render as
          // `#01ABCDE...`. "The winner will seed it" is not a guarantee —
          // the winner can itself be rejected by a bus event landing while
          // IT is in flight, and then nothing seeds the tag at all. This
          // also restores the mirror with the pages side, where
          // `populatePageResolveCache` runs in `searchPages` over whatever
          // the guard RETURNED, outside the persist decision entirely.
          //
          // Still no cross-space write: `batchSet` keys on the LIVE active
          // space, which `spaceStillActive` has just pinned to
          // `requestSpaceId`.
          if (fetched.length > 0) {
            // #4239 — `resolveStoreTitle` on the tag arm is `untitledOr`:
            // verbatim for a real name, the placeholder for a blank one. That
            // matches `preload`'s tag half and `fetchAndCacheLinks`, so a tag
            // reached by two paths does not churn `version`.
            useResolveStore.getState().batchSet(
              fetched.map((t) => ({
                id: t.tag_id,
                title: resolveStoreTitle('tag', t.name),
                deleted: false,
              })),
            )
          }
        } else {
          // The fetch was rejected for a reason that also makes it unsafe
          // to RETURN: a SPACE SWITCH (serving `fetched` would leak the
          // previous space's tags into the new space's picker) or a
          // name-change-bus event on THIS space (rename/removal/
          // invalidation — `fetched` carries exactly the stale/deleted/
          // renamed tag the guard exists to keep out). Either way
          // `tagsListRef.current` has been cleared, patched or overwritten;
          // serve this call's result from there instead of the discarded
          // `fetched`, otherwise this one call still returns the row the
          // guard just refused to cache. Mirrors the `searchPagesViaCache`
          // fix above.
          tags = tagsListRef.current
        }
      }
      const sorted = q ? matchSorter(tags, q, { keys: ['name'] }) : tags
      const result: PickerItem[] = sorted.map((tag) => ({
        id: tag.tag_id,
        label: tag.name,
        icon: Tag,
      }))

      // Prepend a create-new-tag option (`isCreate: true`, rendered by
      // consumers via `t('pageHeader.createTag', { name })`) when the
      // query doesn't exactly match an existing tag — this makes it the
      // default selection so pressing Enter auto-creates the tag (F-26).
      if (q.length > 0) {
        // Fold both sides so Turkish / German / accented tag
        // names match their ASCII-typed queries the same way as pages do.
        const qFolded = foldForSearch(q)
        const exactMatch = tags.some((t) => foldForSearch(t.name) === qFolded)
        if (!exactMatch) {
          result.unshift({
            id: '__create__',
            label: query.replace(/\]+$/, '').trim(),
            isCreate: true,
          })
        }
      }
      logSlowQuery('searchTags', q, t0, result.length)
      return result
    } catch (err) {
      // Never reject — the TipTap Suggestion plugin has no error handling
      // for async items callbacks.  A rejection silently prevents the popup
      // from opening (H-10 / H-11).
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchTags failed', { query, durationMs }, err)
      return []
    }
  }, [])

  /**
   * The `[[` picker's page search: the shared `matchPages`, plus seeding the
   * resolve cache from the rows it found.
   */
  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // #853 — capture the active space at request time so a response that
      // resolves after a space switch can't seed the resolve cache for the
      // wrong space (mirrors the #732 captured-space guard).
      const requestSpaceId = useSpaceStore.getState().currentSpaceId ?? null
      const { rows, items } = await matchPages(query, {
        pagesListRef,
        generationRef: nameChangeGenerationRef,
        requestSeqRef: pagesRequestSeqRef,
      })
      // #4239 — seed from the ROWS (raw, un-split titles), never the rendered
      // items, so the resolve store keeps the full path. Alias-only hits are
      // not in `rows`, so they are not seeded.
      populatePageResolveCache(rows, requestSpaceId)
      logSlowQuery('searchPages', query, t0, items.length)
      return items
    } catch (err) {
      // Never reject — the TipTap Suggestion plugin has no error handling
      // for async items callbacks.  A rejection silently prevents the popup
      // from opening (H-10 / H-11).
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchPages failed', { query, durationMs }, err)
      return []
    }
  }, [])

  const searchBlockRefs = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      const q = query.replace(/\)+$/, '').trim()
      if (q.length < 2) return []

      // #2248 c — `searchBlocks` is space-scoped and rejects an empty scope.
      // No active space ⇒ nothing to search; short-circuit to empty rather
      // than send a `''` that used to mean "match nothing" but now throws.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) return []
      // #2543/#853 — capture the active space at request time so a
      // response that resolves after a space switch can't seed the
      // resolve cache for the wrong space (mirrors the searchPages /
      // populatePageResolveCache guard — this callback had NO guard at
      // all before, unlike searchPages in the same file).
      const requestSpaceId = spaceId
      const resp = unwrap(
        await commands.searchBlocks(q, null, searchBlocksLimit(20), {
          parentId: null,
          tagIds: [],
          scope: requireActiveSearchScope(spaceId),
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
          blockTypeFilter: null,
          stateFilter: [],
          priorityFilter: [],
          dueFilter: null,
          scheduledFilter: null,
          propertyFilters: [],
          excludedPropertyFilters: [],
          excludedStateFilter: [],
          excludedPriorityFilter: [],
        }),
      )
      // Show parent page title as breadcrumb when available.
      // Compose against current space so a foreign-space
      // parent (which shouldn't appear in the picker anyway, but
      // could leak via stale cache) doesn't surface its title.
      // Read once before the per-row map (#1637) — the active space can't
      // change mid-map (synchronous transform), so one read is exact.
      const parentSpaceId = useSpaceStore.getState().currentSpaceId
      const liveRows = resp.items.filter((b) => b.deleted_at === null)
      const results: PickerItem[] = liveRows.map((b) => {
        // #4153 i18n'd this (was a hardcoded English literal); #4190 gave
        // it the trimmed-empty test `untitledOr` uses for page titles,
        // scoped to the first LINE via `blockFirstLineOr` since this maps
        // BLOCK content for the `((` picker, a different surface with its
        // own truncation rules — not a page title (see `makePagePickerItem`'s
        // docblock).
        const firstLine = blockFirstLineOr(b.content)
        const label = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
        const parentTitle = b.parent_id
          ? cacheRef.current.get(keyFor(parentSpaceId, b.parent_id))?.title
          : undefined
        return { id: b.id, label, icon: Hash, breadcrumb: parentTitle }
      })

      // Populate resolve cache. #853 — gate behind the captured-space guard.
      //
      // #4239 review 3 — this seeder ran UNGATED: it wrote
      // `normalizeBlockRefTitle` for every row, and the `searchBlocks` call
      // above passes `blockTypeFilter: null`, so page and tag rows come back
      // here too (`searchPagesViaFts` makes the identical unfiltered call and
      // then filters `block_type === 'page'` — same response shape, proof in
      // this file). Capping a page's namespaced path there is exactly the
      // damage `resolveStoreTitle` exists to prevent; route through it like
      // every other seeder.
      //
      // Seeded from `liveRows` rather than by re-finding each picker item in
      // `resp.items`: the picker LABEL has its own 80-char rule and is not the
      // stored title, so the row is what this needs — and the O(n^2) `find`
      // per row goes away with it.
      if (liveRows.length > 0 && isRequestSpaceStillActive(requestSpaceId)) {
        useResolveStore.getState().batchSet(
          liveRows.map((b) => ({
            id: b.id,
            title: resolveStoreTitle(b.block_type, b.content),
            deleted: false,
          })),
        )
      }
      logSlowQuery('searchBlockRefs', q, t0, results.length)
      return results
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchBlockRefs failed', { query, durationMs }, err)
      return []
    }
  }, [])

  const onCreatePage = useCallback(async (label: string): Promise<string> => {
    // Phase 2 — every page must belong to a space. Route the
    // creation through the atomic `createPageInSpace` Tauri command so
    // CreateBlock + SetProperty('space') are committed together.
    // The `!isReady` branch is defensive — the roving editor doesn't
    // render until `BlockTree` has mounted, which happens after boot's
    // `refreshAvailableSpaces()` resolves, so in practice this guard
    // almost never fires.
    const { currentSpaceId, isReady } = useSpaceStore.getState()
    if (!isReady || currentSpaceId == null) {
      logger.warn(
        'useBlockResolve',
        'onCreatePage called before space hydrated; refusing to create',
        { label },
      )
      notify.error(translate('space.notReady'))
      throw new Error('Space store is not ready')
    }
    try {
      const newId = unwrap(await commands.createPageInSpace(null, label, currentSpaceId))
      // Populate resolve cache so the link chip shows the title immediately
      useResolveStore.getState().set(newId, label, false)
      // #4319 — the generation bump (#4275 item 1) and the fill-guarded
      // append (#4008 review note 1) as ONE call, so this site cannot drift
      // from `onCreateTag`'s or the date picker's. See `recordCreatedRow`
      // for both invariants and why they compose.
      recordCreatedRow(pagesListRef, nameChangeGenerationRef, { id: newId, title: label }, 'id')
      return newId
    } catch (err) {
      logger.error('useBlockResolve', 'onCreatePage failed', { label }, err)
      throw err
    }
  }, [])

  // #4319 — the only handle a page-creation site OUTSIDE this hook gets on
  // the page cache. Everything that makes an append correct lives in
  // `recordCreatedRow`; a caller holding this function cannot skip half of
  // it, and cannot reach `pagesListRef` to append by hand instead. See
  // `UseBlockResolveReturn['registerCreatedPage']`.
  const registerCreatedPage = useCallback((row: { id: string; title: string }): void => {
    recordCreatedRow(pagesListRef, nameChangeGenerationRef, row, 'id')
  }, [])

  const onCreateTag = useCallback(async (name: string): Promise<string> => {
    try {
      // #3081/#2996/#2997 — create the tag ATOMICALLY space-scoped in ONE
      // command: pass the active `spaceId` so the backend stamps
      // `blocks.space_id` in the SAME transaction as the `CreateBlock` op
      // (mirroring how the `[[` page path routes through the space-aware
      // `createPageInSpace`). This makes the tag (a) surface in
      // `listAllTagsInSpace` (the `@` picker index queried by `searchTags`) and
      // (b) resolve to a navigable tag page, immediately and durably.
      //
      // The previous bare `createBlock` + best-effort, catch-swallowed
      // `setProperty({ key: 'space' })` follow-up left the tag an ORPHAN
      // (`space_id = NULL`) whenever that separate op failed — and
      // `listAllTagsInSpace` (WHERE `space_id = ?`) then hides it, so the tag
      // vanished on the next lookup (#3081). The atomic create removes that
      // swallow-on-failure window: a scoping failure fails the whole create and
      // surfaces via the catch below instead of silently orphaning the tag.
      const spaceId = useSpaceStore.getState().currentSpaceId
      // #5415 — no active space means no space to create the tag in; refuse
      // through the catch below rather than create a space-less tag.
      if (spaceId == null) throw new Error('No active space; cannot create tag')
      const block = unwrap(
        await commands.createBlock('tag', name, null, null, requireActiveScope(spaceId), null),
      )
      // Populate resolve cache so the tag chip shows the name immediately
      useResolveStore.getState().set(block.id, name, false)
      // #3277 finding 1 — without the append, a tag created through the SAME
      // `@`-picker session that already lazily filled `tagsListRef` stayed
      // unfindable by that picker: `searchTags` only re-fetches when the
      // cache is empty, so a newly created tag never surfaced until a space
      // switch cleared it (the #732 subscriber above). `usage_count: 0` is
      // correct — the tag isn't yet applied to any block.
      //
      // #4319 — the bump (#4275 item 1) and the fill-guarded append (#4008
      // review note 6) as ONE call, the same one `onCreatePage` makes. See
      // `recordCreatedRow`.
      recordCreatedRow(
        tagsListRef,
        nameChangeGenerationRef,
        {
          tag_id: block.id,
          name,
          usage_count: 0,
          updated_at: new Date().toISOString(),
        },
        'tag_id',
      )
      return block.id
    } catch (err) {
      logger.error('useBlockResolve', 'onCreateTag failed', { name }, err)
      throw err
    }
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    resolveTagStatus,
    searchTags,
    searchPages,
    searchBlockRefs,
    onCreatePage,
    onCreateTag,
    registerCreatedPage,
    pagesListRef,
    tagsListRef,
  }
}
