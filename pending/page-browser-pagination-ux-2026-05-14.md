# PageBrowser pagination UX — count, scroll restore, auto-load

> Status: ready for review.
> Triggered by: "the pages view paging sucks hard, you can't really navigate to previous pages, you don't know in which page you are." Reality check: the virtual list already exists (`@tanstack/react-virtual` at `src/components/PageBrowser.tsx:290`). The pain is three real but smaller things — no progress indicator, no scroll restoration, click-driven load more — that together make the view feel like classical pagination rather than a continuous list.

## What's broken today

`src/components/PageBrowser.tsx` does the right structural thing: cursor-paginated `usePaginatedQuery` + `useVirtualizer` + a `LoadMoreButton` at the bottom. Three gaps:

1. **No "Loaded X of Y".** `LoadMoreButton` already accepts `loadedCount` + `totalCount` (`src/components/LoadMoreButton.tsx:36-39`) and renders the progress line when both are present. `PageBrowser` (`:447-454`) passes neither because the backend can't supply `totalCount` — `PageResponse<T>` is `{ items, next_cursor, has_more }` (`src/lib/bindings.ts:1193-1197`), no count. There is no `count_pages` / `count_blocks_by_type` IPC anywhere in `src-tauri/src/commands/`.
2. **No scroll restoration.** When the user clicks a page → opens the editor → hits back, `PageBrowser` remounts and the virtualizer's scroll offset starts at 0. With a 300-page list that means scrolling all the way back every time. There is no `sessionStorage` scroll save anywhere (grep confirms).
3. **Manual *Load more* feels like real pagination.** With virtualization, the user has to scroll past every loaded row to find the button. There's no signal that more exist (no #1) and no auto-fetch as they approach the bottom — so the experience is "scroll, hit a wall, find a button, click, scroll, hit a wall…" which reads as chunked pagination even though the underlying model is continuous.

## The fix

Three independent changes that compose. Each is shippable on its own; recommend landing all three together because the user-perceived improvement is the sum.

### 1. Backend: surface `total_count` on `listBlocks`

`src-tauri/src/commands/pages.rs` (or wherever `list_blocks` actually lives — verify; `commands/blocks.rs` is plausible). Add `total_count: i64` to the `PageResponse<BlockRow>` returned by the `list_blocks` command (or define a new wider `CountedPageResponse<T>` so other paginated commands aren't forced to compute counts they don't need).

Implementation options:

- **(a) Add to existing PageResponse.** One field, all existing callers ignore it. Backend computes a `SELECT COUNT(*) ... WHERE block_type = ? AND space_id = ? AND deleted_at IS NULL` once per request alongside the LIMIT/OFFSET row fetch. With a covering index on `(block_type, space_id, deleted_at)` the count is fast — sub-ms for typical vault sizes. Cost: a second query per request, computed even if the FE doesn't show the count. Prefer this if it's cheap.
- **(b) Separate `CountedPageResponse<T>` parallel type.** Keeps PageResponse zero-cost; opts in via a new `list_blocks_with_count` command. More plumbing, less wasteful for callers that don't want the count.

Recommend (a) for simplicity; reconsider if the COUNT query measurably regresses cold-start latency (unlikely — single indexed scan).

Generated bindings (`src/lib/bindings.ts:1193`) regenerate from the Rust side via the existing TS bindings pipeline; no manual edit needed.

### 2. Frontend: pass count through to the progress line

`src/components/PageBrowser.tsx:447`. With (1) landed:

```tsx
<LoadMoreButton
  hasMore={hasMore}
  loading={loading}
  onLoadMore={loadMore}
  loadedCount={pages.length}
  totalCount={totalCount}   // sourced from the new field via usePaginatedQuery
  ...
/>
```

`usePaginatedQuery` (`src/hooks/usePaginatedQuery.ts`) needs to track `total_count` from the latest response and expose it. One additional `useState<number | undefined>` + a setter inside the success path, exposed in `UsePaginatedQueryResult<T>`. Existing consumers that don't read it pay nothing.

Also surface the count in the header for a glanceable signal even before the user reaches the bottom: small muted text near the search input — *"312 pages"* (or *"23 of 312 matching"* when filtered). Goes in `src/components/PageBrowser/PageBrowserHeader.tsx`. Plumb `loadedCount` + `totalCount` + `filteredCount` through the existing prop surface.

### 3. Frontend: scroll restoration via sessionStorage

`src/components/PageBrowser.tsx:290-298`. Save the virtualizer's scroll offset on every scroll (debounced ~150 ms via `requestIdleCallback` or a simple ref-tracked timeout) under `sessionStorage['pageBrowser:scrollOffset']`. On mount, after the first batch of items hydrates AND `virtualizer.getTotalSize()` is non-zero, restore via `virtualizer.scrollToOffset(saved, { align: 'start' })`.

Important guards:

- Only restore once per mount. Track with a `restoredRef = useRef(false)` so a second hydration (filter change, sort change) doesn't yank the user back.
- Bound the saved offset to `[0, virtualizer.getTotalSize()]` on read in case the list shrank between sessions.
- Clear the saved offset when filter or sort changes — the position is meaningless against a different ordering. Keep on space switch too (the page set changes entirely).
- Per-space key: `pageBrowser:scrollOffset:${spaceId}` so switching spaces and back restores each space's last position, not whichever was saved last globally.

Out of scope: cross-tab / cross-window scroll sync (sessionStorage is per-tab by design — that's the right scope here).

### 4. Frontend: auto-load near the bottom

`src/components/PageBrowser.tsx:419-443`. Inside the virtual-items loop, when the last *visible* virtual item is within ~5 rows of `virtualItemCount - 1` AND `hasMore` AND `!loading`, call `loadMore()`. Concretely:

```tsx
const virtualItems = virtualizer.getVirtualItems()
const lastVisible = virtualItems.at(-1)
useEffect(() => {
  if (!hasMore || loading) return
  if (lastVisible == null) return
  if (lastVisible.index >= virtualItemCount - 5) {
    void loadMore()
  }
}, [lastVisible?.index, hasMore, loading, loadMore, virtualItemCount])
```

Keep the `<LoadMoreButton>` rendered as today — it remains the:

- A11y affordance: keyboard-only / screen-reader users can `Tab` to it directly.
- Reduced-motion / no-JS / IO-throttled fallback: if for whatever reason the auto-trigger doesn't fire (e.g. the user never scrolls because the loaded set already fills the viewport), the button is the explicit way to say "more please".

The loading spinner inside the button is the visual signal during auto-load too, so users still see "this is happening" even if they didn't click.

### 5. Apply the same shape to the other LoadMoreButton call sites (optional, follow-up)

`grep -l LoadMoreButton src/components` shows: PageBrowser, LinkedReferences, UnlinkedReferences, AgendaResults, DonePanel, DuePanel. The auto-load + count fixes are PageBrowser-specific in this plan, but the underlying primitives become available for any of those views to opt in next time someone touches them. Do not pre-emptively migrate; let the demand drive each one. Tracked here only as "the door is open."

## Verification

- `cargo test -p agaric-tauri commands::pages -- list_blocks_total_count` — assert the new field is populated and matches `items.len()` only when there's no `next_cursor`, and exceeds it when more remain.
- `npm run typecheck` — TS bindings regenerate; consumers compile.
- `npm run test -- PageBrowser usePaginatedQuery LoadMoreButton`:
  - `LoadMoreButton`: existing tests cover `loadedCount`/`totalCount` rendering — no change.
  - `usePaginatedQuery`: new test for `totalCount` exposure across cursor pages.
  - `PageBrowser`: tests for (a) "X of Y" appears in header when count is loaded, (b) auto-load fires when scrolled near bottom, (c) scroll position restored on remount, (d) saved offset cleared on filter/sort/space change.
- Manual: open Pages with ~300+ pages (seed if needed), scroll to row 200, click into one, hit back — should land at row 200, not row 0. Filter the list, clear the filter — should NOT restore the saved offset (filtered view ≠ saved position).
- E2E: existing `page-browser` Playwright spec — verify it still passes; add one new case for scroll restoration.

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | M. Backend `total_count` field + tests: ~3 h. `usePaginatedQuery` + `LoadMoreButton` plumbing + header chip: ~2 h. Auto-load effect + tests: ~2 h. Scroll restoration + tests: ~3 h (the multi-condition reset logic is the fiddly part). Manual + e2e sweep: ~1 h. Total: ~1.5 days. |
| **Impact** | Closes the perception gap between "this is paginated" and "this is a continuous virtual list" — which is what the user actually wants. The three changes attack three independent friction points, so each one moved independently is observable. After all three: scroll-into-list, navigate away, navigate back, see "27 of 312" shrinking as you progress = the view "feels modern." |
| **Risk** | Low-medium. The backend COUNT query is the only place a perf regression could land — pre-empt with `EXPLAIN QUERY PLAN` to confirm the existing index covers it; if not, add `(block_type, space_id, deleted_at)` index in the same migration. Auto-load logic is bounded by `hasMore && !loading` so it cannot over-fire. Scroll restoration's risk is jank: if the saved offset is restored before items hydrate, the virtualizer scrolls into empty space — guard with the `getTotalSize() > 0` check above. |
| **Reversibility** | High per change. Each is a localised diff; remove individually if any sub-change misbehaves. The backend `total_count` field is purely additive (existing consumers ignore it). |

## Out of scope

- Replacing cursor pagination with full eager-load. Discussed but rejected: even though typical vault size is small, large vaults (10k+ pages) still benefit from cursor-paginated initial response so the first paint is fast. Auto-load + count gives the same UX without the up-front cost.
- A-Z jump rail. Useful for very long alphabetised lists; not needed if the count + auto-load + scroll restore make the existing scroll feel responsive. Re-open if usage data shows long-list scroll fatigue.
- "Back to top" floating button. Browser already provides a path (Home key, sticky search input is reachable from any scroll position). Add only if user research surfaces it.
- Migrating other `LoadMoreButton` consumers (LinkedReferences, UnlinkedReferences, AgendaResults, DonePanel, DuePanel). Tracked here only so the next person touching one knows the shape.
- Restoring focused row on remount (separate from scroll offset; would need the focused page id, then `pageIndexToRowIndex` lookup, then `setFocusedIndex`). Probably worth doing alongside but can ship after.
