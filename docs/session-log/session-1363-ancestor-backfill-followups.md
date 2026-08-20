# Session 1363 — #4083 ancestor-backfill follow-ups: batched probe, single engine view, walk diagnostics (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an inherited working-tree diff) |
| **Items closed** | `#4099` `#4100` `#4111` |
| **Items modified** | `#4083` (the path all three follow-ups sit on), `#4107` (probe-failure accounting re-stated for the batched shape) |
| **Tests added** | +0 (frontend) / +4 (backend) |
| **Files touched** | 5 |

**Summary:** The three review follow-ups on #4083's ancestor backfill landed together, since all three touch the same twenty lines of `import_and_project`. The two `SELECT 1 FROM blocks WHERE id = ?` loops (the backfill's candidate probe and the 787 diagnostic's per-edge probe) collapse into one `json_each` + `NOT EXISTS` statement, and the backfill's probe moved *inside* the projection transaction, closing the TOCTOU window jfolcini flagged on #4099. The healing path no longer takes a second engine-guard acquisition, so #540's "one atomic view per projection" holds on the healing path and not only the healthy one. The review of the inherited diff corrected two load-bearing justifications that were wrong as written — a claimed lock-ordering hazard that the local apply path already takes on every op, and a cost bound stated as a constant when it is not — and re-anchored a statement-count spy that measured calls rather than statements.

**Files touched (this session):**
- `src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs` (+454/-127) — new `absent_block_ids` batched probe + `execute_absent_probe` execution site; single engine-guard acquisition reading `changed ++ candidates`; `PRAGMA defer_foreign_keys` and the probe both moved inside the tx; `probe_parent_edges` batched; 2 new tests
- `src-tauri/agaric-engine/src/loro/engine/snapshot.rs` (+130/-6) — `ancestors_outside`: `hops` reworded as a depth cap (the `visited` set is the real termination guard), `tracing::warn!` on a walk truncated by an unreadable parent; 1 new test
- `src-tauri/agaric-engine/src/loro/registry.rs` (+17) — `guard_acquisitions()` test instrument behind `cfg(any(test, feature = "test-util"))`
- `src-tauri/src/sync_protocol/loro_sync_tests.rs` (+114) — `apply_remote_healing_reads_one_engine_view_like_the_healthy_path_4100`
- `src-tauri/dynamic-sql-baseline.txt` (+1/-1) — `loro_sync.rs` 5 → 4 runtime-form sites (two loops removed, one batched probe added)

**Review corrections applied to the inherited diff:**
1. **The #4100 deadlock ruling was wrong in its reasoning.** The comment justified the single acquisition by claiming a lazily-gated second guard "would mean blocking on the engine mutex while holding SQLite's writer lock, which is a lock-ordering hazard". Re-derived from scratch: `EngineGuard` is `!Send`, pinned by the inlined `assert_not_impl_any` tripwire in `loro::registry`, so no async code can hold the engine mutex across the `.await` a SQLite lock acquisition needs — the reverse edge cannot exist anywhere in the workspace, and the only production `block_on`/`block_in_place` sites (`cpu_block_in_place`) do no SQL. Moreover the *forward* edge is the established pattern: every local op takes `for_space_recording` with the caller's write tx already open (`agaric-engine/src/apply/loro_apply.rs`). There is no cycle and no novel hazard. The comment now says what is actually true — the single acquisition buys **latency** (not stalling other writers while waiting on the engine mutex under `BEGIN IMMEDIATE`), and the real reason is #540's atomic-view property.
2. **The cost bound did not hold.** The diff bounded the extra work at "a few ancestor states … bounded and small". It is not a constant: the candidate count is the number of *distinct untouched ancestors of the changed set*, which is tree depth for a sparse edit but reaches the hundreds on exactly the long-offline-catch-up scenario #4099 itself cites. Rewritten to state the real bound, name jfolcini's objection as the real cost it is, and say why option 1 was still taken.
3. **The `#4099` statement spy counted calls, not statements.** `probe_statement_spy::bump()` sat at the top of `absent_block_ids`, so the assertion "one id, one statement / fifty ids, the same" was true by construction and would have passed on an N+1 (or on a future chunking loop) inside the function. The single `sqlx::query_scalar` moved into `execute_absent_probe`, the sole execution site, with the bump bound to it — any future chunking must loop over that function, which keeps the count honest.
4. **Widened failure surface documented.** Reading candidate state unconditionally means a corrupt engine node whose `block_id` is readable (so the #4111 warn does not fire) but whose properties/tags are not now fails every apply below it, where before it failed only the healing path. Same hard failure a corrupt *changed* block already causes, and it fails loudly into the #535 inbox retry — recorded in place so it is not rediscovered as a new defect.

**Verified, not accepted on assertion:**
- jfolcini's #4099 comment explicitly sanctions moving the probe inside the tx ("batch the probe **and** move it inside the tx"), so that scope is asked for, not scope creep. Running it on the writer connection escalates no lock and adds one statement to the tx.
- `NOT EXISTS` over `json_each(?1)`: empty input short-circuits before any round-trip; ids are `&str` so no NULL can enter the array; both callers pass de-duplicated ids (`ancestors_outside` dedups via `visited`, `probe_parent_edges` sorts+dedups); the list binds as one JSON parameter, so no `MAX_SQL_PARAMS` chunking and no concatenated SQL.
- `read_blocks_bulk` returns exactly one `Option` per input id, so the `changed ++ candidates` split by `take(changed_len)` stays index-aligned.
- `dynamic-sql-baseline.txt` moved only the one line; the four surviving runtime-form sites in `loro_sync.rs` were enumerated by hand and the removed sites are gone, not relocated.
- The #4107 "Why the probe failures are counted" narrative rewritten by #4194 is intact and not duplicated (this branch was already at `origin/main`, so no merge was needed).

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — 5932 tests run, 5932 passed, 7 skipped.
- `cargo fmt --check` — clean. `cargo clippy --workspace --all-targets` — no warnings.
- `cargo check --all-targets` — clean. `cargo sqlx prepare --check --workspace -- --all-targets` — exit 0.
- `python3 scripts/check-dynamic-sql.py` — exit 0.
- Mutation-proved the three headline tests rather than trusting the red-output claims: a second `for_space` in the healing branch reddens the #4100 test (6 acquisitions vs 5); a per-edge probe loop reddens the #4111 diagnostic test (101 statements vs 1); silencing the truncation warn reddens the #4111 walk test. The #4099 spy's own assertion was *not* provable this way before the fix — that is what identified it as vacuous.

**Lessons learned (for future sessions):** a "this would be a lock-ordering hazard" argument is only as good as the search for the reverse edge; here the forward edge it warned about is what the local apply path does on every single op, and the property that actually makes the ordering safe (`EngineGuard: !Send`) was already pinned by a compile-time tripwire three files away. And a spy placed at function entry counts calls, not round-trips — put it at the execution site or the assertion measures nothing.

**Commit plan:** single commit / not pushed.
