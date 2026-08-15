# Session 1309 — page_link_cache correctness: invalidation ordering and the backfill gate (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 3 review (2 independent PR passes + 1 review-response) |
| **Items closed** | `#3842`, `#3839` |
| **Items modified** | filed `#3886`, `#3891` |
| **Tests added** | +0 (frontend) / +7 (backend) |
| **Files touched** | 11 |

**Summary:** Closed the two structural weaknesses in the `page_link_cache` rollup. `#3842`
was fixed by re-enqueueing a per-block reindex when `SetBlockPageId` actually moves
`page_id` — plus a stale-key recompute the issue's own sketch did not call for, without
which the fix would have added the correct row and left the spurious one behind. `#3839`
was fixed with a one-shot migration so the rollup is populated at upgrade time and the
lazy read-path heal becomes redundancy rather than the mechanism.

Two independent review passes then both approved AND both independently found the same
hole: the repair signal was transient, so a failed or interrupted reindex lost the repair
permanently. Closed with the #2831 durable-obligation shape, plus an executable guard for
the one sufficiency assumption that existed only in prose, plus a false comment on the
cross-space link filter — and the real asymmetry it was hiding.

**Files touched (this session):**
- `src-tauri/agaric-store/src/cache/page_id.rs`
- `src-tauri/agaric-store/src/cache/page_links.rs`
- `src-tauri/agaric-store/src/cache/block_links.rs`
- `src-tauri/agaric-store/src/cache/mod.rs`
- `src-tauri/agaric-store/src/cache/tests.rs`
- `src-tauri/src/materializer/handlers/task_handlers.rs`
- `src-tauri/src/materializer/retry_queue.rs`
- `src-tauri/src/materializer/dispatch.rs`
- `src-tauri/migrations/0110_page_link_cache_backfill.sql` (new)
- `src-tauri/src/commands/pages/links.rs`
- `src-tauri/src/materializer/tests/page_link_cache.rs`
- `src-tauri/src/db/tests.rs`
- `src-tauri/.sqlx` (one query regenerated across all four crate caches)

**Verification (after the review round):**
- `cd src-tauri && NEXTEST_TEST_THREADS=4 cargo nextest run --workspace` — 5739 tests run,
  5739 passed, 6 skipped. `--workspace` matters: the bare form is package-scoped to `agaric`
  and would have skipped every `agaric-store`/`agaric-engine` test this change touches (#3212).
- `cargo check --workspace --all-targets` — clean; also clean with `SQLX_OFFLINE=true` and no
  `DATABASE_URL`, so the offline cache really covers every macro.
- `cargo clippy --workspace --all-targets` — clean.
- `cargo fmt --all --check` — clean (see process notes; on the first pass it was not).
- `cargo sqlx prepare --check -- --tests` in all FOUR lanes (root, `agaric-store`,
  `agaric-engine`, `agaric-sync`), each against a fresh migrated throwaway DB — clean, after
  regenerating `agaric-store/.sqlx` for the one new query. Note for anyone repeating this: a
  bare `cargo sqlx prepare --workspace` from `src-tauri` PRUNES 260 entries out of the root
  cache (it only sees the root crate's queries). Regenerate per crate, from inside the crate
  directory, exactly as `verify-ci-equivalent.sh` Phase E checks them.
- `prek run --files <changed>` — all 39 hooks pass, including the four SQL guards
  (raw-tx, dynamic-SQL, table-ownership, space-filter drift) and the three migration guards.

**Falsification (each new test verified RED with the fix reverted):**
- Durability: reverting to the transient signal leaves `page_link_cache` at
  `[("CC…", "PT…", 1)]` where `[("PP…", "PT…", 1)]` is required.
- `P1 → P2` guard: with the `debug_assert!` neutered, `test did not panic as expected`.
- Cross-space fallback: with the owning-page `COALESCE` removed, the reindex yields
  `["01TGTSTMP…"]` where both targets are required.

**Process notes:**

- **A test fixture that manufactured an unstorable state, and quietly poisoned the pool.**
  The #3842 regression test originally seeded "parent row not present yet" by inserting the
  child on a connection with `PRAGMA foreign_keys = OFF`. Two problems. First, `blocks.parent_id
  REFERENCES blocks(id)` with `foreign_keys = ON` on every pooled connection means a committed
  row with a dangling `parent_id` is **not storable today**, so the fixture tested a state
  production cannot reach. Second — the part nobody had noticed — sqlx applies its `foreign_keys`
  pragma at *connect* time and does not reset on release, so that connection went back into the
  5-connection pool with FKs **off for the remainder of the test**. The comment claiming "the
  rest of the test stays FK-clean" was false.

  The defect is real and FK-cleanly reachable, which is the better news: `apply_create_block_sql_only`
  derives `page_id` from `block_type == "page"` alone, so every non-page create through that
  documented fallback commits with `page_id IS NULL` while its parent exists on a page — the exact
  precondition, no FK games. The fixture was replaced with that seed; assertions unchanged, and
  both breaks still reproduce RED.

- **`cargo fmt --check` was red before review.** Four hunks. The prek hook is `--check`, not
  auto-fix, so this would have aborted the commit with HEAD silently not advancing. The builder's
  report said "cargo check clean, tests pass" and omitted it — a reminder that `check` and `fmt`
  are different gates and a green one says nothing about the other.

- **The migration was treated as the highest-risk artifact, because it runs once on real vaults
  and cannot be retried.** 0110 was verified as a line-by-line transcription of
  `rebuild_page_link_cache_impl` — key `COALESCE` order, the `sb.deleted_at IS NULL` filter, all
  three #2070 flags, both joins, the `LEFT JOIN` on the rollup key, `GROUP BY 1,2`. Two further
  properties were checked rather than assumed: every `COALESCE` branch is FK-backed at head, so
  the INSERT cannot produce a dangling reference (in a migration an FK abort is a **boot failure**,
  not a logged background error); and `sqlx::migrate!` wraps it in a transaction, so DELETE+INSERT
  is atomic and re-runs from scratch if interrupted. It is a recompute, not a merge, so it
  converges even on a vault the lazy heal had partly filled.

- **Termination was traced, not assumed.** `SetBlockPageId` now triggers a reindex, and reindexes
  are themselves enqueued elsewhere, so a feedback loop was the thing to rule out. Two independent
  reasons it cannot: no enqueue exists anywhere in the callee chain (all four callees take a bare
  `&SqlitePool` and hold no `Materializer`), and nothing in the chain writes `blocks.page_id`, so
  even a hypothetical re-entry is a fixpoint — the null-safe guard returns `false` on a second pass.

  **That fixpoint argument is about LOOP TERMINATION, and the first draft of this log (and of the
  PR body) wrongly extended it to "so the retry queue is safe too". Those are different
  properties, and the second one was false** — see the next note. Corrected here rather than
  quietly dropped, because the conflation is exactly what let a real durability hole read as
  already-argued.

- **The repair was lost on retry — the #2831 defect class, found by two independent reviewers
  reading the code rather than by any test.** `set_block_page_id_from_parent` committed the
  `page_id` write in autocommit and returned a *transient* "did it change" boolean; the reindex
  that performs the repair ran outside that write. A `SQLITE_BUSY` on the reindex's
  `begin_immediate_logged` (or a hard kill in the gap) meant the re-run's null-safe guard matched
  zero rows, `changed` was `false`, and the repair was skipped forever — leaving precisely the
  spurious-row-plus-missing-row state #3842 exists to fix. Both review passes APPROVED the PR and
  both flagged this independently; the existing tests passed either way, which is why it had to be
  read for.

  Fixed in the shape the same file already documents for this defect class at #2831's
  `ReindexBlockTagRefs` arm: **seed a durable, idempotent obligation inside the same transaction
  that commits the state change.** Here that is a `RetryKind::ReindexBlockLinks` row for the block,
  committed atomically with the `page_id` write, after which the repair is owed no matter what
  happens next. The inline attempt stays the happy path and clears the obligation on success; a
  failure is swallowed and left to the sweeper for #2831's own reason — returning `Err` would seed
  a `SetBlockPageId` retry row whose re-run is a guaranteed no-op. That also restores the
  "idempotent, boot-reconcilable" classification `metrics.rs` gives the task. The #2831 seed/clear
  helpers were generalised over `RetryKind` rather than copy-pasted.

  The regression test injects the failure for real instead of simulating it: `block_links` is
  renamed away, so the reindex fails at its first read while the `page_id` write (which touches
  only `blocks`) still commits; the table is restored and the queue swept. Reverting the fix leaves
  the cache at `[(CC…, PT…, 1)]` where `[(PP…, PT…, 1)]` is required — the #3842 state verbatim.

- **The stale-key sweep is sufficient for the path this change creates, and not in general —
  now enforced, not asserted.** `{parent_id, own id}` covers it because `SetBlockPageId` has
  exactly one production enqueue site and writes only `parent.page_id`, so the pre-move key is
  always NULL-derived. A `P1 → P2` page move would strand rows under `P1`. That argument lived only
  in prose, and a future second enqueue site would have reintroduced #3842 silently. The handler
  now carries the prior `page_id` out of the write and pins the assumption with a `debug_assert!`,
  degrading in release to a durable full `RebuildPageLinkCache` obligation rather than stranding
  rows; a `#[should_panic]` test manufactures the forbidden `P1 → P2` write and requires the guard
  to fire. The genuine residual is the same-page reparent inside a page-less subtree, filed as
  `#3886`; this change does not close it and does not claim to.

- **A cross-space filter comment that was false, and the bug hiding behind it.** The target-side
  subquery in `reindex_block_links` was commented as "a verbatim copy of
  `space::resolve_block_space`'s SQL". It was not: `resolve_block_space` reads
  `COALESCE(b.space_id, p.space_id)` over a join to the owning page, and the subquery read only
  `blocks.space_id`. Since `blocks.space_id` on a fresh content block is NULL until
  `SetBlockPageId` stamps it, a same-space target inside that window resolved to NULL, `NULL = ?3`
  was falsy, and a legitimate link was dropped — asymmetric with the source side, which gets the
  fallback by calling `resolve_block_space` directly.

  One reviewer read this as newly reachable via the create-arm reorder; the other argued the
  reorder is inert there. **The second is right, and for a reason neither stated in full:** on the
  create path the in-tx hook (`maintain_pages_cache_counts_after_op`, `PreOpState::Create`) has
  already written the edges, so the background reindex's `to_insert` is empty and `source_space` is
  never even resolved — *and* `project_create_block_to_sql` stamps neither `space_id` nor (for
  non-pages) `page_id`, so even the in-tx call resolves the source to `None` and admits everything.
  The asymmetry is nonetheless real and reachable through the **edit** path's in-tx hook, where the
  source's `space_id` is long since stamped. Pre-existing, unrelated to the reorder, fixed here
  anyway (both pool variants), with a test; the change strictly admits more rows and can never drop
  one the old form kept.

- **`migrations-mock-ack-baseline.txt` needed no entry, and the reason first given was wrong.**
  The first draft credited the `-- mock-unaffected:` line. `check-migration-mock-contract.py`
  extracts affected tables only from `CREATE`/`ALTER`/`DROP TABLE` and `CREATE TRIGGER … ON <t>`;
  0110 is `DELETE` + `INSERT` only, so it names **no** table the guard can intersect with the
  CONTRACT map and requires no acknowledgement at all. The `-- mock-unaffected:` line is
  belt-and-braces, not the exemption.

- **0110 gained the two things sibling migrations carry.** `INSERT OR IGNORE` instead of a plain
  `INSERT`, matching `rebuild_page_link_cache_impl` — a PK collision is impossible under
  `GROUP BY 1, 2` over BINARY-collated TEXT, but the migration's own comments already reason that
  an abort inside a migration is a boot failure rather than a logged background error, and the same
  argument covers a PK conflict. And a runtime bound derived from the query shape rather than
  guessed: one sequential scan of `block_links`, three rowid-PK probes into `blocks` per row, one
  sort/aggregate — `<1s at 100K block_links rows`, the same bound 0066 states.

- **Two follow-ups filed rather than folded in:** `#3886` (the same-page-move hole above, confirmed
  by reading `dispatch.rs`'s `MoveBlock` arm rather than inherited from the issue text) and `#3891`
  (the sweep adds two unindexed `block_links` scans per create/edit — filed explicitly as
  *unmeasured*, with the cheap `EXISTS` mitigation described and the note that measuring first may
  well show it is noise). `#3891` is deliberately still open: narrowing the sweep to the
  `SetBlockPageId` caller is also what currently makes an unrepaired roll-up self-heal on the
  block's next edit, so the two must be resolved together, with measurement. The durability fix
  above does not depend on that self-heal — it is now a redundancy behind the durable obligation
  rather than the recovery path — so narrowing the sweep later cannot regress it.
