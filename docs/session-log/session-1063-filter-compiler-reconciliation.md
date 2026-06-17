# Session 1063 — #1320 filter-compiler reconciliation + #1396 FilterExpr depth guard

2026-06-17. Continuation of session 1062's overnight run. Drove the #1320 filter-compiler
unification: routed the shared FTS primitives through `SearchProjection` so it is the genuine
single compiler, and added the recursion-depth guard the #1280 Phase-0 review asked for.

## Merged

| PR | Issue | Description |
|----|-------|-------------|
| #1399 | #1396 | `FilterExpr::MAX_DEPTH` (50) + a caller-invoked `validate_depth()` pre-validation gate (bounds its own recursion at the top of each frame, so it can't itself overflow); typed `AppError::Validation`. Mirrors the backlink resolver's `compile_backlink_filter` `depth > 50` bound |
| #1400 | #1320 PR-1 | Route the search **Tag** filter through `SearchProjection` — per-tag `IN`-subselect AND-joined, **result-equivalent** to the legacy `COUNT(DISTINCT bt.tag_id) = N` ALL-semantics (DB equivalence test, not a SQL-string snapshot) |
| #1401 | #1320 PR-2 | Route the search **PathGlob** filter through `SearchProjection` with the **GLOB+brace+`[class]`** dialect matching the existing legacy search behavior exactly — zero behavior change. Accepts already-`prepare_globs`-preprocessed input (true drop-in). Pages left on `LIKE` |
| #1402 | #1320 PR-3 | Migrate the last two call sites (`regex_mode_query`, `filter_only_scan` in `toggle_filter.rs`) to the `_via_projection` methods, then **delete** the now-dead `add_tags_all`, `add_page_globs`, `append_page_glob_subselect` (net −139 lines) |

## Notes

- **Reconciliation scope.** A divergence-mapping pass (Plan agent) classified every shared primitive:
  byte-identical (Space — already done PR-0), result-equivalent (Tag), behavior-matching cutover
  (PathGlob — search already ran on GLOB), and wire-breaking (the metadata bundle). Only the first
  three are safe backend-only cutovers; those shipped. The **single chokepoint** is
  `fts/filter_builder.rs` — every cutover touches it, so the PRs were chained, not parallelized.
- **PathGlob was the subtle one.** Both `PagesProjection` and `SearchProjection` used `LIKE`, but the
  *legacy fts* search path used `GLOB`+brace. Routing search through the `LIKE` projection would have
  **regressed** search (losing `[class]`/brace), so PR-2 instead upgraded `SearchProjection::compile_path_glob`
  to the GLOB dialect to match the existing legacy search behavior (zero change), leaving Pages on `LIKE`.
  The load-bearing correctness fact (verified end-to-end by the reviewer): production preprocesses globs
  **once** in `commands::queries::prepare_search_filter`; neither the old nor the new builder re-runs
  `prepare_globs`, so the swap is a true drop-in. Re-preprocessing would have double-substring-wrapped /
  double-lowercased and broken search.
- **Multiplicity.** Brace-expanded globs are OR-joined for include (`IN(?a) OR IN(?b)` ≡ `IN(…?a OR ?b)`,
  union) and AND-joined for exclude (`NOT IN(?a) AND NOT IN(?b)` ≡ `NOT IN(…?a OR ?b)`, difference),
  paren-wrapped so they compose with the surrounding AND-joined builder clauses.
- **Remaining #1320 work** (posted as a plan comment on the issue, left for maintainer review — each
  crosses a behavior/wire line): Pages `LIKE`→`GLOB` (user-visible Pages change); the wire-breaking
  metadata bundle (`HasProperty` valued four-column coercion, multi-value `Priority`, new `State`/
  `DueDate`/`Scheduled` primitives → enum + bindings + `PageBrowser` frontend = #1280 group-B);
  `BacklinkProjection` for the 1122-line resolver; and the additive search `last-edited` wiring.

## Process

- Each PR: build subagent → independent adversarial reviewer (no self-review) → orchestrator
  verification run → commit → push (foreground, serialized) → CI-gate → admin-merge. Reviewers
  re-ran the suites themselves and traced the load-bearing claims (equivalence, bind ordering,
  drop-in preprocessing) against the real call chains.
- One reviewer caught a now-stale comment in `search.rs` ("toggle builders not yet routed") after
  PR-3 routed them; fixed by amend before merge.
