# Session 1743 — the accumulated review-notes sweep

The follow-up PR the sixteen #4639 slices deferred their non-blocking notes to,
plus the one red CI lane that has nothing to do with #4639 and everything to do
with the merges that closed it.

This is NOT a pure-move change. Code is deleted, duplicates collapsed and two
things renamed. Behaviour is unchanged everywhere except the three new tests and
the re-anchored `dynamic-sql-baseline.txt` counts.

## Part 1 — `session-log-pr-collision` was red on every merge

`.github/workflows/pr-overlap.yml`'s `session-log-pr-collision` job failed on
run 34733696195 with:

```
check-session-log-pr-collision: could not verify — PR #5010 (the one running
this check) is not present in the fetched open-PR list (0 entries returned).
SESSION_LOG_PR_COLLISION_VERDICT=UNVERIFIED
```

The workflow fires on `ready_for_review`, and this project's automation undrafts
and squash-merges back to back, so `gh pr list --state open` runs after the PR
has closed and legitimately does not contain it. The guard's self-presence check
is right to refuse a board that omits a PR it believes is open — it just cannot
tell that from a board the PR had already left.

**The fix, and why it cannot mask a genuine stale read.** The `gh pr list` step
now also point-reads this PR's own state (`gh api repos/$REPO/pulls/$PR_NUMBER
--jq .state` → `self-pr-state.txt`), in the same step, right after the board
fetch, using the token that step already holds. The interpreting step's `else`
branch — and only that branch — consults it: when the state is present and is
not `open`, it emits a `::notice::`, writes
`SESSION_LOG_PR_COLLISION_VERDICT=SKIPPED_PR_CLOSED` and exits 0.

Everything else fails closed exactly as before:

- a self PR that IS still `open` but missing from the board — the genuine stale
  read — reads `open` and falls through to the same `::error::` and `exit 1`;
- anything that is not exactly `closed` falls through too — an absent, empty
  or malformed `self-pr-state.txt`, a `null` from a body without `.state`, a
  differently-cased `OPEN` — so a broken re-read can never buy a pass. The test
  is an allowlist (`= "closed"`), not a denylist of `open`: review caught the
  first draft accepting any non-empty string that merely differed from `open`,
  which would have suppressed a genuine stale read the moment `gh api` returned
  200 with an unexpected body shape. `GET /repos/{o}/{r}/pulls/{n}` returns only
  `open` or `closed` (a merged PR reads `closed`), so the allowlist loses
  nothing;
- `(20, COLLISION)` still fails even when the PR has closed. The skip is scoped
  to the unverifiable branch, not to the job.

The suppression is therefore gated on a positive fact about THIS PR read from a
point endpoint, never on the shape of the list it is missing from. A `WHY:`
comment in the file's own voice states the race and cites this file's header
argument that a permanently red informational lane is the failure mode it exists
to avoid.

`scripts/check-session-log-pr-collision.mjs` gains six lines: its header
enumerates the three verdicts it writes, and a reader grepping the prefix now
finds a fourth that the step writes after the guard has exited. The guard's own
logic is untouched.

### `merge-result` does not have this race

Checked, not assumed. `merge-result` never reads the open-PR board: its inputs
are `github.event.pull_request.base.ref` and `.head.sha` from the event payload,
and `scripts/pr-merge-result-check.sh` contains no `gh pr list` and no
`gh api .../pulls`. A PR that merges mid-run makes its fresh `git fetch` of the
base return a base that already contains the change; the merge of head into it
is then a no-op or a both-sides-identical merge, and the ratchet guards run on a
tree equal to `main`. Its upstream `post` job fails OPEN to `[]` and
`pr-file-overlap.mjs` already handles a missing self entry (`?? null`). No
change.

## Part 2 — the accumulated notes

1. **`compile_and` / `compile_or` → `compile_junction`** (`backlink/filters.rs`).
   One helper taking `sep`; the two call sites pass `" AND "` and `" OR "`.
   The two doc comments' distinct empty-list reasoning (an empty `And` is not
   "all", an empty `Or` folds from an empty accumulator) is kept as one
   sentence. **String literals deleted: one duplicate `"({})"`.** Both `" AND "`
   and `" OR "` survive, now once each at the call sites instead of once each
   inside the two bodies.
2. **`resolve_property_text` / `resolve_property_date` →
   `resolve_property_string`** (same file), with a `column` parameter
   interpolated into the two places the SQL named the column. The call sites
   pass the literals `"value_text"` and `"value_date"`; the doc says so, and
   says the parameter is never user input. **String literals deleted: one
   duplicate SQL template** (the surviving one is now parameterised on
   `{column}`) plus the six duplicate operator strings (`"="`, `"<>"`, `"<"`,
   `">"`, `"<="`, `">="`, `"LIKE"`) and the two duplicate LIKE patterns, each of
   which still appears once in the surviving body. Nothing with a distinct
   meaning is gone: the date-specific ISO-8601 note moved into the merged doc.
3. **`write_block_link_diff_split` and `write_block_tag_ref_diff_split`
   deleted.** Both had the same signature (`&mut sqlx::SqliteConnection` plus
   the same four parameters) and byte-identical bodies as their non-`_split`
   twins; only a parameter name and comment prose differed. Both split callers
   now call the survivor. The surviving doc comments say what is actually true:
   the two reindex ROOTS stay independent, but this half is handed a connection
   and cannot tell which root handed it over — and for the tag-refs pair, #375
   already required the two SQL strings to be byte-identical. **String literals
   deleted: two duplicate DELETE/INSERT pairs**, one per file; the surviving
   copy of each is byte-identical to what both callers ran before.
4. **`read_recorded_link_targets_split` deleted**; the survivor is generic over
   `sqlx::Executor` and takes either the transaction connection (`&mut *conn`)
   or the read pool. Done because the duplicate here is a SQL string that the
   two copies had to keep in agreement by hand — the same drift surface as 3,
   for 30 fewer lines. **String literals deleted: one duplicate `UNION ALL`
   query.**
5. **`push_delete_block_invalidations` / `push_purge_block_invalidations` →
   `push_block_removal_invalidations`** (`materializer/dispatch.rs`), taking
   `op_type: &OpType`. The two match arms collapse into
   `OpType::DeleteBlock | OpType::PurgeBlock`, which passes the `&op_type` the
   neighbouring arms already pass. No literal changed.
6. **`Materializer::sender_cell` deleted**; both call sites are now
   `Arc::new(OnceLock::from(fg_tx))` / `(bg_tx)`. `impl From<T> for OnceLock<T>`
   is stable since 1.70 and this repo pins 1.95. The helper's doc said the same
   thing as the `fg_tx` field's own doc ("`OnceLock` instead of
   `Mutex<Option<…>>`; written once, read lock-free"), so nothing is lost, and
   its `expect("freshly-constructed OnceLock cannot already be set")` goes with
   it.
7. **`SweptOpCoords` deleted** (`materializer/retry_queue.rs`). The three slot
   helpers take `record: &OpRecord` — which `slot_write_supersedes_op` already
   held — and read `record.created_at` / `.seq` / `.device_id` themselves. The
   destructure that replaces it is still two `i64` in a row, so the swap the
   struct guarded is not impossible — it is just no longer worth a struct: the
   binding sits three lines above the binds it feeds, inside one function, with
   no call boundary in between, which is where a positional mistake is visible
   rather than silent. The three helpers now return `bool` instead of an `i64` compared
   `!= 0` at the one call site, and `slot_write_supersedes_op` is a bare `match`
   returning it. The SQL and its bind order are untouched, so no `.sqlx` entry
   moves.
8. **`gate_replay_slots` loses its redundant `space_id: &str`** (7 args → 6);
   the two `tracing::warn!` fields read `space.as_str()`, like its siblings. The
   value is normalised: `SpaceId::from_trusted` uppercases, and invariant #8
   says ULIDs are uppercase already, so this is the same text with one spelling.
   A comment in the function says so.
9. **`read_projection_states`' bare `{ }` block deleted** and the body
   dedented. The block ended at the function's end, so the `EngineGuard` drop
   point is unchanged.
10. **`on_loro_sync`'s two nested bare blocks deleted** and the body dedented two
    levels. The `use crate::sync_protocol::loro_sync::{self, ApplyOutcome};`
    keeps its position as the function's first statement; the trailing #2249
    comment was re-wrapped to its new indentation.
11. **`clearable_slot_ids`' `pending_changes` is `&[(PeerID, Counter, Counter)]`**
    instead of `&[(u64, i32, i32)]`. Checked against the producer, not guessed:
    `agaric-engine/src/loro/engine/snapshot.rs:844` declares `pub pending:
    Vec<(PeerID, Counter, Counter)>`.
12. **`HealingDelta` and `OfferedFile` kept, unchanged — note not taken.** Both
    are one-use aliases, and both earn it for the reason `ProjectionStates`
    does: they name positional slots of a tuple that has same-typed neighbours
    (`HealingDelta`'s two `Vec<BlockId>`; `OfferedFile`'s `String` /
    `String` / `Option<String>`), and inlining them puts an unnamed
    `(Vec<…>, Vec<…>, TagScope)` in a signature. Each already carries a doc line
    naming its slots, so adding a second "why this alias exists" line would be
    saying it twice. No edit.
13. **`canonical_path_for_hash` → `ensure_blob_and_canonical_path`**
    (`agaric-sync/src/recovery/attachment_blob_backfill.rs`). It performs an
    `INSERT OR IGNORE` and bumps `report.blobs_created`; its `None` means the
    insert failed. The doc's first line now leads with the write. The
    `Some(match …)` wrapper is a `let stored = match …; Some(stored)`.
14. **The `absorb_imported_loro` comment block re-wrapped** from ~40 columns to
    the file's width. Text unchanged — same sentences, same issue numbers, same
    order; only line breaks moved.
15. **The three `delete_purge_*` helpers state the `_purge_descendants`
    precondition** in their doc comments (`agaric-engine/src/apply/loro_apply.rs`).
    A comment, not a runtime check, as asked.
16. **The duplicated "Branch into two compile-checked `query!` macros…"
    paragraph is said once** (`src/commands/properties.rs`): the caller keeps
    why the check is there (mirrors the sibling inners, one SELECT for the whole
    batch), the helper's doc keeps how it is implemented.
17. **`ProjectedAgendaHorizon` deleted**; `read_projected_agenda_horizon`
    returns `(bool, Option<NaiveDate>)` destructured into two named bindings at
    its one call site. Its fields were not same-typed, which is the criterion
    the other structs in that slice meet. `ProjectionWindow`,
    `ProjectedPageBounds`, `ProjectedAgendaQuery` and `ProjectedAgendaCursorBinds`
    are untouched.
18. **`scripts/bulk-equivalence-baseline.json` gains
    `task_handlers.rs::dispatch_committed_cohorts`**, status `gap`, in sorted
    position, pinned by exact key with a `pin` justification modelled on
    `fetch_prior_text_fallback_only` (the only other by-key pin). Its last two
    statements are the #4733 pass that collapses N per-record
    `reindex_fts_for_ids` calls into one union pass; the reason field says what
    the fold is, what would have to hold for the two to agree, and that no test
    drives a multi-record `BatchApplyOps` against the same ops applied one at a
    time. `kind` is `read-only` because that is what the guard computes (its
    writes are one file away, which the guard's one-level expansion does not
    cross) — recorded to match, since a recorded kind that disagrees with the
    computed one is itself a guard failure.
22. **`usize::try_from(limit_i64).unwrap_or(200)` in
    `parse_projected_agenda_query`** (the note added mid-session). Read first:
    `limit_i64` comes from exactly one `match` four lines above, whose `Some`
    arm is guarded by `(1..=500).contains(&l)`, whose other `Some` arm
    `return`s `AppError::Validation`, and whose `None` arm is the literal `200`.
    There is no other assignment and no cursor path that reaches the conversion
    — `after` is decoded before it and never feeds it. So the conversion is
    infallible, the fallback is unreachable, and a silent `unwrap_or` is exactly
    the clamp shape invariant #10 forbids. Now
    `.expect("limit is validated to [1, 500] above, so the conversion cannot
    fail")`, matching the `usize::try_from(row.cnt).expect(…)` sixty lines above
    it in the same file. Not a second guard: the `expect` states the
    precondition rather than substituting a value for it. (`as usize` is not
    available — `cast_possible_truncation` is a warn-level lint and clippy runs
    with `-D warnings`.)

## Part 3 — the coverage gaps

19. **`purge_tag_property_and_link_rows`: statements KEPT, test added.**
    Every call site was checked. There is exactly one production caller —
    `src/commands/block_cleanup.rs::purge_subtree_tables`, via the crate's
    `purge_block_satellite_caches` — and it does run
    `agaric_engine::block_ops::delete_blocks_in_subtree` afterwards. Every one
    of the five tables' FKs into `blocks(id)` is `ON DELETE CASCADE`
    (migration 0061 for `block_tags`, `block_tag_inherited` on all three
    columns, and `block_links`; migration 0062 for `block_properties`, which
    also moved `value_ref` from SET NULL to CASCADE), so at that call site the
    cascade does reach the same rows.

    Deleting them anyway would reverse a recorded decision rather than remove
    dead code. `agaric-engine`'s sibling purge chain carries exactly this
    question already answered, with an issue number:
    `delete_purge_link_refs_and_doc_state`'s doc says the FKs cascade and "we
    delete them explicitly anyway (issue #1583): the explicit list above is the
    canonical record of every derived table PURGE touches, and relying on the
    cascade silently leaks stale rows if a future migration alters the FK or
    adds a block-referencing cache without CASCADE." `purge_block_satellite_caches`
    is also a `pub` store API whose documented contract is the satellite purge
    alone — its doc says the final `blocks` DELETE is the caller's — and its
    sibling half (`purge_cache_and_lookup_rows`) already has an isolated test
    that never deletes a `blocks` row.

    So the first half got the test the second half already had:
    `purges_tag_property_and_link_rows_without_any_blocks_delete` seeds one
    member row and one bystander row per swept predicate (including a
    `block_tag_inherited` row that names the member only via `inherited_from`,
    and a `block_properties` row owned by a third block that points INTO the
    member set via `value_ref`), calls the purge, and asserts the four tables
    plus a final `COUNT(*) FROM blocks = 4`. No `blocks` row is deleted, so no
    cascade can stand in for the sweep.

20. **`flush_all_drafts_inner`'s orphan and supersession branches now have
    tests.** Session 1742 recorded both as surviving mutants (its "Mutations
    that SURVIVED" items 1 and 2); these are the two tests that kill them. Each
    puts its skipped draft in a multi-draft batch with the `updated_at` ordering
    pinned, so the loop's `continue` is exercised and the sibling drafts prove
    the batch still flushes around it.
    - `flush_all_drafts_drops_an_orphan_draft_mid_batch` — soft-deleted target
      in the middle of three. (A target MISSING from `blocks` is unreachable:
      migration 0038's FK makes seeding one impossible, as the module's own
      comment says. Soft-deleted is the reachable half of that branch.)
    - `flush_all_drafts_drops_a_superseded_draft_mid_batch` — a directly-seeded
      `op_log` row on the same device with `seq` past the draft's anchor.
      Seeded rather than written through the command layer precisely because an
      `edit_block` through the command layer would also rewrite
      `blocks.content`, which is what the test reads back as proof the stale
      draft did not regress it.

21. **The foreground `ApplyOp` lease is pinned to the Failure ladder.**
    `sweep_leases_a_foreground_apply_op_row_on_the_failure_ladder_4208` seeds a
    due `ApplyOp:1:dev-4208` row with `attempts = MAX_ATTEMPTS + 3` and an
    `op_log` row whose payload is `{}`, runs `sweep_once`, and asserts the row's
    `attempts` did not restart and its `next_attempt_at` landed exactly one hour
    out (bracketed by `now_ms()` either side of the sweep).

    Two deliberate fixture choices, both about determinism rather than realism:
    the invalid payload means the re-applied op fails, so the consumer cannot
    `clear_on_success` the row out from under the read; and seeding `attempts`
    past the cap means a `record_failure` landing concurrently (attempts 13 → 14)
    writes the SAME capped rung, while the two ladders are an hour and five
    minutes apart there instead of sharing their 1-minute first rung.

**Not "fixed": `write_pool_confirms_orphan`'s #2032 re-check.** Left exactly as
it is. Gutting it survives because #3519's post-quarantine confirmation reaches
the same end state through quarantine-then-restore — two independent paths to
one invariant is defence in depth working as designed, not an unpinned branch.

## Verified

Run in this session, one cargo process at a time, every cargo command prefixed
`CARGO_INCREMENTAL=0`.

```
$ cd src-tauri && cargo fmt --all -- --check
fmt-check exit=0

$ cd src-tauri && cargo clippy --workspace --lib --tests -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2m 06s
clippy exit=0

$ node scripts/check-bulk-equivalence.mjs
NOTE: 2 recorded, still-uncovered fork(s) (#3346):
  src-tauri/agaric-engine/src/materializer/handlers/task_handlers.rs::dispatch_committed_cohorts
  src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs::replay_inbox_batch
OK: 57 bulk-named function(s) inventoried (6 converged, 13 covered, 2 exception,
2 gap, 10 not-a-fan-out, 9 read-only, 15 wrapper), no new entries, no stale
entries
exit=0

$ node scripts/check-pr-overlap-trust-boundary.mjs
OK: pr-overlap.yml does not trigger on pull_request_target
exit=0

$ node scripts/check-pr-overlap-trust-boundary.mjs --self-test
self-test: all assertions passed
selftest exit=0

$ bash scripts/zizmor-hook.sh .github/workflows/pr-overlap.yml
 INFO audit: zizmor: 🌈 completed .github/workflows/pr-overlap.yml
No findings to report. Good job! (6 suppressed)
exit=0
```

`python3 scripts/check-dynamic-sql.py` over the changed `.rs` files first FAILED
— the baseline held slack the deletions had reclaimed — and was re-anchored with
its own `--update-baseline`, scoped to the current diff:

```
Re-anchored src-tauri/dynamic-sql-baseline.txt — scope: 14 file(s) from the current diff
  src-tauri/agaric-store/src/backlink/filters.rs: 21 -> 20
  src-tauri/agaric-store/src/cache/block_links.rs: 4 -> 2
  60 entries (was 60)
```

Both drops are the deleted duplicates (item 2's merged resolver; item 3's and
4's two deleted `block_links` helpers). `check-raw-tx.py`, `check-command-arity.py`,
`check-table-ownership.py`, `check-op-log-delete.py`, `check-space-filter-drift.py`
and `check-elevation-tiers.py` over the same file list: exit 0.

### The three new tests, each shown red

Each mutation was applied to a `cp` backup, run, restored from that backup, and
`cmp`'d byte-for-byte.

1. **Item 19.** All five DELETEs in `purge_tag_property_and_link_rows` neutered
   (bodies kept as unused tuples so the strings stay in the file):
   ```
   Summary [0.828s] 2 tests run: 1 passed, 1 failed, 6333 skipped
   TRY 2 FAIL agaric-store cache::purge::tests::purges_tag_property_and_link_rows_without_any_blocks_delete
     assertion `left == right` failed
       left: ["bystander", "victim"]
      right: ["bystander"]
   ```
   The pre-existing `purges_store_owned_satellites_for_member_set` PASSED under
   the same mutation — which is the note's premise confirmed: it covers the
   second half of the chain only.

2. **Item 20, orphan.** `draft::delete_draft_in_tx` removed from
   `resolve_or_drop_orphan_draft_in_tx` (session 1742's surviving mutant 1):
   ```
   PASS  agaric commands::drafts::tests_h12::flush_all_drafts_drops_a_superseded_draft_mid_batch
   FAIL  agaric commands::drafts::tests_h12::flush_all_drafts_drops_an_orphan_draft_mid_batch
     assertion `left == right` failed: every draft row is consumed
       left: 1
      right: 0
   ```

3. **Item 20, supersession.** `superseding > 0` → `> 99` in
   `drop_superseded_draft_in_tx` (surviving mutant 2):
   ```
   PASS  agaric commands::drafts::tests_h12::flush_all_drafts_drops_an_orphan_draft_mid_batch
   FAIL  agaric commands::drafts::tests_h12::flush_all_drafts_drops_a_superseded_draft_mid_batch
     assertion `left == right` failed: only the seeded superseding op — the flush appends none
       left: 2
      right: 1
   ```
   Each mutation reddens ITS test and leaves the sibling green, so the
   attribution is not shared.

4. **Item 21.** `BackoffClass::Failure` → `BackoffClass::Shed` in
   `sweep_apply_op_row`:
   ```
   Summary [0.856s] 1 test run: 0 passed, 1 failed, 6334 skipped
   TRY 2 FAIL agaric-engine materializer::retry_queue::tests::sweep_leases_a_foreground_apply_op_row_on_the_failure_ladder_4208
     the lease must not restart attempts — that is the Shed ladder's behaviour,
     and it would reset this row's execution budget (attempts 1 < 13)
   ```

The CI fix was exercised the same way, against the step's own shell extracted
from the workflow and run with fixture files (every path it touches is an env
var, by #4431's design). With `prs.json = []` and `PR_NUMBER = 5010` it
reproduces the real failure exactly, then skips:

| `self-pr-state.txt` | outcome |
|---|---|
| `closed` | `::notice::` + `SKIPPED_PR_CLOSED`, **exit 0** |
| `merged` | `SKIPPED_PR_CLOSED`, **exit 0** |
| `open` | `::error::… could not verify (exit=2, verdict=UNVERIFIED)`, **exit 1** |
| file absent | same error, **exit 1** |
| file empty (`gh api` failed) | same error, **exit 1** |

and with a genuine two-PR collision payload plus `state = closed`, the job still
**exits 1** on `(20, COLLISION)` — the skip never reaches a verdict the guard
did reach.

### Not run here

Playwright, `e2e-tauri`, vitest, the coverage and bundle-budget gates, the
Android and bundle builds, `cargo mutants`, `actionlint` (not installed in this
container; `zizmor` is, and ran). zizmor ran with `--no-online-audits` after its
online audit collection 401'd against github.com, so `impostor-commit`,
`known-vulnerable-actions`, `ref-confusion` and `stale-action-refs` were NOT
checked locally — CI runs them.

No `.sqlx` cache entry was *removed*: every deleted query was a byte-identical
duplicate of a surviving one, item 7 moved binds without touching SQL text, and
item 2's merged resolver is a runtime `AssertSqlSafe` query that was never in
the cache.

One entry was **added**, and an earlier draft of this paragraph missed it by
reasoning only about deleted queries. The new retry-queue lease test embeds a
fresh literal (`task_kind = 'ApplyOp:1:dev-4208'`), which needs its own cache
file in the workspace-root and `agaric-engine` caches. Review caught it: the
`agaric-engine` lane failed `prepare --check` with `.sqlx is missing one or
more queries` while the other three passed. `just gen-sqlx` produced exactly
that one file in exactly those two caches and nothing else — which is itself
the evidence for the sentence above, since a regeneration that also pruned
would have proved a deleted query was not a duplicate after all. All four
lanes pass (invariant 6).

## Review round

A container restart killed this session's builder mid-verification, taking its
`cargo nextest run --workspace` with it and leaving a half-finished
`cargo sqlx prepare` that had deleted ~100 cache files without rewriting them.
Restoring `src-tauri/.sqlx/` from HEAD recovered the casualties and discarded
the one genuinely new entry along with them — the failure is recorded above,
under the `.sqlx` paragraph, because it is the reason that paragraph was wrong
in its first draft.

Review then ran the suite the restart ate, and found two things:

- **Blocking: the `agaric-engine` `.sqlx` lane was red**, `prepare --check`
  reporting `.sqlx is missing one or more queries` while the other three
  passed. Fixed with `just gen-sqlx`, which wrote exactly one file into the
  workspace-root and `agaric-engine` caches and touched nothing else. All four
  lanes pass. That "nothing else" is load-bearing: a regeneration that had also
  pruned would have disproved the claim that every deleted query was a
  duplicate.
- **The closed-PR test was a denylist.** `[ -n "$state" ] && [ "$state" != "open" ]`
  treats `null`, `garbage` and `OPEN` as "closed", so a body without `.state`
  would have suppressed exactly the stale read this lane exists to catch.
  Narrowed to `[ "$state" = "closed" ]`.

Re-verified after both fixes, with the interpreting step re-extracted from the
edited workflow rather than patched in place:

| board / state | exit | verdict |
|---|---|---|
| self-PR absent, `closed` | 0 | SKIPPED_PR_CLOSED |
| self-PR absent, `open` | 1 | UNVERIFIED |
| self-PR absent, `null` | 1 | UNVERIFIED |
| self-PR absent, `garbage` | 1 | UNVERIFIED |
| self-PR absent, `OPEN` | 1 | UNVERIFIED |
| self-PR absent, file empty | 1 | UNVERIFIED |
| self-PR absent, file missing | 1 | UNVERIFIED |
| genuine collision, `closed` | 1 | COLLISION |

The first fixture run of that matrix was wrong and said so: it listed the
self-PR on the board it was meant to be absent from, so all seven rows returned
`CLEAN` without reaching the branch under test. The numbers above are the rerun.

Full suite, run by review on the pre-fix tree: `6322 tests run: 6322 passed,
13 skipped`; `cargo test --doc --workspace` clean. Since then the only Rust
change is a comment inside a `#[cfg(test)]` function;
`cargo nextest run -p agaric-store -E 'test(purge)'` passes 3/3. vitest is not
needed — nothing under `src/` or `e2e*/` is touched, and `vitest.config.ts`
includes only those roots.

Review also re-derived, rather than accepted, the claims this log makes about
the twins being byte-identical, the `dynamic-sql-baseline.txt` re-anchor being
mandatory (restoring the old baseline reds the guard), and session number 1743
being free. Two overstatements it caught are corrected in place above: the
`SweptOpCoords` paragraph no longer claims the swap surface is gone, and the
new purge test's comment no longer implies a bystander row where both seeded
rows name the member.
