# Session 1364 — link-reindex correctness: a target that becomes linkable late (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an inherited uncommitted diff) |
| **Items closed** | `#4118`, `#3843` |
| **Items modified** | `#4208` (filed), `#4209` (filed), `#3843` (correction comment) |
| **Tests added** | +0 (frontend) / +10 (backend) |
| **Files touched** | 10 source + 4 `.sqlx` caches |

**Summary:** Reviewed an inherited, uncommitted diff for #4118 — migration `0112_block_links_unresolved` plus the `ReindexBlockLinks` push half — on the merits and found the mechanism sound but three things wrong: the referrer repair discharged retry-queue obligations it had not satisfied, three of the four `.sqlx` caches were never regenerated (CI's `agaric-store` prepare-check lane would have failed), and the `SetBlockPageId` arm gated the referrer repair on a condition that is not the one that makes a block linkable. Fixed all three with executable pins, re-proved the inherited test matrix by mutation rather than trusting it, corrected a crossed denominator in the #3843 measurement that had already been posted as fact, and filed the follow-up the measurement surfaced.

## What #4118 was and what the diff does

`reindex_block_links_conn`'s INSERT silently discards any parsed `[[ULID]]` / `((ULID))` token whose target is not yet *linkable* — the `WHERE EXISTS (… AND deleted_at IS NULL)` guard and the cross-space subquery. Both conditions are properties of the **target**; both can become true later (a peer can deliver the referrer before the referent; `space_id` is stamped post-commit by `SetBlockPageId`). The reindexer's only trigger is a change to the **source's** content, and there is no vault-wide `rebuild_block_links`, so the edge was lost permanently.

The fix records every declined token in a new table keyed by target, and the existing `ReindexBlockLinks` handler asks "who was waiting for this block?" after reindexing it — covering create, edit and the space stamp with no new task kind. Each referrer gets a durable `RetryKind::ReindexBlockLinks` obligation seeded before the inline repair and cleared after.

## Review findings

### 1. The referrer repair discharged obligations it had not satisfied — FIXED

`resolve_referrers_of` seeded a `ReindexBlockLinks` obligation per referrer and then cleared it after the inline repair. But `seed_obligation_tx` is `ON CONFLICT DO NOTHING` and `clear_obligation`'s DELETE is unconditional, so a referrer that **already** owed a `ReindexBlockLinks` had that pre-existing row deleted too.

The two obligations are not the same work. A pre-existing row owes the whole task — `reindex_one_block_links` **plus** `resolve_referrers_of` for the referrer's own id, the half that re-links whoever is waiting on the *referrer* as a target. The inline repair deliberately runs only the first half (running the second would recurse). Clearing on the strength of half the work reintroduces #4118's permanent loss exactly one hop away.

This is not a corner case. The #3843 measurement (below) shows 74–90% of a large import's background fan-out is **shed** into `materializer_retry_queue` with `SHED_LAST_ERROR` — tasks that never executed. During an import a referrer very often already carries such a row, so the buggy path was the common one.

Fix: track per referrer whether *this* pass authored the row, and clear only then. A row we did not author is left for the sweeper, which re-enqueues the full task and lets `clear_on_success` retire it. The cost of being wrong in this direction is one redundant idempotent reindex; the cost of the other direction is a lost edge nothing re-derives.

Pinned by `a_referrers_preexisting_reindex_obligation_survives_the_inline_relink_4118`.

### 2. Three of four `.sqlx` caches were never regenerated — FIXED

The diff arrived with 6 new entries in `src-tauri/.sqlx` only, and a note that "the warm-prune of 84 unrelated entries was restored from backup".

- The **root** cache was correct against `main`: `git status` showed 6 additions, zero deletions, zero modifications; 612 (HEAD) + 6 = 618 on disk. Nothing was lost in the prune/restore.
- But 5 of the 6 new queries live in `agaric-store/src/cache/block_links.rs`, and `src-tauri/agaric-store/.sqlx` contained **zero** `block_links_unresolved` entries. Same for `agaric-engine/.sqlx` and `agaric-sync/.sqlx` (both compile `agaric-store`'s macros as a path dependency, which is why they carry its queries). This is exactly the `just gen-sqlx` recipe's reason for existing — a bare workspace `cargo sqlx prepare` does not update the leaf caches.
- All four caches additionally still carried a **retired** entry: the old step-3 `SELECT target_id FROM block_links WHERE source_id = ?`, which the diff replaced with the `UNION ALL` form. The restore-from-backup had put a now-dead entry back.

Regenerated all four lanes the way the justfile does. Net per cache: +6 new, −1 retired. Verified with a **negative control** — reverting `agaric-store/.sqlx` to HEAD and re-running its check reproduces `error: prepare check failed: .sqlx is missing one or more queries`, so CI's Phase E `agaric-store` lane would have failed as shipped, and now passes for the right reason rather than by luck.

### 3. `SetBlockPageId` gated the referrer repair on the wrong condition — FIXED

The arm's structure is: write `page_id` (reporting `changed`), then `set_block_space_id_from_parent` — **not** gated on `changed` — then, only `if write.changed`, the reindex that carries the referrer repair. Becoming linkable on this task is a property of the *space stamp*, so the guard and the effect are different conditions and the repair was attached to the wrong one.

No production trace is claimed, and the honest reason is that #3894's owning-page fallback (`COALESCE(tgt.space_id, tp.space_id)`) keeps closing the gap: a target already carrying the `page_id` this arm would write resolves its space *through* that page and was never dropped. The state survives only because `space_id` is inherited from `parent_id` while `page_id` comes from the parent's `page_id` — two different edges — so a parent carrying a space but no page stamps the child's space while leaving `page_id` NULL → NULL.

Wired anyway, on the same standing as the arm's existing `seeded_full_rebuild` fallback (documented as unreachable today with the fallback kept regardless): the cost is one indexed seek on an already-rare arm, and the failure mode is the exact permanent loss the issue exists to end. Pinned executably by `set_block_page_id_space_stamp_relinks_referrers_without_a_page_id_change_4118` so it cannot rot into dead code.

### 4. Inaccurate FK rationale in `truncate_block_links` — FIXED (doc)

The comment claimed the `block_links_unresolved` wipe "is not optional — surviving rows would fail the FK check at COMMIT". False: `source_id … ON DELETE CASCADE` and the RESET's later `DELETE FROM blocks` fires that cascade immediately (cascade *actions* are not deferred by `defer_foreign_keys = ON`; only violation *checks* are), so the rows could never have reached COMMIT. Rewritten to the standing `CACHE_TABLES` already gives for listing `page_link_cache` — idempotent with a cascade, kept explicit so the table is empty before the restore starts inserting.

## Rulings the review was asked for

**Migration safety — SHIP.** `0112` is a new append-only file at the next number, `STRICT`, index in the same migration, no timestamp columns, no op-log write, and it adds no `DROP TABLE blocks` so the rebuild-cascade choreography is untouched. Every guard passes: `migrations-strict-tables`, `migration-test-coverage` (the new `block_links_unresolved_0112_…_4118` test embeds its migration number, so the `_0[0-9]{3}_` filter catches it), `migrations-immutable`, `migrations-rebuild-cascade` (+ self-test), `check-migration-mock-contract` (+ self-test), `check-table-ownership`, `check-dynamic-sql`, `check-raw-tx`, `check-sqlx-cache-drift`, `sqruff`. The mock contract is satisfied by the `-- mock-unaffected:` annotation, matching 0110 and 0111 rather than the baseline route — correct, since the table is backend-only derived state with no IPC surface.

The key/FK shape is right on all four lifecycle questions. `source_id` cascades: a purged source owes nothing. `target_id` deliberately carries **no** FK — that asymmetry is the entire point, since a row exists precisely because the target may not be in `blocks` yet; copying `block_links.target_id`'s FK would make the table unable to hold the only rows it is for. A hard-deleted *target* leaves an inert row costing one row (it cannot block the delete, because there is no FK to block it). A soft-deleted *source* keeps its rows, but the repair is safe: `reindex_block_links_conn` reads content `WHERE … deleted_at IS NULL`, so a tombstoned source reindexes as content-less, drops its edges and drops its unresolved rows — it cannot resurrect an edge. `(source_id, target_id)` PK plus `(target_id, source_id)` covering index answer both directions by seek.

**Unbounded growth — no.** Verified by construction, not by taking the claim. Per source the desired set is exactly `content_tokens − linked_targets`, and the sync enforces it: the DELETE removes rows the content no longer names *or* whose target the INSERT just linked, and the INSERT adds back only unlinked tokens. A source edited repeatedly with fresh never-resolving ghost ULIDs holds only its *current* content's tokens. A source that drops all its tokens takes the short-circuit branch and has every row deleted — the case the removed early return would have skipped, which is why the early return had to go. `truncate_block_links` wipes the table, and `DELETE FROM blocks` cascades it besides. The only genuinely durable residue is a permanently-unresolvable token (a purged target, a legacy cross-space reference), which costs one row and re-drives one idempotent referrer reindex whenever that target is reindexed — bounded churn, noted below as accepted.

**Crash interleavings — safe at every point, with one exception now fixed.** Seed-then-commit, repair, clear. Crash between seed-commit and repair: the obligation is durable, the sweeper re-enqueues the full `ReindexBlockLinks`, which does the repair *and* the referrer's own resolve pass, then `clear_on_success` retires it. Crash between repair and clear: the obligation survives, the re-run is idempotent (the diff finds nothing to do and the unresolved row is already gone) and re-clears. Partial repair — `reindex_one_block_links` is three or four separate transactions — leaves the obligation intact for the same re-run. The exception was the *successful* path colliding with a pre-existing obligation, finding #1 above.

**One level of repair only — proven, not asserted.** Linkability is a function of a block's row existing, its `deleted_at`, and its resolved space. A reindex writes none of those (it writes `block_links`, `block_links_unresolved`, `page_link_cache`, `pages_cache` counts). So reindexing a referrer cannot make that referrer newly linkable for anyone, and one level is the fixed point rather than an arbitrary depth cap — which is also why a mutually-referencing unresolved pair cannot ping-pong. The split into `reindex_one_block_links` / `resolve_referrers_of` is what makes this structural instead of a convention.

**Rejected alternatives — rightly rejected, both.** jfolcini's option 2 (a vault-wide `rebuild_block_links` on `RebuildTagInheritanceCache`'s triggers) is **not adequate**, and the builder's word for it — "a narrowing, not a fix" — is right for a reason worth stating: those triggers fire on restore/purge-shaped lifecycle events, never on "a target became linkable". The issue's own reported scenario (write a reference, create its target, never touch either again) enqueues no lifecycle rebuild at all, so it would remain permanently broken. It would make the #3955 oracle artefact *eventually* clean without making the vault correct — the worst combination, since it is the artefact's ability to see the bug that is currently keeping it out of the gate lane. Pull-at-read-time was rejected on the right grounds too: `block_links.target_id` carries `REFERENCES blocks(id)` so the table cannot hold a dangling token, and both `page_link_cache` and `pages_cache.inbound_link_count` *fold* it as ground truth rather than re-deriving from content — read-time resolution means dropping that FK, re-filtering in every consumer, and giving up the precomputed roll-up the graph view reads. That is a rewrite of the link stack to fix a missing row. The cost actually paid — one satellite table, recomputed per source on every reindex — is proportionate.

**#3843 — the measurement holds; one denominator was crossed.** Spot-checked the arithmetic: offered − processed = shed on all four columns; the fan-out of 4 tasks per `CreateBlock` (`UpdateFtsBlock`, `SetBlockPageId`, `ReindexBlockLinks`, `ReindexBlockTagRefs`) matches `dispatch.rs`; the `2N` op-log denominator matches the one-`property::`-line fixture; +7% foreground (41.6 → 44.6 s) and 23x-for-5x superlinearity both re-derive; §2's 1.6–2.6 µs/row, the 83–99% map share, and the ~250-edits-per-second trigger point all re-derive from the stated tables; and the framing correction (the `unique_ids.is_empty()` early return precedes `load_ref_maps`) is correct against `agaric-store/src/fts/index.rs:339`.

The defect is the **"65–90% shed"** headline: 65% is `1943/3005`, the *pre-#3840* column, while 90% is `17932/20006`, the *shipped* column. Like-for-like the shipped shape sheds 74% → 90% and the pre-#3840 shape 65% → 86%. The conclusion survives on either column, but the number had already been carried into a follow-up as a headline, so it is corrected on the issue rather than propagated.

The "no narrowing justified" verdict is supported by the numbers rather than by effort saved: the marginal cost is ~N extra retry rows with the processed count unchanged inside noise, and the proposed narrowing would duplicate the link-token regex into the dispatch hot path to buy at most the +7%. The one soft spot is that no *stated* import SLO threshold is cited — the argument is relative (the drain is a rounding error beside a superlinear foreground) rather than against a documented budget. Adequate for closing, and recorded here so a future reader knows which kind of argument it is.

**#3843 closes.** Its own "What done looks like" offers exactly two acceptance routes — "either 'within budget, closing' with the numbers recorded, or a narrowing PR justified by them" — and the first is satisfied for both costs, with denominators stated. Recorded as remaining, not blocking: §2 answered its bullet with a per-call microbenchmark plus a computable trigger point rather than an actual inbound-replay batch, deliberately, because the trigger fraction (what share of a real inbound batch is edits to referenced blocks) has not been observed and hoisting `load_ref_maps` without it would be an optimisation justified by an unmeasured multiplier.

## Findings recorded but not fixed

- **#4208 (filed).** The queue-shedding observation the measurement surfaced: 74% of a 1000-block import's background fan-out and 90% of a 5000-block import's is shed into `materializer_retry_queue` rather than drained, with the shed fraction rising with N and the recovery running on a 1 min → 1 h backoff ladder designed for failures rather than backlog. Population and method stated precisely, correction folded in.
- **#4209 (filed).** #4118's residual third transition: a target **restored** from soft-delete never re-links the referrers waiting on it. The declined token *is* recorded (the INSERT's `deleted_at IS NULL` guard treats a tombstone like an absence), but `RestoreBlock` emits `CONTENT_RESTORE_REBUILD_TASKS` + `UpdateFtsBlock` and no per-block `ReindexBlockLinks`, so nothing triggers the discharge. Strictly narrower than the pre-#4118 world — only edges *attempted during the deleted window* are at risk — and closable by enqueuing the existing task on that arm, with no new machinery.
- **Accepted, not filed:** a permanently-unresolvable token (legacy cross-space reference, purged target) is indistinguishable in the table from "not created yet", so every reindex of that target re-drives one idempotent referrer reindex plus a seed/clear pair. Bounded and self-limiting; the alternative (recording *why* a token was declined) would have to be kept in sync with the INSERT's filter, which is the drift #3903 already was.

**Files touched (this session):**
- `src-tauri/migrations/0112_block_links_unresolved.sql` (new, 62 lines — inherited, reviewed unchanged)
- `src-tauri/agaric-store/src/cache/block_links.rs` (+230/−13; doc correction this session)
- `src-tauri/agaric-store/src/cache/mod.rs` (+1)
- `src-tauri/agaric-store/src/cache/tests.rs` (+221)
- `src-tauri/src/db/tests.rs` (+75)
- `src-tauri/src/materializer/handlers/task_handlers.rs` (+244/−2; findings #1 and #3 fixed here)
- `src-tauri/src/materializer/retry_queue.rs` (+12)
- `src-tauri/src/materializer/tests/page_link_cache.rs` (+700; +2 tests this session)
- `src-tauri/src/reconciliation_oracle.rs` (+20/−11)
- `src-tauri/.sqlx`, `src-tauri/agaric-store/.sqlx`, `src-tauri/agaric-engine/.sqlx`, `src-tauri/agaric-sync/.sqlx` (+6/−1 each; three of the four regenerated this session)

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — 5938 tests run, 5938 passed, 7 skipped (348 s).
- `cargo fmt --all --check` — clean.
- `cargo check --all-targets` — clean.
- `cargo clippy --workspace --all-targets` — clean, no warnings.
- `cargo sqlx prepare --check` — all **four** lanes green (root, `agaric-store`, `agaric-engine`, `agaric-sync`), each against a freshly migrated temp DB. Negative control: reverting `agaric-store/.sqlx` to HEAD reproduces `prepare check failed: .sqlx is missing one or more queries`.
- Guards: `migrations-strict`, `migration-test-coverage`, `migrations-rebuild-cascade` (+ `--self-test`), `check-migration-mock-contract` (+ `--self-test`), `migrations-immutable`, `check-table-ownership`, `check-dynamic-sql`, `check-raw-tx`, `check-sqlx-cache-drift`, `sqruff lint` — all pass.

**Anti-vacuity — the test matrix was re-proved by mutation, not read.** Six mutations, each run against `-E 'test(4118)'` (10 tests):

| Mutation | Expected | Observed |
|---|---|---|
| A — `sync_unresolved_links` records nothing | the whole matrix reddens | 9/10 fail; only the 0112 schema test passes (correctly — it does not drive the writer) |
| B — `resolve_referrers_of` returns early | the 5 handler tests redden, the 4 store tests stay green | exactly that |
| C — drop the durable seed | only `a_failed_referrer_relink_is_owed_durably_4118` reddens | exactly that — it is the sole detector |
| D — restore the unconditional clear (the shipped-diff behaviour) | only the new pre-existing-obligation test reddens | exactly that — no inherited test covered finding #1 |
| E — re-gate the referrer repair under `write.changed` | only the new space-stamp test reddens | exactly that |
| G — restore the pre-#4118 early return | only `block_links_forgets_an_unresolved_token_removed_from_content_4118` reddens | exactly that, confirming its stated rationale |

The durability test's injected failure was probed rather than assumed: temporarily panicking in the repair's `Err` arm prints `err=Database(SqliteError { code: 1811, message: "block_links offline (#4118 test)" })` against referrer `SS…` / target `TT…` — i.e. the test's own `RAISE(ABORT)` trigger, hit on the referrer's `block_links` INSERT, which is the intended reason and not an incidental error.

**Process notes:** the `.sqlx` finding is worth generalising. "I pruned the cache and restored it from backup" reads as a recovered mistake, and the root cache genuinely was intact — but the restore also put back a *retired* entry, and the three leaf caches were never touched at all. Checking that the root cache matches `main` is not sufficient evidence that the caches are correct; `git status` across all four plus a per-lane `prepare --check` is. A negative control (revert one lane, watch it fail) is cheap and is what turns "the check passes" into "the check passes for the right reason".

**Lessons learned (for future sessions):** the #2831/#3842 "seed an obligation, clear it after the inline repair" shape has a precondition that is easy to lose when it is copied: the inline attempt must be the *whole* task the obligation names. When a caller reuses the shape for a *partial* repair — as #4118 must, to avoid recursion — the clear has to become conditional on having authored the row, or it silently discharges someone else's work. `clear_obligation`'s doc already flagged that its DELETE is unconditional and that this "is right — the work just succeeded durably"; that sentence is true only for the full-task callers, and is the kind of doc that reads as blanket permission. Worth checking the precondition at every new call site.

**Commit plan:** single commit, not pushed (review session — the diff was inherited uncommitted and the working tree is left staged-clean for the owner).
