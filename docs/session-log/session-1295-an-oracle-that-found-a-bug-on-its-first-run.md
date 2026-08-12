# Session 1295 — an oracle that found a bug on its first run (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 1 discovery, 1 build, 1 review, 1 fix |
| **Items closed** | `#3346` |
| **Items filed** | `#3816`, `#3817`, `#3818`, `#3819` |
| **Tests added** | 0 (frontend) / see below (backend) |
| **Files touched** | 10 |

**Summary:** #3346 asked for a metamorphic equivalence oracle — `batch(ops) ≡ fold(single, ops)` — plus a ratcheted guard so new bulk paths cannot skip it. Built both. The oracle found **two** live production bugs against clean `main` — #3818 (batch restore orphans a block under a deleted parent) and #3819 (batch purge physically erases live blocks with no op and no sync) — which is the outcome that justifies the whole issue.

**Files touched (this session):**
- `src-tauri/src/bulk_equivalence/mod.rs` (new)
- `src-tauri/src/bulk_equivalence/blocks_lifecycle.rs` (new)
- `src-tauri/src/bulk_equivalence/reverse_batch.rs` (new)
- `scripts/check-bulk-equivalence.mjs` (new)
- `scripts/bulk-equivalence-baseline.json` (new)
- `src-tauri/src/lib.rs`
- `prek.toml`
- `scripts/check-table-ownership.py`
- `scripts/check-dynamic-sql.py`
- `.github/workflows/scheduled-deep-checks.yml`
- `docs/session-log/session-1295-an-oracle-that-found-a-bug-on-its-first-run.md` (new)

**Process notes:**

**The issue's motivating bug was already fixed, and its acceptance criteria could not be met as written.** #3346 leads with batch reverse-edit ignoring `payload.prev_edit` (#3280) and asks that #3280 and #3281 "are reproduced by the harness before being fixed". Both are closed. The criterion was satisfied in the only form still available — revert each fix locally, demonstrate verbatim RED, restore — which is strictly the same evidence in a different order. Recorded on the issue before starting rather than quietly reinterpreted.

**A claim carried across sessions was false.** Prior guidance, including a cross-session memory note, said apply-path tests must call `agaric_engine::loro::shared::install_for_test()` or they silently run the `sql_only` fallback instead of production. That function was deleted in `81fe88b7a` (#2249); `grep -rn "fn install_for_test" src-tauri` returns nothing. About ten comments in the tree still instruct the reader to call it, filed as #3817. The memory has been corrected in place rather than left for the next session to rediscover.

The replacement is better than what it replaced, which is the reason to fix the prose rather than delete it: sample `agaric_engine::apply::sql_only_fallback::count()` before and after the region under test and assert a delta of zero. That *measures* that the production path ran; the old discipline only asserted it by construction.

**The oracle earned its cost immediately.** `restore_blocks_by_ids_inner` omits `block_descendants::restore_deleted_ancestor_chain` (#1884), which `restore_block_inner` calls. Delete a child, separately delete its parent, then restore the child through the bulk path: the child returns live beneath a still-tombstoned parent — absent from the tree and from trash at once. No production code was changed; the reproducer is committed `#[ignore]`d so the evidence lives in the tree without reddening the suite.

The documentary asymmetry is the interesting part. `delete_blocks_by_ids_inner` carries an explicit "INTENTIONAL EXCEPTION" block citing #2325/#2250. `restore_blocks_by_ids_inner` has none — its doc says it mirrors `restore_all_deleted_inner`, and it does. But the *all*-variant restores everything, so an upward ancestor walk is vacuous there. The bulk-by-ids path inherited a body whose omission was only sound in its original context. That is a distinct failure mode from the one #3346 describes: not a fork introduced by writing a batch variant, but a correct body copied across a boundary that invalidated it.

**A parity test can be vacuous in a way that is invisible on inspection.** The obvious implementation — build on `proptest_db_harness`'s existing generator — would have been **green with the #3280 bug reinstated**. The generator mints every `EditBlock` with `prev_edit: None` (`proptest_db_harness.rs:465`), which is exactly the shape where the pointer kernel and the timestamp kernel trivially agree. Two additions were needed to make the arms distinguishable: `stamp_prev_edit`, mirroring production's `find_prev_edit_in_tx`, and `seed_distinguishing_prelude` for the #1526 skew and #3644 peer-origin shapes.

This was established by falsification, not by reading the generator. An oracle that cannot fail looks identical to one that passes, and no amount of staring at it distinguishes the two — which is the entire argument for demanding verbatim RED before accepting a test.

Related trap in the same harness: `resolve_chain` mints a fresh random ULID pool per call, so calling it once per arm silently gives the two arms different block ids. It must be resolved once and cloned.

**Normalisation is where an oracle goes to die.** Every excluded field is a class of divergence the oracle can no longer see, so each exclusion is justified inline. `blocks.deleted_at` cannot be compared by value — a batch is one `next_delete_ms` cohort where a fold is N, which is inherent to batching rather than a bug — so it is normalised to presence. To avoid going blind there, each row carries a derived timestamp-free column, `tombstone_matches_a_delete_op`, asserting `deleted_at` equals some `delete_block` op's `created_at` within that arm's own log. That is the invariant `reverse_delete_block` and the `deleted_at_ref` restore guards actually depend on, so the weaker comparison still pins the property that matters.

**The prompt was wrong in three checkable ways, and the builder said so.** The inventory was eight mutating bulk functions, not the nine claimed — two of the nine are the single-item and all-items siblings, which carry no bulk name and which no name-keyed guard can ever see. `delete_blocks_by_ids_inner` no longer contains the `WITH RECURSIVE` cascade that both the issue and the prompt describe; it has used `collect_delete_cohort` since #2895. And the guard scope specified (`src-tauri/src/**/*.rs`) excludes five of the read-only functions the same prompt listed, because they live in `agaric-store`, `agaric-engine` and `agaric-sync`.

That last one is a real limitation of what shipped, not just a prompt error: a genuine bulk fork in those crates would not be caught. It was recorded as a follow-up and then, later the same session, closed — see "Three holes an adversarial review found" below.

**Review demonstrated the oracle passing while real divergence existed — which is the only review result that matters for a test-infrastructure PR.** The harness blanked `deleted_at_ref` in op payloads as batch-inherent noise. The reviewer corrupted **every** `RestoreBlock` payload the bulk path emits — a genuine sync defect, since a peer replaying that op resolves an empty cohort and restores nothing — while leaving the SQL correct. Both scenarios stayed green.

The redaction was necessary (`next_delete_ms` is process-global monotonic, so the second arm legitimately gets later cohort ids), so the fix is not to remove it but to compare a *predicate* instead of blanking the value: does this ref name one of **this arm's own** `delete_block` op timestamps? That mirrors what the module already did for `tombstone_matches_a_delete_op`, and it generalises — whenever a field cannot be compared by value, compare the invariant that depends on it rather than excluding it.

**A blind spot recorded but not closed.** `run_arm` always calls `settle()` before `capture`, so any divergence a background task converges is erased. The module docs named a narrower gap (a bulk path that skips a background dispatch while writing identical SQL); the real one is the inverse and larger — **a bulk path that omits an in-tx repair the single path performs is invisible whenever any background task performs the same repair.** That is precisely why the `rederive_page_and_space_ids` omission cannot be observed. A pre-settle snapshot as a third comparison surface would close it; filed rather than bolted on.

**The `#[ignore]`d reproducer is the honest way to commit a finding.** #3818's evidence lives in the tree and fails on demand under `--run-ignored all`, without reddening the suite for everyone else. The alternative — describing the bug in prose and deleting the test — loses the one artifact that proves it.

**A claim was refuted rather than carried forward as "pending".** The builder reported a second omission (`rederive_page_and_space_ids`) as real-but-unverified. Review built the fixture the single path's own comment points at, and it came back **green**: the global `RebuildPageIds` handler (`task_handlers.rs:585`) has no `deleted_at` filter, so it repairs soft-deleted rows too and the value was already correct. The fixture was deleted rather than committed with a doc comment claiming it failed on main. Recorded on #3818 as *refuted for now*. An unverified claim left in the record as "pending" becomes established fact by attrition — this cluster has already produced six of those.

## Three holes an adversarial review found (same session, second pass)

**A `converged` misclassification is worse than no entry at all, and this one produced a second production bug.** `purge_blocks_by_ids_inner` was recorded `converged` on the grounds that all three purge variants run one `block_cleanup::purge_subtree_tables` cascade. True — and irrelevant to the part that forks. The single path aims that cascade at `descendants_cte_purge!()` (`WHERE id = ?`); the batch path aims it at an inline hand-written multi-root copy seeded from `json_each(?1)`, plus a batch-only `MAX(depth) >= 99` guard. A shared helper converges only the span of the body it covers, and a `converged` entry silences its function permanently — the one disposition that can never be re-litigated by a failing test.

Reclassified `covered`, with a scenario in the same shape as the delete one. Falsified twice before being believed: truncating the batch member set to its first root gives `batch = rows_purged=4 / fold = rows_purged=6` plus the two orphaned `blocks` rows named individually; neutering the depth guard (`>= 99` → `>= i64::MAX`) gives `batch = ERR(Database) / fold = ERR(Validation)`, which is what makes the guard's *presence* — though not its threshold — testable.

Then the happy-path scenario passed and the mixed-input one did not. `purge_blocks_by_ids_inner` filters its input to soft-deleted rows when choosing the roots it emits `PurgeBlock` ops for, and seeds the member-set CTE from the **raw** input list. A live block id in the input is physically erased, subtree and all, with no op, no engine fan-out, and no peer ever learning of it — while `purge_block_inner` refuses the same id with `InvalidOperation`. Filed as an `#[ignore]`d reproducer, exactly as the restore finding was; no production code changed.

**A guard's scan scope is part of its claim.** The script said it "enumerates every bulk-named function"; it walked `src-tauri/src` only. Widened to every discovered `src-tauri/*/src` — 14 more entries, classified individually rather than bulk-labelled. Two are worth naming. `read_blocks_bulk` turned out to be `covered` all along by `reads.rs`'s own bulk-vs-per-block parity tests, which the narrow walk could not see. `replay_inbox_batch` is a genuine uncovered fork — it collapses N imports, N projections and N slot deletes into one tx against a per-slot sibling it also *falls back to on error*, which means the code already assumes the two agree. It is recorded `gap`: a new disposition for "a real fork, no oracle yet, and here is why", distinct from `uncovered` ("no decision made", which still fails the guard). Every clean run prints the gap list, so it cannot go quiet.

**The discriminator did not deliver what its docs promised.** All 14 `wrapper` entries computed `read-only` because their bodies only forward — so "add a write to a read-only fan-out and the guard fails" never fired for any of them. The write-primitive scan now also expands **one hop into same-file callees**, which flips the mutating wrappers and would have caught `ingest_replicated_batch`. It is one hop and does not cross files; the docs now say exactly that instead of implying a general guarantee. `ingest_replicated_batch_inner` is the honest residue: it writes, but its write is two hops away in another crate, so its recorded `kind` stays `read-only` and the reason field says why rather than the entry pretending otherwise.

**A test the ratchet cannot see is not ratcheted.** `fetch_prior_text_fallback_only` is the sixth of `compute_reverse_batch`'s hand-copied kernels and the only one without a `batch` segment in its name, so deleting it would have been invisible. Rather than widen the name regex — which risks pulling in noise while still missing the next one — the baseline can now `pin` a function by exact key. Production code was not renamed to satisfy a heuristic.

**Kept the older hand-written fixture rather than replacing it.** `compute_reverse_batch_matches_per_op_loop` pins *absolute* answers; a parity oracle structurally cannot. A regression that breaks both kernels identically satisfies parity and fails those assertions. The two are complementary, and deleting the fixture on the grounds that the general harness supersedes it would have removed the only test that catches that case.

## Two more (third pass)

**`covered` verified a NAME, not a test.** The guard asserted only that some `fn <test>` existed somewhere under the scanned trees, so the entry stayed green if the covering test was `#[ignore]`d, or if an ordinary function was later renamed on top of a deleted one. That is acutely wrong *here*: this module deliberately ships two `#[ignore]`d reproducers (#3818, #3819), so "an `#[ignore]`d test under `bulk_equivalence/`" is a shape that already reads as intentional — a real covering test silenced the same way would have been indistinguishable. The check now requires the named test to carry a test attribute and to not be `#[ignore]`d, read from the attribute stack *immediately* preceding the signature rather than from a fixed window before it (a window cannot tell one item's attributes from its neighbour's, and both answers are wrong in the dangerous direction). Anything the parser cannot resolve — a `cfg_attr` that could attach an `ignore`, a test attribute that exists only under some `cfg` — fails closed and makes the guard complain. Falsified both ways before being believed: `#[ignore]`ing `delete_blocks_by_ids_matches_per_block_fold` and pointing `restore_blocks_by_ids_inner` at the non-test `seed_tree` each go red, and each was green before.

**A `gap` beside a `covered` still reads as a clean bill of health.** The two entries whose functions have committed failing reproducers said `covered` and named only the passing scenario; the module docs were careful about the divergence, the baseline was not. Both now carry a `reason` naming the `#[ignore]`d reproducer and its issue. No new field was needed — `reason` already coexists with `covered` on `read_blocks_bulk` — but it *was* previously unchecked on `covered` entries, so a placeholder `TODO` there would have been waved through; it is now held to the same bar as every other justification. The remaining honesty gap, left open deliberately: the reproducer name in a `reason` is prose, so deleting that test does not fail the guard the way deleting the `covered` test does.
