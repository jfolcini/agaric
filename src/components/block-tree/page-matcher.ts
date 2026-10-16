/**
 * The page matcher behind the `[[` link picker and the New page dialog: what
 * pages a typed name finds, and whether one of them already carries it.
 *
 * One function, `matchPages`, so the two surfaces cannot disagree about what
 * "already exists" means. The picker keeps its own resolve-cache seeding
 * (`useBlockResolve.searchPages`); this module only reads, plus the lazy
 * `pagesListRef` fill each caller's cache owns.
 */

import { FileText } from 'lucide-react'
import { matchSorter } from 'match-sorter'

import type { PickerItem } from '@/editor/SuggestionList'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { untitledOr } from '@/lib/block-title'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { foldForSearch, matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { getPageDisplayName } from '@/lib/page-display'
import { searchBlocksLimit } from '@/lib/safe-limit'
import { requireActiveScope, requireActiveSearchScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

// ── Strategy helpers ────────────────────────────────────────────────────
//
// Each function below represents a discrete resolution strategy used by
// `matchPages`. They do not close over React state — the only mutable state
// they touch is the cache passed in explicitly. Keeping them as free
// functions makes the dispatcher at the bottom a linear sequence.

/**
 * One page suggestion as the strategies deal in it: the RAW title, exactly
 * as stored. The strategies stop at this shape and the dispatcher renders it
 * into a `PickerItem` — #4239, so the resolve-cache seed can be handed the
 * un-split path instead of `makePagePickerItem`'s leaf-only label. See
 * `populatePageResolveCache`.
 */
export interface PageRow {
  id: string
  title: string
}

export type PagesListRef = React.RefObject<PageRow[]>

/**
 * Ref to the generation counter bumped by the name-change-bus subscriber on
 * EVERY event (any kind, any entity) — see `nameChangeGenerationRef` in
 * `useBlockResolve` and #4055 below.
 */
export type GenerationRef = React.RefObject<number>

/**
 * Ref to a per-list monotonic sequence counter — one for `pagesListRef`
 * fills, a separate one for `tagsListRef` fills (`pagesRequestSeqRef` /
 * `tagsRequestSeqRef` in `useBlockResolve`).
 *
 * #4270 — the generation guard above makes a fill correct with respect to
 * *invalidations*, not with respect to *request ORDER*: two fills started in
 * the same generation (no invalidation between them) both pass it, so
 * whichever RESOLVES last wins, even if it was the earlier-STARTED request
 * racing a fresher one. This ref closes that. It is bumped synchronously at
 * DISPATCH time (before the IPC await), so it always reflects the highest
 * sequence number ISSUED so far, regardless of resolution order. A fill's
 * write is gated on `seqRef.current === (the value it captured at dispatch
 * time)` — i.e. "no newer request for this same list has been issued since
 * I started" — composed with (not replacing) the generation/space checks.
 *
 * Split per-list rather than shared with its sibling: an unrelated tag fill
 * issued between two page fills would otherwise starve out an
 * earlier-but-still-uncontested page fill, which is a needless extra
 * over-rejection this ref has no reason to cause (contrast the generation
 * ref, which is deliberately shared — see its comment in `useBlockResolve`).
 */
export type RequestSeqRef = React.RefObject<number>

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
  return { id, label, title, icon: FileText, breadcrumb }
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
async function searchPagesViaCache(
  q: string,
  pagesListRef: PagesListRef,
  generationRef: GenerationRef,
  requestSeqRef: RequestSeqRef,
): Promise<PageRow[]> {
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
    // #4055 — capture the name-change-bus generation BEFORE the IPC. The
    // #732 space check below only catches a space switch mid-flight; it says
    // nothing about an invalidation/rename/removal landing on THIS space
    // while the fetch is in flight, which #4042 made a routine background
    // event (`sync:complete` / `blocks:changed`, a restore, a large batch
    // trash). The bus subscriber bumps this counter synchronously on every
    // event, so a mismatch here means a fresher event landed than the one
    // this fetch started under — persisting `source` over it would
    // resurrect exactly the stale entries #4007 exists to remove.
    const requestGeneration = generationRef.current
    // #4270 — capture this fill's own sequence number BEFORE the IPC, same
    // moment as `requestGeneration`. See `RequestSeqRef`'s comment.
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
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
    // #4055 — AND only while no name-change-bus event has landed since. See
    // the comment above `requestGeneration`.
    // #4270 — AND only while no newer fill for this same list has been
    // ISSUED since. See `RequestSeqRef`'s comment.
    // #4344 part 2 — the three conditions are evaluated SEPARATELY rather
    // than as one `&&`, because they do not all mean the same thing about
    // the rows that just arrived. Space + generation say whether `source` is
    // still SERVABLE at all (right space, no mutation since it was issued);
    // the sequence only says whether it is the FRESHEST fill. See the two
    // rejection branches below.
    const spaceStillActive = (useSpaceStore.getState().currentSpaceId ?? '') === spaceId
    const generationUnchanged = generationRef.current === requestGeneration
    const isLatestFill = requestSeqRef.current === requestSeq
    if (spaceStillActive && generationUnchanged && isLatestFill) {
      pagesListRef.current = source
    } else if (spaceStillActive && generationUnchanged) {
      // LOST THE #4270 TIE-BREAK, but still SERVABLE: return the freshest
      // rows in hand, without persisting. "Freshest in hand" is
      // `pagesListRef.current` when the #4270 winner has already filled it,
      // and this fill's own `source` otherwise — see the assignment at the
      // end of this branch. Full rationale follows.
      //
      // #4344 part 2 — the space is unchanged and no name-change-bus event
      // has landed, so `source` is a valid snapshot of THIS space at THIS
      // generation: it is merely not the freshest one, and a newer fill has
      // been ISSUED that should own the cache. So: do not PERSIST it (that
      // is #4270's whole point — the earlier-issued fill must not overwrite
      // the later-issued one), but DO RETURN something usable.
      //
      // This branch used to fall through to `source = pagesListRef.current`
      // below, together with the genuinely-unsafe cases. On the common
      // cold-cache path that read ZERO pages: in-order IPC means the
      // earlier-issued fill resolves FIRST, so the winning fill has only
      // been issued, not resolved, and nothing has written the ref yet. The
      // picker therefore rendered EMPTY for one round trip on exactly the
      // fast-typing-into-a-cold-cache path — a flash of nothing where the
      // only thing wrong with the data in hand was that it was one keystroke
      // old. Self-healing, but visible, and strictly worse than the
      // marginally-older answer it discarded.
      //
      // Deliberately NOT extended to the space/generation cases: those are
      // correctness guards, not freshness ones. A space switch must never
      // leak the previous space's pages into the new space's picker, and a
      // rename/removal/invalidation means `source` carries exactly the
      // stale/deleted row #4055 exists to keep out.
      //
      // #4344 part 2 review — plain `source` was still wrong in the OTHER
      // resolution order, which no test asserted: when the later-issued
      // fill (the #4270 winner) resolves FIRST and persists, THIS fill —
      // the earlier-issued loser, resolving second — used to hand back its
      // own older `source` even though `pagesListRef.current` had just been
      // overwritten with the winner's fresher rows sitting right there.
      // Prefer the ref whenever the winner has already filled it; fall back
      // to `source` only when it hasn't (the in-order case above).
      source = pagesListRef.current.length > 0 ? pagesListRef.current : source
    } else {
      // The fetch was rejected for a reason that also makes it unsafe to
      // RETURN. Two of those, both requiring the discarded `source` to be
      // replaced rather than served:
      //   - A name-change-bus event (rename/removal/invalidation) landed on
      //     THIS space while the fetch was in flight, so
      //     `pagesListRef.current` has been cleared, patched or overwritten.
      //     Serve THIS call's result from there instead of the discarded
      //     `source`: the caller (`searchPages`, and via
      //     `populatePageResolveCache`, the shared resolve store) would
      //     otherwise still receive the exact stale/deleted/renamed row the
      //     guard exists to keep out of the cache — just for one call
      //     instead of forever, which is still the bug #4055 exists to
      //     close.
      //   - A SPACE SWITCH landed mid-flight and a fill for the NEW space has
      //     already completed and populated `pagesListRef.current`: this
      //     branch then hands the new space's rows back to a call issued for
      //     the OLD space. Harmless (arguably more correct than serving
      //     nothing), and no cross-space WRITE is reachable through it —
      //     `populatePageResolveCache`'s `batchSet` stays gated on
      //     `requestSpaceId` (captured by the caller before dispatch, not on
      //     this fallback path), so a stale-space call can read the new
      //     space's rows here but can never seed the resolve store under the
      //     old space's key.
      source = pagesListRef.current
    }
  }
  // #4152 — a blank row's only searchable text is the DISPLAYED "Untitled"
  // placeholder. Matched at FILTER time only: `source`'s rows still carry the
  // raw `''` title, so #4138's sort-key invariant is untouched.
  //
  // Blank rows do NOT go through `matchSorter`. A blank row has no title to
  // fuzzy-rank, and ranking the placeholder text puts it in the SAME tiers a
  // real title can reach — `un` scores STARTS_WITH against "Untitled", and
  // same-tier ties fall back to `localeCompare`, which "Untitled" wins against
  // most real titles starting "Un". So blank rows crowd real matches out of
  // the slice budget. Instead: rank real content, admit blank rows by
  // `matchesBlankRowFolded`'s prefix test (the same predicate the FTS path
  // uses), and place real matches first unconditionally, so a placeholder row
  // can only fill a slot no real match wanted.
  //
  // Only for a non-empty query. An empty `q` means "everything matches", and
  // `source` is already in #4138's title-sort order with blank rows FIRST.
  // Partitioning unconditionally would silently reorder that listing.
  // The blank-row comparison takes no per-row input, so it is hoisted to a
  // single value evaluated once rather than once per blank row: the
  // placeholder is recomputed per call rather than cached at module scope,
  // because `untitledOr` reads the live i18next instance (#4153) and
  // `changeLanguage` can fire without a remount.
  //
  // #4337 items 1 and 2 — ONE pass over `source`, and ONE statement of the
  // blank/non-blank branch (`isBlankPageRow`, inside `partitionPageRows`).
  // This used to be two `.filter` sweeps over the whole space's page list
  // per keystroke, each re-deriving that branch from `p.title.trim()` —
  // the same rule written twice here and twice more in `searchPagesViaFts`,
  // with nothing keeping the four in step.
  let filtered = source
  if (q) {
    const blankRowsMatch = matchesBlankRowFolded(foldForSearch(q), foldedUntitledPlaceholder())
    const { real, blank } = partitionPageRows(
      source,
      () => true,
      () => blankRowsMatch,
    )
    filtered = [...matchSorter(real, q, { keys: ['title'] }), ...blank]
  }
  // Copy rather than hand back `pagesListRef.current`'s own objects — the
  // dispatcher and the cache seed both read these, and aliasing the ref's
  // entries would let a future consumer mutate the lazily-filled cache.
  return filtered.slice(0, 20).map((p) => ({ id: p.id, title: p.title }))
}

/**
 * Decides whether a blank (NULL-content) page row matches a picker query,
 * given both sides already folded so neither is recomputed per row.
 *
 * A blank row has no searchable text of its own — only the "Untitled"
 * placeholder it displays (#4152) — and matches that by PREFIX, not
 * substring.
 *
 * The prefix rule is the whole point. A substring test against the
 * placeholder makes every blank row match every substring of it ("unt",
 * "tit", "led", "title"), and because blank titles sort first (#4138) a run
 * of them fills a result budget before any genuine match is considered.
 * `title` is a realistic query.
 *
 * Both filter paths (`searchPagesViaCache` and `searchPagesViaFts`'s cache
 * supplement) route blank rows through this one function, so they cannot
 * disagree about which rows a blank page's match text qualifies for. They
 * did once: a user typing progressively saw blank pages appear and then
 * vanish as the query crossed the length threshold between them.
 *
 * This is about MATCH text only. Where the displayed label comes from is
 * `untitledOr` / `makePagePickerItem` — a separate question, and the one
 * #4138's "search text and displayed label cannot diverge" note is about.
 *
 * Known limitation: prefix-only means a multi-word localised placeholder
 * (fr "Sans titre") is unreachable by its second word. Only `en` ships today.
 *
 * The empty-query guard is load-bearing: a RAW query that is non-empty but
 * folds to `''` — one made entirely of combining marks, which `foldForSearch`
 * strips — would otherwise hit `startsWith('')`'s vacuous truth and match
 * every blank row.
 */
function matchesBlankRowFolded(foldedQuery: string, foldedPlaceholder: string): boolean {
  return foldedQuery !== '' && foldedPlaceholder.startsWith(foldedQuery)
}

/**
 * The once-per-call value `matchesBlankRowFolded` needs for every blank row
 * it is asked about. Recomputed on every call
 * (never cached at module scope): `untitledOr` resolves through the live
 * i18next instance (#4153's "routes the placeholder through the live i18n
 * instance, not a hardcoded literal"), and the active locale can change at
 * runtime via `i18next.changeLanguage` with no remount in between, so a
 * module-scope cache would keep serving a placeholder folded under the OLD
 * locale after such a switch. Once per `searchPages` call is still a large
 * win over once per blank row — the fix this note is about.
 */
function foldedUntitledPlaceholder(): string {
  return foldForSearch(untitledOr(''))
}

/**
 * The ONE statement of the picker's blank/non-blank page-row branch.
 *
 * #4337 item 1 — this rule used to be restated at every site that needed
 * it: twice in `searchPagesViaCache`'s two `.filter` sweeps, twice in
 * `searchPagesViaFts`'s, and once more (in a different form —
 * `foldForSearch(title)` against a raw `''`) in
 * `appendCreatePageOptionIfNeeded`. Five statements of one rule, free to
 * diverge — and #4321 is what it looks like when they do.
 *
 * TRIMMED-empty, not `=== ''`, matching `untitledOr`: a whitespace-only
 * title displays the placeholder, so it must be MATCHED as the placeholder
 * too. `''` alone would leave `'   '` searchable by neither its own
 * (unfoldable) whitespace nor the "Untitled" the user can see.
 */
function isBlankPageRow(title: string): boolean {
  return title.trim() === ''
}

/**
 * The folded text a page row is MATCHED BY — a blank row by the "Untitled"
 * placeholder it displays (#4152), a real row by its own title.
 *
 * #4321 — `appendCreatePageOptionIfNeeded` used to fold the RAW title here
 * while the filter folded the placeholder, so the two disagreed about what
 * a blank row's name is. Querying "Untitled" surfaced the matching blank
 * page AND offered to create a second one beside it, because
 * `foldForSearch('')` never equals `foldForSearch('untitled')` and the
 * exact-match suppression therefore never fired. Both questions — "does
 * this row match the query" and "is the query already satisfied by this
 * row" — now read a row's name through this one function, so they can
 * disagree about the ANSWER (prefix vs. equality, deliberately) but never
 * about the TEXT.
 *
 * `foldedPlaceholder` is passed in rather than computed here because the
 * blank branch takes no per-row input and callers are per-keystroke loops:
 * see `foldedUntitledPlaceholder` for why it is recomputed per call and not
 * cached at module scope.
 */
function foldedRowMatchText(title: string, foldedPlaceholder: string): string {
  return isBlankPageRow(title) ? foldedPlaceholder : foldForSearch(title)
}

/**
 * The single pass both filter paths make over a space's cached page list,
 * splitting it into the real-content rows and the blank rows.
 *
 * The two buckets are kept apart because blank rows must NOT go through
 * `matchSorter` and must NOT be able to outrank a real match — see
 * `matchesBlankRowFolded`'s docstring for the crowd-out this prevents. The
 * caller ranks `real` however it likes and concatenates `blank` after it.
 *
 * #4337 item 2 — one pass, two buckets, at most one `.trim()` per row.
 * `searchPagesViaFts` used to allocate three intermediate arrays over the
 * whole list per keystroke (a `candidates` array plus a `.filter` per
 * bucket) and `searchPagesViaCache` two, with up to three `.trim()` calls
 * per row between them.
 *
 * Both admit-predicates take the whole row, not just its title, because the
 * FTS path also has to drop rows already returned by FTS — from BOTH
 * buckets, which is exactly the kind of half-applied filter a per-bucket
 * `.filter` chain invites.
 */
function partitionPageRows(
  rows: readonly PageRow[],
  admitRealRow: (row: PageRow) => boolean,
  admitBlankRow: (row: PageRow) => boolean,
): { real: PageRow[]; blank: PageRow[] } {
  const real: PageRow[] = []
  const blank: PageRow[] = []
  for (const row of rows) {
    if (isBlankPageRow(row.title)) {
      if (admitBlankRow(row)) blank.push(row)
    } else if (admitRealRow(row)) {
      real.push(row)
    }
  }
  return { real, blank }
}

/**
 * Long-query strategy: FTS5 search filtered to pages. When FTS returns fewer
 * than 5 results and the preloaded cache is non-empty, supplements the result
 * set from cache (deduped, capped at 20 total).
 *
 * Phase 2 — the FTS call is scoped to the current space.
 */
async function searchPagesViaFts(q: string, pagesListRef: PagesListRef): Promise<PageRow[]> {
  // #2248 c — `searchBlocks` is space-scoped and rejects an empty scope. No
  // active space ⇒ nothing to search; short-circuit to empty rather than send
  // a `''` that used to mean "match nothing" but now throws.
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (spaceId == null) return []
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
  const matches = resp.items
    .filter((b) => b.block_type === 'page')
    // #4150 review — carry the raw `''` rather than the placeholder, same as
    // the cache seed above. `makePagePickerItem` maps `''` to `'Untitled'`,
    // so the rendered label is unchanged; this value is only ever a label
    // input (never a sort or match key), which is what makes the two forms
    // interchangeable here and the render site the sole owner of the string.
    .map((b) => ({ id: b.id, title: b.content ?? '' }))

  // #4337 item 3 — KNOWN LIMITATION, deliberately NOT fixed here. This
  // early return also means a cold cache defeats the placeholder search on
  // this path: a long query ("untitled") finds no blank row until something
  // has warmed `pagesListRef`, because unlike `searchPagesViaCache` this
  // path reads the cache but never fills it. In practice the picker opens
  // with an empty query and warms it first, so #4152's headline case is
  // reliably fixed on the short-query path and best-effort on this one —
  // but an invalidation landing mid-typing reopens the window. Fixing it
  // means giving this path a fill of its own (and the fill's space /
  // generation / sequence guards with it), which is a change to the
  // caching contract rather than to the partitioning #4337 items 1-2 are
  // about; it is left for a follow-up.
  if (matches.length >= 5 || pagesListRef.current.length === 0) {
    return matches
  }
  const ftsIds = new Set(matches.map((m) => m.id))
  // #4152 / item 1 of #4295's review — a row with real content is matched by
  // `matchesSearchFolded`'s ordinary folded-SUBSTRING test — including its
  // Unicode-aware fold and ASCII fast path, which keeps this hot
  // cache-lookup cheap when the query is ASCII. A NULL-content row instead
  // matches the DISPLAYED "Untitled" placeholder, prefix-only, via
  // `matchesBlankRowFolded` (see its own docstring for why substring is too
  // noisy here). `p.title` in the returned row (the `.map` below) stays raw
  // either way.
  //
  // #4152 — an earlier round partitioned
  // `searchPagesViaCache`'s ranking (real-content rows first, blank rows
  // only filling what's left) but left THIS supplement as a flat filter +
  // `.slice(0, 10)` over `pagesListRef.current`'s own order, which is
  // blanks-first (#4138: an empty title sorts before any real one). A
  // prefix of "Untitled" (`unt` and longer) matches every blank row via
  // `matchesBlankRowFolded`, so ten of them fill the entire supplement
  // budget before a genuine cache-only match is ever considered — the exact
  // crowd-out the prefix-only narrowing was meant to fix, just reached
  // through this path's unranked slice instead of `matchSorter`'s ranking.
  // Partitioned the same way as `searchPagesViaCache`, so the two paths
  // can't diverge on the rule: real-content matches first, blank rows only
  // fill the slots real matches don't use.
  //
  // The placeholder is folded once here, and the blank-row comparison
  // itself (which takes no per-row input) is hoisted to a single value
  // (`blankRowsMatch`) evaluated once rather than once per blank row inside
  // `matchesBlankRowFolded`. See `foldedUntitledPlaceholder`'s comment for
  // why the placeholder is recomputed per call rather than cached at module
  // scope.
  const blankRowsMatch = matchesBlankRowFolded(foldForSearch(q), foldedUntitledPlaceholder())
  const { real, blank } = partitionPageRows(
    pagesListRef.current,
    (p) => !ftsIds.has(p.id) && matchesSearchFolded(p.title, q),
    (p) => blankRowsMatch && !ftsIds.has(p.id),
  )
  const cacheMatches = [...real, ...blank].slice(0, 10).map((p) => ({ id: p.id, title: p.title }))
  return [...matches, ...cacheMatches].slice(0, 20)
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
 * Returns every alias row the lookup found, the deduped ones included.
 *
 * Failure is logged at warn level — alias-service failure must never
 * abort the picker (see H-10 / H-11).
 *
 * Active-space scoping: the prefix command is scoped to
 * `useSpaceStore.getState().currentSpaceId` so the picker mirrors the
 * other strategies (`searchPagesViaCache` / `searchPagesViaFts`). With no
 * active space nothing is dispatched (#5415) — there are no aliases to
 * surface before the store hydrates anyway.
 */
async function mergeAliasPrefixMatches(matches: PickerItem[], q: string): Promise<AliasRow[]> {
  if (q.length === 0) return []
  try {
    const spaceId = useSpaceStore.getState().currentSpaceId
    if (spaceId == null) return []
    const rows = unwrap(
      await commands.listPageAliasesByPrefix(q, PAGINATION_LIMIT, requireActiveScope(spaceId)),
    )
    if (rows.length === 0) return []

    const existingPageIds = new Set(matches.filter((m) => !m.isCreate).map((m) => m.id))
    const aliasItems: PickerItem[] = []
    const aliasRows = rows.map(([id, alias, title]) => ({ id, alias, title: title ?? '' }))
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
    return aliasRows
  } catch (err) {
    logger.warn('page-matcher', 'alias prefix lookup failed', { query: q }, err)
    return []
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
  rows: readonly PageRow[],
  query: string,
  q: string,
  pagesListRef: PagesListRef,
): void {
  if (q.length === 0) return
  // #4354 — the cold-cache arm is `rows` (this call's RAW page rows), not
  // the rendered `matches`. See the note below the fold guard.
  const allSource: readonly PageRow[] =
    pagesListRef.current.length > 0 ? pagesListRef.current : rows
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
  // folds to `''`, and a title made only of combining marks folds to `''`
  // too — so without this guard such a query would compare EQUAL to such a
  // row, suppressing Create and leaving the picker with nothing at all
  // (nothing matches such a query either). A query that folds away entirely
  // carries no name to match on, so it can never be an "exact match"; offer
  // Create instead. (The guard used to also be what stopped a folded-empty
  // query matching the `''` title #4138 seeds for a NULL-content page; since
  // #4321 that row's match text is the placeholder, so that half is
  // structurally impossible rather than merely guarded.)
  //
  // #4321 — read each row's name through `foldedRowMatchText`, the SAME
  // match text the filter above uses, so "does this row match" and "is this
  // query already satisfied by a row" cannot disagree about what a blank
  // row is called. Folding the RAW title here while the filter folded the
  // placeholder is what made the picker offer "Create new page: Untitled"
  // directly beneath the existing blank page it had just matched.
  //
  // #4354 — BOTH arms compare the page's FULL TITLE. The cold-cache arm
  // used to read the already-rendered `PickerItem.label`, and
  // `makePagePickerItem` runs every title through `formatNamespacedLabel`,
  // which keeps only the LEAF of a namespaced path. So for a page titled
  // `Engineering/Platform/Observability` that arm compared against
  // `Observability`, and the picker answered the same query two different
  // ways depending on nothing but whether the cache happened to be warm:
  //   - `Observability` on a COLD cache matched the leaf and SUPPRESSED
  //     Create, so the user could not create the page they had just named,
  //     and the row offered in its place was a different page whose path
  //     merely ends that way.
  //   - `Engineering/Platform/Observability` on a cold cache matched
  //     nothing (the label is only the leaf) and OFFERED Create for a page
  //     that already exists.
  // The create option creates a PAGE, and a page is identified by its full
  // path, not its leaf — so the full title is what both arms compare, which
  // is what `pagesListRef`'s rows already carried. Passing the raw `rows`
  // instead of `matches` is the whole fix: `allSource` is now one row type,
  // and the union-narrowing this expression used to do (`'title' in p`) goes
  // with it.
  //
  // #4321's guarantee is untouched, and is the reason this is a change of
  // WHICH STRING is read rather than a second blank-row rule: both arms
  // still read their row's name through `foldedRowMatchText`, so a blank
  // row is still named by the placeholder on both. The label arm relied on
  // `makePagePickerItem` having already applied `untitledOr`; the row arm
  // gets the same substitution from `foldedRowMatchText`'s own blank branch,
  // which is where the raw `''` a cold FTS row carries is handled.
  const foldedPlaceholder = foldedUntitledPlaceholder()
  const exactMatch =
    qFolded !== '' &&
    allSource.some((p) => foldedRowMatchText(p.title, foldedPlaceholder) === qFolded)
  if (exactMatch) return
  matches.push({
    id: '__create__',
    label: query.replace(/\]+$/, '').trim(),
    isCreate: true,
  })
}

/** A page an alias prefix lookup found, with the alias that matched and the raw title. */
export interface AliasRow extends PageRow {
  alias: string
}

/** The refs one caller's matcher cache lives in; see each type's docblock. */
export interface PageMatchCache {
  pagesListRef: PagesListRef
  generationRef: GenerationRef
  requestSeqRef: RequestSeqRef
}

/** What `matchPages` found for one query. */
export interface PageMatches {
  /** The title-strategy rows with their raw titles: what the picker seeds the resolve cache with. */
  rows: PageRow[]
  /**
   * Every alias prefix hit, including a page `items` already lists by title
   * (where the picker drops the alias hit as a duplicate).
   */
  aliasRows: AliasRow[]
  /** Alias hits first, then title hits, then a create item when no title matches exactly. */
  items: PickerItem[]
}

/**
 * Short queries are matched against the cached page list, longer ones by FTS
 * (supplemented from the cache); alias prefix hits are prepended and a create
 * item appended when no page title matches the query exactly.
 */
export async function matchPages(query: string, cache: PageMatchCache): Promise<PageMatches> {
  // Strip trailing ]] so [[text]] resolves to "text", not "text]]"
  const q = query.replace(/\]+$/, '').toLowerCase().trim()
  const rows =
    q.length <= 2
      ? await searchPagesViaCache(q, cache.pagesListRef, cache.generationRef, cache.requestSeqRef)
      : await searchPagesViaFts(q, cache.pagesListRef)
  // #4239 — the picker items are rendered separately from the rows, so
  // `makePagePickerItem`'s leaf/breadcrumb split stays a DISPLAY concern.
  const items = rows.map((r) => makePagePickerItem(r.id, r.title))
  const aliasRows = await mergeAliasPrefixMatches(items, q)
  appendCreatePageOptionIfNeeded(items, rows, query, q, cache.pagesListRef)
  return { rows, aliasRows, items }
}
