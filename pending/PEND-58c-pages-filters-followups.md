# PEND-58c — Pages compound filters: deferred follow-ups

> Residual work deliberately deferred out of **PEND-58b** (Session 809, PR #48).
> PEND-58b fixed every *confirmed* review finding; the items below are the ones
> PEND-58b's scope explicitly punted (P1-H option 2; the separate e2e pass), plus
> one minor perf redundancy introduced by the `total_count` fix and one pre-existing
> nit. **None block release.**

## Items

### C1 — `total_count` recomputed on every load-more page  `LOW / perf`

- **Where:** `src-tauri/src/commands/pages.rs` — `list_pages_with_metadata_inner`.
- **What:** the `COUNT(*)` runs on every fetch, including cursor (load-more) pages,
  even though the total cannot change across pages of one filter set. Introduced by
  PEND-58b P1-D (mirrors the legacy count-alongside-fetch pattern; index-served and
  within the 20k perf-gate headroom, so harmless today).
- **Fix:** gate the count on `cursor.is_none()` (compute only on the first page) and
  have the frontend retain the first total across load-more. Saves one aggregate scan
  per page beyond the first.

### C2 — Add UI controls for path-exclude + property `ne`/`notExists`  `MEDIUM / feature`

- **Where:** `src/components/PageBrowser/AddFilterPopover.tsx` (path + property editors);
  the summary formatter already supports these in
  `src/components/PageBrowser/PageBrowserFilterRow.tsx` (annotated "reserved for
  Search / saved-views").
- **What:** PEND-58b P1-H took **option 1** (scope docs + annotate the render-only
  branches). The filter engine + summary support path **exclude** and property
  **not-equals** / **not-exists**, but the Pages popover cannot create them.
- **Fix (P1-H option 2):** an exclude toggle in the path editor; an op selector
  (`= / ≠ / exists / not-exists`) in the property editor. Drop the "reserved"
  annotations once the branches are reachable; extend `docs/PAGES.md` accordingly.

### C3 — Implement the `Ref`-valued / `Ne` `HasProperty` SQL  `LOW / feature`

- **Where:** `src-tauri/src/filters/primitive.rs` — `compile_has_property`.
- **What:** PEND-58b P2-A made `HasProperty { op: Eq|Ne, value: Some(Ref) }` and
  `{ op, value: None }` return `AppError::Validation` instead of a silent
  `1=0 /* UNSUPPORTED */`. Correct and safe, but the actual `value_ref` comparison is
  still unimplemented (unreachable from the current UI; needed if C2 lands the op
  selector, or for saved views).
- **Fix:** implement the `Ref` branch via `value_ref`; add backend tests; remove the
  corresponding validation rejection for the now-supported shapes.

### C4 — PEND-58b e2e-strengthening pass  `MEDIUM / test`

- **Where:** `e2e/pages-filter.spec.ts`.
- **What:** the PEND-58b plan called for a separate e2e pass beyond the P0-D/P0-E
  virtualization + pagination specs already in the branch.
- **Fix:** add e2e for (a) the orphan-grooming flow (add Orphan + a Last-edited
  bucket, assert the list narrows), (b) the chip-only zero-result no-match state and
  recovery (remove the chip to widen), (c) the default-on path, and (d) the `'false'`
  opt-out path.

### C5 — `summaryProperty` redundant ternary  `NIT`

- **Where:** `src/components/PageBrowser/PageBrowserFilterRow.tsx` — `hasPropertySummary`.
- **What:** `filter.value?.type === 'Text' ? filter.value.value : (filter.value?.value ?? '')`
  simplifies to `filter.value?.value ?? ''` (both `PropertyValue` arms expose `.value`).
  Pre-existing (Phase 3+4); left untouched in PEND-58b to keep the diff surgical.

## Cost / Risk

- **Cost:** C1 ~30 min · C2 ~3-4 h · C3 ~1-2 h · C4 ~2-3 h · C5 ~5 min. Total **~7-10 h**.
- **Risk:** low. C1 is a guard + frontend state retention; C2/C3 are additive UI + SQL
  behind existing render paths; C4 is test-only; C5 is a one-line simplification.
  **No migrations, no IPC signature changes.**
