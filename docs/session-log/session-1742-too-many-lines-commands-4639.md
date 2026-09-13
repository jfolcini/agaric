# Session 1742 — the command-module splits (#4639)

Refs #4639, sixteenth slice: the six `#[expect(clippy::too_many_lines)]` sites
in `src-tauri/src/commands/`. All six are gone. The sweep total drops 47 → 41.

Everything here is a pure move. No SQL text, bind order, log line, error
string, `AppError` variant, tracing field, early return or await point
changed. The string-literal multiset of each of the three files is unchanged
except for the six deleted `expect` reason strings.

## Keeping the single and batch property paths apart

`properties.rs` holds both sides of a divergence
`scripts/bulk-equivalence-baseline.json` records as an `exception`: the
single-row `set_todo_state_inner` DOES run recurrence expansion and the
`created_at`/`completed_at` transitions, and the batch paths deliberately do
not; the batch `set_property_batch_inner` DOES enforce a key allowlist the
single path does not. Splitting both roots in one file is exactly how those
two decisions get silently merged, so:

- **No extracted helper is called from both a single and a batch root.**
  Every one of the four new helpers in `properties.rs` has exactly one caller
  and its name says which root it belongs to.
- `write_todo_timestamp_transitions_in_tx` carries the timestamp match that
  the batch paths skip. Its doc comment names both batch inners and says that
  calling it from either would undo the recorded product decision. It is
  private to the module and unreferenced anywhere else.
- `validate_set_property_batch_value_shape` and
  `validate_set_property_batch_text_key` are named for the batch command they
  came out of. Neither is wired into `set_todo_state_inner`,
  `set_priority_inner`, `set_due_date_inner` or `set_scheduled_date_inner`,
  whose own equivalents keep their own per-key wording.

**What is genuinely shared today, and stayed shared, untouched:**

- `validate_reserved_property_value` — the `property_definitions`-missing
  fallback predicate. Called by `set_todo_state_inner`, `set_priority_inner`,
  `set_todo_state_batch_inner` and (now via the new batch helper)
  `set_property_batch_inner`, exactly as at HEAD.
- `warn_if_batch_skips_recurrence` — #3264's shared probe, called by both
  batch inners. Untouched; it is what tells a user about the divergence.
- `crate::commands::blocks::set_property_in_tx` — the per-row write kernel all
  four paths already call.
- `crate::commands::ensure_batch_within_cap` and the
  `SET_PROPERTY_BATCH_ALLOWED_KEYS` guard, both left where they were.

Nothing new was folded into that shared set, and nothing was taken out of it.

## What moved

### `properties.rs`

- `set_todo_state_inner` 139 → 67. The `match (prev_state, new_state)`
  timestamp block became `write_todo_timestamp_transitions_in_tx` (66). It
  takes `&mut CommandTx` and appends to it; **the caller still owns the
  commit** — `tx.commit_and_dispatch(materializer)` stays in the root, and the
  recurrence call after it is unmoved. The `_in_tx` suffix and the `write_`
  prefix are both load-bearing: it writes.
- `set_property_batch_inner` 93 → 60, via
  `validate_set_property_batch_value_shape` (22, pure) and
  `validate_set_property_batch_text_key` (14, one SELECT on the caller's tx).
  The allowlist guard, the empty/cap checks, the tx open, the #3264 warn call,
  the `alive` membership query and the write loop all stay in the root in
  their original order.

Why the timestamp match went out as ONE helper and not four per-arm helpers:
each arm carries its own `"created_at"` / `"completed_at"` literal, twice
over. Folding the two "set `created_at`" arms into a parameterised helper
would drop a literal from the file's multiset — the exact fold this sweep
forbids — and four one-call helpers to avoid it is the gold-plating
AGENTS.md § How we work rules out. One helper at 66 fits.

### `drafts.rs`

`flush_all_drafts_inner` is by design "the body of `flush_draft_inner` looped",
so the two carry duplicate guards at HEAD. That duplication is not this
slice's to delete: each function got its OWN helper, cut where the two paths
genuinely diverge, and the duplicated supersession SELECT still appears twice
in the file.

- `flush_draft_inner` 73 → 67, via `ensure_draft_within_max_content_length`
  (8). Chosen because this is precisely where the two paths differ: the
  single path returns `AppError::Validation` and rolls back with the row
  intact; the batch path `warn!`s and skips (#3262). A shared helper here
  would be wrong, not merely redundant.
- `flush_all_drafts_inner` 83 → 60, via `resolve_or_drop_orphan_draft_in_tx`
  (17) and `drop_superseded_draft_in_tx` (25) — the loop's H-12a and #2651
  guards. Both take `&mut sqlx::Transaction`, both delete on the caller's tx
  and log under the `flush_all_drafts:` prefix, and both leave the `flushed`
  counter and the single `commit_and_dispatch` to the caller. `drop_` and
  `_in_tx` in the names because they DELETE a `block_drafts` row.
- `drop_superseded_draft_in_tx`'s `SELECT COUNT(*) FROM op_log …` literal
  keeps its ORIGINAL interior indentation, over-indented relative to its new
  nesting. Re-flowing the `\`-continuations would leave a byte-different
  literal in the multiset for no behaviour change; the compiler strips the
  continuation whitespace either way.

### `agenda.rs`

`list_projected_agenda_inner_with_today` 177 → 50:

- `parse_projected_agenda_query` (33) — date-format validation, cursor decode,
  limit validation, range parse and the `start <= end` check, returning
  `ProjectedAgendaQuery`. **Invariant #10 holds inside it**: an out-of-range
  limit is still `AppError::Validation` with the identical message, never a
  clamp.
- `read_projected_agenda_horizon` (18) — the `projected_agenda_horizon` read
  plus `cache_covers_range` and `rebuild_today`, returning
  `ProjectedAgendaHorizon`. The `// dynamic-sql:` marker moved with the
  statement it annotates.
- `projected_agenda_cursor_binds` (17) → `ProjectedAgendaCursorBinds`.
- `fetch_cached_projected_agenda` (36) — the keyset page query.
- `cached_rows_to_projected_page` (43) — row decode plus `has_more`, the
  truncate and the next-cursor mint.

Both `return list_projected_agenda_on_the_fly(…)` sites — the #3260 route
guard and the #3160 empty-window fallback — stay inline and verbatim in the
root, in their original order and with their comments. They are two different
routing decisions that happen to share a call expression; collapsing them into
one delegate would have saved 20 lines and hidden the fork.

`list_projected_agenda_on_the_fly` 173 → 47:

- `fetch_repeating_blocks` (39) — `range_end_str` plus the `query_as!`
  prefilter, binds in the original `?1 space_id`, `?2 range_end_str` order.
- `try_insert_projected_entry` (23) — the former `try_insert` closure, now a
  free function taking `&ProjectedPageBounds`.
- `validate_projection_source` (12) — the former `validate_source` closure;
  `block_id = %block.id` became `block_id = %block_id` on a `&str` parameter.
- `project_repeating_block_into_map` (58) — the whole `for block in &rows`
  body.

`cached_rows_to_projected_page` covers the cache path's page assembly while
`list_projected_agenda_on_the_fly` keeps its own identical `has_more` /
next-cursor tail inline. That is deliberate: the helper is keyed to the cache
path by its INPUT type (`Vec<CachedProjectedAgendaRow>`), the projector builds
its page out of a `BTreeMap` it filled itself, and folding the two tails into
one parameterised builder would drop the second
`expect("has_more implies non-empty")` from the file's literal multiset.

## Structs introduced, and why not tuples

Six, all private, all in the file that uses them. Each exists because its
fields are same-typed and a positional swap would compile:

| struct | fields | the swap it prevents |
|---|---|---|
| `ProjectedAgendaQuery` | `after`, `limit_i64: i64`, `cap: usize`, `range_start: NaiveDate`, `range_end: NaiveDate` | start/end of the range; limit/cap |
| `ProjectedAgendaHorizon` | `cache_covers_range: bool`, `rebuild_today: Option<NaiveDate>` | not same-typed — a struct anyway so the two ends of the #2601/#3160 guarantee stay named at the call site |
| `ProjectedAgendaCursorBinds<'a>` | `flag`, `date: &'a str`, `id: &'a str`, `source` | `date`/`id` are `?4`/`?5` of the keyset; a swap silently changes which page you get |
| `ProjectedPageBounds<'a>` | `cursor_key`, `max_entries: usize` | keeps the page's two bounds together through the projection loop |
| `ProjectionWindow` | `today`, `range_start`, `range_end`, all `NaiveDate` | three same-typed dates threaded into `project_block_dates` |
| `CachedProjectedAgendaRow` (type alias) | the 14-column positional row | not a swap guard — it names the tuple so the query helper and its caller share one spelling |

`CachedProjectedAgendaRow` carries the `#[allow(clippy::type_complexity)]`
that sat on the `let cached: Vec<(…)>` statement at HEAD. That attribute was
MOVED, not added; no `#[allow]` or `#[expect]` is new in this slice. The
`#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]` on the
`remaining` binding moved with its own `let` statement into
`project_repeating_block_into_map`.

## Transaction boundaries

None moved. Every `CommandTx::begin_immediate` and every
`commit_and_dispatch` / `commit_without_dispatch` stays in the root that owned
it, at the same point in the sequence. Four helpers take a live transaction
(`write_todo_timestamp_transitions_in_tx`,
`validate_set_property_batch_text_key`, `resolve_or_drop_orphan_draft_in_tx`,
`drop_superseded_draft_in_tx`); all four take it by `&mut` and none of them
commits. No `append_local_op` call moved relative to any other.

## SQL bind sequences moved

Three, each checked against HEAD positionally:

1. `fetch_cached_projected_agenda` — `start_date`(?1), `end_date`(?2),
   `cursor.flag`(?3), `cursor.date`(?4), `cursor.id`(?5), `fetch_limit`(?6),
   `space_id`(?7), `cursor.source`(?8). Same eight `.bind(…)` calls in the
   same order as HEAD's `cursor_flag`/`cursor_date`/`cursor_id`/
   `scope.as_filter_param()`/`cursor_source`. Falsified: swapping `.bind(cursor.date)`
   with `.bind(cursor.id)` reddens three tests (below).
2. `fetch_repeating_blocks` — `query_as!` with `space_id, // ?1` and
   `range_end_str, // ?2`, moved with their trailing comments.
3. `drop_superseded_draft_in_tx` — `bid_upper`(?1), `anchor_device`(?2),
   `draft_anchor_seq`(?3), unchanged.

The three `.fetch_optional`/`.fetch_one` reads that moved
(`property_definitions` × 2 in `validate_set_property_batch_text_key`,
`blocks.block_type` in `resolve_or_drop_orphan_draft_in_tx`) bind a single
value each.

## Adaptations that are not byte-for-byte moves

Each is behaviour-identical; each exists because a moved body crossed a
signature.

- `continue` → `return` in `project_repeating_block_into_map` (the `rule`
  guard and the malformed `repeat-until` arm), where a loop body became a
  function.
- `&mut tx` → `&mut *tx` and `block_id_owned.clone()` → `block_id.to_owned()`
  / `&block_id_owned` → `block_id` in
  `write_todo_timestamp_transitions_in_tx`, where the value arrives already
  borrowed.
- `match cursor.as_deref()` → `match cursor` and `&start_date` →
  `start_date` in `parse_projected_agenda_query`; `end_date.as_str() <= h` →
  `end_date <= h` in `read_projected_agenda_horizon`. Callers pass
  `cursor.as_deref()` / `&start_date` / `&end_date`.
- `let (cursor_flag, cursor_date, cursor_id, cursor_source) = match … { … }`
  became a `ProjectedAgendaCursorBinds { … }` in each arm; both `""`
  literals survive.
- `validate_reserved_property_value(def_exists, &key, v, defaults)?;` became
  the tail expression of `validate_set_property_batch_text_key`.
- `if superseding > 0 { …; flushed += 1; continue; }` became
  `if drop_superseded_draft_in_tx(…).await? { flushed += 1; continue; }`; the
  delete and the `info!` are inside, the counter and the `continue` outside.
- `let Some(target) = target else { …; flushed += 1; continue; }` became
  `let Some(block_type) = resolve_or_drop_orphan_draft_in_tx(…).await? else
  { flushed += 1; continue; }`.
- `let mut entries: Vec<…> = cached.into_iter()…` and the page tail merged
  into `cached_rows_to_projected_page`'s body; the mapping closure is
  unchanged.
- Comments moved with the code they describe. No comment text changed.

## Verified

Measured, not assumed — and measured with clippy itself, not a stand-in.

An earlier draft derived the helper figures from a local counter calibrated
against clippy's six diagnostics on this base, where it read **exactly 2
below clippy on all six**, and added 2 throughout. That calibration set was
six `async fn`s, and the offset does not carry: clippy's body span for an
async fn includes two lines the plain-source span does not, so for a sync
`fn` there is no fixed offset at all. Eight sync-helper figures were inflated
by it. **Do not reuse a "clippy − 2" rule.**

Every figure below is now clippy's own, read from
`cargo clippy -p agaric --lib --message-format=short` with
`too-many-lines-threshold` temporarily set to 5 and `clippy.toml` restored
byte-exact afterwards. The measured offsets ran −2 on seven helpers and −1 on
`project_repeating_block_into_map`, which is why they were measured
individually rather than derived. The gate is clippy itself, silent at
threshold 70.

Before (clippy's own numbers, with the six attributes stripped):

```
agenda.rs:135      list_projected_agenda_inner_with_today  177/70
agenda.rs:494      list_projected_agenda_on_the_fly        173/70
drafts.rs:33       flush_draft_inner                        73/70
drafts.rs:228      flush_all_drafts_inner                   83/70
properties.rs:244  set_todo_state_inner                    139/70
properties.rs:668  set_property_batch_inner                 93/70
```

After:

| function | before | after | helpers extracted (size) |
|---|---|---|---|
| `set_todo_state_inner` | 139 | 67 | `write_todo_timestamp_transitions_in_tx` 66 |
| `set_property_batch_inner` | 93 | 60 | `validate_set_property_batch_value_shape` 22, `validate_set_property_batch_text_key` 14 |
| `flush_draft_inner` | 73 | 67 | `ensure_draft_within_max_content_length` 8 |
| `flush_all_drafts_inner` | 83 | 60 | `resolve_or_drop_orphan_draft_in_tx` 17, `drop_superseded_draft_in_tx` 25 |
| `list_projected_agenda_inner_with_today` | 177 | 50 | `parse_projected_agenda_query` 33, `read_projected_agenda_horizon` 18, `projected_agenda_cursor_binds` 17, `fetch_cached_projected_agenda` 36, `cached_rows_to_projected_page` 43 |
| `list_projected_agenda_on_the_fly` | 173 | 47 | `fetch_repeating_blocks` 39, `try_insert_projected_entry` 23, `validate_projection_source` 12, `project_repeating_block_into_map` 58 |

- `cargo clippy -p agaric --lib --tests -- -D warnings`: clean, no output.
- `cargo fmt --all -- --check`: clean.
- `node scripts/check-bulk-equivalence.mjs`: `OK: 56 bulk-named function(s)
  inventoried (6 converged, 13 covered, 2 exception, 1 gap, 10 not-a-fan-out,
  9 read-only, 15 wrapper), no new entries, no stale entries`.
- `cargo nextest run -p agaric`: `2591 tests run: 2591 passed (1 slow),
  9 skipped`.
- `grep -ro 'expect(clippy::too_many_lines' --include=*.rs src-tauri | wc -l`:
  41 (was 47).
- `python3 scripts/check-dynamic-sql.py`, `check-raw-tx.py`,
  `check-command-arity.py` over the three files: clean. The dynamic-SQL site
  count in `agenda.rs` is unchanged at its baseline of 2.
- A Rust-aware lexer that decodes `\`-continuations and raw strings compared
  the string-literal multiset of each of the three files against HEAD. The
  ONLY difference in each is the two deleted `expect` reasons.
- No `#[tauri::command]` signature changed; `src/lib/bindings.ts` is
  untouched. No `.sqlx/` file is touched — every moved query keeps its exact
  text.

### Baseline change

Two rows added to `scripts/bulk-equivalence-baseline.json`, both
`not-a-fan-out` / `read-only`, for
`validate_set_property_batch_value_shape` and
`validate_set_property_batch_text_key` — the guard's name heuristic catches
their `batch` segment and its header prescribes recording a disposition
rather than narrowing the name. Neither takes N-key input: the `block_ids`
never reach them. One sentence appended to the existing
`set_property_batch_inner` `exception` reason saying where the two checks now
live and that the allowlist fork and its disposition are unchanged. No
recorded `status` or `kind` changed; the diff is 13 insertions, 1
modification.

### Falsified on copies, each restored byte-exact (`cmp`)

- Swapping `.bind(cursor.date)` with `.bind(cursor.id)` in
  `fetch_cached_projected_agenda` reddens
  `projected_agenda_cursor_is_portable_across_both_branches_3206`,
  `projected_agenda_cursor_keeps_duplicate_source_rows_3206` and
  `list_projected_agenda_walks_pages_correctly_m25`.
- Changing `"completed_at"` to `"created_at"` in
  `write_todo_timestamp_transitions_in_tx`'s TODO/DOING → DONE arm reddens
  `todo_state_auto_todo_to_done_sets_completed_at`.
- Neutering `ensure_draft_within_max_content_length`'s bound reddens
  `flush_draft_rejects_oversized_content`.

### Mutations that SURVIVED

Four planted, honestly reported rather than left implied:

1. Removing the `draft::delete_draft_in_tx` call from
   `resolve_or_drop_orphan_draft_in_tx` — all `test(draft)` /
   `test(orphan)` tests stay green. No test asserts that
   `flush_all_drafts_inner` actually deletes the orphan row.
2. Changing `drop_superseded_draft_in_tx`'s `superseding > 0` to `> 99` —
   all `test(2651)` / `test(stale)` tests and every test whose name contains
   the supersession stem stay green.
   `flush_draft_superseded_by_newer_edit_does_not_regress` covers the SINGLE
   path only; the flush-all supersession branch has no test.
   Both 1 and 2 are pre-existing gaps in HEAD's `flush_all_drafts_inner`
   loop — the code is a verbatim move and the three existing flush-all tests
   (`no_drafts_returns_zero`, `writes_one_op_log_row_per_draft`,
   `skips_oversized_draft_and_flushes_the_rest_3262`) never build an orphan
   or a superseded draft. Closing them means adding tests, which is outside
   a pure-move slice.
3. Changing `try_insert_projected_entry`'s `entries_map.len() >=
   bounds.max_entries` to `>`. Green, and on inspection this looks like an
   EQUIVALENT mutant rather than a coverage gap: the map then holds at most
   `limit + 2`, and the caller's `entries.len() > limit_usize` /
   `truncate(limit_usize)` discards the extra, so the page and the cursor are
   identical. Recorded because it was planted, not because it indicts the
   split.
4. Replacing `validate_set_property_batch_value_shape`'s 1-50 character
   `return Err` with a no-op. Green: `set_property_batch_rejects_invalid_reserved_value`
   exercises the option-list path, not the length bound, and an over-long
   value is still rejected downstream by `set_property_in_tx`'s own
   `validate_property_value`. What is unpinned is the batch-specific
   `"{key} must be 1-50 characters"` message. Pre-existing; the check is a
   verbatim move.

### Not run here

The full workspace suite (`--workspace`), doc-tests, Playwright, coverage and
the bundle gates. Every new item is private to its module and no public
signature changed, but `-p agaric` does not compile the dependent crates, so
the workspace run is the reviewer's.
