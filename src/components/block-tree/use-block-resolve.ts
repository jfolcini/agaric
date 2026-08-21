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

import { FileText, Hash, Tag } from 'lucide-react'
import { matchSorter } from 'match-sorter'
import { useCallback, useEffect, useRef } from 'react'

import type { PickerItem } from '@/editor/SuggestionList'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { TagCacheRow } from '@/lib/bindings'
import { blockFirstLineOr, normalizeBlockRefTitle, untitledOr } from '@/lib/block-title'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { foldForSearch, matchesSearchFolded } from '@/lib/fold-for-search'
import { t as translate } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { getPageDisplayName } from '@/lib/page-display'
import { searchBlocksLimit } from '@/lib/safe-limit'
import { requireActiveScope, toSpaceScope } from '@/lib/space-scope'
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
  /** Ref to the pages list cache for search. Lazily filled by
   *  `searchPagesViaCache`, appended to by `onCreatePage` and the date
   *  picker, cleared on space switch (#732), and kept current across renames
   *  and deletes by the name-change bus (#4007). */
  pagesListRef: React.RefObject<Array<{ id: string; title: string }>>
}

// ── searchPages strategy helpers ────────────────────────────────────────
//
// Each function below represents a discrete resolution strategy used by
// `searchPages`. They are defined at module scope because they do not close
// over React state — the only mutable state they touch is the `pagesListRef`
// passed in explicitly. Keeping them as free functions (rather than inline
// closures) makes the dispatcher below a linear, low-complexity sequence.

type PagesListRef = React.RefObject<Array<{ id: string; title: string }>>

/**
 * Splits a `parent/child/leaf` title into `{ label: leaf, breadcrumb: 'parent / child' }`.
 *
 * Bug 1: delegates to the shared `getPageDisplayName` formatter so
 * the picker is the canonical reference implementation for every other
 * "leaf + breadcrumb" surface (tabs, recents chip, inline link chip, group
 * headers). Behaviour is byte-identical to the inlined helper this
 * replaced — non-namespaced titles return `breadcrumb: undefined`, which
 * matches the original `formatNamespacedLabel` contract because
 * `getPageDisplayName`'s non-namespaced branch never assigns the field.
 */
function formatNamespacedLabel(title: string): {
  label: string
  breadcrumb: string | undefined
} {
  const { label, breadcrumb } = getPageDisplayName(title, 'leaf-with-breadcrumb')
  return { label, breadcrumb }
}

/**
 * #4138 — the single render site for the `'Untitled'` placeholder **on the
 * page-title picker items built from a page row**, i.e. everything produced
 * by `searchPagesViaCache` and `searchPagesViaFts`. Cache seeds
 * (`searchPagesViaCache`'s fallback fetch, below) store the RAW title (`''`
 * for NULL content), matching the backend's `COALESCE(b.content, '')` so
 * `comparePageRows` sorts a NULL-content page exactly where a refetch would.
 * Baking `'Untitled'` into the stored title instead (the pre-#4138 shape)
 * made it sort under `U` locally and under `''` (first) on the backend — the
 * seed silently drifted from the comparator #4134/#4131 made exact. The
 * placeholder still needs to be SHOWN, so it is applied here, once, at
 * display time, rather than at every seed site.
 *
 * `untitledOr` / `blockFirstLineOr` live in `@/lib/block-title` now (#4228)
 * — shared with the resolve-store BLOCK title seed (`searchBlockRefs`
 * below, plus the two other seed call sites in
 * `use-block-link-resolve.ts` / `use-block-navigate-to-link.ts`), which is
 * a different surface with its own truncation rules, not a page title.
 */
function makePagePickerItem(id: string, title: string): PickerItem {
  const { label, breadcrumb } = formatNamespacedLabel(untitledOr(title))
  return { id, label, icon: FileText, breadcrumb }
}

/**
 * Short-query strategy: fuzzy-match against the preloaded pages cache.
 * Lazily falls back to `listAllPagesInSpace` when the cache is empty,
 * populating `pagesListRef` as a side effect for subsequent calls.
 *
 * Phase 2 — the lazy fallback is scoped to the current space via
 * `spaceId`. Cross-space `[[ULID]]` targets that are already in the
 * document continue to resolve via the shared resolve cache, they just
 * don't appear as new suggestions.
 */
async function searchPagesViaCache(q: string, pagesListRef: PagesListRef): Promise<PickerItem[]> {
  let source = pagesListRef.current
  if (source.length === 0) {
    // limit-clamp-followup — replaced the silently-clamped
    // `listBlocks({ limit: 500 })` call with `listAllPagesInSpace`, the
    // no-pagination IPC that returns every page in the space.
    // b1 — `listAllPagesInSpace` is required-active: with no active space
    // there are no page suggestions to offer, so short-circuit to an empty
    // list instead of dispatching (a Global scope is rejected by the
    // backend).
    const spaceId = useSpaceStore.getState().currentSpaceId
    if (spaceId == null) return []
    const pages = unwrap(await commands.listAllPagesInSpace(requireActiveScope(spaceId), null))
    // #4138 — seed the RAW title (`''` for NULL content), matching the
    // backend's `COALESCE(b.content, '')` `ORDER BY`. The `'Untitled'`
    // placeholder is applied at the render site (`makePagePickerItem`)
    // instead, so it never leaks into the sort key or the search-match text.
    source = pages.map((p) => ({ id: p.id, title: p.content ?? '' }))
    // #732 — only persist the lazy fill while the active space is still
    // the one the fetch was issued for. A space switch mid-flight would
    // otherwise re-seed the just-invalidated cache with the OLD space's
    // pages (the hook-level subscriber clears the ref on switch, but it
    // cannot see this in-flight promise).
    if ((useSpaceStore.getState().currentSpaceId ?? '') === spaceId) {
      pagesListRef.current = source
    }
  }
  const filtered = q ? matchSorter(source, q, { keys: ['title'] }) : source
  return filtered.slice(0, 20).map((p) => makePagePickerItem(p.id, p.title))
}

/**
 * Long-query strategy: FTS5 search filtered to pages. When FTS returns fewer
 * than 5 results and the preloaded cache is non-empty, supplements the result
 * set from cache (deduped, capped at 20 total).
 *
 * Phase 2 — the FTS call is scoped to the current space.
 */
async function searchPagesViaFts(q: string, pagesListRef: PagesListRef): Promise<PickerItem[]> {
  // #2248 c — `searchBlocks` is space-scoped and rejects an empty scope. No
  // active space ⇒ nothing to search; short-circuit to empty rather than send
  // a `''` that used to mean "match nothing" but now throws.
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (spaceId == null) return []
  const resp = unwrap(
    await commands.searchBlocks(q, null, searchBlocksLimit(20), {
      parentId: null,
      tagIds: [],
      scope: requireActiveScope(spaceId),
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
  const matches = resp.items
    .filter((b) => b.block_type === 'page')
    // #4150 review — pass the raw `''` rather than the placeholder, same as
    // the cache seed above. `makePagePickerItem` maps `''` to `'Untitled'`,
    // so the rendered label is unchanged; this value is only ever a label
    // input (never a sort or match key), which is what makes the two forms
    // interchangeable here and the render site the sole owner of the string.
    .map((b) => makePagePickerItem(b.id, b.content ?? ''))

  if (matches.length >= 5 || pagesListRef.current.length === 0) {
    return matches
  }
  const ftsIds = new Set(matches.map((m) => m.id))
  // Unicode-aware fold. `matchesSearchFolded`'s ASCII fast
  // path keeps this hot cache-lookup cheap when the query is ASCII.
  const cacheMatches = pagesListRef.current
    .filter((p) => matchesSearchFolded(p.title, q) && !ftsIds.has(p.id))
    .slice(0, 10)
    .map((p) => makePagePickerItem(p.id, p.title))
  return [...matches, ...cacheMatches].slice(0, 20)
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
 */
function populatePageResolveCache(matches: PickerItem[], requestSpaceId: string | null): void {
  if (matches.length === 0) return
  if (!isRequestSpaceStillActive(requestSpaceId)) return
  useResolveStore
    .getState()
    .batchSet(
      matches.filter((m) => !m.isCreate).map((m) => ({ id: m.id, title: m.label, deleted: false })),
    )
}

/**
 * Alias-prefix strategy: looks up the query against the
 * page-aliases table by prefix and folds matches into the result list.
 *
 * Each alias hit becomes its own picker item carrying both `isAlias`
 * (visual differentiation) and `aliasText` (for the `[[text]]` input
 * rule's exact-vs-prefix disambiguation). Same-page dedupe against the
 * title strategy still applies — an alias hit is dropped when the page
 * is already in `matches` via title match.
 *
 * Failure is logged at warn level — alias-service failure must never
 * abort the picker (see H-10 / H-11).
 *
 * Active-space scoping: the prefix command is scoped to
 * `useSpaceStore.getState().currentSpaceId` so the picker mirrors the
 * other strategies (`searchPagesViaCache` / `searchPagesViaFts`). The
 * `?? null` fallback is intentional pre-bootstrap behaviour — passing
 * `null` to the backend leaves the result set unscoped, which is fine
 * before any space has been hydrated (no aliases to surface anyway).
 */
async function mergeAliasPrefixMatches(matches: PickerItem[], q: string): Promise<void> {
  if (q.length === 0) return
  try {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const rows = unwrap(
      await commands.listPageAliasesByPrefix(q, PAGINATION_LIMIT, toSpaceScope(spaceId ?? null)),
    )
    if (rows.length === 0) return

    const existingPageIds = new Set(matches.filter((m) => !m.isCreate).map((m) => m.id))
    const aliasItems: PickerItem[] = []
    for (const [pageId, alias, title] of rows) {
      if (existingPageIds.has(pageId)) continue
      existingPageIds.add(pageId)
      aliasItems.push({
        id: pageId,
        // #4153 — trimmed + i18n'd, via the same `untitledOr` the render
        // site uses (see its docblock: whitespace-only titles, not just
        // `null`, and the localised placeholder, not the English literal).
        label: `${untitledOr(title)} (alias: ${alias})`,
        isAlias: true,
        aliasText: alias,
      })
    }
    // Prepend in returned order (shortest-alias first → exact match first).
    matches.unshift(...aliasItems)
  } catch (err) {
    logger.warn('useBlockResolve', 'alias prefix lookup failed', { query: q }, err)
  }
}

/**
 * Appends (not prepends) a create-new-page option (`isCreate: true`) when the
 * query doesn't exactly match an existing page. Consumers render the option
 * label via `t('properties.createNewPageAction')` / `t('pageProperty.createButton')`.
 * Pages keep Create at the end — F-26 only moved Create to the top for tags.
 */
function appendCreatePageOptionIfNeeded(
  matches: PickerItem[],
  query: string,
  q: string,
  pagesListRef: PagesListRef,
): void {
  if (q.length === 0) return
  const allSource = pagesListRef.current.length > 0 ? pagesListRef.current : matches
  // Fold both sides so the "exact match exists" check folds
  // Turkish / German / accented inputs the same way `matchesSearchFolded`
  // does in the filter above.  Without this, a page titled `İstanbul`
  // when queried as `istanbul` would appear as "no exact match" and the
  // create-new-page option (rendered by consumers via
  // `t('properties.createNewPageAction')`) would be appended, even
  // though the page does exist.
  const qFolded = foldForSearch(q)
  // #4150 review — the `q.length === 0` early return above is a check on the
  // RAW query, so it does not cover a non-empty query that FOLDS to empty.
  // `foldForSearch` strips `U+0300..U+036F`, so a combining-mark-only query
  // (`.trim()` does not remove combining marks) survives the length guard and
  // folds to `''` — which then compares EQUAL to the `''` title #4138 now
  // seeds for a NULL-content page, suppressing Create and leaving the picker
  // with nothing at all (nothing matches such a query either). A query that
  // folds away entirely carries no name to match on, so it can never be an
  // "exact match"; offer Create instead.
  const exactMatch =
    qFolded !== '' &&
    allSource.some((p) => foldForSearch('title' in p ? p.title : p.label) === qFolded)
  if (exactMatch) return
  matches.push({
    id: '__create__',
    label: query.replace(/\]+$/, '').trim(),
    isCreate: true,
  })
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
// `@/lib/sqlite-collation` — the Tauri mock's `compareMetaRows` models the
// same two backend clauses and was carrying its own (drifted) spelling of
// them (#3939 item 1).

function compareTagRows(a: TagCacheRow, b: TagCacheRow): number {
  const nameCmp = compareUtf8Bytes(a.name, b.name)
  if (nameCmp !== 0) return nameCmp
  return compareUtf8Bytes(a.tag_id, b.tag_id)
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
  if (!list.some((p) => p.id === id)) return list
  return list.map((p) => (p.id === id ? { ...p, title: name } : p)).toSorted(comparePageRows)
}

/** Applies one tag-scoped change to the `tagsListRef` list. */
function applyTagNameChange(list: TagCacheRow[], change: NameChange): TagCacheRow[] {
  if (change.kind === 'invalidated') return []
  if (change.kind === 'removed') return list.filter((t) => t.tag_id !== change.id)
  const { id, name } = change
  if (!list.some((t) => t.tag_id === id)) return list
  return list.map((t) => (t.tag_id === id ? { ...t, name } : t)).toSorted(compareTagRows)
}

export function useBlockResolve(): UseBlockResolveReturn {
  // Subscribe to version so the component re-renders when the cache updates,
  // keeping cacheRef.current fresh for the stable callbacks below.
  useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)

  const cacheRef = useRef(cache)
  cacheRef.current = cache

  // Local ref for pagesListRef used in searchPages caching. Lazily
  // filled by `searchPagesViaCache` (scoped to the space active at
  // call-time) and appended to by `onCreatePage` and the date picker.
  const pagesListRef = useRef<Array<{ id: string; title: string }>>([])

  // #3277 — mirrors `pagesListRef`: `searchTags` used to call
  // `listAllTagsInSpace` on EVERY keystroke with no client cache, unlike
  // this sibling. Lazily filled by `searchTags` on the FIRST call, filtered
  // client-side (via `matchSorter`) on every subsequent keystroke, and
  // invalidated by the same space-switch subscriber below (#732 pattern).
  const tagsListRef = useRef<TagCacheRow[]>([])

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
    if (cached) return cached.title
    return `[[${id.slice(0, 8)}...]]`
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.title
    return `#${id.slice(0, 8)}...`
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // Strip trailing ] so @tag] resolves to "tag", not "tag]"
      const q = query.replace(/\]+$/, '').toLowerCase().trim()

      // #2543 — `listTagsByPrefix` is a space-UNSCOPED IPC (selects from
      // `tags_cache` with no space filter), so the `#` picker used to
      // surface every space's tags and (via the batchSet below) cache
      // their names under the ACTIVE space's keys — a silent cross-space
      // leak of the exact class #853/#2300 exist to prevent, even though
      // resolve.ts documents tags as space-scoped just like pages.
      // `listAllTagsInSpace` is the space-scoped equivalent (bounded by
      // the space's intrinsic tag count); filtering down to the query
      // happens client-side via the existing `matchSorter` call below,
      // same as `searchPagesViaCache`'s cache-fallback strategy.
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
        const fetched = unwrap(
          await commands.listAllTagsInSpace(requireActiveScope(requestSpaceId)),
        )
        tags = fetched
        // #853 — gate behind the captured-space guard: a stale response
        // from a since-abandoned space must not seed the new space's
        // cache (neither the resolve store nor `tagsListRef`).
        if (isRequestSpaceStillActive(requestSpaceId)) {
          tagsListRef.current = fetched
          // Populate the resolve cache so tag_ref nodes can resolve the
          // name after the block is saved (serialized as #[ULID]) and
          // reloaded. Only on the FILL — a cache-served keystroke re-seeds
          // nothing new, so re-running the diff every keystroke bought
          // nothing (#3277).
          if (fetched.length > 0) {
            useResolveStore
              .getState()
              .batchSet(fetched.map((t) => ({ id: t.tag_id, title: t.name, deleted: false })))
          }
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
   * Dispatcher: picks the right resolution strategy based on query length,
   * then applies cache population, alias disambiguation, and the create-new
   * affordance in priority order.
   *
   * Priority (low → high in the result list):
   *   1. Alias match (prepended first — highest relevance)
   *   2. FTS / cache matches (ordered by strategy)
   *   3. Create-new-page item with `isCreate: true` (appended last)
   */
  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // Strip trailing ]] so [[text]] resolves to "text", not "text]]"
      const q = query.replace(/\]+$/, '').toLowerCase().trim()

      // #853 — capture the active space at request time so a response that
      // resolves after a space switch can't seed the resolve cache for the
      // wrong space (mirrors the #732 captured-space guard).
      const requestSpaceId = useSpaceStore.getState().currentSpaceId ?? null

      // For short/empty queries, use the preloaded pages cache for instant
      // results. For longer queries, use FTS5 server-side search for
      // relevance-ranked results.
      const matches =
        q.length <= 2
          ? await searchPagesViaCache(q, pagesListRef)
          : await searchPagesViaFts(q, pagesListRef)

      populatePageResolveCache(matches, requestSpaceId)
      await mergeAliasPrefixMatches(matches, q)
      appendCreatePageOptionIfNeeded(matches, query, q, pagesListRef)

      logSlowQuery('searchPages', q, t0, matches.length)
      return matches
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
          scope: requireActiveScope(spaceId),
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
      const results: PickerItem[] = resp.items
        .filter((b) => b.deleted_at === null)
        .map((b) => {
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
      if (results.length > 0 && isRequestSpaceStillActive(requestSpaceId)) {
        useResolveStore.getState().batchSet(
          results.map((r) => {
            const block = resp.items.find((b) => b.id === r.id)
            return {
              id: r.id,
              // #4228 — the resolve-store title seed. `normalizeBlockRefTitle`
              // is the SAME normalisation the other two seed call sites
              // (`fetchAndCacheLinks` in use-block-link-resolve.ts,
              // `handleNavigate` in use-block-navigate-to-link.ts) apply to
              // their own content, so all three write byte-identical titles
              // for the same block id — see `@/lib/block-title`'s docblock.
              title: normalizeBlockRefTitle(block?.content ?? null),
              deleted: false,
            }
          }),
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
      // #4008 review note 1 — append ONLY into an already-filled cache, the
      // same guard `onCreateTag` carries below. An EMPTY `pagesListRef` is not
      // "a space with no pages", it is the "not fetched for this space yet"
      // state that makes `searchPagesViaCache` re-fetch; appending there flips
      // it to "filled" with a single row and latches that one page as the
      // whole space for the rest of the session.
      //
      // #4007 widened the window this needs: before, the cache emptied only on
      // a space switch, and the switch is immediately followed by a fill.
      // Now it also empties on every sync / MCP invalidation, every restore,
      // and any delete that drops the last row — and a >2-char query takes the
      // FTS path, which reads the cache but never fills it. So "invalidation,
      // then type a long name, then Create new page" is an ordinary sequence
      // that reaches an empty cache at create time.
      //
      // Skipping the append costs nothing: the next short query re-fetches
      // from the backend, which has already committed this page (awaited above).
      if (pagesListRef.current.length > 0) {
        pagesListRef.current = [...pagesListRef.current, { id: newId, title: label }]
      }
      return newId
    } catch (err) {
      logger.error('useBlockResolve', 'onCreatePage failed', { label }, err)
      throw err
    }
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
      const block = unwrap(
        await commands.createBlock('tag', name, null, null, toSpaceScope(spaceId), null),
      )
      // Populate resolve cache so the tag chip shows the name immediately
      useResolveStore.getState().set(block.id, name, false)
      // #3277 finding 1 — mirror `onCreatePage`'s `pagesListRef` append.
      // Without this, a tag created through the SAME `@`-picker session
      // that already lazily filled `tagsListRef` stayed unfindable by that
      // picker: `searchTags` only re-fetches when the cache is empty, so a
      // newly created tag never surfaced until a space switch cleared the
      // cache (the #732 subscriber above). `usage_count: 0` is correct —
      // the tag isn't yet applied to any block.
      //
      // #4008 review note 6 — append ONLY into an already-filled cache. An
      // EMPTY `tagsListRef` is not "a space with no tags", it is the
      // "not fetched for this space yet" state that makes `searchTags`
      // re-fetch on every call (deliberately, so a zero-tag space is never
      // latched). Appending there would flip it to "filled" with a single
      // entry and permanently suppress that re-fetch, hiding every tag
      // created elsewhere — another window, a sync — for the rest of the
      // session. Skipping the append costs nothing: the very next
      // `searchTags` re-fetches from the backend, which has already
      // committed this tag (the create above is awaited).
      if (tagsListRef.current.length > 0) {
        tagsListRef.current = [
          ...tagsListRef.current,
          { tag_id: block.id, name, usage_count: 0, updated_at: new Date().toISOString() },
        ]
      }
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
    pagesListRef,
  }
}
