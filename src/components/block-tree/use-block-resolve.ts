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
import { blockFirstLineOr, resolveStoreTitle, untitledOr } from '@/lib/block-title'
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
   *  1. TWO ENTRY POINTS. `createPageInSpace` exists both as a typed helper
   *     (`@/lib/tauri/system.ts`) AND as the raw binding
   *     (`commands.createPageInSpace`), so a reference query on either one
   *     alone undercounts — asymmetrically: the helper reaches five of the
   *     sites below and the raw binding the other four, so searching the
   *     helper alone misses four and searching the binding alone misses
   *     five. There are NINE creation sites outside
   *     `onCreatePage`: eight do not register, one does
   *     (`src/components/block-tree/use-block-date-picker.ts:180`, the #4319 site above).
   *  2. THE EIGHT CANNOT REGISTER — they did not forget to.
   *     `useBlockResolve()` has exactly one caller
   *     (`src/components/editor/BlockTree.tsx:494`), and every one of the eight sits above or
   *     beside `BlockTree`: ancestors (`useJournalBlockCreation` via
   *     `JournalPage`/`StreamView`, `App.tsx`, `useAppKeyboardShortcuts`),
   *     sibling subtrees with no BlockTree at all (`usePageCreation` in
   *     PageBrowser, `TemplatesView`), or module-level functions with no
   *     hook context by construction (`palette-commands.ts`,
   *     `WelcomeModal`'s `ensureSamplePage`, and `src/lib/paste-internalize.ts:110`
   *     — the closest analogue to `onCreatePage` in the codebase, and the
   *     one every prior enumeration missed). The journal also mounts one
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
   *  5. IF A SITE EVER DOES NEED TO REGISTER, the route is an `'added'`
   *     event on the name-change bus — not this return value (unreachable
   *     for all eight) and not a React context (module-level call sites
   *     cannot consume one, and it would still fan out to N instances).
   *     `name-change-bus.ts`'s docblock currently states there is
   *     deliberately no "added" event because inserting one row would latch
   *     a one-row list as the whole space; `recordCreatedRow`'s
   *     append-only-into-a-non-empty-cache guard now answers that
   *     objection, so whoever implements it must AMEND that paragraph
   *     rather than silently contradict it.
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

// ── searchPages strategy helpers ────────────────────────────────────────
//
// Each function below represents a discrete resolution strategy used by
// `searchPages`. They are defined at module scope because they do not close
// over React state — the only mutable state they touch is the `pagesListRef`
// passed in explicitly. Keeping them as free functions (rather than inline
// closures) makes the dispatcher below a linear, low-complexity sequence.

/**
 * One page suggestion as the strategies deal in it: the RAW title, exactly
 * as stored. The strategies stop at this shape and the dispatcher renders it
 * into a `PickerItem` — #4239, so the resolve-cache seed can be handed the
 * un-split path instead of `makePagePickerItem`'s leaf-only label. See
 * `populatePageResolveCache`.
 */
interface PageRow {
  id: string
  title: string
}

type PagesListRef = React.RefObject<PageRow[]>

/**
 * Ref to the generation counter bumped by the name-change-bus subscriber on
 * EVERY event (any kind, any entity) — see `nameChangeGenerationRef` in
 * `useBlockResolve` and #4055 below.
 */
type GenerationRef = React.RefObject<number>

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
type RequestSeqRef = React.RefObject<number>

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
 */
function recordCreatedRow<Row>(
  listRef: React.RefObject<Row[]>,
  generationRef: GenerationRef,
  row: Row,
): void {
  generationRef.current += 1
  if (listRef.current.length > 0) {
    listRef.current = [...listRef.current, row]
  }
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
        // #4055 — bump on every event, unconditionally, BEFORE applying it.
        // An in-flight fill's `requestGeneration` capture and this bump can
        // never interleave any other way: JS is single-threaded and nothing
        // awaits between them, so a fill either captured the generation
        // before this listener runs (and must now lose the race) or after
        // (and reads the bumped value already).
        nameChangeGenerationRef.current += 1
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
      const rows =
        q.length <= 2
          ? await searchPagesViaCache(q, pagesListRef, nameChangeGenerationRef, pagesRequestSeqRef)
          : await searchPagesViaFts(q, pagesListRef)

      // #4239 — seed from the ROWS (raw, un-split titles) and render the
      // picker items separately, so `makePagePickerItem`'s leaf/breadcrumb
      // split stays a DISPLAY concern and never reaches the resolve store.
      // Order is unchanged: the seed still runs before the alias merge, so
      // alias-only hits are still not seeded.
      populatePageResolveCache(rows, requestSpaceId)
      const matches = rows.map((r) => makePagePickerItem(r.id, r.title))
      await mergeAliasPrefixMatches(matches, q)
      appendCreatePageOptionIfNeeded(matches, rows, query, q, pagesListRef)

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
      recordCreatedRow(pagesListRef, nameChangeGenerationRef, { id: newId, title: label })
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
    recordCreatedRow(pagesListRef, nameChangeGenerationRef, row)
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
      recordCreatedRow(tagsListRef, nameChangeGenerationRef, {
        tag_id: block.id,
        name,
        usage_count: 0,
        updated_at: new Date().toISOString(),
      })
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
