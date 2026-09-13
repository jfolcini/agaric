# Session 1749 — one guard prelude instead of three

`search_fts`, `search_fts_partitioned` and `fts_fetch_post_filtered_page` each
opened with the same three guards: blank query, over-long query, query that
sanitises away to nothing. Three copies of ~22 lines, differing only in the
empty value each returns.

## Why now

`search_fts_partitioned` sat at **exactly the ceiling** — clippy's own count,
`70/70`, with `too-many-lines-threshold = 70`. Not near it: on it. The next line
anyone added to that function would have turned CI red, and the reviewer's
choices would have been to split it under pressure or to reach for
`#[expect(clippy::too_many_lines)]`, which #4639 exists to retire. The prelude
was the obvious seam, and it was the seam three times over.

Measured with the threshold temporarily dropped to 20 so clippy prints its own
line count for every function, before and after:

| function | before | after |
|---|---|---|
| `search_fts` | 52 | 37 |
| `search_fts_partitioned` | **70** | 55 |
| `fts_fetch_post_filtered_page` | 53 | 38 |

## The shape

`prepare_match_expression(query) -> Result<Option<String>, AppError>` in
`sanitizer.rs`, whose module already existed to turn a raw query into a safe
MATCH expression. `None` means "nothing to run"; each caller keeps its own
`let ... else` returning its own empty value, because the three empty values are
three different types (`PageResponse`, `FtsPartitionedScan`, `PageResponse`) and
no common one is worth inventing.

The blank-query guard reads redundant with the sanitised-empty check — a blank
query sanitises to `""` either way — and it is not: the length cap sits between
them, so deleting it would turn a blank query longer than `MAX_QUERY_LEN` from
an empty page into a validation error. That is now a comment on the guard, so a
future "prefer deleting" pass finds the reason before the behaviour change.

## Falsification

Against a copy (`cp` to the scratchpad, mutate, run, restore, `cmp`):

| mutant | result |
|---|---|
| drop the `MAX_QUERY_LEN` guard | **killed** — `fts_over_long_query_is_rejected` |
| return `Ok(Some(sanitized))`, skipping the empty short-circuit | **killed** — `search_fts5_operators_are_sanitized`, `search_special_fts5_characters_no_crash`, `search_sub_trigram_query_returns_empty` |

`sanitizer.rs` was confirmed byte-identical to its pre-mutation copy afterwards,
so no stub survived the run (#4287, #4018, #4204).

Each caller's `else` branch is the old return body moved verbatim, so whatever
covered it before covers it now; the mutants above exercise the shared half.

## A measurement trap worth recording

`cargo clippy -p agaric-store --lib` does **not** compile: the `tokio/macros`
feature reaches `agaric-store` through feature unification, so `tokio::select!`
and `tokio::try_join!` fail to resolve and clippy emits five `E0433`s and zero
lints. Piped through a `grep` for warnings that reads as "clean". Every
line-count reading here used `--all-targets`, which pulls the feature in via
dev-dependencies. This is the same family as AGENTS.md's warning that `-p` does
not compile dependents: `-p` narrows features too, and a narrowed `-p` build can
fail in a way that looks like a passing lint run.

Clippy also does not re-run on a `clippy.toml` change alone — Cargo does not
track it as a build input — so every threshold sweep here `touch`ed the sources
first.

## Verification

- `cargo nextest run --workspace` — the change is production code in a crate with
  dependents, so `-p` would have proved nothing about them (AGENTS.md, #3443)
- `cargo clippy -p agaric-store --all-targets -- -D warnings`: clean
- Builds used `CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0` (session 1747)
