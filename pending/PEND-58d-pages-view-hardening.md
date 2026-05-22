# PEND-58d — Pages view hardening: review findings + full test/e2e coverage

> **Genesis:** a deep multi-perspective review of the **entire Pages view feature**
> (SQL/data, backend Rust, frontend React, product/UX, testing) followed by an
> adversarial verification pass (5 reviewers + 5 independent verifiers, Session 809).
> Severities below are **post-verification** — the verification round refuted 1
> finding, downgraded 6, and proved the rest with EXPLAIN/seeded-DB probes. Original
> finding IDs (SQL-n / BE-n / FE-n / UX-n / TEST-n) are kept for traceability.
>
> **Supersedes PEND-58c** (its C1–C5 are folded in here as D6 / D24 / D23 / §Testing / D26).
>
> **Refuted / not included** (verification rejected them): the create-retry "stale
> closure" claim (standard `useCallback` semantics); the "count says 50 of 312 so only
> 50 match" framing (the COUNT *is* filter-aware — the real, lesser issue is D11);
> "`Bind::Int` is dead code" (it is a match-required arm).
>
> **Strategic caveat surfaced by verification:** the cross-surface
> `FilterPrimitive` / `Projection` abstraction is currently used **only by Pages** —
> Search still runs on the separate legacy `fts/metadata_filter.rs` subsystem. So the
> "single source of truth shared with Search / never drifts" guarantee in AGENTS.md +
> `docs/architecture/filters.md` is **aspirational, not real today**. Several
> "diverges from Search" findings are really "Pages projection vs the legacy Search
> subsystem." Decide whether to (a) actually migrate Search onto the shared engine, or
> (b) soften the docs to describe the current reality. Tracked as **D27**.

## Status

- **P1 (D1–D4) — SHIPPED (Session 810, 2026-05-22).** D1: `PathGlob` now compiles to the
  documented `title COLLATE NOCASE LIKE ? ESCAPE '\'` (bare word = substring, glob → LIKE),
  fixing the inverted semantics + dropping the per-row `LOWER()`. Discovery during the work:
  SQLite will **not** use a NOCASE index for a case-insensitive `LIKE` (measured — only an
  explicit NOCASE range would), so anchored prefixes still scan; `pages_cache` is one row
  per page so the scan is cheap, and `cost_hint` was made truthful (all `PathGlob` = full
  scan). D2: materialised `inbound_link_count` now excludes same-page/self/deleted-source
  edges (migration 0070 backfill + materializer recompute, mirroring `backlink/grouped.rs`).
  D3: a "Sorted within loaded pages" cue surfaces when a frontend-only sort
  (`alphabetical`/`recent`/`created`) is active with more pages unloaded. D4: a cost-reorder
  IPC test now exercises the `?`→`?N` bind-renumber path. Tests T-B1/T-B5/T-B6 landed.
- **P2 (D5–D15) — SHIPPED (Session 811, 2026-05-22).** D5 `RecentlyModified` perf gate +
  documented ceiling (materialisation deferred); D6 `total_count` gated on first page +
  FE retains it; D7 `LastEdited` NULL symmetry (common epoch sentinel); D8 `HasProperty`
  reshaped to a nested `PropertyPredicate` (invalid states unrepresentable; IPC type +
  bindings regenerated); D9 load-more wrapped in `role="row"`/`gridcell`; D10 optimistic
  create reloads when chips active; D11 count-chip basis (`countMatching` for chips-without-text);
  D12 clear-all control; D13 header `flex-wrap`; D14 Apply disabled on empty; D15 `LastEdited`
  date validation (`InvalidDateFilter:`).
- **P3 (D16–D27) — SHIPPED (Session 811)** except **D23a** (fold-aware `<mark>` ß↔ss
  bounding — deferred, low-impact, overlaps the search fold util). D16 doc fix; D17 `Space`
  kept + documented; D18 `WhereClause.unsupported` boolean field; D19 `Orphan` outbound
  target join (deleted/same-page excluded); D20 count decremented on delete; D21 HasProperty
  editor autoFocus+Enter; D22 chip dedupe; D23b `aria-activedescendant` guarded to rendered
  rows; D24 path-exclude toggle + property op selector (is/is-not/exists/doesn't-exist) +
  facet copy/chip tooltips; D25 popover focus model + redundant/dead i18n cleanup; D26 Ref/Ne
  `HasProperty` SQL (`value_ref`) + summary simplification; D27 docs reconciled to the
  Pages-only reality.
- **Backend/frontend unit + tauri-mock tests — DONE:** T-B2/B3/B4/B7, T-F1/F2/F3/F4, T-M1/M2.
- **REMAINING:** the **comprehensive e2e suite** (below) and the deferred **D23a**.

## TL;DR

- Only the **comprehensive e2e coverage** for every Pages-view feature remains (the explicit
  ask) — the tauri-mock now genuinely filters + reports a real `total_count` (T-M1), so e2e
  can assert narrowing and the count chip. See the Testing section.

---

## Deferred (single remaining non-e2e item)

- **D23a — fold-aware highlight `<mark>` mis-bounding (ß↔ss).** Low-impact; the fold
  offset-mapping in `src/lib/fold-for-search.ts` / `PageBrowserRowRenderer.tsx` can
  mis-place the highlight when a folded character changes length. Deferred to avoid
  churn in the shared search-fold util. (D23b — `aria-activedescendant` guarding —
  shipped in Session 811.)

---

## Testing & e2e coverage expansion

> The standing rule is non-negotiable: every changed code path above ships with tests.
> Beyond that, this section closes the **existing** coverage gaps and builds the
> **comprehensive e2e suite for every Pages-view feature** that the feature currently
> lacks (today's e2e only covers virtualization/pagination + chip-render + a couple of
> grooming facets).

### Backend / integration (IPC-level execution tests)  (TEST-1/2/3/4/5/10)

- **T-B1** — ✅ DONE (Session 810). `PathGlob` glob→LIKE unit tests + compiled-shape +
  EXPLAIN coverage landed; the documented substring/glob contract is now exercised.
- **T-B2** — `LastEdited` Range/Rolling/OlderThan against seeded `op_log` rows: assert
  Rolling{7} includes recent / excludes old, OlderThan{7} is the inverse, Range bounds,
  and the no-op-log-row behaviour (pairs with D7).
- **T-B2** — ✅ DONE (Session 811). `LastEdited` Rolling/OlderThan/Range + no-op-log behaviour.
- **T-B3** — ✅ DONE (Session 811). `Space` + `Priority` IPC narrowing + implicit-scope composition.
- **T-B4** — ✅ DONE (Session 811). `HasProperty` Exists/NotExists/Ne + Eq/Ne over `Ref` (value_ref) end-to-end.
- **T-B5** — ✅ DONE (Session 810). `[Priority(cost1), Tag(cost0)]` reorder + bind-renumber.
- **T-B6** — ✅ DONE (Session 810). same-page inbound parity.
- **T-B7** — ✅ DONE (Session 811). every sort mode's cursor round-trips + cross-mode rejection.

### Frontend unit  (TEST-9/11/12/13) — ✅ ALL DONE (Session 811)

- **T-F1** — ✅ `PageBrowserHeader` count-label branches (null / `countAll` / `countFiltered` / `countMatching`).
- **T-F2** — ✅ `withCursorRecovery` retry-also-fails path.
- **T-F3** — ✅ `AddFilterPopover` via the real component (focus-restore, reset-on-close, emit paths, op selector, exclude toggle).
- **T-F4** — ✅ `PageBrowserRowRenderer.test.tsx` (flag-on/off leaf dispatch, header rows, tree-page rows).

### tauri-mock + e2e enablement  (TEST-6/7 / UX-10) — ✅ DONE (Session 811)

- **T-M1** — ✅ `metaRowMatchesFilter` now filters `PathGlob` / `HasProperty` / `LastEdited` and returns a real `total_count`.
- **T-M2** — ✅ stale `test.fixme('chip-only zero results …')` removed.

### Comprehensive e2e for **all** Pages-view features (the explicit ask)

Build out `e2e/pages-filter.spec.ts` (and/or a new `e2e/pages-view.spec.ts`) so every
user-facing capability has a behavioural test — not just that a control renders, but
that it *does* the thing. Cover, end to end:

1. **Filters — each facet narrows results:** Orphan, Stub, No-inbound, Tag, Priority,
   Page-path (incl. the substring/exact behaviour from D1), Has-property (key-only and
   key=value), and **each** Last-edited bucket (today/this-week/this-month/long-ago).
2. **Compound filters:** AND of 2-3 chips narrows correctly; removing a chip widens;
   the soft-cap warning appears at `MAX_PAGE_FILTERS`.
3. **Zero-result:** a chip that empties the list shows the no-match state (not the
   empty-space "create first"), the chip row stays mounted, and removing the chip recovers.
4. **Clear-all** (once D12 lands).
5. **Count chip:** "X pages" with no filter; updates to the correct narrowed value as
   chips/text change (requires T-M1).
6. **Search box:** text + alias narrowing, and its interplay with chips (orthogonal axes).
7. **Sort:** all seven modes reorder the list; the frontend-only-sort-at-scale cue (D3)
   appears past the first page.
8. **Density:** compact/regular/expanded toggle changes rows and persists across reload.
9. **Pagination/virtualization:** load-more, windowing (DOM row cap), scroll-offset
   restore per space, no scroll-jump on mid-scroll load (extend the existing specs).
10. **CRUD + grooming:** create page (and the optimistic-vs-filter behaviour from D10),
    delete page + confirm dialog, star/unstar + the starred grouping, export all pages.
11. **Flag paths:** `densityV1` default-on and the `'false'` opt-out both render the
    correct surface.
12. **Metadata badges:** inbound / children / last-modified render on density rows.
13. **Cursor recovery:** a `RequiresRefresh` (v1→v2 sort change) recovers without a dupe/drop.
14. **a11y + keyboard:** arrow-key navigation + `aria-activedescendant`; run axe in the
    key states (filtered, zero-result, popover open).
15. **Responsive:** a narrow-viewport pass confirming the header row wraps (D13).

---

## Cost / Impact / Risk

- **Cost:** P1 ~6-9 h · P2 ~8-12 h · P3 ~4-6 h · Testing/e2e ~10-16 h. Total **~28-43 h**
  — split into shippable slices (P1 correctness first; e2e can land incrementally).
- **Impact:** D1/D2 fix genuinely wrong/slow filter results that are one-click reachable;
  D3 fixes a misleading list at scale; the e2e suite converts the current "chip renders"
  confidence into real behavioural coverage and would have caught D1.
- **Risk:** D2 needs a migration backfill (test parity carefully). D8 reshapes an IPC
  type (bindings regen + popover change) — sequence with D24. Everything else is
  localized or additive. Watch the 20k perf gate when touching counts/sorts (D2/D5/D6).
