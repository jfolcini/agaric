# Session 1744 — #4639 slice 17: the `agaric-store/fts/` group

Four `#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]`
attributes removed by splitting the functions they sat on. Threshold is 70 code
lines (`src-tauri/clippy.toml`); an unfulfilled `#[expect]` fails the build, so
clippy is the oracle in both directions — split too little and the attribute
stays earned, split enough and removing it is mandatory.

Sites: 41 on `main` before, 37 after.

## The splits

| function | file | before | after | helpers |
|---|---|---|---|---|
| `fts_fetch_post_filtered_page` | `fts/search/post_filter.rs` | 109 | 53 | `scan_post_filtered_windows` (43), `post_filtered_page_from_scan` (32), `struct PostFilterScan` |
| `search_fts_partitioned` | `fts/search/partitioned.rs` | 89 | 70 | `partitions_from_probe_windows` (27) |
| `search_fts` | `fts/search/cursor.rs` | 75 | 52 | `page_from_probe_window` (26) |
| `expand_braces` | `fts/glob_filter.rs` | 84 | 6 | `parse_brace_segments` (45), `expand_segments_within_cap` (35), `enum Segment` hoisted to module scope |

Counts are clippy's own, not a hand tally: they were read out of a build with
`too-many-lines-threshold` temporarily set to 5, then the threshold restored and
`cmp`-verified. A `-p agaric-store --lib` probe is useless for this — it fails to
compile on `tokio::try_join!` because features do not unify — so the probe has to
be a full workspace check.

`PostFilterScan` is forced rather than chosen: five values cross into the loop
helper and four cross back, which as `&mut` parameters would be nine arguments
and trip `clippy::too_many_arguments` (threshold 7). `enum Segment` is likewise
forced out of the function body by `parse_brace_segments` returning
`Vec<Segment>`; it stays private, so it does not escape the module or reach
rustdoc.

`search_fts_partitioned` lands at exactly 70 — passing, with zero headroom. The
residue is ~27 lines of three unavoidable guard blocks and ~48 lines of two
16-argument `fts_fetch_rows` call expressions that are mostly argument names and
`#346`/`#2200` rationale comments. There is no logic left to extract; the only
further cut is a `FtsPartitionedScan::empty()` for the two identical early
returns, which is deduplication and therefore deferred. Zero headroom is the
mechanism working as designed: the next line added to that function reds the
build and forces the split then.

## Pure move, proven mechanically

The contract for these slices is that every SQL literal, bind, ORDER, log line,
error string, `.await` point and early return comes through byte-identical and
in the same order. Both the builder and the review extracted the string-literal
multiset per file and diffed it; the review did not reuse the builder's
extractor but wrote a second lexer and self-tested it on a fixture carrying
nested block comments, raw and byte strings, escapes, `'a` lifetimes, and
`"// not a comment"` decoys.

Result, all four files: exactly one literal removed each — the `#[expect]`
reason string — and everything else identical in both multiset and source
order. Char-literal multisets also identical (22/22 in `glob_filter.rs`). Counts
83→82, 5→4, 3→2, 2→1.

Chunk-by-chunk body identity was checked by `diff -u` against
`git show main:<file>`. The `post_filter.rs` page assembly, the `cursor.rs`
tail, the `partitioned.rs` body and both `glob_filter.rs` chunks are
**byte-identical with zero normalization**; the `post_filter.rs` window loop
differs only by the `scan.` field prefix and two `&`-borrow removals.

Control flow across the new boundaries: `return` 4→4, `break` 5→5,
`continue` 0→0 in `post_filter.rs`; 10/6/2 unchanged in `glob_filter.rs`. `?`
rises by exactly one per split that introduced a fallible helper call. The one
early `return` that crossed a boundary — the unbalanced-brace
`AppError::validation_coded` now inside `parse_brace_segments` — is reached
through `parse_brace_segments(input)?`, so it still returns `Err` from
`expand_braces` to the same caller.

No SQL text changed, so no `just gen-sqlx` and no `.sqlx` churn. Confirmed
directly: the literal dumps are exhaustive for these files and contain zero SQL,
and `grep -nE 'query(_as|_scalar|_file)?!'` finds no compile-time SQL macros in
any of the four.

## The one thing this slice did not just move

Review's mutation pass killed two seams and left two alive. One survivor is a
pre-existing gap (below). The other was created by this change, so it is fixed
here rather than deferred:

`partitions_from_probe_windows` takes `(pages_rows, page_limit, blocks_rows,
block_limit)` — two same-typed pairs with no compiler check between them. On
`main` those were adjacent locals inside one function; extracting them turns a
transposition into a silent cross-wiring. Every existing partitioned test passes
**equal** limits, where a swap is invisible, so a mutant measuring
`blocks_has_more` against `page_limit` survived all 1442 store tests and a
39-test workspace selector.

`partition_has_more_is_measured_against_each_partitions_own_limit` pins it with
asymmetric limits: 2 matching pages and 1 matching content block, `page_limit`
1, `block_limit` 3. The pages partition holds 2 rows against a limit of 1
(`has_more`); the blocks partition is unrestricted, so it holds both pages plus
the content row, 3 against 3 (not `has_more`).

Both arms are pinned deliberately — pinning one arm of a symmetric pair and
leaving the other open is the half-covered-pair shape AGENTS.md names as fake
coverage. Falsified in both directions against a copy, restored with `cmp`:

| mutant | result |
|---|---|
| `blocks_has_more` measured against `page_limit` | **killed** — "3 block rows against block_limit 3 must not report has_more" |
| `pages_has_more` measured against `block_limit` | **killed** — "2 page rows against page_limit 1 must report has_more" |

The call site was correct before this test and still is; what was missing was
anything that would notice if it stopped being.

## Verification

- Full suite: `6322 tests run: 6322 passed (3 slow), 13 skipped`
- Doc-tests `--doc --workspace`: all seven targets ok
- Workspace clippy `--all-targets -- -D warnings`: zero warnings
- After the added test: `agaric-store` 1443/1443, clippy clean
- Other mutants killed by the existing estate: cursor advance in
  `scan_post_filtered_windows`, the `EXPANSION_CAP` boundary in
  `expand_segments_within_cap`, and `truncated_by_window_cap` in
  `post_filtered_page_from_scan`

`git grep 'clippy::too_many_lines'` across `src-tauri/**/*.rs`: 68 attribute
lines on `main`, 64 now, and the per-file diff shows the delta is exactly the
four claimed removals with nothing added anywhere.

## Deferred to the notes batch

- **Triple-duplicated guard prelude.** `search_fts`, `search_fts_partitioned`
  and `fts_fetch_post_filtered_page` each carry the same three guards — empty
  query, `MAX_QUERY_LEN` with a byte-identical "search query is too long"
  message, empty-after-sanitise — and each spells its empty short-circuit twice
  in-function. That is ~22 code lines of budget in each. It is the obvious next
  seam if any of the three needs to grow, and it is precisely what pure-move
  forbids touching here.
- **Stale deixis in two moved comments.** `post_filter.rs:149` says "the window
  loop below" and `:215` says "assembled once above"; both now point across a
  function boundary. Still substantively true, only the locator words are
  wrong — nothing describes deleted code, so the rule forcing a fix now does not
  bite.
- **Pre-existing coverage gap, #1556 window-cap resume rank.** A mutant zeroing
  the resume rank in `post_filtered_page_from_scan` survives the whole crate:
  `be_a10_post_filter_max_windows_bound_stops_without_hanging` asserts only that
  `next_cursor.is_some()` and never pages through it. A user scrolling past the
  1000-candidate ceiling in a case-sensitive or regex search would get a page
  resuming from the wrong rank — duplicates or dropped results. Byte-identical
  to `main`, so not this PR's to fix, but it is a real hole and the fix is one
  assertion feeding `next_cursor` back.
