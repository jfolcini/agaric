# Session 1750 — #4639 slice 18: the five tractable agaric-store sites

Five `#[expect(clippy::too_many_lines)]` retired. Workspace count 37 → 32.

| function | before | after |
|---|---|---|
| `block_descendants::rederive_page_and_space_ids` | 72 | 53 |
| `recurrence_math::project_block_dates` | 75 | 61 |
| `tag_inheritance::incremental::remove_inherited_tag` | 99 | 11 |
| `tag_query::resolve::resolve_tag_prefix_leaves` | 103 | 17 |
| `pagination::history::list_page_history` | 103 | 7 |

Counts are clippy's own, read by dropping `too-many-lines-threshold` below the
figure of interest (20 for the before-counts, 5 for the three after-counts that
fell under that) with the `#[expect]`s stripped, so the lint prints `(N/…)` for
the silenced functions too — otherwise an `#[expect]` hides the very number you
need to size the split against.

## The seams

Four of the five were sequences of independent statements wearing one name, and
the split just gives each step the name it already had in a comment:

- **`remove_inherited_tag`** ran four SQL statements labelled "Step 1..4" in
  comments. Steps 2-4 became `reseed_from_subtree_taggers`,
  `reseed_descendants_from_outer_ancestors` and `reseed_block_itself`; what is
  left is the delete plus three named calls, and the sequence is now readable
  without scrolling past 80 lines of CTE.
- **`list_page_history`** was an `if page_id == "__all__"` over two queries that
  share a cursor shape and nothing else — different predicates, different binds,
  and `space_id` only ever reaching the global one. It is now a four-line
  dispatcher over `list_global_history` / `list_single_page_history`, and each
  branch's EQP note sits with the query it measured.
- **`resolve_tag_prefix_leaves`** was a 2×2 of near-identical queries (escaped
  vs plain `LIKE`, inherited arm or not), 100 lines deep. The four queries are
  named now and the matrix fits in the dispatcher. The duplication itself
  **stays**: the escaped/plain split is the #1891 LIKE→range optimisation, not
  an accident, and `query_scalar!` needs literal SQL, so there is nothing to
  collapse.
- **`rederive_page_and_space_ids`** gave up its opening three reads —
  "what page does the root belong to now, and is it itself a page" — as
  `root_page_context`.

The extracted SQL literals were re-indented to their new nesting depth, and no
`.sqlx/` cache moved.

I had this backwards first time and shipped the wrong reason in the first push:
I assumed sqlx's prepare cache is keyed on the literal's source text, so I left
every continuation line at its old column to avoid a cache regeneration. It is
not. Rust's `\`-newline escape strips the newline **and** the leading
whitespace of the next line, so source indentation never reaches the string:

```rust
let a = "SELECT x \
         FROM t";
let b = "SELECT x \
     FROM t";
assert_eq!(a, b);   // both are "SELECT x FROM t"
```

The cache agrees — `query-cb4b829b…json` stores that query single-spaced. And
the first push was its own counter-example: it moved all four literals to a
different relative indent and the drift guard passed, which I read as "I
preserved the bytes" when it actually meant "the bytes never depended on the
indent". A guard passing is evidence about the guard's subject, not about
whichever theory you happened to be holding.

`rustfmt` does not reformat inside a macro invocation it cannot parse, which is
why the moved `query_as!` body kept its old column and had to be shifted by
hand; a `query!` body will never re-indent itself after a move.

## The one change that is not a pure move

`project_block_dates` needed only 5 lines, and the `++` catch-up loop was the
honest place to find them. Extracting it as `catch_up_past_today` also
*rewrote* it: the `caught_up` flag and its two `break`s became `?` and an early
`return Some(c)`. Same three outcomes, but a rewrite is exactly where a
refactor stops being a refactor, so both failure arms were falsified
separately rather than argued:

| mutant | result |
|---|---|
| fallthrough `None` → `Some(c)` (budget exhausted) | **killed** — `projection_plus_plus_cap_exhaustion_emits_no_stale_date` |
| `shift_date_once(..)?` → `else { return Some(c) }` (single-step overflow) | **killed** — `projection_plus_plus_overflow_emits_no_stale_date` |

Each mutant killed exactly one test and left the other passing, which is the
point: the two arms are a symmetric pair, and one mutant covering both would
have hidden a half-covered pair. `projection_plus_plus_caught_up_still_emits`
stayed green through both, so neither mutant merely broke the happy path.

Those three tests live in the **app crate** (`src-tauri/src/recurrence/tests.rs`),
not in `agaric-store` — so `-p agaric-store` would have run none of them and
reported this rewrite as fully covered. Falsification used
`cargo nextest run --workspace -E 'test(projection_plus_plus)'`.

`recurrence_math.rs` was confirmed byte-identical to its pre-mutation copy
afterwards (#4287, #4018, #4204).

Everything else is a verbatim move: the statements, their comments and their
SQL are unchanged, so their existing coverage carries over untouched.

## Verification

- `cargo nextest run --workspace`
- `cargo clippy -p agaric-store --all-targets`: no warnings — which is itself
  the proof that all five `#[expect]`s were safe to remove, since an unfulfilled
  `#[expect]` warns and a still-oversized function warns
- Builds used `CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0` (session 1747)

## Left for slice 19

The three remaining `agaric-store` sites are each a PR's worth on their own:
`query::engine::compile_and_run` (217 lines), `query::engine::run_grouped`
(228) and `pagination::properties::query_by_property` (147).
