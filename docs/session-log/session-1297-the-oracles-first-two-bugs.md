# Session 1297 — the oracle's first two bugs (2026-08-13)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-13 |
| **Subagents** | 1 build, 1 review |
| **Items advanced** | `#3818`, `#3819` (both closed) |
| **Items filed** | `#3833`, `#3834`, `#3835` |
| **Tests added** | 2 reproducers un-`#[ignore]`d, 1 unit test split into 2 |

**Summary:** The batch-vs-fold equivalence oracle landed in #3820 with two committed, deliberately-failing reproducers documenting bugs it had found on its first run. This session fixed both. One was silent data loss: `purge_blocks_by_ids_inner` filtered roots for op emission but seeded its physical cascade CTE from the raw input, so a batch containing a live block id **erased that block from disk** with no op, no fan-out and no peer notification.

**Process notes:**

**Reject, not filter — the oracle decides the fix, not just the bug.** The obvious repair for #3819 is to filter live ids out of the cascade seed, matching the op-emission filter. That stops the data loss and would have shipped. It was rejected because the single path *refuses* a live id with `InvalidOperation`, so filtering would leave the batch silently **skipping** what the single path **refuses** — a permanent, deliberate output divergence, i.e. exactly the class of drift the oracle exists to detect. The reproducer could then never be un-`#[ignore]`d, and the guard entry would have to be downgraded from `covered` to a standing exception.

So the batch now rejects too, byte-identically to `purge_block_inner`'s message. The equivalence contract is not a test that happens to be watching this code; it selected between two working fixes.

**The reproducer itself was wrong, and correcting it looks worse than it is.** As committed, its input was `[R1 (deleted), R3 (live)]`. The fold arm commits R1's purge *before* R3 fails, so the fold ends with R1 gone; an atomic batch that rejects the whole request ends with R1 still present. No atomic implementation could match that end state — the test could not pass under *either* candidate fix. Reordering to put the live id first makes the two arms comparable, and makes the test diverge **harder** against the unfixed code, not less.

Editing a failing test's input while fixing the code is the shape of moving the goalposts, so the reasoning is written at the test and in the PR rather than left to look like convenience. The mixed-batch case where the live id is *not* first is still pinned, by a separate unit test asserting full rollback.

**Rejecting needs a caller audit, because a new error is a new failure mode.** Refusing where the code previously succeeded can strand a UI. Checked before committing: `useListMultiSelect` already resets selection on `items.length` change; `handleBatchPurge` and `handleEmptyTrash` both catch and toast; and `maintenance.rs`'s `tombstone_purge` propagates via `?` to a job runner that warn-logs **without setting `last_run`**, so the sweep retries on the next 24h tick — by which point a raced restore has made the id ineligible anyway. Self-healing, not a stuck sweep.

**A guard's own prose is not exempt from the guard.** Two review findings were the same failure mode this whole cluster is about — text describing a tree that no longer exists — and both were fixed in place rather than filed:

The nightly `--run-ignored=only` sweep excluded `create_block_apply_then_reverse_round_trip_i_lifecycle_3`. That test had been renamed and un-`#[ignore]`d when it was rewritten to pin the tombstone shape, so the `-E` filter **matched nothing**. The comment sitting directly beside it states the rule "the `#[ignore]` and the exclusion go together"; the exclusion violated it. Auditing every real `#[ignore]` attribute in the workspace found six — one manual codegen task, four perf gates, one measurement harness — and none deliberately failing, so the exclusion list is now correctly empty and no `-E` is passed at all.

A stale exclusion is worse than a missing one precisely because it fails silently: `not test(<name>)` for a name that no longer exists matches nothing and reports nothing, and if the name ever returns it silently un-gates a test that is by then expected to pass.

Separately, `check-bulk-equivalence.mjs` still justified its `#[ignore]` detection with "this module ships two deliberately ignored reproducers (#3818, #3819)" — both un-ignored by this very PR. The check remains worth keeping and its rationale still holds in general terms (this *is* where such reproducers land), so the prose was restated rather than deleted.

**What the oracle cannot see, filed as #3834.** Review found that both the batch path and `restore_block_inner` call `restore_deleted_ancestor_chain` and then discard the returned chain, citing an `apply_op` fan-out arm that never runs for locally-authored ops — local commands do not advance the apply cursor, so the op is replayed only at boot, when the chain is already live in SQL and the kernel returns empty. The ancestors end up live in SQL and still tombstoned in the CRDT, a state a later reprojection resolves by **re-deleting them**.

The point worth keeping: a `bulk_equivalence` scenario will never catch this, because both arms are equally wrong and so `batch ≡ fold` holds. An equivalence oracle pins the two implementations *to each other*, not to correctness. Where a defect is symmetric it is invisible by construction, and needs a different oracle — here, a CRDT/SQL agreement assertion.

**Net for the ratchet:** `purge_blocks_by_ids_inner` was originally recorded `converged` on the grounds that all three purge variants share one `purge_subtree_tables` cascade. They do — but the *member set* fed to that cascade was a second, hand-written CTE, which is where the bug lived. A shared helper converges only the part of the body it spans, and "shares a helper" is a claim about the whole body that is rarely true.
