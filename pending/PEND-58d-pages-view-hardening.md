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
- **P2/P3/Testing/e2e — REMAIN** for future batches (see below).

## TL;DR

- **P2 (~8-12 h):** `RecentlyModified` unmaterialised + ungated (D5); per-page
  `total_count` recompute (D6); `LastEdited` NULL asymmetry (D7); `HasProperty` admits
  invalid states (D8); load-more button is an invalid grid child (D9, a11y);
  optimistic-create bypasses active filters (D10); count-chip basis skew (D11); no
  clear-all (D12); header row no mobile wrap (D13); empty-value Apply dead-end (D14);
  unvalidated `LastEdited` dates (D15).
- **P3 (~4-6 h):** a basket of maintainability/robustness/UX nits (D16–D26).
- **Testing & e2e (~10-16 h):** close every IPC execution gap, make the tauri-mock
  actually filter, and build **comprehensive e2e for every Pages-view feature**
  (the explicit ask). See the Testing section.
- **No further migrations** for what remains (D2's backfill, migration 0070, already shipped).
  One IPC behaviour change is possible (D8 type reshape) — gate it on whether we keep specta
  parity.

---

## P2 — should-fix

- **D5 — `RecentlyModified` unmaterialised + ungated  `P2`  (SQL-3).** Correlated
  `MAX(op_log.created_at)` per page across the space before LIMIT; the 20k perf gate
  only covers `MostLinked`. Fix: materialise `pages_cache.last_edited_at` (preferred) or
  add a `RecentlyModified` perf gate and document the ceiling.
- **D6 — `total_count` recomputed every load-more page  `P2`  (SQL-4 = PEND-58c C1).**
  Gate the COUNT on `req.after.is_none()`; have the FE retain the first total.
- **D7 — `LastEdited` NULL asymmetry  `P2`  (SQL-5).** A page with no op_log row is
  excluded by Rolling/Range but included by OlderThan (epoch COALESCE). Fix: COALESCE
  all three to a common sentinel and document the "no op-log ⇒ epoch" rule.
- **D8 — `HasProperty` admits invalid states  `P2`  (BE-1).** `{op, value: Option}`
  lets `Eq/Ne+None` and `Eq/Ne+Ref` be constructed → runtime `unsupported()`. Fix:
  model as a single enum (`Exists | NotExists | Eq(PropertyValue) | Ne(PropertyValue)`)
  so invalid states are unrepresentable. **NB:** changes the IPC type — regenerate
  bindings (`cargo test -- specta_tests --ignored`) and the popover emit. Sequence with
  D24 (which adds the op selector) since they touch the same shape.
- **D9 — `LoadMoreButton` is an invalid `role="grid"` child  `P2`  (FE-1, a11y).**
  Wrap it in a `role="row"`/`role="gridcell"` footer or move it outside the grid
  container (mirror the no-match grid-role drop). Add an axe assertion in the hasMore state.
- **D10 — optimistic create bypasses active filters/sort  `P2`  (FE-3).** New page
  prepends regardless of active chips and lacks metadata. Fix: when `wireFilters.length > 0`,
  `reload()` instead of optimistic prepend (or suppress the optimistic row).
- **D11 — count-chip basis skew  `P2`  (UX-3 + FE-4).** `countFiltered` pairs a
  loaded+text-narrowed numerator with the filtered-total denominator. Fix: when chips
  are active without text, show just the total ("312 pages"); reserve "X of Y" for the
  text box narrowing the loaded set — or otherwise make numerator/denominator share a
  basis.
- **D12 — no "Clear all filters"  `P2`  (UX-4).** Add a clear-all control to the chip
  row (mirror `GraphFilterBar`'s `clearAll`).
- **D13 — header row no mobile wrap  `P2`  (UX-5).** The search/sort/density row is
  `flex items-center gap-2` with no `flex-wrap`/`flex-col` fallback. Fix: add wrapping.
- **D14 — empty-value Apply is a silent dead-end  `P2`  (UX-6).** Tag/Path/Property
  editors no-op on empty input with no feedback. Fix: disable Apply when empty or show
  inline validation.
- **D15 — unvalidated `LastEdited` dates on Pages  `P2`  (BE-2, downgraded but real).**
  `Range{start,end}` binds raw strings with no format check → malformed date silently
  yields zero rows. Fix: validate dates (and reject empty start/end) returning
  `AppError::Validation("InvalidDateFilter:")`, matching the legacy Search contract.

---

## P3 — nits / latent / maintainability

- **D16  (BE-4):** stale module doc names sort modes `Biggest`/`Ulid`; enum has
  `MostContent`/`Default`. Fix the comment.
- **D17  (BE-6):** `compile_space` is a redundant no-op on the always-space-scoped IPC
  (no-op for the request space, zero rows otherwise). Decide whether `Space` should be
  offered on Pages at all; if not, drop it from `PAGES_ALLOWED_KEYS`/popover.
- **D18  (BE-7):** `is_unsupported()` detects via substring match on `/* UNSUPPORTED */`.
  Replace with a boolean field on `WhereClause` (or a `Result`/enum return).
- **D19  (SQL-6, downgraded):** `Orphan` outbound term ignores the target's
  deleted/same-page state (purged targets are moot — FK cascade). Fix: join the target,
  require `tgt.deleted_at IS NULL`, exclude same-page edges — to match D2's inbound fix.
- **D20  (FE-5):** count chip not decremented on optimistic delete. Fix: decrement
  `totalCount` on delete or recompute from loaded length.
- **D21  (FE-6):** HasProperty editor lacks `autoFocus` + Enter-to-apply (inconsistent
  with `InlineValueEditor`). Fix: add both or reuse the editor pattern.
- **D22  (FE-7):** duplicate identical chips allowed (ship duplicate primitives). Fix:
  dedupe on add by comparing the stripped primitive against existing `wireFilters`.
- **D23  (FE-8 / FE-9):** fold-aware highlight can mis-bound the `<mark>` (ß↔ss);
  `aria-activedescendant` may reference an unrendered virtual row. Low-impact; fix when
  touching those files.
- **D24  (UX-7 / PEND-58c C2):** Orphan vs No-inbound near-duplicate copy; chips drop
  the facet descriptions. Plus add the missing UI controls for path **exclude** and
  property `ne`/`notExists` (the engine + summary already support them — currently
  "reserved for Search/saved-views"). Reconsider clearer facet labels and chip tooltips.
- **D25  (UX-8 / UX-9 / UX-11 / UX-12):** redundant `densityPersistedTooltip` copy;
  dead i18n key `metadata.summaryTooltip`; select tooltips likely unreachable on touch
  (needs runtime check); popover is `role="dialog"` but items are plain buttons with no
  roving-focus menu nav (pick one interaction model).
- **D26  (PEND-58c C3 / BE-5 + PEND-58c C5):** implement the `Ref`-valued / `Ne`
  `HasProperty` SQL (`value_ref`) so the admitted `has-property` key isn't partially
  rejected; simplify the `summaryProperty` redundant ternary.
- **D27  (strategic, from verification):** reconcile the "shared with Search / single
  source of truth" framing — either migrate Search onto the `FilterPrimitive`/`Projection`
  engine, or update AGENTS.md + `docs/architecture/filters.md` to describe the current
  Pages-only reality.

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
- **T-B3** — `Space` and `Priority` IPC tests (narrowing + composition with the implicit
  space scope).
- **T-B4** — `HasProperty` `Exists`/`NotExists`/`Ne` executed end-to-end (only `Eq` runs
  today); plus the validation-rejection for unsupported shapes (already present).
- **T-B5** — ✅ DONE (Session 810). `filter_priority_and_tag_compose_correctly_despite_cost_reorder`
  exercises the `[Priority(cost1), Tag(cost0)]` reorder + bind-renumber.
- **T-B6** — ✅ DONE (Session 810). `same_page_edge_excluded_from_inbound_count` +
  the updated parity helper assert materialised == canonical for same-page edges.
- **T-B7** — per-mode cursor discriminator coverage in `validate_pages_metadata_cursor`
  (all sort modes, not just the one pair + the legacy None arm).

### Frontend unit  (TEST-9/11/12/13)

- **T-F1** — `PageBrowserHeader` count-label branches driven directly (null / `countAll`
  / `countFiltered`).
- **T-F2** — `withCursorRecovery` retry-also-fails path (original error propagates).
- **T-F3** — `AddFilterPopover` (un-mock the popover or test via the real component):
  focus-restore on close, reset on `onOpenChange(false)`, and the `op:'eq'` emit path.
- **T-F4** — a dedicated `PageBrowserRowRenderer.test.tsx` (flag-on/flag-off leaf dispatch,
  header rows, tree-page rows).

### tauri-mock + e2e enablement  (TEST-6/7 / UX-10)

- **T-M1** — extend `metaRowMatchesFilter` to actually filter `PathGlob` / `HasProperty`
  / `LastEdited` (today they're pass-through no-ops), and compute a real `total_count`
  (today `null`). This is the prerequisite that lets e2e assert *narrowing* and the
  count chip rather than just chip-render.
- **T-M2** — remove the stale `test.fixme('chip-only zero results …')` at
  `e2e/pages-filter.spec.ts:401` (P0-B has shipped + is unit-covered).

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
