# PEND-71 — Search backend test coverage matrix

> Surfaced by the 2026-05-19 backend audit (round 2). The existing `src-tauri/src/fts/tests.rs` suite covers happy paths thoroughly, but four categories of stress / edge-case tests are missing. They're independently small (~50-100 LOC each) and unblock confidence in the PEND-69 / PEND-70 refactors.

## TL;DR

Add four test categories to `src-tauri/src/fts/tests.rs`:

1. **Concurrent IPC.** `tokio::join!` 5 `search_blocks_partitioned` calls against the same pool; assert pool fairness and no deadlock.
2. **Pathological queries.** Long queries (100 KB sanitized), all-stopword queries (post-sanitize-empty path), 12-parameter combinatorial filter worst cases.
3. **Empty / giant space.** Zero-page space partitioned-scan smoke test; 10k-block fixture wall-time bound.
4. **Boolean + toggles combinations.** `case_sensitive + "foo OR bar"`, `whole_word + "foo AND bar"`, `regex + "foo|bar"` — verify sanitizer and post-FTS filter compose correctly.

## Current state — verified

- `src-tauri/src/fts/tests.rs` covers: happy-path partitioned search, partition isolation, caps, has_more, empty query, filter compatibility, cursor-pagination boundary, regex error mapping.
- Missing: concurrent execution, pathological inputs, scale stress, boolean-operator + toggle combinatorial paths.
- The seed helper `seed_partitioned_fixture` (`fts/tests.rs:4152`) is small-scale (a handful of rows).

## Design

### Concurrent IPC tests

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_partitioned_searches_do_not_deadlock_or_starve() {
    let pool = test_pool().await;
    seed_partitioned_fixture(&pool).await;
    let futs = (0..5).map(|i| {
        let pool = pool.clone();
        async move {
            search_blocks_partitioned_inner(
                &pool, format!("query{i}"), 8, 40, default_filter(),
            ).await
        }
    });
    let results: Vec<_> = tokio::time::timeout(
        Duration::from_secs(5),
        futures::future::join_all(futs),
    ).await.expect("no deadlock within 5s");
    for r in results { assert!(r.is_ok()); }
}
```

Plus a starvation-bound test: queue 10 read tasks against the 4-conn pool, assert tail latency stays under 500 ms.

### Pathological-query tests

- **Long query:** 100 KB query of `"a a a a …"`. After sanitization the trigram filter should reduce it to `MATCH ""` (or empty); assert short-circuit to empty results without SQLite errors.
- **All-stopword:** Currently FTS5 strips stopwords pre-tokenize. Verify behavior with a sanitizer-internal stopword list (if any) and assert empty result.
- **Combinatorial filters:** Build a filter with all 12 fields populated (`includePageGlobs`, `excludePageGlobs`, `caseSensitive`, `wholeWord`, `isRegex`, `stateFilter`, `priorityFilter`, `dueFilter`, `scheduledFilter`, `propertyFilters`, `excludedPropertyFilters`, `excludedStateFilter`, `excludedPriorityFilter`). Assert all clauses build and the query executes.

### Scale tests

- **Empty space:** Space with zero pages / zero blocks. Assert `result.pages.items == []`, `result.blocks.items == []`, `has_more == false`, no errors.
- **Giant space:** 10k-block fixture (`seed_giant_fixture` helper). Assert search completes within bounded wall time on a CI runner — generous bound (e.g. 1 s) to absorb runner variance; primarily catches accidental N+1.

### Boolean + toggle tests

- `case_sensitive=true + "Foo OR Bar"` — assert post-FTS filter keeps exact-case matches; sanitizer preserved `OR`.
- `whole_word=true + "foo AND bar"` — assert `OR` boundary semantics across two terms.
- `regex=true + "(foo|bar).*baz"` — assert the regex matches both alternations; post-FTS regex filter runs over `LIMIT 1000` window.
- Edge: `regex=true + invalid pattern` — assert `AppError::Validation("InvalidRegex: …")` mapped at `toggle_filter.rs:331-343`.

## Tests checklist

- [ ] `concurrent_partitioned_searches_do_not_deadlock_or_starve`
- [ ] `concurrent_pool_starvation_bound_500ms`
- [ ] `partitioned_long_query_returns_empty_via_short_circuit`
- [ ] `partitioned_all_filters_populated_executes_cleanly`
- [ ] `partitioned_empty_space_returns_empty_partitions`
- [ ] `partitioned_giant_space_completes_within_1s`
- [ ] `partitioned_case_sensitive_with_OR_preserves_case`
- [ ] `partitioned_whole_word_with_AND_combines_terms`
- [ ] `partitioned_regex_alternation_matches_both`
- [ ] `partitioned_regex_invalid_pattern_returns_validation_error`

## Acceptance criteria

- All new tests pass via `cargo nextest run`.
- Tests respect AGENTS.md patterns (`#[tokio::test(flavor = "multi_thread", ...)]` for concurrency-sensitive paths; `test_pool()` + TempDir for isolation).
- Wall-clock bound on giant-space test is generous enough that CI runner variance doesn't cause flakes (allow 3x the local-dev measurement).
- No reliance on the sleep-loop / polling antipatterns called out in AGENTS.md.

## Open questions

1. **CI wall-clock budget for the giant-space test.** Local-dev measurement on a warm cache might be ~50 ms; CI runner under load can easily 10x that. **Recommendation:** measure on the slowest CI runner observed, then 3x that for the assertion threshold. Don't pick a number without measurement (see project memory note "Measure, don't imagine").
2. **Should the concurrent-IPC starvation test cap at 5 readers or simulate the worst case (`max_connections + N`)?** The read pool is `max_connections(4)`. **Recommendation:** 5 readers — saturates the pool by 1, simulates real "fast typist while another surface is open" pattern. Pure stress at N >> 4 belongs in a benchmark, not a unit test.
3. **Pathological queries: should the assertion be "completes without error" or "completes in bounded time"?** The latter is more useful but flake-prone on CI. **Recommendation:** start with "completes without error within a generous timeout (5 s)"; tighten in a follow-up if a benchmark harness lands.

## Out of scope

- Test coverage for write-path search (none exists today by design — search is read-only).
- Performance regression tracking infrastructure (would need a separate benchmark harness; out of scope for unit tests).

## Cost / impact

- **Cost:** S-M (~4-6 h). Mostly mechanical test additions; no new test fixtures beyond the giant-space seed helper.
- **Impact:** Catches regressions from PEND-69 refactor; documents expected behavior under stress; bounds future surprises.
- **Risk:** Low. Pure test additions; no production code changes.

## Related

- PEND-69 — pages partition correctness; this PEND validates the refactor doesn't regress.
- PEND-70 — server-side cancellation; this PEND covers the concurrent-IPC dimension.
- `src-tauri/src/fts/tests.rs`, `src-tauri/src/fts/search.rs`
