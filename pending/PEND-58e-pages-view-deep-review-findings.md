# PEND-58e — Pages view: deep-review findings (post-verification)

> **Genesis:** a second deep multi-perspective review of the **entire Pages view feature**
> after PEND-58d shipped (P1–P3 + comprehensive e2e). Five perspective reviewers
> (SQL/data, backend Rust, frontend React, product/UX, testing/e2e) produced 40 raw
> findings; three independent **adversarial verifiers** then re-checked every finding
> against the code (`sqlite3` / `cargo` / `tsc` probes) and ruled each
> **CONFIRMED / OVERSTATED / REFUTED**. Sessions 812–813.
>
> Everything below is the **post-verification** set — confirmed against the code, with
> the refuted/downgraded items recorded at the bottom so they are not re-litigated.
> Original reviewer IDs (`F-n`, `SQLR-/BER-/FER-/UXR-/TER-n`) are kept for traceability.
>
> **Scope note:** several items are **pre-existing** (PEND-58, not introduced by the
> 58d hardening) — flagged inline. They surface now because PEND-58 consumes the
> affected data in filters/sorts/counts.
>
> **Sibling:** PEND-58d still tracks one deferred item (**D23a** — fold-aware `<mark>`
> ß↔ss bounding); not duplicated here.

## TL;DR

- **P1 (2):** the Priority facet is non-functional out of the box (offers `A/B/C`, data
  is `1/2/3`); `docs/PAGES.md` self-contradicts the shipped D24 controls.
- **P2 (6):** `LastEdited` custom Range drops end-day edits; cross-page `MoveBlock`
  leaves `child_block_count` stale; `tag:` is id-only but invites a name; filter pills
  never truncate; the count chip miscounts in namespaced/starred vaults;
  `docs/architecture/filters.md` still shows the pre-D8 `HasProperty` shape.
- **P3 (~13):** test-efficacy gaps (EXPLAIN-of-a-copy, parity shared-shape blind spot),
  tauri-mock fidelity gaps, perf-gate realism, and a basket of UX/a11y/doc nits.
- **No migrations.** One small IPC-adjacent change (Priority levels are already on the
  wire as strings — no type change). Most fixes are localized.

---

## P1 — functional / high-confidence

### E1 — Priority facet matches nothing out of the box  `P1`  (F14 / UXR-2) — *pre-existing*

- **Where:** `src/components/PageBrowser/AddFilterPopover.tsx:54` (`PRIORITIES = ['A','B','C']`),
  emit ~line 200; `docs/PAGES.md:75`. Backend `src-tauri/src/filters/primitive.rs`
  `compile_priority` → `b.priority = ?`.
- **Problem:** priorities are stored/configured as `['1','2','3']`
  (`src/lib/priority-levels.ts` `DEFAULT_PRIORITY_LEVELS`, user-configurable via
  `usePriorityLevels`). The popover hardcodes `A/B/C` and there is no `A→1` mapping, so
  clicking Priority in a default space returns **zero** pages (and silently — see E20-adjacent
  zero-match). `GraphFilterBar` already does this correctly.
- **Verdict:** CONFIRMED P1 (3 reviewers + orchestrator probe + verifier).
- **Fix:** drive the popover from `usePriorityLevels()` like `GraphFilterBar`
  (`GraphFilterBar.tsx:136`); update `docs/PAGES.md:75` to stop naming `A/B/C`. Add a
  unit test that the offered values equal the configured levels.

### E2 — `docs/PAGES.md` self-contradicts the shipped D24 controls  `P1` (doc)  (F24 / UXR-1)

- **Where:** `docs/PAGES.md` "Notes and limitations" (~line 109) vs the facet table
  (lines 73–74). Corroborated by stale code comments at
  `PageBrowserFilterRow.tsx:90,130`.
- **Problem:** the limitations note still says path-`exclude` / property `not-equals` /
  `not-exists` are "Search-side; the Pages popover does not create them" — but D24 ships
  exactly those controls (the table documents them). Introduced because the D27 doc pass
  updated the table but not this section.
- **Verdict:** CONFIRMED P1 (doc).
- **Fix:** delete/rewrite the stale limitation note; refresh the two corroborating code
  comments.

---

## P2 — should-fix

### E3 — `LastEdited` custom Range drops end-day edits  `P2`  (F1-Range / SQLR-1 / BER-6)

- **Where:** `src-tauri/src/filters/primitive.rs` `compile_last_edited` (Range arm, ~596);
  validation `src-tauri/src/commands/pages.rs` `validate_last_edited_date` (~1946).
- **Problem:** a bare `YYYY-MM-DD` `end` is bound verbatim into
  `created_at BETWEEN ? AND ?` against full RFC3339 timestamps. `sqlite3`-confirmed:
  `'2026-03-01T09:00:00.123Z' BETWEEN '2026-02-01' AND '2026-03-01'` → **excluded**. Every
  page edited during the *daytime* of the end day is silently lost. Data correctness.
- **Verdict:** CONFIRMED P2. (The companion claim that Rolling/OlderThan share this bug
  was **REFUTED** — that lexical compare is correct because `T` > space.)
- **Fix:** when an `end` bound is a bare date, compare against `< end + 1 day` (or append
  `T23:59:59.999Z`); add a test with a non-midnight end-day edit.

### E4 — cross-page `MoveBlock` leaves `child_block_count` stale  `P2`  (F2 / BER-2 / SQLR-4 / TER-5) — *pre-existing*

- **Where:** `src-tauri/src/materializer/handlers.rs` `maintain_pages_cache_counts_after_op`
  (MoveBlock no-op arm ~845-856); contradicted by `src-tauri/src/commands/blocks/move_ops.rs`
  (~196-231, recomputes `page_id` on cross-page reparent); dispatch
  `src-tauri/src/materializer/dispatch.rs:401-404` enqueues `RebuildPageIds` but not
  `RebuildPagesCache`.
- **Problem:** the count hook skips MoveBlock on a comment-asserted "MoveBlock never
  alters page_id" invariant that `move_ops.rs` already violates. After a cross-page move
  the source and destination `child_block_count` (and the `↗`/child badge, `Stub`,
  `MostContent`) drift until an unrelated op touches each page. The in-code comment
  literally invites this verification.
- **Verdict:** CONFIRMED P2 (3 reviewers).
- **Fix:** on a MoveBlock that changes `page_id`, recompute counts for both the source and
  destination pages (call `recompute_pages_cache_counts_for_pages` for the affected set),
  or enqueue `RebuildPagesCache`. Add a cross-page-move parity test (the
  `pages_cache_count_parity` mod currently never exercises move).

### E5 — `tag:` facet is id-only but invites a name  `P2`  (F15 / UXR-3) — *pre-existing*

- **Where:** `compile_tag` (`primitive.rs`) → `block_tags WHERE tag_id = ?`; placeholder
  `pages.ts:285` "Tag name or id"; `docs/PAGES.md:72`; `PageBrowser.tsx:913` renders
  `<PageBrowserFilterRow>` without the supported `tagResolver` prop
  (`PageBrowserFilterRow.tsx:43,161`), so `pageFilterSummary` falls back to the raw ULID.
- **Problem:** a typed tag *name* silently matches nothing, and even a correct id renders
  an opaque `tag: 01TAG…` chip.
- **Verdict:** CONFIRMED P2.
- **Fix:** resolve a typed name → id in the editor (mirror `GraphFilterBar`'s named-tag
  picker), and pass a `tagResolver` so the chip shows the tag name. Minimum: pass the
  resolver + correct the placeholder/doc to "tag id" if name-resolution is out of scope.

### E6 — filter pills never truncate  `P2`  (F16 / UXR-4) — *pre-existing*

- **Where:** `src/components/ui/badge.tsx:33` (`whitespace-nowrap`, no `max-width`),
  `src/components/ui/filter-pill.tsx:41` (`shrink-0`), chip row
  `PageBrowserFilterRow.tsx:167` (`flex-wrap`).
- **Problem:** a long tag/path/property value yields an unbounded-width pill that wraps to
  its own line and can push Add-filter / Clear-all off-screen on narrow viewports; value
  chips have no tooltip rescue (`pageFilterChipTitle` returns undefined for them).
- **Verdict:** CONFIRMED P2.
- **Fix:** add `max-w-[…] truncate` to the pill label and a `title`/tooltip carrying the
  full value.

### E7 — count chip miscounts in namespaced/starred vaults  `P2`  (F8 / FER-1)

- **Where:** `PageBrowser.tsx:899` (`filteredCount={filteredPages.length}`), `:601` (SR
  result count); `usePageBrowserGrouping.ts:183-191` (namespace subtree → one `tree-page`
  row; starred+namespaced page double-counted).
- **Problem:** `filteredPages` is the **grouped** row array, not a flat page list, so under
  a free-text query "X of Y matching" and the screen-reader announcement under/over-count.
- **Verdict:** CONFIRMED P2.
- **Fix:** compute the numerator from the actual matched **page** count (not grouped rows);
  add a namespaced/starred fixture test.

### E8 — `docs/architecture/filters.md` shows the pre-D8 `HasProperty` shape  `P2` (doc)  (F23 / BER-3)

- **Where:** `docs/architecture/filters.md:24,28-30`.
- **Problem:** the primitive-enum table + value sub-types still list
  `HasProperty { key, op, value }` + `PropertyOp (eq/ne/exists/notExists)`; the shipped
  type is `HasProperty { key, predicate: PropertyPredicate }`. Doc miss in the D27 pass.
- **Verdict:** CONFIRMED P2 (doc).
- **Fix:** update the table + sub-types to `PropertyPredicate`.

---

## P3 — nits / latent / test-efficacy

- **E9 — EXPLAIN tests assert against a SQL copy  (F6b / TER-2).** `explain_query_plan_for`
  (`list_pages_with_metadata_tests.rs:880-905`) EXPLAINs a hand-rebuilt query, not the
  IPC's actual SQL, so a regression in the real query's plan would not be caught. Fix:
  expose the composed SQL from the IPC (test-only accessor) and EXPLAIN that.
- **E10 — parity helper is a textual copy of the recompute  (F6a, downgraded from P1).**
  `materializer/tests.rs` `canonical_counts` duplicates the recompute SQL shape, so a bug
  shared by both copies passes. (Not a pure tautology — it runs the real materializer and
  has adversarial hard-literal asserts.) Fix: derive `canonical_counts` from
  `backlink/grouped.rs`-style first principles, or assert more hard literals.
- **E11 — `Orphan` cost + perf-gate realism  (F3 + F4 / SQLR-5/6 / TER-8).** `cost_hint`
  ranks `Orphan` 0 though its outbound term is a 3-table correlated subquery; no `#[ignore]`
  gate covers a *filtered* query at scale; `most_linked` gate seeds zero links and
  `recently_modified` seeds one op-log row/page. Fix: rerank Orphan (or materialise an
  `outbound_link_count`); add a filtered-query gate; seed realistic skew/op-log depth.
- **E12 — tauri-mock fidelity gaps  (F10a/b/c / TER-3/4/7).** The mock returns
  `total_count` on cursor pages (the D6 null-retention path is e2e-untested), never emits
  `RequiresRefresh:` (`withCursorRecovery` is e2e-untested), and omits the same-page
  inbound exclusion (latent — no seed edge exercises it). Fix: make the mock mirror the
  backend (null total_count on cursor; emit RequiresRefresh on cross-sort cursor; same-page
  exclusion in `pageLinkStats`) + add a same-page seed edge.
- **E13 — count chip text+chips basis skew  (F9 / UXR-8).** With a text query active, the
  numerator is the loaded+text-narrowed set but the denominator is the server filtered
  total. Cosmetic; relates to E7. Fix: share a basis or label it "in loaded".
- **E14 — client re-sort tiebreaker reshuffles ties  (F7 / SQLR-2).** Server keysets ties
  by `id ASC`; the frontend re-sorts loaded rows by a title tiebreak for the server-derived
  sorts, so equal-count groups reshuffle as pages load. No data loss. Fix: tiebreak by id
  client-side too for those modes.
- **E15 — StrictMode double-decrement on delete  (F11) — dev-only.** `setDisplayTotalCount`
  is called inside the `setPages` updater (`PageBrowser.tsx:302-312`), a non-idempotent
  pattern that double-fires under StrictMode (prod fires once; e2e asserts direction). Fix:
  move the decrement out of the updater.
- **E16 — clear-all announces only the first removed chip  (F12).** The SR remove branch
  uses a single `.find()`; clear-all of N chips announces one. Fix: announce a clear-all
  message.
- **E17 — `sortTopLevelUnits` allocates per-comparison  (F13).** `created`/`recent` call
  `collectDescendantPageIds` (walk + alloc) inside the `.sort()` comparator; bounded to ≤50
  loaded rows. Fix: decorate-once (Schwartzian).
- **E18 — `InvalidFilter:` prefix unrecognized frontend  (F5).** Emitted backend-side, no
  FE handler (unlike `RequiresRefresh:` / `InvalidDateFilter:`); falls through to a generic
  toast. Defence-in-depth path; low. Fix: recognise it or accept the generic toast.
- **E19 — popover/zero-result UX nits  (F18/F19/F20).** Clear-all is undocumented in
  `docs/PAGES.md`; only the three boolean facets have popover descriptions (Tag/Path/
  HasProperty/Last-edited/Priority have none); the zero-result state gives no "which chip"
  hint (compounds E1/E5). Fix: doc clear-all; add value-facet descriptions; consider a
  "no pages match these filters" empty-state variant.
- **E20 — dead `export-all` i18n keys in the Pages view  (F22, downgraded to P3).**
  `pageBrowser.exportAll/exporting/exportSuccess/exportFailed` (`pages.ts:137-140`) have
  zero consumers; the working export lives in Settings (`DataSettingsTab.tsx`). Fix: remove
  the dead keys (or wire an export control if desired). NB: the original reviewer mislabeled
  `list_all_pages_in_space` as the export backend — it is the page-listing handler.
- **E21 — recompute comment stale anchors  (F25 / BER-4).** `materializer/handlers.rs:520,529`
  cite `pages.rs:1666-1675` ("mirrors verbatim") which is now the `SqlBind` helper, and the
  "mirrors canonical `grouped.rs`" claim doesn't hold (grouped is single-block-scoped; the
  materialised count is page-wide). Fix: correct the comment to cite migration 0070 +
  `recompute_pages_cache_counts_for_pages` and drop the verbatim/grouped claim.

---

## Refuted / downgraded by the adversarial round (do not re-litigate)

- **REFUTED:** the "Rolling/OlderThan datetime-format" half of E3 (lexical order is
  correct); the native-`<select>` "inconsistency" (explicitly justified for Popover
  focus-scope robustness); "the parity test is a pure tautology" (it runs the real
  materializer + has hard-literal asserts → reduced to E10's shared-shape blind spot).
- **DOWNGRADED:** tooltip-on-touch P2→P3 (the visible "Sorted within loaded pages" text
  carries the signal; only supplementary copy is hover-gated); export-all P2→P3; the
  mock-fidelity items P2→P3 (the backend behaviour itself is unit-tested).
- **Confirmed already covered (no gap):** HasProperty full predicate×value matrix
  end-to-end; optimistic-create-under-filter reload; cost-reorder bind alignment;
  validation-rejection paths; chip dedupe; `aria-activedescendant` rendered-window guard.

---

## Cost / Impact / Risk

- **Cost:** P1 ~1-2 h (E1 wiring + E2 doc) · P2 ~5-8 h (E4 is the only non-trivial one —
  materializer trigger-set + parity test) · P3 ~6-10 h (test-efficacy + mock fidelity are
  the bulk). Total **~12-20 h**, splittable by file boundary.
- **Impact:** E1 (a shipped control that returns nothing) and E3 (silent date-range data
  loss) are the genuine user-facing defects; E4 is latent corruption surfaced by the new
  count consumers; E9/E10/E12 harden the tests/mocks so future regressions don't slip.
- **Risk:** all localized and additive except E4 (materializer hot path — add a parity test
  and watch the 20k gate). No migrations. E1 emits configured priority strings already on
  the wire (no IPC type change).
