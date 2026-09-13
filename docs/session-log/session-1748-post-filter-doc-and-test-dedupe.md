# Session 1748 — the doc that contradicted the contract

Both non-blocking notes from #5016's review. One of them is not cosmetic.

## `POST_FILTER_MAX_WINDOWS` documented the behaviour #1556 removed

Its doc comment said that when the window ceiling is hit we "stop scanning and
report `has_more = false` (best-effort: matches beyond the window are not
surfaced)". That is the pre-#1556 contract. #1556 replaced it: the scan stops,
but the FTS source is still live, so the page reports `has_more = true` and
carries a cursor that resumes past the ceiling.

#5016 pinned that behaviour with a test. So as of that merge the doc comment on
the constant asserted the exact opposite of what the suite enforces one file
away — the worst state for a comment to be in, because it reads as authoritative
and is wrong in the direction a reader would act on (concluding results are
exhausted when they are not). Corrected, and it now names the test that holds
the contract, so the next person to change one finds the other.

## The test's duplicated 12-argument call

`be_a10_post_filter_max_windows_bound_stops_without_hanging` invoked
`search_with_toggles` twice with twelve arguments, identical except the
`PageRequest`. A `search_page` closure binds the eleven fixed terms once; both
pages are now one line each, and the thing that actually differs between them is
visible instead of buried.

## Verification

A refactor of a test is exactly where a test quietly stops being able to fail, so
the mutant from #5016 was re-injected against the **refactored** test rather than
assumed still dead:

| mutant | result |
|---|---|
| `truncated_by_window_cap` cursor built with rank `0.0` | **killed** — same assertion, same `left: 0, right: 1` |

Then restored, with `post_filter.rs`'s diff against `HEAD` confirmed to be the
doc comment and nothing else.

- `cargo nextest run -p agaric-store`: `1443 tests run: 1443 passed, 3 skipped`
- `cargo clippy -p agaric-store --all-targets -- -D warnings`: clean
- `cargo test --doc -p agaric-store`: `4 passed; 0 failed; 2 ignored` — run
  because a doc comment changed, where a broken intra-doc link fails and
  `nextest` would not have caught it

Scoped to `-p agaric-store`: the only production change is comment text, and the
rest is test-internal, so there is no consumer to break. The full workspace run
is CI's. Builds used `CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0` for
the disk reasons recorded in session 1747.
