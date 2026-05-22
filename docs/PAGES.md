<!-- markdownlint-disable MD060 -->
# Pages view

The Pages view is the canonical "show me every page in this space" surface — a flat, sortable, paginated list of every page in the active space. Beyond the name-substring search box at the top, it offers a row of **compound filter chips** that narrow the list *server-side*: instead of scrolling, you stack a few filters ("orphaned pages edited long ago") and the backend returns exactly that set.

This page documents the user-facing filter vocabulary. For the data flow behind the list (the metadata IPC, the seven sort modes, density rows), see [Pages view architecture](architecture/pages-view.md). The same filter primitives power the find-across-pages surface — see [Search](SEARCH.md) for the query-input side of that story.

## Overview

Compound filters live in a chip row above the page list. You add a chip from the **Add filter** popover, and each chip narrows the result set. Chips combine with AND: every page in the result satisfies *every* applied chip. The filtering happens in SQL on the backend, so the count and the list stay correct regardless of how many pages the space holds — you are not filtering a partial, already-paginated page in the browser.

The chip set is split into two groups, mirroring the popover:

- **Filters** (shared with Search): Tag, Page path, Has property, the Last-edited buckets, and Priority. A `tag:` chip applied here returns the same pages whose blocks the Search surface returns for the same tag — the two surfaces share one filter engine and never drift.
- **Pages** (grooming facets that only make sense at page granularity): Orphan, Stub, and No inbound links.

### The chip row (and how to opt out)

The compound-filter chip row is **on by default**. It rides the same `list_pages_with_metadata` code path as density rows, so a single localStorage flag gates both:

- **Flag key:** `pageBrowser.densityV1`
- **Default:** on. A missing key — or any value other than the bare string `'false'` — means the chip row is shown (the value is *not* JSON-wrapped). Only the exact string `'false'` opts out.

To opt out, set the flag from the devtools console:

```js
localStorage.setItem('pageBrowser.densityV1', 'false')
```

then reload. The flag is read once when the Pages view mounts (it is not reactive), so a reload is required after changing it. To turn the chip row back on, `localStorage.removeItem('pageBrowser.densityV1')` (or set it to anything other than `'false'`) and reload. The flag-read lives in `src/components/PageBrowser.tsx`; the chip row itself is `src/components/PageBrowser/PageBrowserFilterRow.tsx`, fed by the Add-filter popover in `src/components/PageBrowser/AddFilterPopover.tsx`.

With the chip row opted out, the Pages view behaves exactly as it always has: the name-substring box filters the loaded list and there is no chip row.

## Filter facets

Each facet adds one chip. The chip label is the human-readable summary shown on the chip; the popover offers the same labels under **Add filter**. The facet semantics are defined in `src-tauri/src/filters/primitive.rs`.

### Pages-only facets

These describe a page's connectivity or emptiness — concepts that only exist at the page level, so they are absent from Search.

| Chip label | What it matches | Example |
|---|---|---|
| **Orphan** | A page with **no inbound links *and* no outbound links** — nothing points to it and it points to nothing. Prime archival / merge candidate. | Surface every disconnected page so you can decide whether to keep, merge, or archive it. |
| **Stub** | An empty-but-named page: **zero non-title descendants**. The page exists and has a title, but no content blocks under it. | Find the named placeholders you created and never filled in. |
| **No inbound links** | A page with **zero backlinks** — nobody has linked *to* it yet (its own outbound links don't count). The looser sibling of Orphan. | Discover pages that exist in the space but aren't woven into your link graph. |

Two notes on the link counting, so the results aren't surprising:

- **"Inbound" means page *or any descendant*.** The inbound count counts block-reference and `[[page]]` edges that target the page block **or any non-deleted block under it**. So a page is *not* "No inbound links" if some deep content block inside it is referenced from elsewhere, even when the page title itself has no backlinks. This is deliberate: it matches the inbound-link count rendered on each density row and the "Most linked" sort, so clicking **No inbound links** after seeing "0 inbound" on a row always agrees with the surfaced number.
- **Orphan is a strict superset of No inbound links.** Every Orphan page also has no inbound links. Applying both chips at once is redundant but not an error — the backend evaluates the redundancy away. The chips both render; the result is identical to Orphan alone.

### Last-edited buckets

The Last-edited facet adds one of four recency buckets. The buckets are **rolling** windows measured back from now (not calendar-aligned weeks/months), driven by each page's most recent edit. The exact window behind each bucket is defined with the filter primitives in `src-tauri/src/filters/primitive.rs`:

| Chip label | What it matches |
|---|---|
| **Edited today** | Edited within the most recent rolling day. |
| **Edited this week** | Edited within the rolling week. |
| **Edited this month** | Edited within the rolling month. |
| **Edited long ago** | *Not* edited within the rolling month — the stale tail. |

Because the buckets are rolling, "this week" is a window ending right now, not "since Monday." A page that crosses a bucket boundary between two views moves to the correct bucket on the next load with no manual refresh — the boundary is computed at query time.

### Shared facets

These behave identically here and on the Search surface. The same chip applied on both surfaces returns intersecting result sets.

| Chip label | What it matches | Example |
|---|---|---|
| **Tag** | Pages carrying the given tag. Enter a tag **id** in the inline editor (the facet matches by id); the resulting chip resolves and displays the tag's name. Multiple Tag chips AND together. | A **Tag** chip for the `urgent` tag's id returns every page tagged urgent, and reads `tag: urgent` once resolved. |
| **Page path** | Pages whose **title** matches a glob, case-insensitively. `*` is any run of characters, `?` is one. A bare word with no wildcard becomes a substring match. Tick **Exclude** to invert the match (pages that do *not* match). | `Projects/*` matches every page whose title starts with `Projects/`; `Alpha` matches any title containing "Alpha"; `Projects/*` with **Exclude** returns everything outside `Projects/`. |
| **Has property** | Pages constrained by a property key. The selector offers **is** / **is not** / **exists** / **doesn't exist**: **exists** / **doesn't exist** match on the key alone; **is** / **is not** compare against the value you type. | **Has property** key `status` + **exists** matches any page with a `status` property; key `status` + **is** + `draft` matches only `status = draft`; key `status` + **is not** + `draft` matches pages whose `status` is anything but draft. |
| **Priority** | Pages with the given priority. The popover offers your **configured priority levels** — the built-in defaults are `1`, `2`, `3` (most-urgent first), and they are customisable, so the offered values always match what your space uses. | **Priority** `1` returns the top-priority pages. |

The popover also defines an implicit **Space** filter — you are always scoped to the active space — but it is never offered as a chip because it is always on.

## Worked examples

### Find stale, unconnected pages

The classic grooming sweep: pages nothing links to that also haven't been touched in a while — strong candidates for archival.

1. Open **Add filter** and, under **Pages**, click **Orphan**.
2. Open **Add filter** again and, under **Filters**, click the **Edited long ago** bucket.

The list now shows only pages that are both disconnected and stale. The two chips read **Orphan** and **Edited long ago**; removing either widens the set (drop **Orphan** to see *all* stale pages; drop **Edited long ago** to see *all* orphans).

### What changed this week

A quick "where did I leave off" view:

1. Open **Add filter** and click the **Edited this week** bucket under **Filters**.

The list collapses to pages edited in the last seven days. Pair it with the **Recently modified** sort (from the sort control) to read them newest-first.

## Combining filters

- **Chips AND together.** Every applied chip must be satisfied. There is no OR between chips — to widen a set, remove a chip rather than add one.
- **Filters compose with sort and the search box.** The chip set, the sort order, and the name-substring box are orthogonal axes. You can apply **Orphan**, sort by **Most linked**, and type a substring in the search box all at once; each narrows or orders independently.
- **Soft cap (`MAX_PAGE_FILTERS`).** Most grooming flows use a handful of chips. Once the active chip count reaches the soft cap (`MAX_PAGE_FILTERS`, defined in `src/components/PageBrowser/PageBrowserFilterRow.tsx`), the Add-filter popover shows "Many filters can slow the view." because each extra clause adds query cost. This is a *soft* warning, not a hard limit — you can keep adding chips past the cap; the UI just stops being confident the view will stay fast.
- **Remove a chip** with its `×`; the result set widens and the list refetches from the top.
- **Clear all filters at once** with the **Clear all** control in the chip row; every chip is removed and the list returns to the unfiltered view in one step (a screen-reader announcement confirms the clear).

## Notes and limitations

- **The search box is separate from the chips.** The name-substring box at the top of the Pages view filters by page title only — it is *not* a query input. Typing `tag:urgent` into it searches for a page literally titled "tag:urgent" (almost always zero results), because the Pages input does **not** parse inline filter syntax. Structured filters live exclusively in chips. This is a deliberate split: the Pages box is a "jump to the page I half-remember the name of" affordance, and mixing prefix syntax into it would force users to memorise prefixes for a view that should be obvious at first paint. (The Search surface *does* parse inline `tag:` / `path:` syntax, because Search has a real query that composes naturally with filters — see [Search](SEARCH.md).)
- **An invalid filter returns zero results, not an error.** A Tag chip pointing at a tag that no longer exists simply matches nothing; the chip still renders with the value you gave it, so you can remove it. The backend does not round-trip every chip for validation.
- **Negation and exclusion are built in.** The Pages **Add filter** popover builds both affirmative and negated forms: a **Page path** is an *include* glob by default and an *exclude* glob when you tick **Exclude**, and **Has property** offers *exists* / *doesn't exist* and *is* / *is not* (see the **Page path** and **Has property** rows above). The same negated forms also render correctly when they arrive from a saved view.
- **Empty state.** With no chips applied, the Pages view shows every page in the active space, sorted by your current sort and paginated normally — identical to the no-filter view. An empty chip row renders just the **Add filter** button.
- **Pages-only facets vs Search.** The Orphan / Stub / No-inbound-links facets are never offered on the Search surface; conversely, Search-only facets (regex, case-sensitive, whole-word, snippet) are never offered here. The per-surface allow-list that enforces this is documented alongside the filter primitives in `src-tauri/src/filters/primitive.rs`.
